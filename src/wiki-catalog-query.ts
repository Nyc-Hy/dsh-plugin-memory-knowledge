/** Wiki 元数据导航只分页读取 SQLite 记录，不读取原文，也不证明材料已被模型阅读。 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { KnowledgeSourceId, WikiCoverageId, WikiRunId, WikiTaskId } from './ids.js'
import { parseWikiCoverageItem, parseWikiShardTask, type WikiCoverageItem, type WikiMaterialRange, type WikiShardTask } from './wiki-model.js'

/** 绑定 Run、任务、Session 与查询条件的定位游标。 */
export type WikiCatalogCursor = Branded<'WikiCatalogCursor'>

/** 查询由当前运行任务发起，项目根不来自模型参数。 */
export interface WikiCatalogQueryOwner {
  projectRoot: string
  runId: WikiRunId
  taskId: WikiTaskId
  agentSessionId: SessionId
  limit: number
  maxCharacters: number
  cursor?: WikiCatalogCursor
}

/** 路径按字面子串匹配，空字符串列出目录；不搜索正文或推断语义。 */
export interface SearchWikiCatalogRequest extends WikiCatalogQueryOwner {
  query: string
  scope: 'task' | 'run'
  sourceId?: KnowledgeSourceId
}

/** 区间查询只接受当前 Run 内的 Coverage。 */
export interface ListWikiCatalogRangesRequest extends WikiCatalogQueryOwner {
  coverageId: WikiCoverageId
}

/** 分配状态表示文件归属当前任务；实际读取仍受区间、字节预算和来源校验限制。 */
export interface WikiCatalogFileHit {
  coverageId: WikiCoverageId
  sourceId: KnowledgeSourceId
  path: string
  byteSize: number
  status: WikiCoverageItem['status']
  assignedToTask: boolean
  requiresRange: boolean
}

/** 核心区间与上下文范围来自持久化准备结果，不包含文件正文。 */
export interface WikiCatalogRangeHit {
  range: WikiMaterialRange
  status: WikiShardTask['status']
  assignedToTask: boolean
}

/** nextCursor 存在表示仍有匹配元数据；末页不表示项目语义已完整搜索。 */
export interface WikiCatalogQueryPage<T> {
  runId: WikiRunId
  taskId: WikiTaskId
  metadataOnly: true
  items: T[]
  nextCursor?: WikiCatalogCursor
}

const cursorSchema = z.object({
  version: z.literal(1), fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  after: z.string().regex(/^(?:wcov|wtask)_[0-9a-f]{64}$/u),
}).strict()

function fingerprint(request: WikiCatalogQueryOwner, filter: unknown): string {
  return createHash('sha256').update(JSON.stringify([
    request.projectRoot, request.runId, request.taskId, request.agentSessionId,
    request.limit, request.maxCharacters, filter,
  ])).digest('hex')
}

function afterCursor(cursor: WikiCatalogCursor | undefined, queryHash: string): string {
  if (cursor === undefined) return ''
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('Wiki 目录游标无效，请重新查询')
  const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  if (parsed.fingerprint !== queryHash) throw new Error('Wiki 目录游标不属于当前查询或任务，请重新查询')
  return parsed.after
}

function makeCursor(queryHash: string, after: string): WikiCatalogCursor {
  return Buffer.from(JSON.stringify({ version: 1, fingerprint: queryHash, after })).toString('base64url') as WikiCatalogCursor
}

function queryOwner(database: DatabaseSync, request: WikiCatalogQueryOwner): WikiShardTask {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 1) {
    throw new Error('Wiki 目录查询预算必须是可用的正安全整数')
  }
  const row = database.prepare(`SELECT r.project_root, t.id, t.payload_json FROM wiki_tasks t
    JOIN wiki_runs r ON r.id = t.run_id WHERE t.run_id = ? AND t.id = ?`)
    .get(request.runId, request.taskId) as { project_root: string; id: string; payload_json: string } | undefined
  if (row?.project_root !== request.projectRoot) throw new Error('Wiki 目录查询任务不属于当前项目')
  const task = parseWikiShardTask(JSON.parse(row.payload_json))
  if (task.id !== request.taskId || task.runId !== request.runId || task.status !== 'running'
    || task.agentSessionId !== request.agentSessionId
    || !['analysis', 'verification', 'consistency'].includes(task.kind)) {
    throw new Error('Wiki 目录查询不属于当前运行的事实任务 Session')
  }
  return task
}

function page<T>(request: WikiCatalogQueryOwner, queryHash: string, rows: Array<{ id: string; value: T }>): WikiCatalogQueryPage<T> {
  let result: WikiCatalogQueryPage<T> = { runId: request.runId, taskId: request.taskId, metadataOnly: true, items: [] }
  if (JSON.stringify(result).length > request.maxCharacters) throw new Error('Wiki 目录结果字符预算不足')
  for (const [index, row] of rows.slice(0, request.limit).entries()) {
    const candidate: WikiCatalogQueryPage<T> = {
      runId: request.runId, taskId: request.taskId, metadataOnly: true, items: [...result.items, row.value],
      ...(index + 1 < rows.length ? { nextCursor: makeCursor(queryHash, row.id) } : {}),
    }
    if (JSON.stringify(candidate).length > request.maxCharacters) {
      if (result.items.length === 0) throw new Error('Wiki 目录单项元数据超过结果字符预算，请提高 maxCatalogCharacters')
      break
    }
    result = candidate
  }
  return result
}

function assertCoverageRow(row: { id: string; payload_json: string }, runId: WikiRunId): WikiCoverageItem {
  const item = parseWikiCoverageItem(JSON.parse(row.payload_json))
  if (item.id !== row.id || item.runId !== runId) throw new Error('Wiki 目录记录身份不一致')
  return item
}

/** 在调用者的读事务内定位文件，不加载完整 Wiki 快照或源码。
 * @param database 已开启事务的数据库。
 * @param request 当前运行任务、字面路径条件和分页预算。
 * @returns 当前 Run 中有界的文件元数据页。
 */
export function searchWikiCatalog(database: DatabaseSync, request: SearchWikiCatalogRequest): WikiCatalogQueryPage<WikiCatalogFileHit> {
  const task = queryOwner(database, request)
  const queryHash = fingerprint(request, ['files', request.scope, request.query, request.sourceId ?? null])
  const after = afterCursor(request.cursor, queryHash)
  const rows = database.prepare(`SELECT c.id, c.payload_json FROM wiki_coverage c
    WHERE c.run_id = ? AND c.id > ? AND instr(c.path, ?) > 0
    AND (? IS NULL OR c.source_id = ?)
    AND (? = 'run' OR c.id IN (SELECT value FROM json_each(?)))
    ORDER BY c.id LIMIT ?`).all(request.runId, after, request.query, request.sourceId ?? null,
      request.sourceId ?? null, request.scope, JSON.stringify(task.coverageIds), request.limit + 1) as Array<{ id: string; payload_json: string }>
  return page(request, queryHash, rows.map(row => {
    const item = assertCoverageRow(row, request.runId)
    return { id: row.id, value: {
      coverageId: item.id, sourceId: item.sourceId, path: item.path, byteSize: item.byteSize, status: item.status,
      assignedToTask: task.coverageIds.includes(item.id), requiresRange: item.preparedContentHash !== undefined,
    } }
  }))
}

/** 在当前 Run 中定位大文件区间；区间排序使用稳定任务 id，不代表阅读顺序。
 * @param database 已开启事务的数据库。
 * @param request 当前运行任务、目标 Coverage 与分页预算。
 * @returns 核心/上下文区间及当前任务分配标记。
 */
export function listWikiCatalogRanges(database: DatabaseSync, request: ListWikiCatalogRangesRequest): WikiCatalogQueryPage<WikiCatalogRangeHit> {
  const task = queryOwner(database, request)
  const coverageRow = database.prepare('SELECT id, payload_json FROM wiki_coverage WHERE run_id = ? AND id = ?')
    .get(request.runId, request.coverageId) as { id: string; payload_json: string } | undefined
  if (coverageRow === undefined) throw new Error('Wiki 区间目标不属于当前 Run')
  const coverage = assertCoverageRow(coverageRow, request.runId)
  const queryHash = fingerprint(request, ['ranges', request.coverageId])
  const after = afterCursor(request.cursor, queryHash)
  const rows = database.prepare(`SELECT id, payload_json FROM wiki_tasks WHERE run_id = ? AND id > ?
    AND json_extract(payload_json, '$.materialRanges[0].coverageId') = ? ORDER BY id LIMIT ?`)
    .all(request.runId, after, request.coverageId, request.limit + 1) as Array<{ id: string; payload_json: string }>
  return page(request, queryHash, rows.map(row => {
    const sourceTask = parseWikiShardTask(JSON.parse(row.payload_json))
    const range = sourceTask.materialRanges[0]
    if (sourceTask.id !== row.id || sourceTask.runId !== request.runId || sourceTask.kind !== 'analysis'
      || sourceTask.materialRanges.length !== 1 || range?.coverageId !== coverage.id
      || coverage.preparedContentHash === undefined || range.contentEndByte > coverage.byteSize) {
      throw new Error('Wiki 目录区间与 Coverage 不一致')
    }
    return { id: row.id, value: { range, status: sourceTask.status,
      assignedToTask: task.coverageIds.includes(coverage.id)
        && (task.kind !== 'analysis' || task.materialRanges.some(assigned => assigned.id === range.id)),
    } }
  }))
}
