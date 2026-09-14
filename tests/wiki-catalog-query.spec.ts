import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryKnowledgeEngine } from '../src/engine.js'
import { KnowledgeSourceId } from '../src/ids.js'
import { startWikiTask } from '../src/wiki-task.js'
import { makeTempDirectory, makeTempProject } from './helpers.js'

const engines: MemoryKnowledgeEngine[] = []
const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
const otherSourceId = KnowledgeSourceId('src_22222222-2222-4222-8222-222222222222')
const contentHash = `sha256:${'1'.repeat(64)}`

afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.close()))
})

async function runningFixture(ranged = false) {
  const projectRoot = await makeTempProject()
  const databasePath = join(await makeTempDirectory(), 'catalog.sqlite')
  const engine = await MemoryKnowledgeEngine.open({
    path: databasePath,
    journalMode: 'wal',
    wikiShards: { maxItems: 1 },
  })
  engines.push(engine)
  const entries = ranged ? [{
    sourceId,
    path: '大文件/未知语言.blob',
    byteSize: 100,
    revision: { kind: 'git-object' as const, commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
    preparedMaterial: {
      contentHash,
      ranges: Array.from({ length: 3 }, (_, ordinal) => ({
        ordinal,
        startByte: ordinal * 30,
        endByte: ordinal === 2 ? 100 : (ordinal + 1) * 30,
        startLine: ordinal + 1,
        endLine: ordinal + 1,
        contentStartByte: ordinal * 30,
        contentEndByte: ordinal === 2 ? 100 : (ordinal + 1) * 30,
        contentStartLine: ordinal + 1,
        contentEndLine: ordinal + 1,
        contentHash,
      })),
    },
  }, {
    sourceId,
    path: 'plain.txt',
    byteSize: 12,
    revision: { kind: 'content-hash' as const, contentHash },
  }] : [
    { sourceId, path: 'src/入口.未知', byteSize: 12, revision: { kind: 'content-hash' as const, contentHash } },
    { sourceId: otherSourceId, path: 'src/入口.未知', byteSize: 12, revision: { kind: 'content-hash' as const, contentHash } },
    { sourceId, path: 'docs/100%_literal.md', byteSize: 12, revision: { kind: 'content-hash' as const, contentHash } },
    { sourceId, path: 'lib/runtime.py', byteSize: 12, revision: { kind: 'content-hash' as const, contentHash } },
  ]
  const planned = await engine.planWikiRun({
    projectRoot,
    catalogHash: `sha256:${'2'.repeat(64)}`,
    catalogComplete: true,
    catalogOmittedItemCount: 0,
    entries,
  })
  const task = planned.tasks.find(item => ranged ? item.materialRanges.length > 0 : true)!
  const agentSessionId = SessionId('session-catalog-test')
  const running = await engine.saveWikiRunSnapshot(startWikiTask(planned, task.id, agentSessionId), planned.snapshotHash)
  return { engine, running, task, projectRoot, agentSessionId }
}

describe('Wiki catalog metadata query', () => {
  it('paginates literal paths without loading source or creating a material budget', async () => {
    const fixture = await runningFixture()
    const request = {
      projectRoot: fixture.projectRoot,
      runId: fixture.running.run.id,
      taskId: fixture.task.id,
      agentSessionId: fixture.agentSessionId,
      query: '',
      scope: 'run' as const,
      limit: 1,
      maxCharacters: 16_000,
    }
    const first = await fixture.engine.searchWikiCatalog(request)
    expect(first.items).toHaveLength(1)
    expect(first.metadataOnly).toBe(true)
    expect(first.items[0]).toEqual(expect.objectContaining({ assignedToTask: expect.any(Boolean), requiresRange: false }))
    const second = await fixture.engine.searchWikiCatalog({ ...request, cursor: first.nextCursor! })
    expect(second.items[0]!.coverageId).not.toBe(first.items[0]!.coverageId)
    expect(await fixture.engine.getWikiMaterialReadBudget({ runId: request.runId, taskId: request.taskId }))
      .toBeUndefined()

    const taskScoped = await fixture.engine.searchWikiCatalog({ ...request, scope: 'task' })
    expect(taskScoped.items).toHaveLength(1)
    expect(taskScoped.items[0]).toEqual(expect.objectContaining({ assignedToTask: true }))
  })

  it('uses case-sensitive literal matching and source filtering for unknown and Unicode paths', async () => {
    const fixture = await runningFixture()
    const request = {
      projectRoot: fixture.projectRoot,
      runId: fixture.running.run.id,
      taskId: fixture.task.id,
      agentSessionId: fixture.agentSessionId,
      scope: 'run' as const,
      limit: 20,
      maxCharacters: 16_000,
    }
    expect((await fixture.engine.searchWikiCatalog({ ...request, query: '入口.未知' })).items).toHaveLength(2)
    expect((await fixture.engine.searchWikiCatalog({ ...request, query: '%_' })).items)
      .toEqual([expect.objectContaining({ path: 'docs/100%_literal.md' })])
    expect((await fixture.engine.searchWikiCatalog({ ...request, query: 'RUNTIME' })).items).toEqual([])
    expect((await fixture.engine.searchWikiCatalog({ ...request, query: '入口.未知', sourceId: otherSourceId })).items)
      .toEqual([expect.objectContaining({ sourceId: otherSourceId })])
  })

  it('binds cursors to query identity and rejects task or Session reuse', async () => {
    const fixture = await runningFixture()
    const request = {
      projectRoot: fixture.projectRoot,
      runId: fixture.running.run.id,
      taskId: fixture.task.id,
      agentSessionId: fixture.agentSessionId,
      query: '',
      scope: 'run' as const,
      limit: 1,
      maxCharacters: 16_000,
    }
    const cursor = (await fixture.engine.searchWikiCatalog(request)).nextCursor!
    await expect(fixture.engine.searchWikiCatalog({ ...request, query: 'src', cursor })).rejects.toThrow('游标不属于')
    await expect(fixture.engine.searchWikiCatalog({ ...request, limit: 2, cursor })).rejects.toThrow('游标不属于')
    await expect(fixture.engine.searchWikiCatalog({ ...request, maxCharacters: 15_999, cursor })).rejects.toThrow('游标不属于')
    await expect(fixture.engine.searchWikiCatalog({ ...request, agentSessionId: SessionId('session-other'), cursor }))
      .rejects.toThrow('当前运行')
    await expect(fixture.engine.searchWikiCatalog({ ...request, cursor: 'invalid' as never })).rejects.toThrow()
    await expect(fixture.engine.searchWikiCatalog({ ...request, maxCharacters: 1 })).rejects.toThrow('字符预算')
  })

  it('lists prepared ranges with stable order and marks only the assigned range readable', async () => {
    const fixture = await runningFixture(true)
    const request = {
      projectRoot: fixture.projectRoot,
      runId: fixture.running.run.id,
      taskId: fixture.task.id,
      agentSessionId: fixture.agentSessionId,
      coverageId: fixture.task.coverageIds[0]!,
      limit: 2,
      maxCharacters: 16_000,
    }
    const first = await fixture.engine.listWikiCatalogRanges(request)
    const second = await fixture.engine.listWikiCatalogRanges({ ...request, cursor: first.nextCursor! })
    const items = [...first.items, ...second.items]
    expect(items.map(item => item.range.ordinal).sort((left, right) => left - right)).toEqual([0, 1, 2])
    expect(items.filter(item => item.assignedToTask)).toHaveLength(1)
    expect(items.every(item => item.range.coverageId === request.coverageId)).toBe(true)
    const files = await fixture.engine.searchWikiCatalog({
      projectRoot: fixture.projectRoot,
      runId: fixture.running.run.id,
      taskId: fixture.task.id,
      agentSessionId: fixture.agentSessionId,
      query: '未知语言',
      scope: 'run',
      limit: 20,
      maxCharacters: 16_000,
    })
    expect(files.items[0]).toEqual(expect.objectContaining({ requiresRange: true }))
  })
})
