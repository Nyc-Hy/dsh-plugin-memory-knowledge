import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCanonicalStore } from '../src/canonical.js'
import {
  detectKnowledgeCardFreshness,
  createSourceInventoryBaseline,
  inspectKnowledgeProject,
  NodeSourceInventoryBackend,
} from '../src/inventory.js'
import { DEFAULT_SOURCE_INVENTORY_CONFIG, KnowledgeProjectInspector } from '../src/inventory-provider.js'
import { DeterministicSourceAnalyzer } from '../src/source-analysis.js'
import { commitProjectChanges, fileContentHash, initializeGitProject, makeTempProject, readJson, writeJson } from './helpers.js'

const cardId = 'card_44444444-4444-4444-8444-444444444444'
const sourceId = 'src_22222222-2222-4222-8222-222222222222'

class CountingInventoryBackend extends NodeSourceInventoryBackend {
  readonly readPaths: string[] = []
  readonly gitArguments: string[][] = []

  override runGit(...parameters: Parameters<NodeSourceInventoryBackend['runGit']>): ReturnType<NodeSourceInventoryBackend['runGit']> {
    this.gitArguments.push([...parameters[1]])
    return super.runGit(...parameters)
  }

  override readFile(...parameters: Parameters<NodeSourceInventoryBackend['readFile']>): ReturnType<NodeSourceInventoryBackend['readFile']> {
    this.readPaths.push(parameters[1])
    return super.readFile(...parameters)
  }
}

async function alignedProject(): Promise<{ project: string; commit: string }> {
  const project = await makeTempProject()
  const commit = await initializeGitProject(project)
  const sourcePath = join(project, 'src', 'example.ts')
  const cardPath = join(project, '.dsh', 'knowledge', 'cards', `${cardId}.json`)
  const card = await readJson(cardPath)
  const contentHash = await fileContentHash(sourcePath)
  card['sourceRevisions'] = [{ sourceId, kind: 'git', commit }]
  const provenance = [{ kind: 'git-file', sourceId, commit, path: 'src/example.ts', contentHash }]
  card['provenance'] = provenance
  const sections = card['sections'] as Array<Record<string, unknown>>
  sections[0]!['provenance'] = provenance
  await writeJson(cardPath, card)
  return { project, commit }
}

describe('source inventory', () => {
  it('builds a deterministic inventory with portable paths, hashes, and language boundaries', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, '.env'), 'TOKEN=excluded\n')
    await initializeGitProject(project)
    const store = await readCanonicalStore(project)
    const first = await inspectKnowledgeProject(
      new NodeSourceInventoryBackend(),
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
    )
    const second = await inspectKnowledgeProject(
      new NodeSourceInventoryBackend(),
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
    )
    expect(first.sources[0]).toMatchObject({
      state: 'ready',
      sourceId,
      dirty: false,
      fileCount: 1,
      files: [{ path: 'src/example.ts', language: 'TypeScript' }],
    })
    expect(first.sources[0]!.files[0]!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(first.sources[0]!.inventoryHash).toBe(second.sources[0]!.inventoryHash)
    expect(JSON.stringify(first.sources)).not.toContain(project)
    expect(JSON.stringify(first.sources)).not.toContain('TOKEN=excluded')

    await writeFile(join(project, '.dsh', 'knowledge', 'wiki-local-change.md'), 'derived change\n')
    const derivedChange = await inspectKnowledgeProject(
      new NodeSourceInventoryBackend(),
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
    )
    expect(derivedChange.sources[0]).toMatchObject({ dirty: false, inventoryHash: first.sources[0]!.inventoryHash })
  })

  it('changes the inventory for untracked edits and reports a deleted tracked file', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const store = await readCanonicalStore(project)
    const backend = new NodeSourceInventoryBackend()
    const baseline = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    await writeFile(join(project, 'src', 'new.ts'), 'export const added = true\n')
    const added = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    expect(added.sources[0]!.inventoryHash).not.toBe(baseline.sources[0]!.inventoryHash)
    expect(added.sources[0]!.dirty).toBe(true)
    expect(added.sources[0]!.files.map(file => file.path)).toContain('src/new.ts')

    await rm(join(project, 'src', 'example.ts'))
    const deleted = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    expect(deleted.sources[0]).toMatchObject({
      state: 'degraded',
      issues: expect.arrayContaining([{ kind: 'missing-file', path: 'src/example.ts' }]),
    })
  })

  it('reuses unchanged files across clean commits and matches a cold full scan', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'README.md'), '# Fixture\n')
    await writeFile(join(project, 'src', 'remove.ts'), 'export const remove = true\n')
    await writeFile(join(project, 'src', 'stable.ts'), 'export const stable = true\n')
    await initializeGitProject(project)
    const store = await readCanonicalStore(project)
    const backend = new CountingInventoryBackend()
    const first = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    const baseline = createSourceInventoryBaseline(first.sources[0]!)!
    expect(first.sources[0]).toMatchObject({ scanMode: 'full', reusedFileCount: 0, readFileCount: 4 })

    await writeFile(join(project, 'src', 'example.ts'), 'export function changed(): string {\n  return "changed"\n}\n')
    await writeFile(join(project, 'src', 'new.ts'), 'export const added = true\n')
    await rm(join(project, 'src', 'remove.ts'))
    await rename(join(project, 'README.md'), join(project, 'GUIDE.md'))
    await commitProjectChanges(project, 'change inventory paths')
    backend.readPaths.length = 0
    backend.gitArguments.length = 0

    const incremental = await inspectKnowledgeProject(
      backend,
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      new DeterministicSourceAnalyzer(),
      { baselines: [baseline] },
    )
    const source = incremental.sources[0]!
    expect(source).toMatchObject({ scanMode: 'incremental', reusedFileCount: 1, readFileCount: 3 })
    expect(backend.readPaths.sort()).toEqual(['GUIDE.md', 'src/example.ts', 'src/new.ts'])
    expect(backend.gitArguments.some(args => args[0] === 'diff' && args.includes('--name-status'))).toBe(true)
    expect(source.files.map(file => file.path)).toEqual(['GUIDE.md', 'src/example.ts', 'src/new.ts', 'src/stable.ts'])

    const cold = await inspectKnowledgeProject(
      new CountingInventoryBackend(),
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
    )
    expect(source.inventoryHash).toBe(cold.sources[0]!.inventoryHash)
    expect(source.files).toEqual(cold.sources[0]!.files)

    backend.readPaths.length = 0
    const unchanged = await inspectKnowledgeProject(
      backend,
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      new DeterministicSourceAnalyzer(),
      { baselines: [createSourceInventoryBaseline(source)!] },
    )
    expect(unchanged.sources[0]).toMatchObject({ scanMode: 'incremental', reusedFileCount: 4, readFileCount: 0 })
    expect(backend.readPaths).toEqual([])
  })

  it('falls back to a full scan for dirty worktrees or incompatible analyzer settings', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const store = await readCanonicalStore(project)
    const baselineStatus = await inspectKnowledgeProject(new NodeSourceInventoryBackend(), store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    const baseline = createSourceInventoryBaseline(baselineStatus.sources[0]!)!
    const backend = new CountingInventoryBackend()

    const incompatible = await inspectKnowledgeProject(
      backend,
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      new DeterministicSourceAnalyzer({
        maxEvidencePerFile: 2,
        maxEvidenceNameChars: 240,
        maxModuleReferencesPerFile: 64,
        maxModuleSpecifierChars: 512,
      }),
      { baselines: [baseline] },
    )
    expect(incompatible.sources[0]).toMatchObject({ scanMode: 'full', reusedFileCount: 0, readFileCount: 1 })

    await writeFile(join(project, 'src', 'example.ts'), 'export const dirty = true\n')
    backend.readPaths.length = 0
    const dirty = await inspectKnowledgeProject(
      backend,
      store,
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      new DeterministicSourceAnalyzer(),
      { baselines: [baseline] },
    )
    expect(dirty.sources[0]).toMatchObject({ dirty: true, scanMode: 'full', reusedFileCount: 0, readFileCount: 1 })
  })
})

describe('Knowledge Card freshness', () => {
  it('keeps a card fresh for unrelated changes and marks its changed evidence file stale', async () => {
    const { project } = await alignedProject()
    const backend = new NodeSourceInventoryBackend()
    const store = await readCanonicalStore(project)
    const fresh = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    expect(fresh.cards).toMatchObject([{ cardId, state: 'fresh', reasons: [] }])

    await writeFile(join(project, 'README.md'), 'unrelated\n')
    const unrelated = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    expect(unrelated.cards[0]!.state).toBe('fresh')

    await writeFile(join(project, 'src', 'example.ts'), 'export const changed = true\n')
    const changed = await inspectKnowledgeProject(backend, store, DEFAULT_SOURCE_INVENTORY_CONFIG)
    expect(changed.cards[0]).toMatchObject({
      state: 'stale',
      reasons: [{ kind: 'file-changed', sourceId, path: 'src/example.ts' }],
    })
  })

  it('degrades unavailable sources and persists detected stale cards only on explicit write', async () => {
    const { project } = await alignedProject()
    const inspector = new KnowledgeProjectInspector(
      new NodeSourceInventoryBackend(),
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      () => '2026-08-24T12:00:00.000Z',
    )
    await writeFile(join(project, 'src', 'example.ts'), 'export const changed = true\n')
    const preview = await inspector.inspect(project)
    expect(preview.staleCardCount).toBe(1)
    expect((await readJson(join(project, '.dsh', 'knowledge', 'cards', `${cardId}.json`)))['status']).toBe('verified')

    const written = await inspector.markStale(project)
    expect(written.updatedCardIds).toEqual([cardId])
    const card = await readJson(join(project, '.dsh', 'knowledge', 'cards', `${cardId}.json`))
    expect(card).toMatchObject({ status: 'stale', revision: 2, updatedAt: '2026-08-24T12:00:00.000Z' })
    const canonical = await readCanonicalStore(project)
    expect(detectKnowledgeCardFreshness(canonical.cards, written.status.sources)[0]!.state).toBe('stale')
  })
})
