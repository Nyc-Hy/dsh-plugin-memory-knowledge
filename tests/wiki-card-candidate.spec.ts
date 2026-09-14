import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryKnowledgeEngine } from '../src/engine.js'
import { NodeSourceInventoryBackend } from '../src/inventory.js'
import { DEFAULT_SOURCE_INVENTORY_CONFIG, KnowledgeProjectInspector } from '../src/inventory-provider.js'
import { planWikiCardCandidates } from '../src/wiki-card-candidate.js'
import { createWikiCitationId, createWikiClaimId, createWikiPageId, KnowledgeSourceId, WikiRunId } from '../src/ids.js'
import type { CanonicalStore } from '../src/canonical.js'
import type { ProjectKnowledgeStatus } from '../src/inventory.js'
import type { WikiProjectCatalog } from '../src/wiki-catalog.js'
import type { WikiRunSnapshot } from '../src/wiki-model.js'
import { startWikiTask, succeedWikiPageTask, succeedWikiTask, succeedWikiVerificationTask } from '../src/wiki-task.js'
import { fileContentHash, initializeGitProject, makeTempProject } from './helpers.js'

const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
const runId = WikiRunId('wrun_11111111-1111-4111-8111-111111111111')
const pageId = createWikiPageId()
const claimId = createWikiClaimId()
const citationId = createWikiCitationId()
const commit = 'a'.repeat(40)
const contentHash = `sha256:${'b'.repeat(64)}`
const inventoryHash = `sha256:${'c'.repeat(64)}`

function snapshot(overrides: Partial<WikiRunSnapshot> = {}): WikiRunSnapshot {
  return {
    schemaVersion: 8,
    run: { id: runId, status: 'complete' },
    coverage: [{
      id: 'wcov_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
      runId,
      sourceId,
      path: 'src/app.unknown',
      byteSize: 12,
      revision: { kind: 'git-object', commit, objectId: 'd'.repeat(40) },
      area: 'src',
      shardKey: 'shard-src',
      status: 'analyzed',
      attemptCount: 1,
      analyzedContentHash: contentHash,
      analyzedAt: '2026-09-07T00:00:00.000Z',
    }],
    tasks: [],
    citations: [{
      id: citationId,
      runId,
      role: 'supports',
      provenance: { kind: 'git-file', sourceId, commit, path: 'src/app.unknown', contentHash, startLine: 1, endLine: 1 },
    }],
    claims: [{
      id: claimId,
      runId,
      kind: 'assertion',
      status: 'verified',
      statement: '应用入口注册了项目服务。',
      citationIds: [citationId],
      coverageIds: ['wcov_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never],
      sourceClaimIds: [],
    }],
    conflicts: [],
    pages: [{ id: pageId, runId, slug: 'app', title: '应用入口', status: 'verified', claimIds: [claimId], childPageIds: [] }],
    snapshotHash: `sha256:${'e'.repeat(64)}`,
    ...overrides,
  } as unknown as WikiRunSnapshot
}

function store(cards: CanonicalStore['cards'] = []): CanonicalStore {
  return {
    projectRoot: '/workspace/project',
    knowledgeRoot: '/workspace/project/.dsh/knowledge',
    manifest: {
      schemaVersion: 1,
      spaceId: 'ks_11111111-1111-4111-8111-111111111111' as never,
      sources: [{ id: sourceId, kind: 'git', relativeRoot: '.' }],
      projection: { generator: 'test', version: '1' },
    },
    memories: [],
    cards,
  }
}

function status(): ProjectKnowledgeStatus {
  return {
    sources: [{
      version: 3,
      sourceId,
      state: 'ready',
      commit,
      branch: 'main',
      dirty: false,
      reuseKey: 'reuse',
      scanMode: 'full',
      reusedFileCount: 0,
      readFileCount: 1,
      inventoryHash,
      fileCount: 1,
      totalBytes: 12,
      files: [],
      issues: [],
    }],
    cards: [],
    staleCardCount: 0,
    degradedCardCount: 0,
  }
}

describe('Wiki Page Knowledge Card candidates', () => {
  it('keeps verified Git-backed claims auditable and idempotent', () => {
    const first = planWikiCardCandidates(snapshot(), store(), status())
    const second = planWikiCardCandidates(snapshot(), store(), status())
    expect(first.skipped).toEqual([])
    expect(first.inputs).toHaveLength(1)
    expect(second.inputs[0]!.generation.key).toBe(first.inputs[0]!.generation.key)
    expect(first.inputs[0]).toMatchObject({
      suggestedBy: 'wiki',
      generation: { generator: 'wiki-page', inputHash: snapshot().snapshotHash },
      card: {
        targetCardId: expect.stringMatching(/^card_/u),
        kind: 'module',
        evidenceClass: 'ai-suggested',
        sourceRevisions: [{ sourceId, commit, inventoryHash }],
      },
    })
    expect(first.inputs[0]!.card.sections[0]!.provenance).toEqual([
      expect.objectContaining({ kind: 'git-file', path: 'src/app.unknown', startLine: 1, endLine: 1 }),
    ])
  })

  it('updates the same card when a later run keeps the source and page slug', () => {
    const first = planWikiCardCandidates(snapshot(), store(), status()).inputs[0]!
    const targetCardId = first.card.targetCardId!
    const current: CanonicalStore['cards'][number] = {
      schemaVersion: 1,
      id: targetCardId,
      revision: 1,
      scope: first.card.scope,
      kind: first.card.kind,
      title: first.title,
      summary: first.card.summary,
      sections: first.card.sections,
      provenance: first.card.provenance,
      sourceRevisions: first.card.sourceRevisions,
      status: 'verified',
      evidenceClass: first.card.evidenceClass,
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z',
    }
    const original = snapshot()
    const laterRunId = WikiRunId('wrun_22222222-2222-4222-8222-222222222222')
    const later = snapshot({
      run: { ...original.run, id: laterRunId },
      coverage: original.coverage.map(value => ({ ...value, runId: laterRunId })),
      citations: original.citations.map(value => ({ ...value, runId: laterRunId })),
      claims: original.claims.map(value => ({ ...value, runId: laterRunId })),
      pages: original.pages.map(value => ({ ...value, id: createWikiPageId(), runId: laterRunId })),
      snapshotHash: `sha256:${'f'.repeat(64)}`,
    })

    const planned = planWikiCardCandidates(later, store([current]), status()).inputs[0]!
    expect(planned.card).toMatchObject({ targetCardId, baseRevision: 1 })
  })

  it('does not promote uncertain, non-Git, or cross-source evidence into one card', () => {
    const uncertain = snapshot({ claims: [{ ...snapshot().claims[0]!, status: 'uncertain' }] })
    expect(planWikiCardCandidates(uncertain, store(), status()).skipped).toMatchObject([
      { pageId, kind: 'wiki-page-unsupported-evidence' },
    ])
    const changed = status()
    changed.sources[0]!.commit = 'f'.repeat(40)
    expect(planWikiCardCandidates(snapshot(), store(), changed).skipped).toMatchObject([
      { pageId, kind: 'wiki-source-changed' },
    ])
  })

  it('uses a complete current Catalog without requiring a full source inventory', () => {
    const value = snapshot({ run: { ...snapshot().run, catalogHash: `sha256:${'7'.repeat(64)}` } })
    const catalog: WikiProjectCatalog = {
      version: 1,
      projectRoot: '/workspace/project',
      state: 'complete',
      catalogHash: value.run.catalogHash,
      omittedItemCount: 0,
      entryCount: 1,
      totalBytes: 12,
      excludedEntryCount: 0,
      blockedEntryCount: 0,
      sources: [{ sourceId, commit, entryCount: 1, totalBytes: 12, complete: true }],
      entries: [],
      issues: [],
    }

    const planned = planWikiCardCandidates(value, store(), catalog)
    expect(planned.skipped).toEqual([])
    expect(planned.inputs[0]).toMatchObject({
      generation: { generator: 'wiki-page', catalogHash: catalog.catalogHash },
      card: { sourceRevisions: [{ sourceId, commit, catalogHash: catalog.catalogHash }] },
    })
  })

  it('feeds a completed Git Wiki run into the existing review and promotion flow', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), {
      ...DEFAULT_SOURCE_INVENTORY_CONFIG,
      maxTotalBytes: 1,
    })
    const engine = await MemoryKnowledgeEngine.open({ path: ':memory:', journalMode: 'wal' }, inspector)
    try {
      const planned = await engine.planWikiProject(project)
      const analysis = planned.run.tasks.find(task => task.kind === 'analysis')!
      const coverage = planned.run.coverage.find(item => analysis.coverageIds.includes(item.id))!
      const source = planned.catalog.sources.find(value => value.sourceId === coverage.sourceId)!
      const entry = planned.catalog.entries.find(value => value.sourceId === coverage.sourceId && value.path === coverage.path)!
      const contentHash = await fileContentHash(`${project}/${coverage.path}`)
      const citationId = createWikiCitationId()
      const claimId = createWikiClaimId()
      const analyzed = succeedWikiTask(startWikiTask(
        planned.run,
        analysis.id,
        SessionId('session-wiki-card-analysis'),
        '2026-09-07T00:01:00.000Z',
      ), analysis.id, {
        coverage: [{ coverageId: coverage.id, status: 'analyzed', contentHash }],
        citations: [{
          id: citationId,
          runId: planned.run.run.id,
          role: 'supports',
          provenance: {
            kind: 'git-file',
            sourceId: coverage.sourceId,
            commit: source.commit!,
            path: coverage.path,
            contentHash,
            startLine: 1,
            endLine: 4,
          },
        }],
        claims: [{
          id: claimId,
          runId: planned.run.run.id,
          kind: 'assertion',
          status: 'proposed',
          statement: '项目入口导出 greeting 函数。',
          citationIds: [citationId],
          coverageIds: [coverage.id],
          sourceClaimIds: [],
        }],
      }, '2026-09-07T00:02:00.000Z')
      await engine.saveWikiRunSnapshot(analyzed, planned.run.snapshotHash)
      const verification = analyzed.tasks.find(task => task.kind === 'verification')!
      const verified = succeedWikiVerificationTask(startWikiTask(
        analyzed,
        verification.id,
        SessionId('session-wiki-card-verification'),
        '2026-09-07T00:03:00.000Z',
      ), verification.id, { decisions: [{ claimId, status: 'verified' }], citations: [], conflicts: [] }, '2026-09-07T00:04:00.000Z')
      await engine.saveWikiRunSnapshot(verified, analyzed.snapshotHash)
      const pageTask = verified.tasks.find(task => task.kind === 'page')!
      const completed = succeedWikiPageTask(startWikiTask(
        verified,
        pageTask.id,
        SessionId('session-wiki-card-page'),
        '2026-09-07T00:05:00.000Z',
      ), pageTask.id, { pages: [{ slug: 'entry', title: '项目入口', claimIds: [claimId], childSlugs: [] }] }, '2026-09-07T00:06:00.000Z')
      await engine.saveWikiRunSnapshot(completed, verified.snapshotHash)

      const generated = await engine.generateKnowledgeCardCandidates(project)
      const candidate = generated.candidates.find(value => value.suggestedBy === 'wiki')
      expect(candidate).toMatchObject({
        target: 'knowledge-card',
        generation: { generator: 'wiki-page', sourceId: coverage.sourceId, catalogHash: planned.run.run.catalogHash },
        title: '项目入口',
        card: {
          targetCardId: expect.stringMatching(/^card_/u),
          sections: [{ content: '项目入口导出 greeting 函数。' }],
        },
      })
      expect(entry).toBeDefined()
      const accepted = await engine.reviewCandidate(candidate!.id, 'accept', candidate!.revision)
      const promoted = await engine.promoteCandidate(accepted.id, project, accepted.revision)
      expect(promoted.recordType).toBe('knowledge-card')
      if (promoted.recordType === 'knowledge-card') {
        expect(promoted.card.evidenceClass).toBe('ai-suggested')
        expect(promoted.card.provenance).toMatchObject([{ kind: 'git-commit', sourceId: coverage.sourceId }])
        expect(promoted.card.sections[0]!.provenance).toMatchObject([{ kind: 'git-file', path: coverage.path }])
        expect(promoted.card.sourceRevisions).toMatchObject([{ catalogHash: planned.run.run.catalogHash }])
      }
    } finally {
      await engine.close()
    }
  })
})
