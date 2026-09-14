import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { WikiRunId, WIKI_RUN_ID_PATTERN, WikiTaskId, WIKI_TASK_ID_PATTERN } from './ids.js'

/** 一个任务的材料读取账本身份；重试和恢复沿用相同身份。 */
export interface WikiMaterialBudgetKey {
  runId: WikiRunId
  taskId: WikiTaskId
}

/** 预扣的原文字节，不代表模型 token、实际传输量或成功读取量。 */
export interface WikiMaterialReadBudget extends WikiMaterialBudgetKey {
  limitBytes: number
  reservedBytes: number
  reservationCount: number
  blockedReadBytes: number | null
  startedAtAttempt: number
  startedAt: string
}

/** 首次预扣固定额度；后续请求中的 limitBytes 不覆盖已持久化额度。 */
export interface ReserveWikiMaterialRead extends WikiMaterialBudgetKey {
  agentSessionId: SessionId
  byteSize: number
  limitBytes: number
}

/** 按项目和游标查询已存在的账本，不加载项目 Coverage。 */
export interface ListWikiMaterialBudgetsRequest {
  projectRoot: string
  runId: WikiRunId
  onlyBlocked: boolean
  afterTaskId?: WikiTaskId
  limit: number
}

/** 当前任务状态与已校验账本；hash 用于人工扩额的乐观并发校验。 */
export interface WikiTaskMaterialBudget {
  budget: WikiMaterialReadBudget
  budgetHash: string
  kind: 'analysis' | 'file-synthesis' | 'verification' | 'consistency' | 'page'
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'cancelled'
}

/** 一页账本；没有账本的任务不表示历史消耗为零。 */
export interface WikiMaterialBudgetPage {
  items: WikiTaskMaterialBudget[]
  nextAfterTaskId?: WikiTaskId
}

/** 浏览器操作者确认的项目与完整账本版本。 */
export interface WikiMaterialBudgetUpdateGuard {
  projectRoot: string
  expectedBudgetHash: string
}

/** 账本在人工确认后发生了读取、拒绝或扩额。 */
export class WikiMaterialBudgetConflictError extends Error {
  constructor() { super('Wiki 材料读取账本已变化，请刷新并重新确认额度') }
}

/** 计算账本版本，不改变持久化格式。
 * @param budget 已校验的账本。
 * @returns 完整账本的 SHA-256。
 */
export function wikiMaterialBudgetHash(budget: WikiMaterialReadBudget): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(budgetSchema.parse(budget))).digest('hex')}`
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const budgetSchema = z.object({
  runId: z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN)).transform(WikiRunId),
  taskId: z.string().regex(new RegExp(WIKI_TASK_ID_PATTERN)).transform(WikiTaskId),
  limitBytes: count.refine(value => value > 0),
  reservedBytes: count,
  reservationCount: count,
  blockedReadBytes: count.nullable(),
  startedAtAttempt: count.refine(value => value > 0),
  startedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.reservedBytes > value.limitBytes
    || (value.reservationCount === 0 && value.reservedBytes !== 0)
    || (value.blockedReadBytes !== null && value.blockedReadBytes <= value.limitBytes - value.reservedBytes)) {
    context.addIssue({ code: 'custom', message: 'Wiki 材料读取账本计数不一致' })
  }
})

const taskOwnerSchema = z.object({
  kind: z.enum(['analysis', 'file-synthesis', 'verification', 'consistency', 'page']),
  status: z.enum(['planned', 'running', 'succeeded', 'failed', 'cancelled']),
  agentSessionId: z.string().optional(),
  attemptCount: count,
})

function assertProjectRun(database: DatabaseSync, runId: WikiRunId, projectRoot: string): void {
  const row = database.prepare('SELECT project_root FROM wiki_runs WHERE id = ?').get(runId) as { project_root: string } | undefined
  if (row?.project_root !== projectRoot) throw new Error('Wiki 预算运行不属于当前项目')
}

/** 在读取事务内分页查询已记账任务；不返回 Session、源码或本机路径。
 * @param database 已开启事务的本地数据库。
 * @param request 项目、Run、筛选条件和有界游标。
 * @returns 一页已校验账本和可选下一页游标。
 */
export function listWikiMaterialBudgets(database: DatabaseSync, request: ListWikiMaterialBudgetsRequest): WikiMaterialBudgetPage {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Wiki 预算查询条数必须是可递增的正安全整数')
  }
  assertProjectRun(database, request.runId, request.projectRoot)
  const rows = database.prepare(`SELECT b.task_id, t.payload_json AS task_json FROM wiki_material_budgets b
    JOIN wiki_tasks t ON t.run_id = b.run_id AND t.id = b.task_id
    WHERE b.run_id = ? AND b.task_id > ? AND (? = 0 OR json_extract(b.payload_json, '$.blockedReadBytes') IS NOT NULL)
    ORDER BY b.task_id LIMIT ?`)
    .all(request.runId, request.afterTaskId ?? '', request.onlyBlocked ? 1 : 0, request.limit + 1) as Array<{ task_id: string; task_json: string }>
  const items = rows.slice(0, request.limit).map(row => {
    const budget = readWikiMaterialBudget(database, { runId: request.runId, taskId: WikiTaskId(row.task_id) })!
    const task = taskOwnerSchema.parse(JSON.parse(row.task_json))
    return { budget, budgetHash: wikiMaterialBudgetHash(budget), kind: task.kind, status: task.status }
  })
  return { items, ...(rows.length > request.limit ? { nextAfterTaskId: items.at(-1)!.budget.taskId } : {}) }
}

/** 读取并校验持久化账本；不存在的账本不表示历史消耗为零。
 * @param database 本地数据库。
 * @param key 任务身份。
 * @returns 当前账本或尚未开始记账。
 */
export function readWikiMaterialBudget(database: DatabaseSync, key: WikiMaterialBudgetKey): WikiMaterialReadBudget | undefined {
  const row = database.prepare('SELECT payload_json FROM wiki_material_budgets WHERE run_id = ? AND task_id = ?')
    .get(key.runId, key.taskId) as { payload_json: string } | undefined
  if (row === undefined) return undefined
  const budget = budgetSchema.parse(JSON.parse(row.payload_json))
  if (budget.runId !== key.runId || budget.taskId !== key.taskId) throw new Error('Wiki 材料读取账本身份不匹配')
  return budget
}

function writeBudget(database: DatabaseSync, budget: WikiMaterialReadBudget): WikiMaterialReadBudget {
  const validated = budgetSchema.parse(budget)
  database.prepare(`INSERT INTO wiki_material_budgets (run_id, task_id, payload_json) VALUES (?, ?, ?)
    ON CONFLICT(run_id, task_id) DO UPDATE SET payload_json = excluded.payload_json`)
    .run(validated.runId, validated.taskId, JSON.stringify(validated))
  return validated
}

/** 在调用者的事务内先预扣再读取；失败、取消和重复读取不退款。
 * @param database 已开启写事务的本地数据库。
 * @param request 当前运行 Session、材料字节数与首次额度。
 * @returns 预扣后的账本；blockedReadBytes 非空时禁止读取和提交事实。
 */
export function reserveWikiMaterialBudget(database: DatabaseSync, request: ReserveWikiMaterialRead): WikiMaterialReadBudget {
  count.parse(request.byteSize)
  count.refine(value => value > 0).parse(request.limitBytes)
  const row = database.prepare('SELECT payload_json FROM wiki_tasks WHERE run_id = ? AND id = ?')
    .get(request.runId, request.taskId) as { payload_json: string } | undefined
  if (row === undefined) throw new Error('Wiki 材料读取任务不存在')
  const task = taskOwnerSchema.parse(JSON.parse(row.payload_json))
  if (task.kind === 'page' || task.status !== 'running' || task.agentSessionId !== request.agentSessionId) {
    throw new Error('Wiki 材料读取不属于当前运行 Session')
  }
  const budget = readWikiMaterialBudget(database, request) ?? {
    runId: request.runId, taskId: request.taskId, limitBytes: request.limitBytes,
    reservedBytes: 0, reservationCount: 0, blockedReadBytes: null,
    startedAtAttempt: task.attemptCount, startedAt: new Date().toISOString(),
  }
  if (budget.blockedReadBytes !== null) return budget
  if (request.byteSize > budget.limitBytes - budget.reservedBytes) {
    budget.blockedReadBytes = request.byteSize
  } else {
    budget.reservedBytes += request.byteSize
    budget.reservationCount += 1
  }
  return writeBudget(database, budget)
}

/** 操作者显式扩额，不清除消耗；新额度必须能容纳被拒绝的那次读取。
 * @param database 已开启写事务的本地数据库。
 * @param key 任务身份。
 * @param limitBytes 新的累计额度。
 * @param guard 浏览器操作必须携带项目身份和操作者所见的完整账本版本。
 * @returns 扩额后的账本。
 */
export function increaseWikiMaterialBudget(
  database: DatabaseSync, key: WikiMaterialBudgetKey, limitBytes: number, guard?: WikiMaterialBudgetUpdateGuard,
): WikiMaterialReadBudget {
  if (guard !== undefined) assertProjectRun(database, key.runId, guard.projectRoot)
  const budget = readWikiMaterialBudget(database, key)
  if (budget === undefined) throw new Error('Wiki 任务尚无材料读取账本')
  if (guard !== undefined) {
    if (wikiMaterialBudgetHash(budget) !== guard.expectedBudgetHash) throw new WikiMaterialBudgetConflictError()
    const row = database.prepare('SELECT payload_json FROM wiki_tasks WHERE run_id = ? AND id = ?')
      .get(key.runId, key.taskId) as { payload_json: string } | undefined
    if (row === undefined) throw new Error('Wiki 预算任务不存在')
    const task = taskOwnerSchema.parse(JSON.parse(row.payload_json))
    if (task.kind === 'page' || !['running', 'failed', 'cancelled'].includes(task.status)) {
      throw new Error('只有尚未完成的材料读取任务可以在页面扩额')
    }
  }
  if (limitBytes <= budget.limitBytes || limitBytes - budget.reservedBytes < (budget.blockedReadBytes ?? 0)) {
    throw new Error('新额度必须高于当前额度，并容纳被拒绝的读取；消耗不会清零')
  }
  return writeBudget(database, { ...budget, limitBytes, blockedReadBytes: null })
}

/** 生成可审计的停止原因与本机恢复入口。
 * @param budget 已耗尽的任务账本。
 * @returns 不包含本机路径的错误文本。
 */
export function wikiMaterialBudgetFailure(budget: WikiMaterialReadBudget): string {
  return `Wiki 材料读取预算不足：已预扣 ${budget.reservedBytes}/${budget.limitBytes} 字节，本次需要 ${budget.blockedReadBytes} 字节。`
    + `任务未完成，未读取的材料不能作为证据。请使用 wiki-budget ${budget.runId} ${budget.taskId} --limit <新总字节数> 显式扩额后重试。`
}
