import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KnowledgeSelectionRevisionConflictError,
  KnowledgeHumanRevisionRequestConflictError,
  MemoryKnowledgeDatabase,
} from '../src/database.js'
import {
  createKnowledgeEffectiveVersion,
  createKnowledgeGeneratedVersion,
  selectKnowledgeRun,
} from '../src/knowledge-version.js'
import {
  createKnowledgeHumanRevisionRequestId,
  createWikiCitationId,
  createWikiClaimId,
  KnowledgeSourceId,
} from '../src/ids.js'
import {
  assessWikiCompletion,
  createPlannedWikiRun,
  finalizeWikiRunSnapshot,
  type WikiCompletionCheckId,
  type WikiCompletionReport,
  type WikiRunSnapshot,
} from '../src/wiki-model.js'
import { startWikiTask, succeedWikiPageTask, succeedWikiTask, succeedWikiVerificationTask } from '../src/wiki-task.js'
import { makeTempDirectory } from './helpers.js'

const timestamp = '2026-09-10T00:00:00.000Z'
const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
const contentHash = `sha256:${'1'.repeat(64)}`
const completionCheckIds: WikiCompletionCheckId[] = [
  'catalog',
  'coverage',
  'analysis',
  'file-synthesis',
  'verification',
  'consistency',
  'pages',
  'material-exposure',
  'business-questions',
  'cross-module-flows',
]
const databases: MemoryKnowledgeDatabase[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.close()))
})

function withoutSnapshotHash(snapshot: WikiRunSnapshot): Omit<WikiRunSnapshot, 'snapshotHash'> {
  const payload = structuredClone(snapshot) as Partial<WikiRunSnapshot>
  delete payload.snapshotHash
  return payload as Omit<WikiRunSnapshot, 'snapshotHash'>
}

function passingCompletion(): WikiCompletionReport {
  return {
    eligibleForActivation: true,
    checks: completionCheckIds.map(id => ({ id, state: 'pass', issueCount: 0 })),
  }
}

function completeWikiSnapshot(projectRoot: string): WikiRunSnapshot {
  let current = createPlannedWikiRun({
    projectRoot,
    catalogHash: contentHash,
    catalogComplete: true,
    catalogOmittedItemCount: 0,
    entries: [{
      sourceId,
      path: 'README.md',
      byteSize: 42,
      revision: { kind: 'content-hash', contentHash },
    }],
    now: timestamp,
  })
  const analysisTask = current.tasks[0]!
  const citationId = createWikiCitationId()
  const claimId = createWikiClaimId()
  current = succeedWikiTask(startWikiTask(
    current,
    analysisTask.id,
    SessionId(`session-${analysisTask.id}`),
    '2026-09-10T00:01:00.000Z',
  ), analysisTask.id, {
    coverage: [{ coverageId: current.coverage[0]!.id, status: 'analyzed', contentHash }],
    citations: [{
      id: citationId,
      runId: current.run.id,
      role: 'supports',
      provenance: { kind: 'document', sourceId, path: 'README.md', contentHash },
    }],
    claims: [{
      id: claimId,
      runId: current.run.id,
      kind: 'assertion',
      status: 'proposed',
      statement: 'README 明确描述项目入口。',
      citationIds: [citationId],
      coverageIds: [current.coverage[0]!.id],
      sourceClaimIds: [],
    }],
  }, '2026-09-10T00:02:00.000Z')
  const verificationTask = current.tasks.find(task => task.kind === 'verification')!
  current = succeedWikiVerificationTask(startWikiTask(
    current,
    verificationTask.id,
    SessionId(`session-${verificationTask.id}`),
    '2026-09-10T00:03:00.000Z',
  ), verificationTask.id, {
    decisions: [{ claimId, status: 'verified' }],
    citations: [],
    conflicts: [],
  }, '2026-09-10T00:04:00.000Z')
  const pageTask = current.tasks.find(task => task.kind === 'page')!
  current = succeedWikiPageTask(startWikiTask(
    current,
    pageTask.id,
    SessionId(`session-${pageTask.id}`),
    '2026-09-10T00:05:00.000Z',
  ), pageTask.id, {
    pages: [{ slug: 'overview', title: '项目概览', claimIds: [claimId], childSlugs: [] }],
  }, '2026-09-10T00:06:00.000Z')
  return finalizeWikiRunSnapshot({
    ...withoutSnapshotHash(current),
    run: {
      ...current.run,
      status: 'complete',
      updatedAt: '2026-09-10T00:07:00.000Z',
      completedAt: '2026-09-10T00:07:00.000Z',
    },
  })
}

async function memoryDatabase(path = ':memory:'): Promise<MemoryKnowledgeDatabase> {
  const database = await MemoryKnowledgeDatabase.open(path, path === ':memory:' ? 'wal' : 'delete')
  databases.push(database)
  return database
}

describe('project knowledge versions', () => {
  it('keeps run selection generations explicit and idempotent', () => {
    const first = completeWikiSnapshot('/workspace/project-a')
    const second = completeWikiSnapshot('/workspace/project-a')
    const selected = selectKnowledgeRun(first.run.projectRoot, first.run.id, undefined, timestamp)
    const unchanged = selectKnowledgeRun(first.run.projectRoot, first.run.id, selected, '2026-09-10T00:08:00.000Z')
    const advanced = selectKnowledgeRun(second.run.projectRoot, second.run.id, selected, '2026-09-10T00:09:00.000Z')

    expect(unchanged).toEqual(selected)
    expect(advanced).toMatchObject({ revision: 2, analysisGeneration: 2, currentRunId: second.run.id })
  })

  it('rejects a planned run selected from an obsolete project revision', async () => {
    const database = await memoryDatabase()
    const first = completeWikiSnapshot('/workspace/project-selection-race')
    const second = completeWikiSnapshot('/workspace/project-selection-race')
    await database.saveWikiRunSnapshot(first)
    await database.saveWikiRunSnapshot(second)

    const selected = await database.selectKnowledgeRun(
      first.run.projectRoot,
      first.run.id,
      timestamp,
      { expectedRevision: undefined },
    )
    await expect(database.selectKnowledgeRun(
      second.run.projectRoot,
      second.run.id,
      '2026-09-10T00:08:00.000Z',
      { expectedRevision: undefined },
    )).rejects.toBeInstanceOf(KnowledgeSelectionRevisionConflictError)

    const advanced = await database.selectKnowledgeRun(
      second.run.projectRoot,
      second.run.id,
      '2026-09-10T00:09:00.000Z',
      { expectedRevision: selected.revision },
    )
    expect(advanced).toMatchObject({
      revision: 2,
      analysisGeneration: 2,
      currentRunId: second.run.id,
    })
  })

  it('refuses to seal the current incomplete Host completion contract', () => {
    const snapshot = completeWikiSnapshot('/workspace/project-refusal')
    const report = assessWikiCompletion(snapshot.run)

    expect(report.eligibleForActivation).toBe(false)
    expect(() => createKnowledgeGeneratedVersion(snapshot, report, timestamp))
      .toThrow('generated knowledge version requires a passing completion report')
  })

  it('atomically activates one immutable generated/effective pair and retries idempotently', async () => {
    const database = await memoryDatabase()
    const snapshot = completeWikiSnapshot('/workspace/project-active')
    await database.saveWikiRunSnapshot(snapshot)
    const selected = await database.selectKnowledgeRun(snapshot.run.projectRoot, snapshot.run.id, timestamp)
    const generatedVersion = createKnowledgeGeneratedVersion(snapshot, passingCompletion(), timestamp)
    const effectiveVersion = createKnowledgeEffectiveVersion(generatedVersion, timestamp)

    expect(await database.searchEffectiveKnowledge({
      query: '项目入口',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toEqual([])

    const activated = await database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion,
      expectedSelectionRevision: selected.revision,
    })
    const retried = await database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion,
      expectedSelectionRevision: selected.revision,
    })

    expect(activated.selection).toMatchObject({
      revision: selected.revision + 1,
      currentRunId: snapshot.run.id,
      effectiveVersionId: activated.effectiveVersion.id,
    })
    expect(retried).toEqual(activated)
    expect(await database.getKnowledgeVersionState(snapshot.run.projectRoot)).toEqual(activated)
    expect(await database.searchEffectiveKnowledge({
      query: '项目入口',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toMatchObject([{
      title: '项目概览',
      content: expect.stringContaining('README 明确描述项目入口。'),
      generatedVersionId: generatedVersion.id,
      effectiveVersionId: activated.effectiveVersion.id,
      humanRevisionIds: [],
      sources: [{ provenance: { kind: 'document', path: 'README.md' } }],
    }])
    expect(await database.search({
      query: '项目入口',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toEqual([])

    const changed = finalizeWikiRunSnapshot({
      ...withoutSnapshotHash(snapshot),
      run: { ...snapshot.run, updatedAt: '2026-09-10T00:10:00.000Z' },
    })
    await expect(database.saveWikiRunSnapshot(changed))
      .rejects.toThrow('generated knowledge version makes its Wiki run snapshot immutable')
  })

  it('layers idempotent human revisions without rewriting the generated Wiki snapshot', async () => {
    const database = await memoryDatabase()
    const snapshot = completeWikiSnapshot('/workspace/project-human-revision')
    await database.saveWikiRunSnapshot(snapshot)
    const selected = await database.selectKnowledgeRun(snapshot.run.projectRoot, snapshot.run.id, timestamp)
    const generatedVersion = createKnowledgeGeneratedVersion(snapshot, passingCompletion(), timestamp)
    const activated = await database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion: createKnowledgeEffectiveVersion(generatedVersion, timestamp),
      expectedSelectionRevision: selected.revision,
    })
    const page = snapshot.pages.find(candidate => candidate.claimIds.length > 0)!
    const request = {
      requestId: createKnowledgeHumanRevisionRequestId(),
      projectRoot: snapshot.run.projectRoot,
      expectedSelectionRevision: activated.selection.revision,
      baseEffectiveVersionId: activated.effectiveVersion.id,
      pageId: page.id,
      kind: 'replace-page-body' as const,
      title: '人工项目概览',
      content: '操作者补充的项目入口说明。',
    }

    const revised = await database.applyKnowledgeHumanRevision(request, '2026-09-10T00:08:00.000Z')
    const retried = await database.applyKnowledgeHumanRevision(request, '2026-09-10T00:09:00.000Z')

    expect(retried).toEqual(revised)
    expect(revised.revision).toMatchObject({
      revision: 1,
      generatedVersionId: generatedVersion.id,
      baseEffectiveVersionId: activated.effectiveVersion.id,
      effectiveVersionId: revised.effectiveVersion.id,
      pageId: page.id,
      kind: 'replace-page-body',
      affectedClaimIds: page.claimIds,
    })
    expect(revised.effectiveVersion.humanRevisionIds).toEqual([revised.revision.id])
    expect(revised.selection).toMatchObject({
      revision: activated.selection.revision + 1,
      mode: 'fixed',
      effectiveVersionId: revised.effectiveVersion.id,
    })
    expect(await database.getWikiRunSnapshot(snapshot.run.id)).toEqual(snapshot)
    expect((await database.getKnowledgeVersionState(snapshot.run.projectRoot)).generatedVersion)
      .toEqual(generatedVersion)
    expect(await database.listKnowledgeHumanRevisions(snapshot.run.projectRoot, 20))
      .toEqual([revised.revision])
    expect(await database.searchEffectiveKnowledge({
      query: 'README 明确描述',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toEqual([])
    expect(await database.searchEffectiveKnowledge({
      query: '操作者补充',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toMatchObject([{
      title: '人工项目概览',
      content: expect.stringContaining('操作者补充的项目入口说明。'),
      effectiveVersionId: revised.effectiveVersion.id,
      humanRevisionIds: [revised.revision.id],
      bodyRevisionId: revised.revision.id,
      noteRevisionIds: [],
      sources: [],
    }])
  })

  it('rejects stale edits and idempotency keys reused with different content', async () => {
    const database = await memoryDatabase()
    const snapshot = completeWikiSnapshot('/workspace/project-human-conflict')
    await database.saveWikiRunSnapshot(snapshot)
    const selected = await database.selectKnowledgeRun(snapshot.run.projectRoot, snapshot.run.id, timestamp)
    const generatedVersion = createKnowledgeGeneratedVersion(snapshot, passingCompletion(), timestamp)
    const activated = await database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion: createKnowledgeEffectiveVersion(generatedVersion, timestamp),
      expectedSelectionRevision: selected.revision,
    })
    const page = snapshot.pages.find(candidate => candidate.claimIds.length > 0)!
    const request = {
      requestId: createKnowledgeHumanRevisionRequestId(),
      projectRoot: snapshot.run.projectRoot,
      expectedSelectionRevision: activated.selection.revision,
      baseEffectiveVersionId: activated.effectiveVersion.id,
      pageId: page.id,
      kind: 'append-page-note' as const,
      content: '第一条人工说明。',
    }
    const appended = await database.applyKnowledgeHumanRevision(request, '2026-09-10T00:08:00.000Z')
    expect(await database.searchEffectiveKnowledge({
      query: 'README 明确',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toMatchObject([{ content: expect.stringContaining('README 明确描述项目入口。') }])
    expect(await database.searchEffectiveKnowledge({
      query: '第一条人工说明',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toMatchObject([{
      effectiveVersionId: appended.effectiveVersion.id,
      humanRevisionIds: [appended.revision.id],
      noteRevisionIds: [appended.revision.id],
      content: expect.stringContaining('第一条人工说明。'),
      sources: [{ provenance: { kind: 'document', path: 'README.md' } }],
    }])

    await expect(database.applyKnowledgeHumanRevision({
      ...request,
      content: '复用请求 id 的不同说明。',
    }, '2026-09-10T00:09:00.000Z')).rejects.toBeInstanceOf(KnowledgeHumanRevisionRequestConflictError)
    await expect(database.applyKnowledgeHumanRevision({
      ...request,
      requestId: createKnowledgeHumanRevisionRequestId(),
    }, '2026-09-10T00:10:00.000Z')).rejects.toBeInstanceOf(KnowledgeSelectionRevisionConflictError)
  })

  it('migrates v22 effective versions to an empty human-revision chain', async () => {
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const database = await MemoryKnowledgeDatabase.open(databasePath, 'delete')
    const snapshot = completeWikiSnapshot('/workspace/project-v22-migration')
    await database.saveWikiRunSnapshot(snapshot)
    const selected = await database.selectKnowledgeRun(snapshot.run.projectRoot, snapshot.run.id, timestamp)
    const generatedVersion = createKnowledgeGeneratedVersion(snapshot, passingCompletion(), timestamp)
    const activated = await database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion: createKnowledgeEffectiveVersion(generatedVersion, timestamp),
      expectedSelectionRevision: selected.revision,
    })
    await database.close()

    const legacy = new DatabaseSync(databasePath)
    const row = legacy.prepare('SELECT payload_json FROM knowledge_effective_versions WHERE id = ?')
      .get(activated.effectiveVersion.id) as { payload_json: string }
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    delete payload['humanRevisionIds']
    legacy.prepare('UPDATE knowledge_effective_versions SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(payload), activated.effectiveVersion.id)
    legacy.exec('DROP INDEX knowledge_effective_versions_project_created')
    legacy.exec('DROP INDEX knowledge_effective_versions_generated')
    legacy.exec('ALTER TABLE knowledge_effective_versions RENAME TO knowledge_effective_versions_v23')
    legacy.exec(`
      CREATE TABLE knowledge_effective_versions (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        generated_version_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT
    `)
    legacy.exec(`
      INSERT INTO knowledge_effective_versions
      SELECT * FROM knowledge_effective_versions_v23
    `)
    legacy.exec('DROP TABLE knowledge_effective_versions_v23')
    legacy.exec('CREATE INDEX knowledge_effective_versions_project_created ON knowledge_effective_versions(project_root, created_at DESC)')
    legacy.exec('DROP TABLE knowledge_human_revisions')
    legacy.exec('PRAGMA user_version = 22')
    legacy.close()

    const upgraded = await memoryDatabase(databasePath)
    const state = await upgraded.getKnowledgeVersionState(snapshot.run.projectRoot)
    expect(state.effectiveVersion?.humanRevisionIds).toEqual([])
    expect(await upgraded.searchEffectiveKnowledge({
      query: '项目入口',
      projectRoot: snapshot.run.projectRoot,
      limit: 5,
      maxChars: 2_000,
    })).toMatchObject([{ effectiveVersionId: state.effectiveVersion?.id }])
    const page = snapshot.pages.find(candidate => candidate.claimIds.length > 0)!
    await upgraded.applyKnowledgeHumanRevision({
      requestId: createKnowledgeHumanRevisionRequestId(),
      projectRoot: snapshot.run.projectRoot,
      expectedSelectionRevision: state.selection!.revision,
      baseEffectiveVersionId: state.effectiveVersion!.id,
      pageId: page.id,
      kind: 'append-page-note',
      content: '迁移后新增的人工说明。',
    })
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 25 })
    expect(migrated.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_effective_versions WHERE generated_version_id = ?
    `).get(generatedVersion.id)).toEqual({ count: 2 })
    migrated.close()
  })

  it('rejects activation prepared against an obsolete selection revision', async () => {
    const database = await memoryDatabase()
    const first = completeWikiSnapshot('/workspace/project-race')
    const second = completeWikiSnapshot('/workspace/project-race')
    await database.saveWikiRunSnapshot(first)
    await database.saveWikiRunSnapshot(second)
    const selected = await database.selectKnowledgeRun(first.run.projectRoot, first.run.id, timestamp)
    await database.selectKnowledgeRun(second.run.projectRoot, second.run.id, '2026-09-10T00:08:00.000Z')
    const generatedVersion = createKnowledgeGeneratedVersion(first, passingCompletion(), timestamp)

    await expect(database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion: createKnowledgeEffectiveVersion(generatedVersion, timestamp),
      expectedSelectionRevision: selected.revision,
    })).rejects.toBeInstanceOf(KnowledgeSelectionRevisionConflictError)
    expect((await database.getKnowledgeVersionState(first.run.projectRoot)).effectiveVersion).toBeUndefined()
  })
})
