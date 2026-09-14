import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderSourceEvidencePack } from './evidence-pack.js'
import type { ProvenanceRef } from './model.js'
import { renderRecall } from './recall.js'
import type { MemoryTrace } from './runtime-model.js'
import type {} from './service.js'
import { DEFAULT_PROJECT_ROOT_MARKERS, findProjectRoot } from './workspace.js'

/** Cordis plugin name. */
export const name = 'memory-knowledge-tools'

/** Tool Consumer dependencies. */
export const inject = ['memoryKnowledge', 'systemPrompt', 'tools']

export const DEFAULT_TOOL_SEARCH_RESULTS = 8
export const DEFAULT_TOOL_SEARCH_CHARS = 12_000
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000

/** Model-facing memory tool configuration. */
export interface Config {
  maxSearchResults?: number
  maxSearchChars?: number
  timeoutMs?: number
  projectRootMarkers?: string[]
  cwdFallback?: 'process' | 'none'
}

/** Schemastery configuration for memory tools. */
export const Config: z<Config> = z.object({
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_TOOL_SEARCH_RESULTS),
  maxSearchChars: z.number().step(1).min(1).default(DEFAULT_TOOL_SEARCH_CHARS),
  timeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(DEFAULT_TOOL_TIMEOUT_MS),
  projectRootMarkers: z.array(z.string()).min(1).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  cwdFallback: z.union(['process', 'none'] as const).default('process'),
})

interface ResolvedConfig {
  maxSearchResults: number
  maxSearchChars: number
  timeoutMs: number
  projectRootMarkers: string[]
  cwdFallback: 'process' | 'none'
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    maxSearchResults: config.maxSearchResults ?? DEFAULT_TOOL_SEARCH_RESULTS,
    maxSearchChars: config.maxSearchChars ?? DEFAULT_TOOL_SEARCH_CHARS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    projectRootMarkers: [...(config.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS)],
    cwdFallback: config.cwdFallback ?? 'process',
  }
  for (const [key, value] of Object.entries({
    maxSearchResults: resolved.maxSearchResults,
    maxSearchChars: resolved.maxSearchChars,
    timeoutMs: resolved.timeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`memory tools ${key} must be a positive safe integer`)
  }
  if (resolved.projectRootMarkers.length === 0 || resolved.projectRootMarkers.some(marker => marker.trim().length === 0)) {
    throw new Error('memory tools projectRootMarkers must contain non-empty paths')
  }
  return resolved
}

function owningAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('memory tool requires an owning agent session')
  return exec.agent
}

async function projectRoot(agent: Agent, config: ResolvedConfig): Promise<string | undefined> {
  const cwd = agent.session.header.cwd ?? (config.cwdFallback === 'process' ? process.cwd() : undefined)
  return cwd === undefined ? undefined : findProjectRoot(cwd, config.projectRootMarkers)
}

async function knowledgeProjectRoot(agent: Agent, config: ResolvedConfig): Promise<string> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('knowledge_search requires a workspace-bound session')
  return findProjectRoot(cwd, config.projectRootMarkers)
}

function durableToolSeq(exec: ToolRunContext, agent: Agent): number {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'tool/call'
      && (event.data.callId === exec.callId || event.data.callId === exec.rootCallId)) return event.seq
  }
  throw new Error('memory candidate tool call is not present in the owning session log')
}

function provenanceLabel(reference: ProvenanceRef): string {
  switch (reference.kind) {
    case 'git-file':
      return `${reference.sourceId}:${reference.path}@${reference.commit}${reference.startLine === undefined ? '' : `:${reference.startLine}${reference.endLine === undefined || reference.endLine === reference.startLine ? '' : `-${reference.endLine}`}`}`
    case 'git-commit':
      return `${reference.sourceId}@${reference.commit}`
    case 'session':
      return `session:${reference.sessionId}#${reference.eventSeqs.join(',')}`
    case 'document':
      return `${reference.sourceId}:${reference.path}`
    default:
      return assertNever(reference)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled provenance: ${JSON.stringify(value)}`)
}

/** Render one exact trace without exposing local absolute paths. */
export function renderTrace(trace: MemoryTrace): string {
  return [
    `# ${trace.title}`,
    `ID: ${trace.id}`,
    `类型：${trace.recordType}`,
    `状态：${trace.status}`,
    `更新时间：${trace.updatedAt}`,
    `来源：${trace.provenance.map(provenanceLabel).join('; ')}`,
    '',
    trace.content,
  ].join('\n')
}

const PROMPT = [
  '只有当用户明确要求记住，或明确陈述具有长期价值的偏好、决定、事实、教训或约束时，才调用 memory_candidate_save。',
  '保存结果只是本地待审核候选，不代表事实已验证，也不会自动进入 Git。不要保存凭据、令牌或其他秘密。',
  '需要主动查找记忆时使用 memory_search；需要查找当前项目的源码导出、文档标题和精确行号时使用 knowledge_search；需要核对记忆来源和状态时使用 memory_trace。当前代码和文档证据与记忆冲突时，以当前证据为准。',
].join('\n')

/** Register candidate, memory search, Source evidence search, and trace tools plus their model guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({ name: 'tool:memory-knowledge', order: 114, text: PROMPT })

  ctx.tools.register(defineTool({
    name: 'memory_candidate_save',
    description: '保存一条本地待审核长期记忆候选；不会自动召回或写入 Git。',
    parameters: {
      applicability: {
        type: 'string',
        required: true,
        enum: ['global', 'project'],
        description: 'global 对所有项目有效；project 只对当前项目有效。',
      },
      kind: {
        type: 'string',
        required: true,
        enum: ['fact', 'decision', 'lesson', 'preference', 'constraint'],
        description: '候选的语义类别。',
      },
      title: { type: 'string', required: true, description: '简短标题。' },
      content: { type: 'string', required: true, description: '完整、自包含的候选内容。' },
      tags: {
        type: 'array',
        required: true,
        description: '用于查找的标签，可以为空数组。',
        items: { type: 'string' },
      },
      sensitivity: {
        type: 'string',
        required: true,
        enum: ['normal', 'restricted'],
        description: 'restricted 候选只保存在本地且不能推广到 Git。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          reviewRequired: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已保存候选 ${value.id}，状态为 ${value.status}；需要人工审核后才会参与 recall。`,
      }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const agent = owningAgent(exec)
      const root = args.applicability === 'project' ? await projectRoot(agent, resolved) : undefined
      if (args.applicability === 'project' && root === undefined) {
        throw new Error('project candidate requires a session cwd')
      }
      const candidate = await ctx.memoryKnowledge.saveCandidate({
        target: 'memory',
        applicability: args.applicability,
        ...root === undefined ? {} : { projectRoot: root },
        kind: args.kind,
        title: args.title,
        content: args.content,
        tags: args.tags,
        sensitivity: args.sensitivity,
        suggestedBy: 'model',
        provenance: [{
          kind: 'session',
          sessionId: agent.id,
          eventSeqs: [durableToolSeq(exec, agent)],
        }],
      })
      return { id: candidate.id, status: candidate.status, reviewRequired: candidate.status === 'pending' }
    },
    presentCall: args => ({ card: 'generic', title: '保存记忆候选', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '搜索已审核的个人长期记忆和当前项目知识。',
    parameters: {
      query: { type: 'string', required: true, description: '要查找的事实、决定、偏好或项目概念。' },
      limit: { type: 'integer', description: '最多返回多少条；省略时使用部署默认值。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          ids: { type: 'array', required: true, items: { type: 'string' } },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ count: value.count, ids: value.ids }),
    },
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = owningAgent(exec)
      const root = await projectRoot(agent, resolved)
      const requestedLimit = args.limit ?? resolved.maxSearchResults
      const limit = Math.min(requestedLimit, resolved.maxSearchResults)
      const hits = await ctx.memoryKnowledge.search({
        query: args.query,
        ...root === undefined ? {} : { projectRoot: root },
        domain: 'memory',
        limit,
        maxChars: resolved.maxSearchChars,
        signal: exec.signal,
      })
      return {
        count: hits.length,
        ids: hits.map(hit => hit.id),
        text: renderRecall(hits, resolved.maxSearchChars) ?? '没有找到已审核记忆。',
      }
    },
    presentCall: args => ({ card: 'generic', title: '搜索记忆', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_trace',
    description: '读取一条候选或已索引记忆的完整正文、审核状态与来源。',
    parameters: {
      id: { type: 'string', required: true, description: 'memory_search 或 memory_candidate_save 返回的 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = await projectRoot(owningAgent(exec), resolved)
      const trace = await ctx.memoryKnowledge.trace(args.id, root)
      return trace === undefined
        ? { found: false, text: `未找到记忆 ${args.id}。` }
        : { found: true, text: renderTrace(trace) }
    },
    presentCall: args => ({ card: 'generic', title: '查看记忆来源', kind: 'read', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: '搜索当前项目本地 Source evidence 索引中的 AST 代码符号、Markdown 标题、文件路径和精确行号。',
    parameters: {
      query: { type: 'string', required: true, description: '符号、标题、文件、区域或语言关键词。' },
      limit: { type: 'integer', description: '最多返回多少条；省略时使用部署默认值。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          omitted: { type: 'integer', required: true },
          truncationReasons: { type: 'array', required: true, items: { type: 'string' } },
          locations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'integer', required: true },
              },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        count: value.count,
        omitted: value.omitted,
        locations: value.locations,
      }),
    },
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = await knowledgeProjectRoot(owningAgent(exec), resolved)
      const requestedLimit = args.limit ?? resolved.maxSearchResults
      const limit = Math.min(requestedLimit, resolved.maxSearchResults)
      const pack = await ctx.memoryKnowledge.searchSourceEvidence({
        projectRoot: root,
        query: args.query,
        limit,
        signal: exec.signal,
      })
      const rendered = renderSourceEvidencePack(pack, resolved.maxSearchChars)
      return {
        count: rendered.renderedHitCount,
        omitted: rendered.omittedHitCount,
        truncationReasons: rendered.truncationReasons,
        locations: pack.hits.slice(0, rendered.renderedHitCount).map(hit => ({
          path: hit.path,
          line: hit.evidence.startLine,
        })),
        text: rendered.text,
      }
    },
    presentCall: args => ({ card: 'generic', title: '搜索项目证据', kind: 'search', rawInput: args.query }),
  }))
}
