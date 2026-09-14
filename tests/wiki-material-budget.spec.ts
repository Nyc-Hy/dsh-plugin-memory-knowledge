import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKnowledgeEngine } from '../src/engine.js'
import { KnowledgeSourceId, WikiRunId, WikiTaskId } from '../src/ids.js'
import { failWikiTask, startWikiTask, succeedWikiTask } from '../src/wiki-task.js'
import { WikiMaterialBudgetConflictError } from '../src/wiki-material-budget.js'
import { runCli } from '../src/cli.js'
import { makeTempDirectory, makeTempProject } from './helpers.js'

const engines: MemoryKnowledgeEngine[] = []
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.close())) })

async function fixture(itemCount = 1) {
  const databasePath = join(await makeTempDirectory(), 'budget.sqlite')
  const engine = await MemoryKnowledgeEngine.open({ path: databasePath, journalMode: 'wal', wikiShards: { maxItems: 1 } })
  engines.push(engine)
  const planned = await engine.planWikiRun({
    projectRoot: await makeTempProject(), catalogHash: `sha256:${'1'.repeat(64)}`,
    catalogComplete: true, catalogOmittedItemCount: 0,
    entries: Array.from({ length: itemCount }, (_, index) => ({ sourceId: KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111'),
      path: `unknown-${index}.ext`, byteSize: 60, revision: { kind: 'content-hash' as const, contentHash: `sha256:${'2'.repeat(64)}` } })),
  })
  const taskId = planned.tasks[0]!.id
  const agentSessionId = SessionId('session-material-budget')
  const started = await engine.saveWikiRunSnapshot(startWikiTask(planned, taskId, agentSessionId), planned.snapshotHash)
  const key = { runId: planned.run.id, taskId }
  const request = { ...key, agentSessionId, byteSize: 60, limitBytes: 100 }
  return { engine, databasePath, started, key, request }
}

describe('Wiki 材料读取持久账本', () => {
  it('读取、拒绝和扩额会改变确认版本；过期确认不覆盖新账本', async () => {
    const test = await fixture()
    const query = { projectRoot: test.started.run.projectRoot, runId: test.key.runId, onlyBlocked: false, limit: 20 }
    expect(await test.engine.listWikiMaterialReadBudgets(query)).toEqual({ items: [] })
    await test.engine.reserveWikiMaterialRead(test.request)
    const first = (await test.engine.listWikiMaterialReadBudgets(query)).items[0]!
    await test.engine.reserveWikiMaterialRead(test.request)
    const blocked = (await test.engine.listWikiMaterialReadBudgets(query)).items[0]!
    expect(blocked.budgetHash).not.toBe(first.budgetHash)
    await expect(test.engine.increaseWikiMaterialReadBudget(test.key, 120, {
      projectRoot: query.projectRoot, expectedBudgetHash: first.budgetHash,
    })).rejects.toBeInstanceOf(WikiMaterialBudgetConflictError)
    const guard = { projectRoot: query.projectRoot, expectedBudgetHash: blocked.budgetHash }
    const other = await MemoryKnowledgeEngine.open({ path: test.databasePath, journalMode: 'wal' })
    engines.push(other)
    const grants = await Promise.allSettled([
      test.engine.increaseWikiMaterialReadBudget(test.key, 120, guard),
      other.increaseWikiMaterialReadBudget(test.key, 140, guard),
    ])
    expect(grants.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(grants.find(value => value.status === 'rejected')).toMatchObject({ reason: expect.any(WikiMaterialBudgetConflictError) })
    const updated = (await test.engine.listWikiMaterialReadBudgets(query)).items[0]!
    expect(updated.budgetHash).not.toBe(blocked.budgetHash)
    expect(updated.budget).toMatchObject({ reservedBytes: 60, reservationCount: 1, blockedReadBytes: null })
    await test.engine.reserveWikiMaterialRead(test.request)
    expect((await test.engine.listWikiMaterialReadBudgets(query)).items[0]!.budgetHash).not.toBe(updated.budgetHash)
  })

  it('按项目验证查询与确认扩额，拒绝其他项目、Run、任务和已完成任务', async () => {
    const test = await fixture()
    const budget = await test.engine.reserveWikiMaterialRead(test.request)
    const query = { projectRoot: test.started.run.projectRoot, runId: test.key.runId, onlyBlocked: false, limit: 20 }
    const row = (await test.engine.listWikiMaterialReadBudgets(query)).items[0]!
    const guard = { projectRoot: query.projectRoot, expectedBudgetHash: row.budgetHash }
    const otherProject = await makeTempProject()
    await expect(test.engine.listWikiMaterialReadBudgets({ ...query, projectRoot: otherProject })).rejects.toThrow('不属于当前项目')
    await expect(test.engine.listWikiMaterialReadBudgets({ ...query, runId: WikiRunId('wrun_22222222-2222-4222-8222-222222222222') })).rejects.toThrow('不属于当前项目')
    await expect(test.engine.listWikiMaterialReadBudgets({ ...query, limit: 0 })).rejects.toThrow('正安全整数')
    await expect(test.engine.increaseWikiMaterialReadBudget(test.key, 200, { ...guard, projectRoot: otherProject })).rejects.toThrow('不属于当前项目')
    await expect(test.engine.increaseWikiMaterialReadBudget({ ...test.key, taskId: WikiTaskId(`wtask_${'0'.repeat(64)}`) }, 200, guard)).rejects.toThrow('尚无')
    expect(await test.engine.getWikiMaterialReadBudget(test.key)).toEqual(budget)
    const completed = succeedWikiTask(test.started, test.key.taskId, {
      coverage: test.started.tasks[0]!.coverageIds.map(coverageId => ({ coverageId, status: 'analyzed', contentHash: `sha256:${'2'.repeat(64)}` })),
      citations: [], claims: [],
    })
    await test.engine.saveWikiRunSnapshot(completed, test.started.snapshotHash)
    await expect(test.engine.increaseWikiMaterialReadBudget(test.key, 200, guard)).rejects.toThrow('尚未完成')
    expect(await test.engine.getWikiMaterialReadBudget(test.key)).toEqual(budget)
  })

  it('大任务列表按游标分页且仅返回已记账任务，预算不足筛选可翻页', async () => {
    const test = await fixture(23)
    let snapshot = test.started
    const taskIds = snapshot.tasks.map(task => task.id)
    for (const [index, taskId] of taskIds.slice(0, 22).entries()) {
      if (index > 0) snapshot = await test.engine.saveWikiRunSnapshot(startWikiTask(snapshot, taskId, test.request.agentSessionId), snapshot.snapshotHash)
      const request = { ...test.request, taskId }
      await test.engine.reserveWikiMaterialRead(request)
      if (index % 2 === 0) await test.engine.reserveWikiMaterialRead(request)
      snapshot = await test.engine.saveWikiRunSnapshot(failWikiTask(snapshot, taskId, '暂停'), snapshot.snapshotHash)
    }
    const query = { projectRoot: snapshot.run.projectRoot, runId: snapshot.run.id, onlyBlocked: false, limit: 20 }
    const first = await test.engine.listWikiMaterialReadBudgets(query)
    const second = await test.engine.listWikiMaterialReadBudgets({ ...query, afterTaskId: first.nextAfterTaskId! })
    expect(first.items).toHaveLength(20)
    expect(second.items).toHaveLength(2)
    expect(second.nextAfterTaskId).toBeUndefined()
    expect([...first.items, ...second.items].map(item => item.budget.taskId)).toEqual(taskIds.slice(0, 22).sort())
    const blocked = await test.engine.listWikiMaterialReadBudgets({ ...query, onlyBlocked: true, limit: 10 })
    const blockedTail = await test.engine.listWikiMaterialReadBudgets({ ...query, onlyBlocked: true, limit: 10, afterTaskId: blocked.nextAfterTaskId! })
    expect(blocked.items).toHaveLength(10)
    expect(blockedTail.items).toHaveLength(1)
    expect([...blocked.items, ...blockedTail.items].every(item => item.budget.blockedReadBytes === 60 && item.status === 'failed')).toBe(true)
    expect(blockedTail.nextAfterTaskId).toBeUndefined()
  })

  it('两个数据库连接并发预扣不超额，快照替换与重启不重置账本', async () => {
    const test = await fixture()
    const other = await MemoryKnowledgeEngine.open({ path: test.databasePath, journalMode: 'wal' })
    engines.push(other)
    const results = await Promise.all([test.engine.reserveWikiMaterialRead(test.request), other.reserveWikiMaterialRead(test.request)])
    expect(results.map(value => value.blockedReadBytes)).toEqual([null, 60])
    expect(await test.engine.getWikiRunSnapshot(test.key.runId)).toEqual(test.started)
    const failed = failWikiTask(test.started, test.key.taskId, '材料额度耗尽')
    await test.engine.saveWikiRunSnapshot(failed, test.started.snapshotHash)
    await other.close()
    const reopened = await MemoryKnowledgeEngine.open({ path: test.databasePath, journalMode: 'wal' })
    engines.push(reopened)
    expect(await reopened.getWikiMaterialReadBudget(test.key)).toMatchObject({
      limitBytes: 100, reservedBytes: 60, reservationCount: 1, blockedReadBytes: 60,
    })
    const retry = startWikiTask(failed, test.key.taskId, SessionId('session-budget-retry'))
    await reopened.saveWikiRunSnapshot(retry, failed.snapshotHash)
    expect(await reopened.reserveWikiMaterialRead({ ...test.request, agentSessionId: retry.tasks[0]!.agentSessionId!, limitBytes: 10_000 }))
      .toMatchObject({ limitBytes: 100, reservedBytes: 60, reservationCount: 1, blockedReadBytes: 60 })
  })

  it('CLI 显式扩额保留消耗；拒绝减额、无效输入和不足以重试的额度', async () => {
    const test = await fixture()
    await test.engine.reserveWikiMaterialRead(test.request)
    await test.engine.reserveWikiMaterialRead(test.request)
    const output: string[] = []
    const errors: string[] = []
    const io = { out: (value: string) => { output.push(value) }, error: (value: string) => { errors.push(value) } }
    const args = ['wiki-budget', test.key.runId, test.key.taskId, '--db', test.databasePath]
    expect(await runCli(args, io)).toBe(0)
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ reservedBytes: 60, blockedReadBytes: 60 })
    for (const limit of ['99', '110', '-1', 'Infinity']) expect(await runCli([...args, '--limit', limit], io)).toBe(1)
    expect(await runCli([...args, '--status', 'pending'], io)).toBe(1)
    expect(await runCli(['wiki-budget', 'wrong', 'wrong', '--db', test.databasePath], io)).toBe(1)
    expect(await runCli([...args, '--limit', '120'], io)).toBe(0)
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ limitBytes: 120, reservedBytes: 60, reservationCount: 1, blockedReadBytes: null })
    expect(await test.engine.reserveWikiMaterialRead(test.request)).toMatchObject({ limitBytes: 120, reservedBytes: 120, reservationCount: 2 })
  })

  it('拒绝过期 Session 和非运行任务，不创建账本', async () => {
    const test = await fixture()
    await expect(test.engine.reserveWikiMaterialRead({ ...test.request, agentSessionId: SessionId('session-wrong') }))
      .rejects.toThrow('不属于当前运行')
    await expect(test.engine.reserveWikiMaterialRead({ ...test.request, byteSize: -1 })).rejects.toThrow()
    await test.engine.saveWikiRunSnapshot(failWikiTask(test.started, test.key.taskId, 'failed'), test.started.snapshotHash)
    await expect(test.engine.reserveWikiMaterialRead(test.request)).rejects.toThrow('不属于当前运行')
    expect(await test.engine.getWikiMaterialReadBudget(test.key)).toBeUndefined()
    await expect(test.engine.increaseWikiMaterialReadBudget(test.key, 200)).rejects.toThrow('尚无')
  })

  it('v19 升级不虚构历史消耗，仍运行的任务在首次读取时建立账本', async () => {
    const test = await fixture()
    await test.engine.close()
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(test.databasePath)
    legacy.exec('DROP TABLE wiki_material_budgets')
    legacy.exec('PRAGMA user_version = 19')
    legacy.close()
    const upgraded = await MemoryKnowledgeEngine.open({ path: test.databasePath, journalMode: 'wal' })
    engines.push(upgraded)
    expect(await upgraded.getWikiRunSnapshot(test.key.runId)).toEqual(test.started)
    expect(await upgraded.getWikiMaterialReadBudget(test.key)).toBeUndefined()
    expect(await upgraded.reserveWikiMaterialRead(test.request)).toMatchObject({ startedAtAttempt: 1, reservationCount: 1 })
    const database = new DatabaseSync(test.databasePath, { readOnly: true })
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 23 })
    database.close()
  })

  it('持久账本的非法计数拒绝加载', async () => {
    const test = await fixture()
    const budget = await test.engine.reserveWikiMaterialRead(test.request)
    await test.engine.close()
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(test.databasePath)
    database.prepare('UPDATE wiki_material_budgets SET payload_json = ?').run(JSON.stringify({ ...budget, reservedBytes: 101 }))
    database.close()
    const reopened = await MemoryKnowledgeEngine.open({ path: test.databasePath, journalMode: 'wal' })
    engines.push(reopened)
    await expect(reopened.getWikiMaterialReadBudget(test.key)).rejects.toThrow('计数不一致')
  })
})
