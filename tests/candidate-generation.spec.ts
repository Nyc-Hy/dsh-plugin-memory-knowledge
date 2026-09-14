import { describe, expect, it } from 'vitest'
import {
  planKnowledgeCardCandidates,
  SOURCE_INVENTORY_CANDIDATE_VERSION,
} from '../src/candidate-generation.js'
import type { CanonicalStore } from '../src/canonical.js'
import type { ProjectKnowledgeStatus, SourceInventory } from '../src/inventory.js'
import type { KnowledgeCard, KnowledgeManifest } from '../src/model.js'
import { buildSourceUnderstanding } from '../src/source-records.js'

const sourceId = 'src_22222222-2222-4222-8222-222222222222' as never
const commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const manifest: KnowledgeManifest = {
  schemaVersion: 1,
  spaceId: 'ks_11111111-1111-4111-8111-111111111111' as never,
  sources: [{ id: sourceId, kind: 'git', relativeRoot: '.' }],
  projection: { generator: 'test', version: '1' },
}

function store(cards: readonly KnowledgeCard[] = []): CanonicalStore {
  return {
    projectRoot: '/portable-test-root',
    knowledgeRoot: '/portable-test-root/.dsh/knowledge',
    manifest,
    memories: [],
    cards,
  }
}

function inventory(overrides: Partial<SourceInventory> = {}): SourceInventory {
  return {
    version: 3,
    sourceId,
    state: 'ready',
    commit,
    branch: 'main',
    dirty: false,
    reuseKey: 'sha256:reuse',
    scanMode: 'full',
    reusedFileCount: 0,
    readFileCount: 3,
    inventoryHash: 'sha256:inventory',
    fileCount: 3,
    totalBytes: 60,
    files: [
      {
        path: 'src/b.ts', size: 20, contentHash: 'sha256:b', language: 'TypeScript',
        analysis: {
          provider: 'deterministic-source-evidence', version: 3, omittedEvidenceCount: 0,
          moduleReferences: [{ kind: 'import', specifier: './a.js', startLine: 1, endLine: 1 }],
          omittedModuleReferenceCount: 0,
          evidence: [{ kind: 'code-symbol', name: 'run', declaration: 'function', exported: true, startLine: 4, endLine: 4 }],
        },
      },
      {
        path: 'README.md', size: 10, contentHash: 'sha256:r', language: 'Markdown',
        analysis: {
          provider: 'deterministic-source-evidence', version: 3, omittedEvidenceCount: 0,
          moduleReferences: [], omittedModuleReferenceCount: 0,
          evidence: [{ kind: 'document-heading', name: 'Project', level: 1, startLine: 1, endLine: 1 }],
        },
      },
      { path: 'src/a.ts', size: 30, contentHash: 'sha256:a', language: 'TypeScript' },
    ],
    issues: [],
    ...overrides,
  }
}

function status(value: SourceInventory): ProjectKnowledgeStatus {
  return { sources: [value], cards: [], staleCardCount: 0, degradedCardCount: 0 }
}

const config = { maxSources: 4, maxLanguages: 3, maxAreas: 3, maxEvidencePerArea: 3 }

describe('deterministic Knowledge Card candidate planning', () => {
  it('builds the same portable overview candidate regardless of inventory file order', () => {
    const first = planKnowledgeCardCandidates(store(), status(inventory()), config)
    const reordered = inventory({ files: [...inventory().files].reverse() })
    const second = planKnowledgeCardCandidates(store(), status(reordered), config)

    expect(second).toEqual(first)
    expect(first.inputs).toHaveLength(1)
    expect(first.inputs[0]).toMatchObject({
      target: 'knowledge-card',
      applicability: 'project',
      kind: 'overview',
      suggestedBy: 'inventory',
      generation: {
        generator: 'source-inventory',
        version: SOURCE_INVENTORY_CANDIDATE_VERSION,
        sourceId,
        inventoryHash: 'sha256:inventory',
      },
      card: {
        scope: { kind: 'source', sourceId },
        evidenceClass: 'deterministic',
        sourceRevisions: [{ sourceId, kind: 'git', commit }],
      },
    })
    expect(first.inputs[0]!.content).toContain('TypeScript：2 个文件，50 字节')
    expect(JSON.stringify({ generation: first.inputs[0]!.generation, card: first.inputs[0]!.card }))
      .not.toContain('/portable-test-root')
  })

  it('skips dirty and degraded sources instead of producing non-portable candidates', () => {
    expect(planKnowledgeCardCandidates(store(), status(inventory({ dirty: true })), config))
      .toMatchObject({ inputs: [], skipped: [{ sourceId, kind: 'source-dirty' }] })
    expect(planKnowledgeCardCandidates(store(), status(inventory({ state: 'degraded' })), config))
      .toMatchObject({ inputs: [], skipped: [{ sourceId, kind: 'source-degraded' }] })
  })

  it('builds a stable architecture candidate from the matching Source record checkpoint', () => {
    const firstInventory = inventory()
    const firstUnderstanding = buildSourceUnderstanding(firstInventory, { maxRepresentativeFilesPerArea: 2 })
    const first = planKnowledgeCardCandidates(store(), status(firstInventory), config, [firstUnderstanding])
    const reorderedInventory = inventory({ files: [...inventory().files].reverse() })
    const reorderedUnderstanding = buildSourceUnderstanding(reorderedInventory, { maxRepresentativeFilesPerArea: 2 })
    const second = planKnowledgeCardCandidates(store(), status(reorderedInventory), config, [reorderedUnderstanding])

    expect(second).toEqual(first)
    expect(first.inputs.map(input => input.kind)).toEqual(['overview', 'architecture', 'module'])
    const architecture = first.inputs.find(input => input.kind === 'architecture')!
    expect(architecture).toMatchObject({
      target: 'knowledge-card',
      suggestedBy: 'inventory',
      generation: {
        generator: 'source-record-map',
        sourceId,
        inventoryHash: 'sha256:inventory',
        inputHash: firstUnderstanding.outputHash,
      },
      card: {
        kind: 'architecture',
        evidenceClass: 'deterministic',
        sourceRevisions: [{ sourceId, kind: 'git', commit, inventoryHash: 'sha256:inventory' }],
      },
    })
    expect(architecture.content).toContain('不推断模块职责')
    expect(architecture.content).toContain('代表文件：')
    expect(architecture.content).toContain('静态模块引用：1 条')
    expect(architecture.content).toContain('src/b.ts:1 → src/a.ts（import）')
    expect(architecture.card.sections).toEqual(expect.arrayContaining([expect.objectContaining({
      title: 'src',
      provenance: expect.arrayContaining([expect.objectContaining({
        kind: 'git-file', path: 'src/b.ts', startLine: 1, endLine: 1, contentHash: 'sha256:b',
      })]),
    })]))
    expect(JSON.stringify({ generation: architecture.generation, card: architecture.card }))
      .not.toContain('/portable-test-root')

    const module = first.inputs.find(input => input.kind === 'module')!
    expect(module).toMatchObject({
      generation: { generator: 'source-evidence-map', inputHash: firstUnderstanding.outputHash },
      card: {
        kind: 'module',
        evidenceClass: 'deterministic',
        sections: expect.arrayContaining([expect.objectContaining({
          provenance: expect.arrayContaining([expect.objectContaining({
            kind: 'git-file', path: 'src/b.ts', startLine: 4, endLine: 4, contentHash: 'sha256:b',
          })]),
        })]),
      },
    })
    expect(module.content).toContain('代码符号 函数「run」，模块导出 — src/b.ts:4')
    expect(module.content).toContain('不证明模块职责')
  })

  it('does not regenerate an already-current verified overview card', () => {
    const card: KnowledgeCard = {
      schemaVersion: 1,
      id: 'card_44444444-4444-4444-8444-444444444444' as never,
      revision: 2,
      scope: { kind: 'source', sourceId },
      kind: 'overview',
      title: '项目源码清单概览',
      summary: 'current',
      sections: [{ id: 'source-state', title: '来源状态', content: 'current', provenance: [{ kind: 'git-commit', sourceId, commit }] }],
      provenance: [{ kind: 'git-commit', sourceId, commit }],
      sourceRevisions: [{ sourceId, kind: 'git', commit }],
      status: 'verified',
      evidenceClass: 'deterministic',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    expect(planKnowledgeCardCandidates(store([card]), status(inventory()), config))
      .toMatchObject({ inputs: [], skipped: [{ sourceId, kind: 'already-current' }] })
  })
})
