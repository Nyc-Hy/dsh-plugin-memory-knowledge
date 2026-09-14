/** 为事实任务提供元数据导航；搜索结果不进入已读材料集合。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KnowledgeSourceId, WikiCoverageId, type WikiRunId, type WikiTaskId, KNOWLEDGE_SOURCE_ID_PATTERN, WIKI_COVERAGE_ID_PATTERN } from './ids.js'
import type { WikiCatalogCursor, WikiCatalogQueryOwner } from './wiki-catalog-query.js'
import type {} from './service.js'

/** 目录工具的输出和查询预算，不计为原文读取额度。 */
export interface WikiCatalogToolConfig {
  maxCatalogItems: number
  maxCatalogCharacters: number
  maxCatalogQueryCharacters: number
  toolTimeoutMs: number
}

const NAVIGATION_NOTICE = '仅目录元数据，不是源码搜索或已读证据。assignedToTask=false 的结果不能由当前任务读取或引用；空结果不能证明项目中不存在相关逻辑。区间 ordinal 表示文件内顺序，分页按稳定 id 排序。'

/** 在当前 Agent 的 effect 范围内注册项目目录与区间定位工具。
 * @param agentCtx 当前事实任务的工具 Context。
 * @param rootCtx 拥有持久化查询 Service 的 Context。
 * @param owner 固定的项目、Run 与 Task；模型不能修改。
 * @param config 已解析的查询与输出预算。
 */
export function installWikiCatalogTools(
  agentCtx: Context, rootCtx: Context,
  owner: { projectRoot: string; runId: WikiRunId; taskId: WikiTaskId }, config: WikiCatalogToolConfig,
): void {
  const requestOwner = (agentSessionId: WikiCatalogQueryOwner['agentSessionId'], cursor: string | undefined): WikiCatalogQueryOwner => ({
    ...owner, agentSessionId, limit: config.maxCatalogItems, maxCharacters: config.maxCatalogCharacters,
    ...(cursor === undefined ? {} : { cursor: cursor as WikiCatalogCursor }),
  })
  agentCtx.tools.register(defineTool({
    name: 'wiki_catalog_search',
    description: '按字面路径关键词分页定位当前 Run 的文件，不读取正文。任务外命中只供定位，不授权读取或引用。',
    parameters: {
      query: { type: 'string', required: true, description: '区分大小写的路径子串；空字符串浏览目录，不是正则或语义问题。' },
      scope: { type: 'string', required: true, enum: ['task', 'run'], description: 'task 只定位分配给当前任务的文件；run 定位整个当前 Run 的目录。' },
      sourceId: { type: 'string', description: '可选的稳定 Source id，用于区分多仓来源。' },
      cursor: { type: 'string', description: '上一页的 nextCursor；查询条件变化后必须省略。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
          metadataOnly: { type: 'boolean', required: true, const: true }, nextCursor: { type: 'string' },
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              coverageId: { type: 'string', required: true }, sourceId: { type: 'string', required: true },
              path: { type: 'string', required: true }, byteSize: { type: 'integer', required: true },
              status: { type: 'string', required: true }, assignedToTask: { type: 'boolean', required: true },
              requiresRange: { type: 'boolean', required: true },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${NAVIGATION_NOTICE}\n${JSON.stringify(value)}` }],
    },
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('Wiki 目录工具需要当前 Agent')
      if (args.query.length > config.maxCatalogQueryCharacters || args.query.includes('\0')) {
        throw new Error('Wiki 目录路径关键词超过配置上限或包含 NUL')
      }
      if (args.sourceId !== undefined && !new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u').test(args.sourceId)) {
        throw new Error('Wiki 目录 Source id 无效')
      }
      exec.signal.throwIfAborted()
      return rootCtx.memoryKnowledge.searchWikiCatalog({
        ...requestOwner(exec.agent.id, args.cursor), query: args.query, scope: args.scope,
        ...(args.sourceId === undefined ? {} : { sourceId: KnowledgeSourceId(args.sourceId) }),
      })
    },
    presentCall: args => ({ card: 'generic', title: '定位 Wiki 项目材料', kind: 'search', rawInput: args.query }),
  }))

  agentCtx.tools.register(defineTool({
    name: 'wiki_catalog_ranges',
    description: '分页查看目标大文件的不可变材料区间和分配状态，不读取正文，不改变材料读取或 Citation 规则。',
    parameters: {
      coverageId: { type: 'string', required: true, description: '目录命中的 Coverage id。' },
      cursor: { type: 'string', description: '同一 Coverage 查询上一页的 nextCursor。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
          metadataOnly: { type: 'boolean', required: true, const: true }, nextCursor: { type: 'string' },
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              status: { type: 'string', required: true }, assignedToTask: { type: 'boolean', required: true },
              range: { type: 'object', required: true, additionalProperties: false, properties: {
                id: { type: 'string', required: true }, coverageId: { type: 'string', required: true },
                ordinal: { type: 'integer', required: true }, startByte: { type: 'integer', required: true },
                endByte: { type: 'integer', required: true }, startLine: { type: 'integer', required: true },
                endLine: { type: 'integer', required: true }, contentStartByte: { type: 'integer', required: true },
                contentEndByte: { type: 'integer', required: true }, contentStartLine: { type: 'integer', required: true },
                contentEndLine: { type: 'integer', required: true }, contentHash: { type: 'string', required: true },
              } },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${NAVIGATION_NOTICE}\n${JSON.stringify(value)}` }],
    },
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('Wiki 目录工具需要当前 Agent')
      if (!new RegExp(WIKI_COVERAGE_ID_PATTERN, 'u').test(args.coverageId)) throw new Error('Wiki 目录 Coverage id 无效')
      exec.signal.throwIfAborted()
      return rootCtx.memoryKnowledge.listWikiCatalogRanges({
        ...requestOwner(exec.agent.id, args.cursor), coverageId: WikiCoverageId(args.coverageId),
      })
    },
    presentCall: args => ({ card: 'generic', title: '定位 Wiki 大文件区间', kind: 'search', rawInput: args.coverageId }),
  }))
}
