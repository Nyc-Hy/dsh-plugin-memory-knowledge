import { access, open, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryKnowledgeEngine } from '../src/engine.js'
import { LocalMemoryRevisionConflictError, MemoryCandidateRevisionConflictError } from '../src/database.js'
import { NodeSourceInventoryBackend } from '../src/inventory.js'
import { DEFAULT_SOURCE_INVENTORY_CONFIG, KnowledgeProjectInspector } from '../src/inventory-provider.js'
import { createWikiCitationId, createWikiClaimId, KnowledgeSourceId } from '../src/ids.js'
import type { ProvenanceRef } from '../src/model.js'
import { finalizeWikiRunSnapshot, summarizeWikiCoverage } from '../src/wiki-model.js'
import type { WikiProjectCatalog } from '../src/wiki-catalog.js'
import { startWikiTask, succeedWikiPageTask, succeedWikiTask, succeedWikiVerificationTask } from '../src/wiki-task.js'
import { commitProjectChanges, initializeGitProject, makeTempDirectory, makeTempProject, readJson, writeJson } from './helpers.js'
import { completeSynthesisLayer, synthesisFixture } from './wiki-synthesis-fixture.js'
import { testBusinessQuestionFindings } from './wiki-business-question-fixture.js'

const engines: MemoryKnowledgeEngine[] = []
const sessionProvenance: ProvenanceRef[] = [{
  kind: 'session',
  sessionId: 'session-engine-test' as never,
  eventSeqs: [4],
}]

class CountingSourceInventoryBackend extends NodeSourceInventoryBackend {
  readonly readPaths: string[] = []

  override readFile(...parameters: Parameters<NodeSourceInventoryBackend['readFile']>): ReturnType<NodeSourceInventoryBackend['readFile']> {
    this.readPaths.push(parameters[1])
    return super.readFile(...parameters)
  }
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.close()))
})

async function memoryEngine(): Promise<MemoryKnowledgeEngine> {
  const engine = await MemoryKnowledgeEngine.open({ path: ':memory:', journalMode: 'wal' })
  engines.push(engine)
  return engine
}

async function projectEngine(): Promise<MemoryKnowledgeEngine> {
  const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
  const engine = await MemoryKnowledgeEngine.open({ path: ':memory:', journalMode: 'wal' }, inspector)
  engines.push(engine)
  return engine
}

describe('memory knowledge engine', () => {
  it('rejects an unowned empty SQLite file with an unknown schema version', async () => {
    const databasePath = join(await makeTempDirectory(), 'unknown.sqlite')
    const handle = await open(databasePath, 'wx', 0o600)
    await handle.close()
    const { DatabaseSync } = await import('node:sqlite')
    const unknown = new DatabaseSync(databasePath)
    unknown.exec('PRAGMA user_version = 99')
    unknown.close()

    await expect(MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }))
      .rejects.toThrow('unknown unowned schema version 99')
  })

  it('upgrades schema v3 by rebuilding only disposable Source checkpoints', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const old = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const candidate = await old.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'preference',
      title: '保留的候选',
      content: '数据库升级不能删除人工候选。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await old.generateKnowledgeCardCandidates(project)
    expect(await old.listSourceUnderstandings(project)).toHaveLength(1)
    await old.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('PRAGMA user_version = 3')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.getCandidate(candidate.id)).toMatchObject({ id: candidate.id, title: candidate.title })
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
  })

  it('upgrades schema v4 by discarding Source checkpoints from the obsolete analyzer', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    await original.generateKnowledgeCardCandidates(project)
    expect(await original.listSourceUnderstandings(project)).toHaveLength(1)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('PRAGMA user_version = 4')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
    expect(await upgraded.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 }))
      .toMatchObject({ totalMatches: 0, hits: [] })
  })

  it('upgrades schema v5 by dropping incompatible Source records and evidence', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    await original.generateKnowledgeCardCandidates(project)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('DROP TABLE source_evidence_fts')
    downgraded.exec('DROP TABLE source_evidence_documents')
    downgraded.exec('PRAGMA user_version = 5')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
    expect(await upgraded.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 }))
      .toMatchObject({ totalMatches: 0, hits: [] })
  })

  it('upgrades schema v6 without deleting candidates or conversation checkpoints', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const candidate = await original.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '保留审核数据',
      content: 'AST 分析器升级只能删除可重建的 Source 派生数据。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await original.prepareConversationExtraction({
      sessionId: 'session-schema-six' as never,
      extractor: 'explicit-memory',
      version: 1,
      baselineSeq: 4,
    })
    await original.generateKnowledgeCardCandidates(project)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('PRAGMA user_version = 6')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.getCandidate(candidate.id)).toMatchObject({ id: candidate.id })
    expect(await upgraded.prepareConversationExtraction({
      sessionId: 'session-schema-six' as never,
      extractor: 'explicit-memory',
      version: 1,
      baselineSeq: 99,
    })).toMatchObject({ throughSeq: 4 })
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
  })

  it('upgrades schema v7 by rebuilding only Source data for incremental reuse', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const candidate = await original.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '保留 schema v7 候选',
      content: '增量复用升级只清理可重建的 Source 数据。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await original.generateKnowledgeCardCandidates(project)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('PRAGMA user_version = 7')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.getCandidate(candidate.id)).toMatchObject({ id: candidate.id })
    expect(await upgraded.listSourceInventoryBaselines(project)).toEqual([])
    expect(await upgraded.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 }))
      .toMatchObject({ totalMatches: 0, hits: [] })
  })

  it('upgrades schema v8 by rebuilding relation checkpoints without deleting review candidates', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'dependency.ts'), 'export const dependency = true\n')
    await writeFile(join(project, 'src', 'example.ts'), "import { dependency } from './dependency.js'\nexport const greeting = dependency\n")
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const candidate = await original.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '保留 schema v8 候选',
      content: '模块关系升级只替换 Source 派生数据。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    const generated = await original.generateKnowledgeCardCandidates(project)
    expect(generated.understandings[0]).toMatchObject({ relationCount: 1, internalRelationCount: 1 })
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    expect(downgraded.prepare('SELECT count(*) AS count FROM source_relation_edges').get()).toEqual({ count: 1 })
    downgraded.exec('PRAGMA user_version = 8')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.getCandidate(candidate.id)).toMatchObject({ id: candidate.id })
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('SELECT count(*) AS count FROM source_relation_edges').get()).toEqual({ count: 0 })
    migrated.close()
  })

  it('upgrades schema v9 by rebuilding symbol checkpoints without deleting review candidates', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'dependency.ts'), 'export const dependency = true\n')
    await writeFile(join(project, 'src', 'example.ts'), [
      "import { dependency } from './dependency.js'",
      'export const greeting = dependency',
    ].join('\n'))
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const candidate = await original.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '保留 schema v9 候选',
      content: '符号关系升级只替换 Source 派生数据。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await original.generateKnowledgeCardCandidates(project)
    expect((await original.querySourceSymbols({ projectRoot: project, limit: 20 })).totalMatches).toBeGreaterThan(0)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    expect(downgraded.prepare('SELECT count(*) AS count FROM source_symbol_references').get())
      .toEqual({ count: expect.any(Number) })
    downgraded.exec('PRAGMA user_version = 9')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.getCandidate(candidate.id)).toMatchObject({ id: candidate.id })
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('SELECT count(*) AS count FROM source_symbol_definitions').get()).toEqual({ count: 0 })
    expect(migrated.prepare('SELECT count(*) AS count FROM source_symbol_references').get()).toEqual({ count: 0 })
    migrated.close()
  })

  it('upgrades schema v10 by rebuilding tsconfig-aware symbol checkpoints without deleting review candidates', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }))
    await writeFile(join(project, 'src', 'dependency.ts'), 'export const dependency = true\n')
    await writeFile(join(project, 'src', 'example.ts'), [
      "import { dependency } from '@/dependency.js'",
      'export const greeting = dependency',
    ].join('\n'))
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const candidate = await original.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '保留 schema v10 候选',
      content: 'TypeScript 配置解析升级只替换 Source 派生数据。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await original.generateKnowledgeCardCandidates(project)
    expect((await original.querySourceSymbols({ projectRoot: project, limit: 20 })).totalMatches).toBeGreaterThan(0)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('PRAGMA user_version = 10')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.getCandidate(candidate.id)).toMatchObject({ id: candidate.id })
    expect(await upgraded.listSourceUnderstandings(project)).toEqual([])
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('SELECT count(*) AS count FROM source_symbol_definitions').get()).toEqual({ count: 0 })
    expect(migrated.prepare('SELECT count(*) AS count FROM source_symbol_references').get()).toEqual({ count: 0 })
    migrated.close()
  })

  it('upgrades schema v11 without discarding current Source checkpoints', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    await original.generateKnowledgeCardCandidates(project)
    const before = await original.listSourceUnderstandings(project)
    expect(before).toHaveLength(1)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const downgraded = new DatabaseSync(databasePath)
    downgraded.exec('PRAGMA user_version = 11')
    downgraded.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(upgraded)
    expect(await upgraded.listSourceUnderstandings(project)).toEqual(before)
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    expect(migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'wiki_runs'").get())
      .toEqual({ count: 1 })
    expect(migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'wiki_tasks'").get())
      .toEqual({ count: 1 })
    expect(migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_generated_versions'").get())
      .toEqual({ count: 1 })
    expect(migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_effective_versions'").get())
      .toEqual({ count: 1 })
    expect(migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_selections'").get())
      .toEqual({ count: 1 })
    migrated.close()
  })

  it('migrates accepted candidates into independent local memory entries', async () => {
    const project = await makeTempProject()
    const databasePath = join(project, 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'wal' })
    const candidate = await original.saveCandidate({
      target: 'memory',
      applicability: 'project',
      projectRoot: project,
      kind: 'lesson',
      title: '迁移后的长期记忆',
      content: '旧 accepted 候选升级后形成独立长期条目。',
      tags: ['migration'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await original.reviewCandidate(candidate.id, 'accept')
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const row = legacy.prepare('SELECT payload_json FROM candidates WHERE id = ?').get(candidate.id) as { payload_json: string }
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    delete payload['localMemoryId']
    legacy.exec("DELETE FROM search_fts WHERE document_key IN (SELECT document_key FROM search_documents WHERE owner = 'local-memory')")
    legacy.exec("DELETE FROM search_documents WHERE owner = 'local-memory'")
    legacy.exec('DROP TABLE memory_entry_revisions')
    legacy.exec('DROP TABLE memory_entries')
    legacy.prepare('UPDATE candidates SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), candidate.id)
    legacy.exec('PRAGMA user_version = 21')
    legacy.close()

    const migrated = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'wal' })
    engines.push(migrated)
    const accepted = await migrated.getCandidate(candidate.id)
    if (accepted?.target !== 'memory' || accepted.localMemoryId === undefined) throw new Error('missing migrated memory')
    expect(await migrated.listLocalMemoryEntries({ projectRoot: project, limit: 10 })).toMatchObject([
      { id: accepted.localMemoryId, revision: 1, status: 'active', sourceCandidateId: candidate.id },
    ])
    expect(await migrated.search({ query: '独立长期条目', projectRoot: project, domain: 'memory', limit: 5, maxChars: 2_000 }))
      .toMatchObject([{ id: accepted.localMemoryId }])
  })

  it('persists and reconstructs a complete language-neutral Wiki coverage plan', async () => {
    const project = await makeTempProject()
    const engine = await memoryEngine()
    const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
    const planned = await engine.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'2'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [
        {
          sourceId,
          path: 'cmd/main.go',
          byteSize: 1024,
          revision: { kind: 'git-object', commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
          language: 'Go',
        },
        {
          sourceId,
          path: 'Services/App.cs',
          byteSize: 2048,
          revision: { kind: 'content-hash', contentHash: `sha256:${'3'.repeat(64)}` },
          language: 'C#',
        },
      ],
      now: '2026-08-27T00:00:00.000Z',
    })

    expect(await engine.getWikiRunSnapshot(planned.run.id)).toEqual(planned)
    expect(await engine.listWikiRuns(project)).toEqual([planned.run])
    expect(await engine.listWikiRuns(project, 1)).toEqual([planned.run])
    expect(await engine.listWikiRuns()).toEqual([planned.run])
    expect(await engine.getKnowledgeVersionState(project)).toMatchObject({
      selection: {
        revision: 1,
        analysisGeneration: 1,
        currentRunId: planned.run.id,
      },
    })
    await expect(engine.activateWikiRun(planned.run.id))
      .rejects.toThrow('Wiki run is not eligible for project-knowledge activation')
    await expect(engine.listWikiRuns(project, 0)).rejects.toThrow('positive safe integer')
  })

  it('rejects a Wiki snapshot write based on an obsolete snapshot hash', async () => {
    const project = await makeTempProject()
    const engine = await memoryEngine()
    const planned = await engine.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'5'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId: KnowledgeSourceId('src_33333333-3333-4333-8333-333333333333'),
        path: 'src/main.go',
        byteSize: 32,
        revision: { kind: 'git-object', commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
      }],
      now: '2026-08-27T00:20:00.000Z',
    })
    const started = startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-cas-winner'),
      '2026-08-27T00:21:00.000Z',
    )
    await engine.saveWikiRunSnapshot(started, planned.snapshotHash)

    await expect(engine.saveWikiRunSnapshot(
      startWikiTask(planned, planned.tasks[0]!.id, SessionId('session-cas-loser'), '2026-08-27T00:21:30.000Z'),
      planned.snapshotHash,
    )).rejects.toThrow('snapshot changed')
  })

  it('migrates schema v12 Wiki runs to durable shard tasks without dropping the run', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'4'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId: KnowledgeSourceId('src_22222222-2222-4222-8222-222222222222'),
        path: 'src/main.unknown',
        byteSize: 64,
        revision: { kind: 'git-object', commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
      }],
      now: '2026-08-27T00:30:00.000Z',
    })
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const row = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(row.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 1
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    legacy.exec('DELETE FROM wiki_tasks')
    legacy.exec('PRAGMA user_version = 12')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const snapshot = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(snapshot).toBeDefined()
    expect({
      ...snapshot!,
      run: {
        ...snapshot!.run,
        fileSynthesis: planned.run.fileSynthesis,
        materialExposure: planned.run.materialExposure,
        businessQuestions: planned.run.businessQuestions,
      },
      tasks: snapshot!.tasks.map((task, index) => ({
        ...task,
        modelInputAudit: planned.tasks[index]!.modelInputAudit,
        businessQuestions: planned.tasks[index]!.businessQuestions,
      })),
      snapshotHash: planned.snapshotHash,
    }).toEqual(planned)
    expect(snapshot!.run.fileSynthesis).toMatchObject({
      rulesVersion: 2,
      status: 'unassessed',
      fileCount: 0,
      inputClaimCount: 0,
      taskCount: 0,
      completeFileCount: 0,
      incompleteFileCount: null,
    })
    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    expect(migrated.prepare('SELECT count(*) AS count FROM wiki_tasks').get()).toEqual({ count: 1 })
    migrated.close()
  })

  it('migrates schema v13 verifying runs into resumable cross-shard verification tasks', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const sourceId = KnowledgeSourceId('src_99999999-9999-4999-8999-999999999999')
    const contentHash = `sha256:${'9'.repeat(64)}`
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'8'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId,
        path: 'README.unknown',
        byteSize: 64,
        revision: { kind: 'content-hash', contentHash },
      }],
      now: '2026-08-27T01:00:00.000Z',
    })
    const started = startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-v13-analysis'),
      '2026-08-27T01:01:00.000Z',
    )
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const verifying = succeedWikiTask(started, started.tasks[0]!.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: { kind: 'document', sourceId, path: 'README.unknown', contentHash },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: '项目使用未知扩展名的说明文件。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T01:02:00.000Z')
    await original.saveWikiRunSnapshot(verifying, planned.snapshotHash)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 2
    legacyRun['tasks'] = {
      taskCount: 1,
      planned: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    }
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    legacy.prepare("DELETE FROM wiki_tasks WHERE shard_key LIKE 'verification_%'").run()
    const taskRow = legacy.prepare('SELECT id, payload_json FROM wiki_tasks WHERE run_id = ?')
      .get(planned.run.id) as { id: string; payload_json: string }
    const legacyTask = JSON.parse(taskRow.payload_json) as Record<string, unknown>
    delete legacyTask['kind']
    delete legacyTask['claimIds']
    legacy.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyTask), taskRow.id)
    legacy.exec('PRAGMA user_version = 13')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(migrated).toMatchObject({
      run: { schemaVersion: 10, status: 'verifying', tasks: { taskCount: 2, succeeded: 1, planned: 1 } },
      tasks: [
        { kind: 'analysis', status: 'succeeded', claimIds: [] },
        { kind: 'verification', status: 'planned', claimIds: [claimId] },
      ],
      claims: [{ id: claimId, status: 'proposed' }],
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
  })

  it('migrates schema v14 reviewed runs into audited global consistency recall', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const sourceId = KnowledgeSourceId('src_88888888-8888-4888-8888-888888888888')
    const contentHash = `sha256:${'8'.repeat(64)}`
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'7'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId,
        path: 'README.md',
        byteSize: 64,
        revision: { kind: 'content-hash', contentHash },
      }],
      now: '2026-08-27T01:10:00.000Z',
    })
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const analyzed = succeedWikiTask(startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-v14-analysis'),
      '2026-08-27T01:11:00.000Z',
    ), planned.tasks[0]!.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: { kind: 'document', sourceId, path: 'README.md', contentHash },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: 'README 是项目说明。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T01:12:00.000Z')
    const verificationTask = analyzed.tasks.find(task => task.kind === 'verification')!
    const reviewed = succeedWikiVerificationTask(startWikiTask(
      analyzed,
      verificationTask.id,
      SessionId('session-v14-verification'),
      '2026-08-27T01:13:00.000Z',
    ), verificationTask.id, {
      decisions: [{ claimId, status: 'verified' }],
      citations: [],
      conflicts: [],
    }, '2026-08-27T01:14:00.000Z')
    await original.saveWikiRunSnapshot(reviewed, planned.snapshotHash)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 3
    legacyRun['status'] = 'needs-review'
    legacyRun['tasks'] = {
      taskCount: 2,
      planned: 0,
      running: 0,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
    }
    delete legacyRun['consistency']
    delete legacyRun['pageGeneration']
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    const taskRows = legacy.prepare('SELECT id, payload_json FROM wiki_tasks WHERE run_id = ?')
      .all(planned.run.id) as Array<{ id: string; payload_json: string }>
    for (const row of taskRows) {
      const task = JSON.parse(row.payload_json) as Record<string, unknown>
      if (task['kind'] === 'page') {
        legacy.prepare('DELETE FROM wiki_tasks WHERE id = ?').run(row.id)
        continue
      }
      delete task['candidatePairs']
      legacy.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE id = ?').run(JSON.stringify(task), row.id)
    }
    legacy.exec('PRAGMA user_version = 14')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    expect(await upgraded.getWikiRunSnapshot(planned.run.id)).toMatchObject({
      run: {
        schemaVersion: 10,
        status: 'synthesizing',
        consistency: {
          rulesVersion: 1,
          planned: true,
          candidatePairCount: 0,
          candidatePairsComplete: true,
          omittedCandidatePairCount: 0,
        },
      },
      tasks: expect.arrayContaining([
        expect.objectContaining({ kind: 'analysis', candidatePairs: [] }),
        expect.objectContaining({ kind: 'verification', candidatePairs: [] }),
        expect.objectContaining({ kind: 'page', candidatePairs: [], status: 'planned' }),
      ]),
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
  })

  it('migrates schema v15 Pages as preserved legacy data before regenerating the active tree', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const sourceId = KnowledgeSourceId('src_99999999-9999-4999-8999-999999999999')
    const contentHash = `sha256:${'9'.repeat(64)}`
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'6'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId,
        path: 'docs/storage.md',
        byteSize: 32,
        revision: { kind: 'content-hash', contentHash },
      }],
      now: '2026-08-27T04:00:00.000Z',
    })
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const analyzed = succeedWikiTask(startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-v15-analysis'),
      '2026-08-27T04:01:00.000Z',
    ), planned.tasks[0]!.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: { kind: 'document', sourceId, path: 'docs/storage.md', contentHash },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: '项目使用本地持久化。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T04:02:00.000Z')
    const verificationTask = analyzed.tasks.find(task => task.kind === 'verification')!
    const synthesizing = succeedWikiVerificationTask(startWikiTask(
      analyzed,
      verificationTask.id,
      SessionId('session-v15-verification'),
      '2026-08-27T04:03:00.000Z',
    ), verificationTask.id, {
      decisions: [{ claimId, status: 'verified' }],
      citations: [],
      conflicts: [],
    }, '2026-08-27T04:04:00.000Z')
    const pageTask = synthesizing.tasks.find(task => task.kind === 'page')!
    const reviewed = succeedWikiPageTask(startWikiTask(
      synthesizing,
      pageTask.id,
      SessionId('session-v15-page'),
      '2026-08-27T04:05:00.000Z',
    ), pageTask.id, {
      pages: [{ slug: 'storage', title: '存储', claimIds: [claimId], childSlugs: [] }],
    }, '2026-08-27T04:06:00.000Z')
    await original.saveWikiRunSnapshot(reviewed, planned.snapshotHash)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 4
    legacyRun['tasks'] = {
      taskCount: 2,
      planned: 0,
      running: 0,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
    }
    delete legacyRun['pageGeneration']
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    const taskRows = legacy.prepare('SELECT id, payload_json FROM wiki_tasks WHERE run_id = ?')
      .all(planned.run.id) as Array<{ id: string; payload_json: string }>
    for (const row of taskRows) {
      const task = JSON.parse(row.payload_json) as Record<string, unknown>
      if (task['kind'] === 'page') legacy.prepare('DELETE FROM wiki_tasks WHERE id = ?').run(row.id)
    }
    const pageRows = legacy.prepare('SELECT id, payload_json FROM wiki_pages WHERE run_id = ?')
      .all(planned.run.id) as Array<{ id: string; payload_json: string }>
    for (const row of pageRows) {
      const page = JSON.parse(row.payload_json) as Record<string, unknown>
      delete page['sourceTaskId']
      legacy.prepare('UPDATE wiki_pages SET payload_json = ? WHERE id = ?').run(JSON.stringify(page), row.id)
    }
    legacy.exec('PRAGMA user_version = 15')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(migrated).toMatchObject({
      run: {
        schemaVersion: 10,
        status: 'synthesizing',
        rootPageIds: [],
        pageGeneration: { planned: true, claimCount: 1, taskCount: 1 },
      },
      pages: expect.arrayContaining([
        expect.objectContaining({ title: '存储', status: 'stale', legacy: true }),
        expect.objectContaining({ title: 'Wiki', status: 'stale', legacy: true }),
      ]),
      tasks: expect.arrayContaining([
        expect.objectContaining({ kind: 'page', status: 'planned', claimIds: [claimId] }),
      ]),
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
  })

  it('migrates schema v16 Wiki runtime payloads to durable empty material ranges', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'7'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId: KnowledgeSourceId('src_77777777-7777-4777-8777-777777777777'),
        path: 'src/runtime.unknown',
        byteSize: 48,
        revision: { kind: 'content-hash', contentHash: `sha256:${'8'.repeat(64)}` },
      }],
      now: '2026-08-27T05:00:00.000Z',
    })
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 5
    delete legacyRun['materialRanges']
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    const taskRows = legacy.prepare('SELECT id, payload_json FROM wiki_tasks WHERE run_id = ?')
      .all(planned.run.id) as Array<{ id: string; payload_json: string }>
    for (const row of taskRows) {
      const task = JSON.parse(row.payload_json) as Record<string, unknown>
      delete task['materialRanges']
      legacy.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE id = ?').run(JSON.stringify(task), row.id)
    }
    legacy.exec('PRAGMA user_version = 16')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(migrated).toMatchObject({
      schemaVersion: 10,
      run: {
        schemaVersion: 10,
        materialRanges: {
          rangeCount: 0,
          totalBytes: 0,
          analyzedBytes: 0,
          planned: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
        },
      },
      tasks: [expect.objectContaining({ materialRanges: [] })],
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
  })

  it('migrates schema v17 Wiki runtime payloads with explicit unassessed file synthesis', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const revisionHash = `sha256:${'9'.repeat(64)}`
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'a'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId: KnowledgeSourceId('src_88888888-8888-4888-8888-888888888888'),
        path: 'README.unknown',
        byteSize: 32,
        revision: { kind: 'content-hash', contentHash: revisionHash },
      }],
      now: '2026-08-27T05:10:00.000Z',
    })
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const analyzed = succeedWikiTask(startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-v17-analysis'),
      '2026-08-27T05:11:00.000Z',
    ), planned.tasks[0]!.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash: revisionHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: {
          kind: 'document',
          sourceId: planned.coverage[0]!.sourceId,
          path: planned.coverage[0]!.path,
          contentHash: revisionHash,
        },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: 'README 记录了一项项目事实。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T05:12:00.000Z')
    await original.saveWikiRunSnapshot(analyzed, planned.snapshotHash)
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 6
    delete legacyRun['fileSynthesis']
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    const claimRow = legacy.prepare('SELECT payload_json FROM wiki_claims WHERE run_id = ? AND id = ?')
      .get(planned.run.id, claimId) as { payload_json: string }
    const legacyClaim = JSON.parse(claimRow.payload_json) as Record<string, unknown>
    delete legacyClaim['sourceClaimIds']
    legacy.prepare('UPDATE wiki_claims SET payload_json = ? WHERE run_id = ? AND id = ?')
      .run(JSON.stringify(legacyClaim), planned.run.id, claimId)
    legacy.exec('PRAGMA user_version = 17')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(migrated).toMatchObject({
      schemaVersion: 10,
      run: {
        schemaVersion: 10,
        fileSynthesis: {
          status: 'unassessed',
          completeFileCount: 0,
          incompleteFileCount: null,
        },
      },
      claims: [expect.objectContaining({ id: claimId, sourceClaimIds: [] })],
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
  })

  it('迁移 v18 单层综合，补全来源任务但不追认递归完整性', async () => {
    const project = await realpath(await makeTempProject())
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(original)
    const completed = completeSynthesisLayer(synthesisFixture(
      { maxClaimsPerTask: 4, maxStatementCharactersPerTask: 20_000, maxLevels: 8 }, 4, project,
    ))
    await original.saveWikiRunSnapshot(completed)
    await original.close()
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    try {
      const { fileSynthesis: _summary, ...run } = completed.run
      legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?').run(JSON.stringify({
        ...run, schemaVersion: 7,
        fileSynthesis: { rulesVersion: 1, planned: true, fileCount: 1, inputClaimCount: 4, taskCount: 1, complete: true, incompleteFileCount: 0 },
      }), completed.run.id)
      for (const task of completed.tasks) {
        const { fileSynthesis: _state, ...payload } = task
        legacy.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), task.id)
      }
      for (const claim of completed.claims) {
        const { sourceTaskId: _owner, ...payload } = claim
        legacy.prepare('UPDATE wiki_claims SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), claim.id)
      }
      legacy.exec('PRAGMA user_version = 18')
    } finally {
      legacy.close()
    }
    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(completed.run.id)
    expect(migrated?.run.fileSynthesis).toMatchObject({ status: 'unassessed', fileCount: 1, taskCount: 1, limits: null })
    expect(migrated?.claims).toEqual(completed.claims)
    expect(migrated?.tasks.find(task => task.kind === 'file-synthesis')?.fileSynthesis)
      .toEqual({ level: 0, batchIndex: 0, batchCount: 1 })
    expect(migrated?.run.status).toBe('verifying')
  })

  it.each([19, 20, 21, 22, 23, 24])(
    'migrates v%i Wiki tasks without inventing historical model-input evidence',
    async legacySchemaVersion => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'9'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId: KnowledgeSourceId('src_99999999-9999-4999-8999-999999999999'),
        path: 'src/main.unknown',
        byteSize: 32,
        revision: { kind: 'content-hash', contentHash: `sha256:${'8'.repeat(64)}` },
      }],
      now: '2026-09-15T00:00:00.000Z',
    })
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 8
    delete legacyRun['materialExposure']
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    const taskRows = legacy.prepare('SELECT id, payload_json FROM wiki_tasks WHERE run_id = ?')
      .all(planned.run.id) as Array<{ id: string; payload_json: string }>
    for (const row of taskRows) {
      const task = JSON.parse(row.payload_json) as Record<string, unknown>
      delete task['modelInputAudit']
      legacy.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE id = ?').run(JSON.stringify(task), row.id)
    }
    legacy.exec(`PRAGMA user_version = ${legacySchemaVersion}`)
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(migrated).toMatchObject({
      schemaVersion: 10,
      run: {
        schemaVersion: 10,
        materialExposure: {
          requiredTaskCount: 1,
          verifiedTaskCount: 0,
          pendingTaskCount: 0,
          unsupportedTaskCount: 1,
        },
      },
      tasks: [expect.objectContaining({
        modelInputAudit: { rulesVersion: 0, state: 'unsupported', material: [] },
      })],
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
    },
  )

  it('migrates v25 Wiki analysis without inventing historical business-question answers', async () => {
    const project = await makeTempProject()
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    const planned = await original.planWikiRun({
      projectRoot: project,
      catalogHash: `sha256:${'7'.repeat(64)}`,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        sourceId: KnowledgeSourceId('src_77777777-7777-4777-8777-777777777777'),
        path: 'src/legacy.unknown',
        byteSize: 48,
        revision: { kind: 'content-hash', contentHash: `sha256:${'6'.repeat(64)}` },
      }],
      now: '2026-09-15T01:00:00.000Z',
    })
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(databasePath)
    const runRow = legacy.prepare('SELECT payload_json FROM wiki_runs WHERE id = ?')
      .get(planned.run.id) as { payload_json: string }
    const legacyRun = JSON.parse(runRow.payload_json) as Record<string, unknown>
    legacyRun['schemaVersion'] = 9
    delete legacyRun['businessQuestions']
    legacy.prepare('UPDATE wiki_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyRun), planned.run.id)
    const taskRows = legacy.prepare('SELECT id, payload_json FROM wiki_tasks WHERE run_id = ?')
      .all(planned.run.id) as Array<{ id: string; payload_json: string }>
    for (const row of taskRows) {
      const task = JSON.parse(row.payload_json) as Record<string, unknown>
      delete task['businessQuestions']
      legacy.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE id = ?').run(JSON.stringify(task), row.id)
    }
    legacy.exec('PRAGMA user_version = 25')
    legacy.close()

    const upgraded = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' })
    engines.push(upgraded)
    const migrated = await upgraded.getWikiRunSnapshot(planned.run.id)
    expect(migrated).toMatchObject({
      schemaVersion: 10,
      run: {
        schemaVersion: 10,
        businessQuestions: {
          state: 'unsupported',
          requiredQuestionCount: 9,
          analysisTaskCount: 1,
          completedTaskCount: 0,
        },
      },
      tasks: [expect.objectContaining({
        modelInputAudit: { rulesVersion: 1, state: 'pending', material: [] },
        businessQuestions: { rulesVersion: 0, state: 'unsupported', findings: [] },
      })],
    })
    const database = new DatabaseSync(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 })
    database.close()
  })

  it('catalogs a clean project from Git metadata and persists its Wiki coverage plan', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'worker.go'), 'package worker\n')
    await initializeGitProject(project)
    const engine = await projectEngine()

    const planned = await engine.planWikiProject(project)

    expect(planned.catalog).toMatchObject({ state: 'complete', omittedItemCount: 0 })
    expect(planned.run.run).toMatchObject({
      status: 'planned',
      catalogComplete: true,
      coverage: { itemCount: planned.catalog.entryCount, excluded: expect.any(Number) },
    })
    expect(planned.run.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/worker.go', language: 'Go', status: 'pending' }),
      expect.objectContaining({ path: '.dsh/knowledge/manifest.json', status: 'excluded' }),
    ]))
    expect(await engine.getWikiRunSnapshot(planned.run.run.id)).toEqual(planned.run)
  })

  it('keeps same-project Wiki planning requests in start order', async () => {
    const project = await makeTempProject()
    const canonicalProject = await realpath(project)
    const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
    const digest = (character: string): string => `sha256:${character.repeat(64)}`
    const catalog = (character: string): WikiProjectCatalog => ({
      version: 1,
      projectRoot: canonicalProject,
      state: 'complete',
      catalogHash: digest(character),
      omittedItemCount: 0,
      entryCount: 1,
      totalBytes: 8,
      excludedEntryCount: 0,
      blockedEntryCount: 0,
      sources: [{ sourceId, entryCount: 1, totalBytes: 8, complete: true }],
      entries: [{
        sourceId,
        path: 'README.md',
        byteSize: 8,
        revision: { kind: 'content-hash', contentHash: digest(character) },
      }],
      issues: [],
    })
    let releaseFirst!: (value: WikiProjectCatalog) => void
    let markFirstStarted!: () => void
    const firstCatalog = new Promise<WikiProjectCatalog>(resolve => { releaseFirst = resolve })
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    let catalogCalls = 0
    const engine = await MemoryKnowledgeEngine.open({ path: ':memory:', journalMode: 'wal' }, {
      inspect: async () => ({ sources: [], cards: [], staleCardCount: 0, degradedCardCount: 0 }),
      catalog: () => {
        catalogCalls += 1
        if (catalogCalls === 1) {
          markFirstStarted()
          return firstCatalog
        }
        return Promise.resolve(catalog('2'))
      },
    })
    engines.push(engine)

    const firstRequest = engine.planWikiProject(project)
    await firstStarted
    const secondRequest = engine.planWikiProject(project)
    await Promise.resolve()
    expect(catalogCalls).toBe(1)

    releaseFirst(catalog('1'))
    const first = await firstRequest
    const second = await secondRequest
    const selected = await engine.getKnowledgeVersionState(project)

    expect(first.run.run.catalogHash).toBe(digest('1'))
    expect(second.run.run.catalogHash).toBe(digest('2'))
    expect(selected.selection).toMatchObject({
      currentRunId: second.run.run.id,
      analysisGeneration: 2,
    })
  })

  it('prepares oversized Git material before persisting the Wiki plan', async () => {
    const project = await makeTempProject()
    const cacheRoot = await makeTempDirectory()
    await writeFile(join(project, 'src', 'large.polyglot'), '跨语言材料🙂\n'.repeat(80))
    await initializeGitProject(project)
    const inspector = new KnowledgeProjectInspector(
      new NodeSourceInventoryBackend(),
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      undefined,
      undefined,
      undefined,
      {
        chunkBytes: 32,
        maxMaterialBytes: 4_096,
        rangeTargetBytes: 128,
        rangeContextBytes: 16,
        stderrMaxBytes: 8_192,
        processGraceMs: 1_000,
      },
      cacheRoot,
    )
    const engine = await MemoryKnowledgeEngine.open({ path: ':memory:', journalMode: 'wal' }, inspector)
    engines.push(engine)

    const planned = await engine.planWikiProject(project)
    const coverage = planned.run.coverage.find(item => item.path === 'src/large.polyglot')!
    const tasks = planned.run.tasks.filter(task => task.coverageIds.includes(coverage.id))

    expect(coverage).toMatchObject({ status: 'pending', preparedContentHash: expect.any(String) })
    expect(tasks.length).toBeGreaterThan(1)
    expect(tasks.every(task => task.materialRanges.length === 1)).toBe(true)
    expect(planned.run.run.materialRanges).toMatchObject({
      rangeCount: tasks.length,
      totalBytes: coverage.byteSize,
      analyzedBytes: 0,
      planned: tasks.length,
    })
    expect(await engine.getWikiRunSnapshot(planned.run.run.id)).toEqual(planned.run)
  })

  it('persists a blocked Wiki run when the current worktree differs from cataloged HEAD', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    await writeFile(join(project, 'src', 'example.ts'), 'export const dirty = true\n')
    const engine = await projectEngine()

    const planned = await engine.planWikiProject(project)

    expect(planned.catalog).toMatchObject({ state: 'incomplete', omittedItemCount: null })
    expect(planned.run.run).toMatchObject({
      status: 'blocked',
      catalogComplete: false,
      catalogOmittedItemCount: null,
      blockingReasons: [
        '项目目录清单不完整，遗漏数量未知，禁止生成 Wiki',
        expect.stringContaining('存在未纳入 Catalog 的工作树变更'),
      ],
    })
  })

  it('reuses analyzed coverage by content identity and invalidates only changed files', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'stable.go'), 'package stable\n')
    await writeFile(join(project, 'src', 'changed.py'), 'value = 1\n')
    await initializeGitProject(project)
    const engine = await projectEngine()

    const first = await engine.planWikiProject(project)
    const analyzedAt = '2026-08-27T02:00:00.000Z'
    const analyzedCoverage = first.run.coverage.map((item, index) => item.status !== 'pending' ? item : ({
      ...item,
      status: 'analyzed' as const,
      attemptCount: 2,
      analyzedContentHash: `sha256:${index.toString(16).padStart(64, '0')}`,
      analyzedAt,
    }))
    const analyzed = finalizeWikiRunSnapshot({
      schemaVersion: 10,
      run: { ...first.run.run, coverage: summarizeWikiCoverage(analyzedCoverage), updatedAt: analyzedAt },
      coverage: analyzedCoverage,
      tasks: first.run.tasks,
      citations: [],
      claims: [],
      conflicts: [],
      pages: [],
    })
    await engine.saveWikiRunSnapshot(analyzed)

    const duplicate = await engine.planWikiProject(project)
    expect(duplicate.run.run.id).toBe(first.run.run.id)

    await writeFile(join(project, 'src', 'changed.py'), 'value = 2\n')
    await commitProjectChanges(project, 'change one file')
    const incremental = await engine.planWikiProject(project)
    const stable = incremental.run.coverage.find(item => item.path === 'src/stable.go')!
    const changed = incremental.run.coverage.find(item => item.path === 'src/changed.py')!

    expect(incremental.run.run.id).not.toBe(first.run.run.id)
    expect(stable).toMatchObject({ status: 'analyzed', attemptCount: 2, analyzedAt })
    expect(changed).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(changed).not.toHaveProperty('analyzedContentHash')
  })

  it('checkpoints automatic conversation candidates atomically and idempotently', async () => {
    const engine = await memoryEngine()
    const sessionId = 'session-conversation-extraction' as never
    const checkpoint = await engine.prepareConversationExtraction({
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      baselineSeq: 2,
    })
    expect(checkpoint).toMatchObject({ sessionId, throughSeq: 2 })

    expect(await engine.recordConversationExtraction({
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      turnEndSeq: 5,
    })).toEqual({ outcome: 'skipped', throughSeq: 5 })

    const candidate = {
      target: 'memory' as const,
      applicability: 'global' as const,
      kind: 'preference' as const,
      title: '偏好：以后请用中文回答我',
      content: '以后请用中文回答我',
      tags: ['conversation-extraction'],
      sensitivity: 'normal' as const,
      suggestedBy: 'conversation' as const,
      provenance: [{ kind: 'session' as const, sessionId, eventSeqs: [7] }],
    }
    const recorded = await engine.recordConversationExtraction({
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      turnEndSeq: 9,
      candidate,
    })
    expect(recorded).toMatchObject({ outcome: 'candidate', throughSeq: 9, candidate: { suggestedBy: 'conversation' } })
    expect(await engine.recordConversationExtraction({
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      turnEndSeq: 9,
      candidate,
    })).toEqual({ outcome: 'already-processed', throughSeq: 9 })
    expect(await engine.listCandidates({ status: 'pending', limit: 20 })).toHaveLength(1)
  })

  it('does not advance a conversation checkpoint when candidate provenance is invalid', async () => {
    const engine = await memoryEngine()
    const sessionId = 'session-conversation-rollback' as never
    await engine.prepareConversationExtraction({
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      baselineSeq: -1,
    })
    const input = {
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      turnEndSeq: 4,
      candidate: {
        target: 'memory' as const,
        applicability: 'global' as const,
        kind: 'fact' as const,
        title: '自动候选',
        content: '需要完整来源',
        tags: [],
        sensitivity: 'normal' as const,
        suggestedBy: 'conversation' as const,
        provenance: [{ kind: 'session' as const, sessionId: 'another-session' as never, eventSeqs: [2] }],
      },
    }
    await expect(engine.recordConversationExtraction(input)).rejects.toThrow('provenance does not match')
    expect(await engine.recordConversationExtraction({
      sessionId,
      extractor: 'explicit-memory',
      version: 1,
      turnEndSeq: 4,
    })).toEqual({
      outcome: 'skipped',
      throughSeq: 4,
    })
  })

  it('rejects a durable Knowledge Card candidate whose provenance was detached from its generation', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'tampered.sqlite')
    const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
    const original = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    const generated = await original.generateKnowledgeCardCandidates(project)
    const module = generated.candidates.find(candidate => candidate.kind === 'module')!
    await original.close()

    const { DatabaseSync } = await import('node:sqlite')
    const tampered = new DatabaseSync(databasePath)
    const row = tampered.prepare('SELECT payload_json FROM candidates WHERE id = ?').get(module.id) as { payload_json: string }
    const payload = JSON.parse(row.payload_json) as { provenance: Array<{ commit: string }> }
    payload.provenance[0]!.commit = 'b'.repeat(40)
    tampered.prepare('UPDATE candidates SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), module.id)
    tampered.close()

    const reopened = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'delete' }, inspector)
    engines.push(reopened)
    await expect(reopened.getCandidate(module.id)).rejects.toThrow('candidate provenance does not match')
  })

  it('deduplicates pending candidates and recalls them only after acceptance', async () => {
    const engine = await memoryEngine()
    const input = {
      target: 'memory' as const,
      applicability: 'global' as const,
      kind: 'preference' as const,
      title: '默认使用 SQLite',
      content: '用户偏好在本地插件中使用 SQLite 保存长期状态。',
      tags: ['sqlite', 'storage'],
      sensitivity: 'normal' as const,
      suggestedBy: 'model' as const,
      provenance: sessionProvenance,
    }
    const first = await engine.saveCandidate(input)
    const duplicate = await engine.saveCandidate(input)
    expect(duplicate.id).toBe(first.id)
    expect(await engine.search({ query: 'SQLite', limit: 5, maxChars: 2_000 })).toEqual([])

    const accepted = await engine.reviewCandidate(first.id, 'accept')
    expect(accepted.status).toBe('accepted')
    if (accepted.target !== 'memory' || accepted.localMemoryId === undefined) throw new Error('expected local memory')
    const hits = await engine.search({ query: 'SQLite', limit: 5, maxChars: 2_000 })
    expect(hits).toMatchObject([{ id: accepted.localMemoryId, recordType: 'personal-memory', evidenceClass: 'human-verified' }])
    expect(await engine.trace(first.id)).toMatchObject({ id: first.id, status: 'accepted', recordType: 'candidate' })
    expect(await engine.trace(accepted.localMemoryId)).toMatchObject({
      id: accepted.localMemoryId,
      status: 'active',
      recordType: 'personal-memory',
    })
  })

  it('keeps restricted accepted memory out of default recall', async () => {
    const engine = await memoryEngine()
    const candidate = await engine.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '受限内容',
      content: 'restricted-private-value',
      tags: [],
      sensitivity: 'restricted',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    await engine.reviewCandidate(candidate.id, 'accept')
    expect(await engine.search({ query: 'restricted', limit: 5, maxChars: 2_000 })).toEqual([])
    expect(await engine.search({
      query: 'restricted',
      limit: 5,
      maxChars: 2_000,
      includeRestricted: true,
    })).toHaveLength(1)
    await expect(engine.promoteCandidate(candidate.id, await makeTempProject())).rejects.toThrow(
      'restricted candidates stay local',
    )
  })

  it('protects review mutations with candidate revisions', async () => {
    const engine = await memoryEngine()
    const candidate = await engine.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'lesson',
      title: '并发审核',
      content: '候选审核必须拒绝过期页面提交的决定。',
      tags: ['review'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    const accepted = await engine.reviewCandidate(candidate.id, 'accept', candidate.revision)
    expect(accepted.revision).toBe(candidate.revision + 1)
    await expect(engine.reviewCandidate(candidate.id, 'accept', candidate.revision))
      .rejects.toBeInstanceOf(MemoryCandidateRevisionConflictError)
  })

  it('keeps local memory lifecycle revisions and recall in one transaction', async () => {
    const engine = await memoryEngine()
    const created = await engine.createLocalMemoryEntry({
      applicability: 'global',
      kind: 'method',
      title: '先复现再修改',
      content: '处理缺陷时先保存可重复的失败证据。',
      conditions: ['调试任务'],
      tags: ['debugging'],
      sensitivity: 'normal',
      provenance: [],
    })
    expect(created).toMatchObject({ revision: 1, status: 'active', kind: 'method' })
    expect(await engine.search({ query: '失败证据', domain: 'memory', limit: 5, maxChars: 2_000 }))
      .toMatchObject([{ id: created.id, status: 'active' }])

    const updated = await engine.updateLocalMemoryEntry(created.id, {
      title: '先复现、再修改、最后回归',
      content: '处理缺陷时先保存可重复的失败证据，修复后运行针对性回归。',
      kind: 'method',
      conditions: ['调试任务', '缺陷修复'],
      tags: ['debugging', 'regression'],
      sensitivity: 'normal',
      supersedes: [],
      conflictsWith: [],
    }, created.revision)
    expect(updated).toMatchObject({ revision: 2, status: 'active' })
    await expect(engine.updateLocalMemoryEntry(created.id, {
      title: created.title,
      content: created.content,
      kind: created.kind,
      conditions: created.conditions,
      tags: created.tags,
      sensitivity: created.sensitivity,
      supersedes: [],
      conflictsWith: [],
    }, created.revision)).rejects.toBeInstanceOf(LocalMemoryRevisionConflictError)

    const deprecated = await engine.setLocalMemoryEntryStatus(created.id, 'deprecated', updated.revision)
    expect(deprecated.revision).toBe(3)
    expect(await engine.search({ query: '失败证据', domain: 'memory', limit: 5, maxChars: 2_000 })).toEqual([])
    expect(await engine.listLocalMemoryEntries({ status: 'deprecated', limit: 10 }))
      .toMatchObject([{ id: created.id, revision: 3 }])

    const restored = await engine.setLocalMemoryEntryStatus(created.id, 'active', deprecated.revision)
    expect(await engine.search({ query: '针对性回归', domain: 'memory', limit: 5, maxChars: 2_000 }))
      .toMatchObject([{ id: created.id, status: 'active' }])
    const deleted = await engine.setLocalMemoryEntryStatus(created.id, 'deleted', restored.revision)
    expect(deleted).toMatchObject({ revision: 5, status: 'deleted' })
    expect(await engine.search({ query: '针对性回归', domain: 'memory', limit: 5, maxChars: 2_000 })).toEqual([])
    expect(await engine.listLocalMemoryRevisions(created.id, undefined, 10)).toMatchObject([
      { kind: 'deleted', entry: { revision: 5 } },
      { kind: 'restored', entry: { revision: 4 } },
      { kind: 'deprecated', entry: { revision: 3 } },
      { kind: 'edited', entry: { revision: 2 } },
      { kind: 'created', entry: { revision: 1 } },
    ])
  })

  it('separates memory and knowledge browsing while preserving applicable Agent recall', async () => {
    const engine = await memoryEngine()
    const project = await makeTempProject()
    const personal = await engine.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'preference',
      title: '个人可视化偏好',
      content: '使用紧凑的记忆列表。',
      tags: ['ui'],
      sensitivity: 'normal',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    const restricted = await engine.saveCandidate({
      target: 'memory',
      applicability: 'global',
      kind: 'fact',
      title: '不进入浏览列表',
      content: 'private-memory-record',
      tags: [],
      sensitivity: 'restricted',
      suggestedBy: 'human',
      provenance: sessionProvenance,
    })
    const acceptedPersonal = await engine.reviewCandidate(personal.id, 'accept')
    if (acceptedPersonal.target !== 'memory' || acceptedPersonal.localMemoryId === undefined) {
      throw new Error('expected personal local memory')
    }
    await engine.reviewCandidate(restricted.id, 'accept')

    expect(await engine.listRecallable({ limit: 20 })).toMatchObject([
      { id: acceptedPersonal.localMemoryId, status: 'active', recordType: 'personal-memory' },
    ])
    const projectRecords = await engine.listRecallable({ projectRoot: project, limit: 20 })
    expect(projectRecords.map(record => record.id)).toContain(acceptedPersonal.localMemoryId)
    expect(projectRecords.map(record => record.id)).toContain('mem_33333333-3333-4333-8333-333333333333')
    expect(projectRecords.map(record => record.id)).not.toContain(restricted.id)

    const selectedMemory = await engine.listRecallable({
      projectRoot: project,
      domain: 'memory',
      scopeMode: 'selected',
      limit: 20,
    })
    expect(selectedMemory.map(record => record.id)).toEqual(['mem_33333333-3333-4333-8333-333333333333'])
    expect(selectedMemory.every(record => record.recordType === 'project-memory')).toBe(true)

    const selectedKnowledge = await engine.listRecallable({
      projectRoot: project,
      domain: 'knowledge',
      scopeMode: 'selected',
      limit: 20,
    })
    expect(selectedKnowledge.map(record => record.id)).toEqual(['card_44444444-4444-4444-8444-444444444444'])
    expect(selectedKnowledge.every(record => record.recordType === 'knowledge-card')).toBe(true)

    const applicableMemory = await engine.listRecallable({ projectRoot: project, domain: 'memory', limit: 20 })
    expect(applicableMemory.map(record => record.id)).toEqual(expect.arrayContaining([
      acceptedPersonal.localMemoryId,
      'mem_33333333-3333-4333-8333-333333333333',
    ]))
    expect(applicableMemory.every(record => record.recordType !== 'knowledge-card')).toBe(true)

    const knowledgeHits = await engine.search({
      query: '示例模块',
      projectRoot: project,
      domain: 'knowledge',
      scopeMode: 'selected',
      limit: 5,
      maxChars: 4_000,
    })
    expect(knowledgeHits.map(hit => hit.id)).toEqual(['card_44444444-4444-4444-8444-444444444444'])
  })

  it('indexes the current reviewed canonical snapshot with provenance', async () => {
    const engine = await memoryEngine()
    const project = await makeTempProject()
    const hits = await engine.search({ query: '固定问候语', projectRoot: project, limit: 5, maxChars: 4_000 })
    expect(hits.map(hit => hit.id)).toContain('mem_33333333-3333-4333-8333-333333333333')
    expect(hits.find(hit => hit.recordType === 'project-memory')).toMatchObject({
      evidenceClass: 'deterministic',
      sensitivity: 'normal',
    })
  })

  it('keeps an effectively stale Knowledge Card out of recall before canonical status is rewritten', async () => {
    const project = await makeTempProject()
    const engine = await MemoryKnowledgeEngine.open(
      { path: ':memory:', journalMode: 'wal' },
      {
        inspect: async () => ({
          sources: [],
          cards: [{
            cardId: 'card_44444444-4444-4444-8444-444444444444' as never,
            title: '示例模块',
            canonicalStatus: 'verified',
            state: 'stale',
            reasons: [{ kind: 'file-changed', path: 'src/example.ts' }],
          }],
          staleCardCount: 1,
          degradedCardCount: 0,
        }),
      },
    )
    engines.push(engine)
    const records = await engine.listRecallable({ projectRoot: project, limit: 20 })
    expect(records.map(record => record.id)).not.toContain('card_44444444-4444-4444-8444-444444444444')
    expect(records.map(record => record.id)).toContain('mem_33333333-3333-4333-8333-333333333333')
  })

  it('keeps identical canonical ids isolated between project roots', async () => {
    const engine = await memoryEngine()
    const firstProject = await makeTempProject()
    const secondProject = await makeTempProject()
    const entryPath = join(
      secondProject,
      '.dsh',
      'knowledge',
      'entries',
      'mem_33333333-3333-4333-8333-333333333333.json',
    )
    const changed = await readJson(entryPath)
    changed['title'] = '第二个克隆中的独立标题'
    changed['content'] = 'clone-isolation-evidence'
    await writeJson(entryPath, changed)

    const firstId = 'mem_33333333-3333-4333-8333-333333333333'
    const firstHits = await engine.search({ query: '固定问候语', projectRoot: firstProject, limit: 5, maxChars: 4_000 })
    expect(firstHits.find(hit => hit.id === firstId)).toMatchObject({ title: '示例模块返回固定问候语' })
    const secondHits = await engine.search({
      query: 'clone-isolation-evidence',
      projectRoot: secondProject,
      limit: 5,
      maxChars: 4_000,
    })
    expect(secondHits.find(hit => hit.id === firstId)).toMatchObject({ title: '第二个克隆中的独立标题' })
    const repeatedFirstHits = await engine.search({
      query: '固定问候语',
      projectRoot: firstProject,
      limit: 5,
      maxChars: 4_000,
    })
    expect(repeatedFirstHits.find(hit => hit.id === firstId)).toMatchObject({ title: '示例模块返回固定问候语' })
  })

  it('isolates Source evidence packs by canonical project root and reports result truncation', async () => {
    const firstProject = await makeTempProject()
    const secondProject = await makeTempProject()
    await writeFile(join(firstProject, 'src', 'example.ts'), [
      'export const greetingAlpha = true',
      'export const greetingBeta = true',
    ].join('\n'), 'utf8')
    await writeFile(join(secondProject, 'src', 'example.ts'), 'export const farewell = true\n', 'utf8')
    await initializeGitProject(firstProject)
    await initializeGitProject(secondProject)
    const engine = await projectEngine()
    await engine.generateKnowledgeCardCandidates(firstProject)
    await engine.generateKnowledgeCardCandidates(secondProject)

    const limited = await engine.searchSourceEvidence({ projectRoot: firstProject, query: 'greeting', limit: 1 })
    expect(limited).toMatchObject({
      totalMatches: 2,
      omittedHitCount: 1,
      truncationReasons: ['result-limit'],
      hits: [{ path: 'src/example.ts' }],
    })
    await expect(engine.searchSourceEvidence({ projectRoot: secondProject, query: 'greeting', limit: 5 }))
      .resolves.toMatchObject({ totalMatches: 0, hits: [] })
    await expect(engine.searchSourceEvidence({ projectRoot: secondProject, query: 'farewell', limit: 5 }))
      .resolves.toMatchObject({ totalMatches: 1, hits: [{ evidence: { name: 'farewell' } }] })
  })

  it('queries only current project relations with combined filters and stable truncation', async () => {
    const firstProject = await makeTempProject()
    const secondProject = await makeTempProject()
    await writeFile(join(firstProject, 'src', 'dependency.ts'), 'export const dependency = true\n', 'utf8')
    await writeFile(join(firstProject, 'src', 'example.ts'), [
      "import { dependency } from './dependency.js'",
      "import React from 'react'",
      "export { missing } from './missing.js'",
      'export const greeting = dependency',
    ].join('\n'), 'utf8')
    await initializeGitProject(firstProject)
    await initializeGitProject(secondProject)
    const engine = await projectEngine()
    await engine.generateKnowledgeCardCandidates(firstProject)
    await engine.generateKnowledgeCardCandidates(secondProject)

    const limited = await engine.querySourceRelations({ projectRoot: firstProject, limit: 2 })
    expect(limited).toMatchObject({
      retriever: 'source-relations-sql',
      version: 1,
      totalMatches: 3,
      omittedEdgeCount: 1,
      truncationReasons: ['result-limit'],
    })
    expect(limited.edges).toHaveLength(2)
    expect(limited.sourceRevisions).toHaveLength(1)
    await expect(engine.querySourceRelations({
      projectRoot: firstProject,
      query: 'dependency',
      area: 'src',
      resolution: 'internal',
      kind: 'import',
      limit: 10,
    })).resolves.toMatchObject({
      query: 'dependency',
      area: 'src',
      resolution: 'internal',
      kind: 'import',
      totalMatches: 1,
      edges: [{ fromPath: 'src/example.ts', toPath: 'src/dependency.ts', startLine: 1 }],
    })
    await expect(engine.querySourceRelations({ projectRoot: secondProject, limit: 10 }))
      .resolves.toMatchObject({ totalMatches: 0, edges: [], sourceRevisions: [] })
    await expect(engine.querySourceRelations({ projectRoot: firstProject, area: 'tests', limit: 10 }))
      .resolves.toMatchObject({ totalMatches: 0, edges: [] })
  })

  it('queries only current symbol references with combined filters and stable truncation', async () => {
    const firstProject = await makeTempProject()
    const secondProject = await makeTempProject()
    await writeFile(join(firstProject, 'src', 'model.ts'), [
      'export interface User { name: string }',
      'export function greet(user: User): string { return user.name }',
    ].join('\n'), 'utf8')
    await writeFile(join(firstProject, 'src', 'main.ts'), [
      "import { greet, type User } from './model.js'",
      "export const result = greet({ name: 'Ada' } satisfies User)",
    ].join('\n'), 'utf8')
    await initializeGitProject(firstProject)
    await initializeGitProject(secondProject)
    const engine = await projectEngine()
    await engine.generateKnowledgeCardCandidates(firstProject)
    await engine.generateKnowledgeCardCandidates(secondProject)

    const limited = await engine.querySourceSymbols({ projectRoot: firstProject, limit: 1 })
    expect(limited.retriever).toBe('source-symbols-sql')
    expect(limited.version).toBe(2)
    expect(limited.totalMatches).toBeGreaterThan(1)
    expect(limited.edges).toHaveLength(1)
    expect(limited.omittedReferenceCount).toBe(limited.totalMatches - 1)
    expect(limited.truncationReasons).toEqual(['result-limit'])
    expect(limited.sourceRevisions).toHaveLength(1)

    await expect(engine.querySourceSymbols({
      projectRoot: firstProject,
      query: 'greet',
      definitionPath: 'model.ts',
      referencePath: 'main.ts',
      referenceKind: 'value',
      limit: 20,
    })).resolves.toMatchObject({
      query: 'greet',
      definitionPath: 'model.ts',
      referencePath: 'main.ts',
      referenceKind: 'value',
      totalMatches: 1,
      edges: [{
        symbolName: 'greet',
        definitionPath: 'src/model.ts',
        referencePath: 'src/main.ts',
        referenceStartLine: 2,
      }],
    })
    await expect(engine.querySourceSymbols({ projectRoot: secondProject, limit: 20 }))
      .resolves.toMatchObject({ totalMatches: 0, edges: [], sourceRevisions: [] })
  })

  it('replaces stale symbol references with the current Source checkpoint', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'dependency.ts'), 'export const dependency = true\n')
    await writeFile(join(project, 'src', 'example.ts'), [
      "import { dependency } from './dependency.js'",
      'export const greeting = dependency',
    ].join('\n'))
    await initializeGitProject(project)
    const engine = await projectEngine()
    await engine.generateKnowledgeCardCandidates(project)
    expect((await engine.querySourceSymbols({ projectRoot: project, query: 'dependency', limit: 20 })).totalMatches)
      .toBeGreaterThan(0)

    await writeFile(join(project, 'src', 'example.ts'), 'export const greeting = true\n')
    await commitProjectChanges(project, 'remove symbol reference')
    await engine.generateKnowledgeCardCandidates(project)

    expect(await engine.querySourceSymbols({ projectRoot: project, query: 'dependency', limit: 20 }))
      .toMatchObject({ totalMatches: 0, edges: [], sourceRevisions: [] })
  })

  it('replaces stale Source evidence when the current checkpoint changes', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const engine = await projectEngine()
    await engine.generateKnowledgeCardCandidates(project)
    expect(await engine.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 }))
      .toMatchObject({ totalMatches: 1 })

    await writeFile(join(project, 'src', 'example.ts'), 'export const replacementSymbol = true\n', 'utf8')
    await commitProjectChanges(project, 'replace source evidence')
    await engine.generateKnowledgeCardCandidates(project)

    expect(await engine.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 }))
      .toMatchObject({ totalMatches: 0, hits: [] })
    expect(await engine.searchSourceEvidence({ projectRoot: project, query: 'replacementSymbol', limit: 5 }))
      .toMatchObject({ totalMatches: 1, hits: [{ evidence: { name: 'replacementSymbol' } }] })
  })

  it('indexes internal AST members with their declaration container', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'example.ts'), [
      'class Worker {',
      '  runTask(): void {}',
      '}',
      'export { Worker }',
    ].join('\n'), 'utf8')
    await initializeGitProject(project)
    const engine = await projectEngine()
    await engine.generateKnowledgeCardCandidates(project)

    expect(await engine.searchSourceEvidence({ projectRoot: project, query: 'runTask', limit: 5 }))
      .toMatchObject({
        totalMatches: 1,
        hits: [{
          path: 'src/example.ts',
          evidence: {
            kind: 'code-symbol',
            declaration: 'method',
            name: 'runTask',
            exported: false,
            containerName: 'Worker',
            startLine: 2,
            endLine: 2,
          },
        }],
      })
    expect(await engine.searchSourceEvidence({ projectRoot: project, query: 'Worker', limit: 10 }))
      .toMatchObject({ totalMatches: 3 })
  })

  it('reuses persisted Source files after restart and replaces stale evidence', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'README.md'), '# Incremental fixture\n')
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const firstBackend = new CountingSourceInventoryBackend()
    const first = await MemoryKnowledgeEngine.open(
      { path: databasePath, journalMode: 'delete' },
      new KnowledgeProjectInspector(firstBackend, DEFAULT_SOURCE_INVENTORY_CONFIG),
    )
    await first.generateKnowledgeCardCandidates(project)
    expect(firstBackend.readPaths.sort()).toEqual(['README.md', 'src/example.ts'])
    await first.close()

    await writeFile(join(project, 'src', 'example.ts'), 'export function changed(): string {\n  return "changed"\n}\n')
    await commitProjectChanges(project, 'change one source file')
    const secondBackend = new CountingSourceInventoryBackend()
    const reopened = await MemoryKnowledgeEngine.open(
      { path: databasePath, journalMode: 'delete' },
      new KnowledgeProjectInspector(secondBackend, DEFAULT_SOURCE_INVENTORY_CONFIG),
    )
    engines.push(reopened)
    await reopened.generateKnowledgeCardCandidates(project)

    expect(secondBackend.readPaths).toEqual(['src/example.ts'])
    expect(await reopened.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 }))
      .toMatchObject({ totalMatches: 0, hits: [] })
    expect(await reopened.searchSourceEvidence({ projectRoot: project, query: 'changed', limit: 5 }))
      .toMatchObject({ totalMatches: 1, hits: [{ path: 'src/example.ts', evidence: { name: 'changed' } }] })
  })

  it('re-resolves reused importer references when an internal target is renamed', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'dependency.ts'), 'export const dependency = true\n')
    await writeFile(join(project, 'src', 'example.ts'), [
      "import { dependency } from './dependency.js'",
      'export const greeting = dependency',
    ].join('\n'))
    await initializeGitProject(project)
    const databasePath = join(await makeTempDirectory(), 'memory.sqlite')
    const firstBackend = new CountingSourceInventoryBackend()
    const first = await MemoryKnowledgeEngine.open(
      { path: databasePath, journalMode: 'delete' },
      new KnowledgeProjectInspector(firstBackend, DEFAULT_SOURCE_INVENTORY_CONFIG),
    )
    expect((await first.generateKnowledgeCardCandidates(project)).understandings[0])
      .toMatchObject({ relationCount: 1, internalRelationCount: 1, unresolvedRelationCount: 0 })
    expect(await first.querySourceRelations({ projectRoot: project, limit: 10 }))
      .toMatchObject({ totalMatches: 1, edges: [{ resolution: 'internal', toPath: 'src/dependency.ts' }] })
    await first.close()

    await rename(join(project, 'src', 'dependency.ts'), join(project, 'src', 'renamed.ts'))
    await commitProjectChanges(project, 'rename dependency target')
    const incrementalBackend = new CountingSourceInventoryBackend()
    const reopened = await MemoryKnowledgeEngine.open(
      { path: databasePath, journalMode: 'delete' },
      new KnowledgeProjectInspector(incrementalBackend, DEFAULT_SOURCE_INVENTORY_CONFIG),
    )
    engines.push(reopened)
    const incremental = await reopened.generateKnowledgeCardCandidates(project)

    expect(incrementalBackend.readPaths).toEqual(['src/renamed.ts'])
    expect(incremental.understandings[0])
      .toMatchObject({ relationCount: 1, internalRelationCount: 0, unresolvedRelationCount: 1 })
    expect(await reopened.querySourceRelations({ projectRoot: project, limit: 10 }))
      .toMatchObject({ totalMatches: 1, edges: [{ resolution: 'unresolved' }] })

    const coldBackend = new CountingSourceInventoryBackend()
    const cold = await MemoryKnowledgeEngine.open(
      { path: ':memory:', journalMode: 'delete' },
      new KnowledgeProjectInspector(coldBackend, DEFAULT_SOURCE_INVENTORY_CONFIG),
    )
    engines.push(cold)
    const coldResult = await cold.generateKnowledgeCardCandidates(project)
    expect(coldBackend.readPaths.sort()).toEqual(['src/example.ts', 'src/renamed.ts'])
    expect(coldResult.understandings).toEqual(incremental.understandings)
  })

  it('persists Source records and promotes idempotent overview, architecture, and module candidates', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const engine = await projectEngine()

    const [first, repeated] = await Promise.all([
      engine.generateKnowledgeCardCandidates(project),
      engine.generateKnowledgeCardCandidates(project),
    ])
    expect(first.skipped).toEqual([])
    expect(first.understandings).toMatchObject([{
      sourceId: expect.any(String),
      recordCount: 1,
      evidenceCount: 1,
      areaCount: 1,
    }])
    expect(await engine.listSourceUnderstandings(project)).toEqual(first.understandings)
    const evidencePack = await engine.searchSourceEvidence({ projectRoot: project, query: 'greeting', limit: 5 })
    expect(evidencePack).toMatchObject({
      query: 'greeting',
      totalMatches: 1,
      omittedHitCount: 0,
      truncationReasons: [],
      sourceRevisions: [{ sourceId: first.understandings[0]!.sourceId }],
      hits: [{
        path: 'src/example.ts',
        area: 'src',
        artifactKind: 'code',
        language: 'TypeScript',
        evidence: {
          kind: 'code-symbol',
          declaration: 'function',
          name: 'greeting',
          exported: true,
          startLine: 2,
          endLine: 4,
        },
      }],
    })
    expect(first.candidates.map(candidate => candidate.kind)).toEqual(['overview', 'architecture', 'module'])
    expect(repeated.candidates.map(candidate => candidate.id)).toEqual(first.candidates.map(candidate => candidate.id))
    expect(repeated.candidates.map(candidate => candidate.generation.key))
      .toEqual(first.candidates.map(candidate => candidate.generation.key))

    const architecture = first.candidates.find(candidate => candidate.kind === 'architecture')!
    const accepted = await engine.reviewCandidate(architecture.id, 'accept')
    expect((await engine.listRecallable({ projectRoot: project, limit: 20 })).map(record => record.id))
      .not.toContain(accepted.id)

    const promoted = await engine.promoteCandidate(accepted.id, undefined, accepted.revision)
    if (promoted.recordType !== 'knowledge-card') throw new Error('expected Knowledge Card promotion')
    expect(promoted.candidate.status).toBe('promoted')
    expect(promoted.card).toMatchObject({
      kind: 'architecture',
      status: 'verified',
      evidenceClass: 'deterministic',
    })
    await access(promoted.path)
    expect(promoted.path).toContain('/cards/')
    expect(await readFile(join(project, '.dsh', 'knowledge', 'wiki', 'cards', `${promoted.card.id}.md`), 'utf8'))
      .toContain('# 项目结构地图')
    expect(await engine.search({ query: '工件角色', projectRoot: project, limit: 5, maxChars: 4_000 }))
      .toMatchObject([{ id: promoted.card.id, recordType: 'knowledge-card' }])

    const module = first.candidates.find(candidate => candidate.kind === 'module')!
    expect(module.card.sections[0]!.provenance).toMatchObject([{
      kind: 'git-file',
      path: 'src/example.ts',
      startLine: 2,
      endLine: 4,
    }])
    const acceptedModule = await engine.reviewCandidate(module.id, 'accept')
    const promotedModule = await engine.promoteCandidate(acceptedModule.id, undefined, acceptedModule.revision)
    if (promotedModule.recordType !== 'knowledge-card') throw new Error('expected module Knowledge Card promotion')
    expect(promotedModule.card).toMatchObject({ kind: 'module', status: 'verified' })
    expect(await readFile(join(project, '.dsh', 'knowledge', 'wiki', 'cards', `${promotedModule.card.id}.md`), 'utf8'))
      .toContain('src/example.ts:2-4')

    const overview = first.candidates.find(candidate => candidate.kind === 'overview')!
    const acceptedOverview = await engine.reviewCandidate(overview.id, 'accept')
    await engine.promoteCandidate(acceptedOverview.id, undefined, acceptedOverview.revision)

    await commitProjectChanges(project, 'knowledge projection')
    const current = await engine.generateKnowledgeCardCandidates(project)
    expect(current.candidates).toEqual([])
    expect(current.skipped).toMatchObject([
      { cardKind: 'overview', kind: 'already-current' },
      { cardKind: 'architecture', kind: 'already-current' },
      { cardKind: 'module', kind: 'already-current' },
    ])
  })

  it('refuses to promote a Knowledge Card candidate after its source inventory changes', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const engine = await projectEngine()
    const generated = await engine.generateKnowledgeCardCandidates(project)
    const architecture = generated.candidates.find(candidate => candidate.kind === 'architecture')!
    const accepted = await engine.reviewCandidate(architecture.id, 'accept')
    await writeFile(join(project, 'src', 'example.ts'), 'export const changed = true\n', 'utf8')

    await expect(engine.promoteCandidate(accepted.id, undefined, accepted.revision))
      .rejects.toThrow('source changed; generate a new candidate')
  })

  it('keeps a rejected generation checkpoint instead of recreating the same candidate', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const engine = await projectEngine()
    const generated = await engine.generateKnowledgeCardCandidates(project)
    const architecture = generated.candidates.find(candidate => candidate.kind === 'architecture')!
    const rejected = await engine.reviewCandidate(architecture.id, 'reject')

    const repeated = await engine.generateKnowledgeCardCandidates(project)
    expect(repeated.candidates.find(candidate => candidate.kind === 'architecture'))
      .toMatchObject({ id: rejected.id, status: 'rejected', generation: architecture.generation })
    expect(await engine.listCandidates({ projectRoot: project, limit: 20 })).toHaveLength(3)
  })

  it('promotes a project candidate into canonical JSON and its Markdown projection', async () => {
    const engine = await memoryEngine()
    const project = await makeTempProject()
    const candidate = await engine.saveCandidate({
      target: 'memory',
      applicability: 'project',
      projectRoot: project,
      kind: 'decision',
      title: '索引采用本地 FTS5',
      content: '项目记忆索引使用 SQLite FTS5，并保留 canonical JSON 作为事实来源。',
      tags: ['fts5', 'memory'],
      sensitivity: 'normal',
      suggestedBy: 'model',
      provenance: sessionProvenance,
    })

    await expect(engine.promoteCandidate(candidate.id)).rejects.toThrow('must be accepted before promotion')
    await engine.reviewCandidate(candidate.id, 'accept')
    const promoted = await engine.promoteCandidate(candidate.id)
    if (promoted.recordType !== 'memory') throw new Error('expected memory promotion')
    expect(promoted.candidate.status).toBe('promoted')
    expect(promoted.memory.evidenceClass).toBe('human-verified')
    await access(promoted.path)
    const canonical = JSON.parse(await readFile(promoted.path, 'utf8')) as { id: string; title: string }
    expect(canonical).toMatchObject({ id: promoted.memory.id, title: '索引采用本地 FTS5' })
    const wiki = join(project, '.dsh', 'knowledge', 'wiki', 'memory', `${promoted.memory.id}.md`)
    expect(await readFile(wiki, 'utf8')).toContain('# 索引采用本地 FTS5')
    expect(await engine.search({ query: 'FTS5', projectRoot: project, limit: 5, maxChars: 4_000 }))
      .toMatchObject([{ id: promoted.memory.id, recordType: 'project-memory' }])
  })
})
