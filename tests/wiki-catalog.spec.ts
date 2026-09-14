import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCanonicalStore } from '../src/canonical.js'
import { NodeSourceInventoryBackend } from '../src/inventory.js'
import {
  buildWikiProjectCatalog,
  DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
} from '../src/wiki-catalog.js'
import { initializeGitProject, makeTempProject, readJson, writeJson } from './helpers.js'

class NoContentReadBackend extends NodeSourceInventoryBackend {
  readonly readPaths: string[] = []

  override readFile(...parameters: Parameters<NodeSourceInventoryBackend['readFile']>): ReturnType<NodeSourceInventoryBackend['readFile']> {
    this.readPaths.push(parameters[1])
    return super.readFile(...parameters)
  }
}

describe('LLM Wiki project catalog', () => {
  it('catalogs a clean polyglot Git tree without reading tracked file contents', async () => {
    const project = await makeTempProject()
    await mkdir(join(project, 'cmd'), { recursive: true })
    await mkdir(join(project, 'Services'), { recursive: true })
    await mkdir(join(project, 'dist'), { recursive: true })
    await writeFile(join(project, 'cmd', 'main.go'), 'package main\n')
    await writeFile(join(project, 'Services', 'App.cs'), 'public sealed class App {}\n')
    await writeFile(join(project, 'domain.unknown'), 'opaque project material\n')
    await writeFile(join(project, 'dist', 'app.js'), 'generated\n')
    await writeFile(join(project, '.env'), 'TOKEN=excluded\n')
    await initializeGitProject(project)
    const backend = new NoContentReadBackend()
    const store = await readCanonicalStore(project)

    const first = await buildWikiProjectCatalog(backend, store)
    const second = await buildWikiProjectCatalog(backend, store)

    expect(first).toMatchObject({
      state: 'complete',
      omittedItemCount: 0,
      entryCount: expect.any(Number),
      excludedEntryCount: expect.any(Number),
      sources: [{ complete: true }],
      issues: [],
    })
    expect(first.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'cmd/main.go', language: 'Go' }),
      expect.objectContaining({ path: 'Services/App.cs', language: 'C#' }),
      expect.objectContaining({ path: 'domain.unknown' }),
      expect.objectContaining({ path: 'dist/app.js', disposition: expect.objectContaining({ status: 'excluded' }) }),
      expect.objectContaining({ path: '.env', disposition: expect.objectContaining({ status: 'excluded' }) }),
      expect.objectContaining({
        path: '.dsh/knowledge/manifest.json',
        disposition: expect.objectContaining({ status: 'excluded' }),
      }),
    ]))
    expect(first.totalBytes).toBeGreaterThan(0)
    expect(first.catalogHash).toBe(second.catalogHash)
    expect(backend.readPaths).toEqual([])
  })

  it('marks a dirty worktree as an unknown-size blind spot instead of cataloging stale HEAD content as current', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    await writeFile(join(project, 'src', 'example.ts'), 'export const dirty = true\n')
    const catalog = await buildWikiProjectCatalog(
      new NodeSourceInventoryBackend(),
      await readCanonicalStore(project),
    )

    expect(catalog).toMatchObject({
      state: 'incomplete',
      omittedItemCount: null,
      issues: [{ kind: 'dirty-worktree', affectedItemCount: 1 }],
      sources: [{ complete: false }],
    })
  })

  it('counts metadata entries omitted by the configured catalog memory budget', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'README.md'), '# Catalog budget\n')
    await initializeGitProject(project)
    const catalog = await buildWikiProjectCatalog(
      new NodeSourceInventoryBackend(),
      await readCanonicalStore(project),
      { ...DEFAULT_WIKI_PROJECT_CATALOG_CONFIG, maxEntries: 2 },
    )

    expect(catalog.state).toBe('incomplete')
    expect(catalog.entryCount).toBe(2)
    expect(catalog.omittedItemCount).toBeGreaterThan(0)
    expect(catalog.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'entry-budget' })]))
  })

  it('normalizes Git root paths for a Source rooted in a repository subdirectory', async () => {
    const project = await makeTempProject()
    const manifestPath = join(project, '.dsh', 'knowledge', 'manifest.json')
    const manifest = await readJson(manifestPath)
    const sources = manifest['sources'] as Array<Record<string, unknown>>
    sources[0]!['relativeRoot'] = 'app'
    await writeJson(manifestPath, manifest)
    await mkdir(join(project, 'app', 'src'), { recursive: true })
    await writeFile(join(project, 'app', 'src', 'lib.rs'), 'pub fn run() {}\n')
    await initializeGitProject(project)

    const catalog = await buildWikiProjectCatalog(
      new NodeSourceInventoryBackend(),
      await readCanonicalStore(project),
    )

    expect(catalog).toMatchObject({ state: 'complete', omittedItemCount: 0 })
    expect(catalog.entries).toEqual([
      expect.objectContaining({ path: 'src/lib.rs', language: 'Rust' }),
    ])
  })
})
