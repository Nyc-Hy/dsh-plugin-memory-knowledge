import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import {
  CallId as ToolCallId,
  createToolResultMessage,
  markAgentLoopRequest,
  type StreamChunk,
  type ToolResultMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import DurableWikiGeneration, { type Config as WikiAgentConfig } from '../src/wiki-agent-provider.js'
import { MemoryKnowledgeEngine } from '../src/engine.js'
import type { WikiMaterialBudgetKey, ReserveWikiMaterialRead } from '../src/wiki-material-budget.js'
import type { SearchWikiCatalogRequest, ListWikiCatalogRangesRequest } from '../src/wiki-catalog-query.js'
import { KnowledgeSourceId } from '../src/ids.js'
import {
  activeWikiClaims,
  createPlannedWikiRun,
  WIKI_BUSINESS_QUESTION_DEFINITIONS,
  type WikiMaterialRange,
  type WikiRunSnapshot,
} from '../src/wiki-model.js'
import { makeTempProject } from './helpers.js'

const contexts: Context[] = []
const stores: MemoryKnowledgeEngine[] = []

function businessQuestionArgs(claimCount: number): Array<{
  key: typeof WIKI_BUSINESS_QUESTION_DEFINITIONS[number]['key']
  outcome: 'evidence' | 'not-applicable'
  claimIndexes: number[]
  reason?: string
}> {
  return WIKI_BUSINESS_QUESTION_DEFINITIONS.map((definition, index) => claimCount > 0 && index === 0
    ? { key: definition.key, outcome: 'evidence', claimIndexes: Array.from({ length: claimCount }, (_, claim) => claim) }
    : { key: definition.key, outcome: 'not-applicable', claimIndexes: [], reason: '当前测试材料不覆盖该项目问题。' })
}

function appendCompletedTurn(session: Session, message: UserMessage): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

async function bench(
  content: string,
  afterPrompt: (agent: Agent, message: UserMessage, planned: WikiRunSnapshot) => Promise<void> | void,
  materialComplete: Partial<{
    byteSize: number
    contentHash: string
    chunkCount: number
    objectByteSize: number
    objectContentHash: string
    startByte: number
    endByte: number
  }> = {},
  providerConfig: WikiAgentConfig & {
    ranged?: boolean
    twoRanges?: boolean
    auditModelInputs?: boolean | 'mismatched-call'
  } = {},
): Promise<{ ctx: Context; store: MemoryKnowledgeEngine; planned: WikiRunSnapshot; current(): WikiRunSnapshot; reads(): number; resumes(): number }> {
  const root = await realpath(await makeTempProject())
  const bytes = new TextEncoder().encode(content)
  const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const contentLineCount = Math.max(1, content.split('\n').length - (content.endsWith('\n') ? 1 : 0))
  const { ranged = false, twoRanges = false, auditModelInputs = false, ...wikiProviderConfig } = providerConfig
  const newline = bytes.indexOf(10) + 1
  if (twoRanges && (newline <= 0 || newline >= bytes.byteLength)) {
    throw new Error('two-range Wiki Agent tests require at least two non-empty lines')
  }
  const preparedRanges = twoRanges ? [{
    ordinal: 0,
    startByte: 0,
    endByte: newline,
    startLine: 1,
    endLine: 1,
    contentStartByte: 0,
    contentEndByte: newline,
    contentStartLine: 1,
    contentEndLine: 1,
    contentHash: `sha256:${createHash('sha256').update(bytes.subarray(0, newline)).digest('hex')}`,
  }, {
    ordinal: 1,
    startByte: newline,
    endByte: bytes.byteLength,
    startLine: 2,
    endLine: contentLineCount,
    contentStartByte: newline,
    contentEndByte: bytes.byteLength,
    contentStartLine: 2,
    contentEndLine: contentLineCount,
    contentHash: `sha256:${createHash('sha256').update(bytes.subarray(newline)).digest('hex')}`,
  }] : [{
    ordinal: 0,
    startByte: 0,
    endByte: bytes.byteLength,
    startLine: 1,
    endLine: contentLineCount,
    contentStartByte: 0,
    contentEndByte: bytes.byteLength,
    contentStartLine: 1,
    contentEndLine: contentLineCount,
    contentHash,
  }]
  const planned = createPlannedWikiRun({
    projectRoot: root,
    catalogHash: `sha256:${'7'.repeat(64)}`,
    catalogComplete: true,
    catalogOmittedItemCount: 0,
    entries: [ranged ? {
      sourceId: KnowledgeSourceId('src_44444444-4444-4444-8444-444444444444'),
      path: 'README.unknown',
      byteSize: bytes.byteLength,
      revision: { kind: 'git-object', commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
      preparedMaterial: {
        contentHash,
        ranges: preparedRanges,
      },
    } : {
      sourceId: KnowledgeSourceId('src_44444444-4444-4444-8444-444444444444'),
      path: 'README.unknown',
      byteSize: bytes.byteLength,
      revision: { kind: 'content-hash', contentHash },
    }],
    now: '2026-08-28T00:00:00.000Z',
  })
  let current = structuredClone(planned)
  const store = await MemoryKnowledgeEngine.open({ path: ':memory:', journalMode: 'delete' })
  stores.push(store)
  await store.saveWikiRunSnapshot(planned)
  let readCount = 0
  let resumeCount = 0

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  ctx.tools.register(defineTool({
    name: 'dangerous_global_tool',
    description: 'must be hidden from the Wiki Agent',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('danger'),
  }))
  ctx.provide('memoryKnowledge', {
    planWikiProject: () => Promise.resolve({ catalog: {} as never, run: structuredClone(current) }),
    getWikiRunSnapshot: () => Promise.resolve(structuredClone(current)),
    searchWikiCatalog: (request: SearchWikiCatalogRequest) => store.searchWikiCatalog(request),
    listWikiCatalogRanges: (request: ListWikiCatalogRangesRequest) => store.listWikiCatalogRanges(request),
    getWikiMaterialReadBudget: (key: WikiMaterialBudgetKey) => store.getWikiMaterialReadBudget(key),
    reserveWikiMaterialRead: (request: ReserveWikiMaterialRead) => store.reserveWikiMaterialRead(request),
    saveWikiRunSnapshot: async (next: WikiRunSnapshot, expected?: string) => {
      if (expected !== undefined && expected !== current.snapshotHash) {
        return Promise.reject(new Error('test snapshot changed'))
      }
      current = await store.saveWikiRunSnapshot(next, expected)
      return Promise.resolve(structuredClone(current))
    },
  } as never)
  ctx.provide('knowledgeProject', {
    async *readWikiMaterial(): AsyncIterable<unknown> {
      readCount += 1
      yield { kind: 'chunk', index: 0, startByte: 0, bytes }
      yield {
        kind: 'complete',
        byteSize: materialComplete.byteSize ?? bytes.byteLength,
        contentHash: materialComplete.contentHash ?? contentHash,
        chunkCount: materialComplete.chunkCount ?? 1,
        objectByteSize: materialComplete.objectByteSize ?? bytes.byteLength,
        objectContentHash: materialComplete.objectContentHash ?? contentHash,
        startByte: materialComplete.startByte ?? 0,
        endByte: materialComplete.endByte ?? bytes.byteLength,
      }
    },
    async *readWikiMaterialRange(
      _projectRoot: string,
      _coverage: unknown,
      range: WikiMaterialRange,
    ): AsyncIterable<unknown> {
      readCount += 1
      const rangeBytes = bytes.subarray(range.contentStartByte, range.contentEndByte)
      const rangeHash = `sha256:${createHash('sha256').update(rangeBytes).digest('hex')}`
      yield { kind: 'chunk', index: 0, startByte: range.contentStartByte, bytes: rangeBytes }
      yield {
        kind: 'complete',
        byteSize: materialComplete.byteSize ?? rangeBytes.byteLength,
        contentHash: materialComplete.contentHash ?? rangeHash,
        chunkCount: materialComplete.chunkCount ?? 1,
        objectByteSize: materialComplete.objectByteSize ?? bytes.byteLength,
        objectContentHash: materialComplete.objectContentHash ?? contentHash,
        startByte: materialComplete.startByte ?? range.contentStartByte,
        endByte: materialComplete.endByte ?? range.contentEndByte,
      }
    },
  } as never)

  let loopCtx!: Context
  await ctx.plugin(Object.assign(
    (inner: Context) => { loopCtx = inner },
    { inject: ['systemPrompt', 'tools'] },
  ))
  const createHandle = async (options: CreateAgentOptions, existing?: Session): Promise<AgentHandle> => {
      const session = existing ?? ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      let idle = Promise.resolve()
      const agent = {} as Agent
      const scope = createScope(loopCtx, agent)
      const agentCtx = scope.ctx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx: agentCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
          idle = Promise.resolve().then(() => afterPrompt(agent, message, planned))
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      if (auditModelInputs) {
        const materialResults: ToolResultMessage[] = []
        agentCtx.on('tools/result', (exec, result) => {
          if (exec.name !== 'wiki_material_read' || result.isError) return
          materialResults.push(createToolResultMessage({
            callId: exec.callId,
            content: result.content,
            isError: false,
          }))
        })
        agentCtx.on('tools/execute', async (exec, next) => {
          if (!['wiki_task_submit', 'wiki_file_synthesis_submit', 'wiki_verification_submit'].includes(exec.name)) {
            return next()
          }
          const request = markAgentLoopRequest({
            provider: 'test-provider',
            model: 'test-model',
            messages: materialResults,
            sessionId: agent.session.id,
          })
          const chunks = (async function* (): AsyncIterable<StreamChunk> {
            const block = {
              type: 'tool-call' as const,
              id: auditModelInputs === 'mismatched-call' ? ToolCallId('different-observed-submit') : exec.callId,
              name: exec.name,
              arguments: '{}',
            }
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          })()
          const stream = agentCtx.waterfall(
            agentCtx as never,
            'llm/stream',
            request,
            () => chunks,
          ) as AsyncIterable<StreamChunk>
          for await (const _chunk of stream) { /* drain the observed successful request */ }
          return next()
        })
      }
      return { agent, dispose: () => scope.dispose() }
  }
  ctx.agents.setFactory({
    createAgent: (_ownerCtx, options) => createHandle(options),
    resume: (_ownerCtx, options) => {
      resumeCount += 1
      const session = ctx.sessions.get(options.resumeSessionId)
      if (session === undefined) throw new Error('test resume Session is missing')
      return createHandle({ sessionId: options.resumeSessionId,
        ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
        ...(options.setup === undefined ? {} : { setup: options.setup }),
      }, session)
    },
  })
  await ctx.plugin(DurableWikiGeneration, {
    maxMaterialBytes: 4_096,
    dataEgressMode: wikiProviderConfig.dataEgressMode ?? 'allow',
    ...wikiProviderConfig,
  })
  return { ctx, store, planned, current: () => structuredClone(current), reads: () => readCount, resumes: () => resumeCount }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(stores.splice(0).map(store => store.close()))
})

describe('durable Wiki Agent provider', () => {
  it('persists the exact successful Provider request that exposed task material', async () => {
    const test = await bench('模型最终请求中的项目事实。\n', async (agent, message, planned) => {
      const coverageId = planned.coverage[0]!.id
      const read = await agent.ctx.tools.execute({
        name: 'wiki_material_read',
        arguments: { coverageId },
        agent,
        callId: ToolCallId('audited-material-read'),
        signal: new AbortController().signal,
      })
      expect(read.isError).toBe(false)
      const submit = await agent.ctx.tools.execute({
        name: 'wiki_task_submit',
        arguments: {
          coverage: [{ coverageId, outcome: 'analyzed' }],
          citations: [],
          claims: [],
          questions: businessQuestionArgs(0),
        },
        agent,
        callId: ToolCallId('audited-task-submit'),
        signal: new AbortController().signal,
      })
      expect(submit.isError).toBe(false)
      appendCompletedTurn(agent.session, message)
    }, {}, { auditModelInputs: true })

    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result.tasks[0]!.modelInputAudit).toMatchObject({
      rulesVersion: 1,
      state: 'verified',
      provider: 'test-provider',
      model: 'test-model',
      submissionCallId: 'audited-task-submit',
      requestMessageCount: 1,
      requestLastMessageId: expect.any(String),
      requestMessagesHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      material: [{
        coverageId: result.coverage[0]!.id,
        contentHash: result.coverage[0]!.analyzedContentHash,
      }],
      recordedAt: expect.any(String),
    })
    expect(result.run.materialExposure).toEqual({
      rulesVersion: 1,
      requiredTaskCount: 1,
      verifiedTaskCount: 1,
      pendingTaskCount: 0,
      unsupportedTaskCount: 0,
    })
    expect(result.run.businessQuestions).toMatchObject({
      state: 'complete',
      requiredQuestionCount: 9,
      analysisTaskCount: 1,
      completedTaskCount: 1,
      notApplicableFindingCount: 9,
    })
  })

  it('rejects model-input evidence bound to another submit tool call', async () => {
    const test = await bench('提交请求必须精确绑定。\n', async (agent, message, planned) => {
      const coverageId = planned.coverage[0]!.id
      await agent.ctx.tools.execute({
        name: 'wiki_material_read',
        arguments: { coverageId },
        agent,
        callId: ToolCallId('stale-audit-read'),
        signal: new AbortController().signal,
      })
      const reused = await agent.ctx.tools.execute({
        name: 'wiki_task_submit',
        arguments: {
          coverage: [{ coverageId, outcome: 'analyzed' }], citations: [], claims: [], questions: businessQuestionArgs(0),
        },
        agent,
        callId: ToolCallId('current-task-submit'),
        signal: new AbortController().signal,
      })
      expect(reused).toMatchObject({ isError: true, error: {
        message: expect.stringContaining('does not match its observed model request'),
      } })
      appendCompletedTurn(agent.session, message)
    }, {}, { auditModelInputs: 'mismatched-call' })

    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result.tasks[0]!.status).toBe('failed')
    expect(result.tasks[0]!.modelInputAudit.state).toBe('pending')
  })

  it('fails closed until ask-mode data egress is explicitly confirmed', async () => {
    let prompts = 0
    const test = await bench('项目材料。\n', (agent, message) => {
      prompts += 1
      appendCompletedTurn(agent.session, message)
    }, {}, { dataEgressMode: 'ask' })

    await expect(test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot))
      .rejects.toThrow('requires explicit confirmation')
    expect(prompts).toBe(0)
    await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot, { dataEgressConfirmed: true })
    expect(prompts).toBe(1)
  })

  it('never starts a Wiki Agent when data egress is denied', async () => {
    let prompts = 0
    const test = await bench('项目材料。\n', () => { prompts += 1 }, {}, { dataEgressMode: 'deny' })
    await expect(test.ctx.wikiGeneration.runNext(
      test.planned.run.projectRoot,
      { dataEgressConfirmed: true },
    )).rejects.toThrow('data egress is disabled')
    expect(prompts).toBe(0)
  })

  it.each([false, true])('累计额度耗尽后不再读取或提交，显式扩额后保留消耗继续（区间 %s）', async ranged => {
    const content = '这是语言无关的原文。\n'
    const byteSize = Buffer.byteLength(content)
    let prompts = 0
    const test = await bench(content, async (agent, message, planned) => {
      prompts += 1
      const execute = (name: string, args: Record<string, unknown>) => agent.ctx.tools.execute({
        name, arguments: args, agent, callId: ToolCallId(`budget-${prompts}-${name}`), signal: new AbortController().signal,
      })
      const coverageId = planned.coverage[0]!.id
      const range = planned.tasks[0]!.materialRanges[0]
      const args = { coverageId, ...(range === undefined ? {} : { rangeId: range.id }) }
      const read = await execute('wiki_material_read', args)
      expect(read).toMatchObject({ isError: false, value: {
        reservedMaterialBytes: byteSize * prompts, materialBudgetBytes: byteSize * prompts,
      } })
      expect(read.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('不是 token') })]))
      if (prompts === 1) {
        const denied = await execute('wiki_material_read', args)
        expect(denied.isError).toBe(true)
      }
      const submission = await execute('wiki_task_submit', {
        coverage: [{ coverageId, outcome: 'analyzed' }], citations: [], claims: [], questions: businessQuestionArgs(0),
      })
      expect(submission.isError).toBe(prompts === 1)
      appendCompletedTurn(agent.session, message)
    }, {}, { maxTaskMaterialBytes: byteSize, ranged })
    const failed = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(failed.tasks[0]!.status).toBe('failed')
    expect(failed.run.failure).toContain('wiki-budget')
    expect(failed.coverage[0]!.status).toBe('pending')
    expect(test.reads()).toBe(1)
    await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(prompts).toBe(1)
    const key = { runId: failed.run.id, taskId: failed.tasks[0]!.id }
    await test.store.increaseWikiMaterialReadBudget(key, byteSize * 2)
    const completed = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(completed.tasks[0]).toMatchObject({ status: 'succeeded', attemptCount: 2 })
    expect(await test.store.getWikiMaterialReadBudget(key)).toMatchObject({
      reservedBytes: byteSize * 2, reservationCount: 2, startedAtAttempt: 1, blockedReadBytes: null,
    })
  })

  it.each([1, 2])('Session 中断恢复后必须重新读证据，累计预算保留（允许读取 %s 次）', async readsAllowed => {
    const content = '跨恢复的事实。\n'
    const byteSize = Buffer.byteLength(content)
    let prompts = 0
    const test = await bench(content, async (agent, message, planned) => {
      prompts += 1
      const execute = (name: string, args: Record<string, unknown>) => agent.ctx.tools.execute({
        name, arguments: args, agent, callId: ToolCallId(`resume-${prompts}-${name}`), signal: new AbortController().signal,
      })
      const coverageId = planned.coverage[0]!.id
      const submission = {
        coverage: [{ coverageId, outcome: 'analyzed' }], citations: [], claims: [], questions: businessQuestionArgs(0),
      }
      if (prompts === 2) expect((await execute('wiki_task_submit', submission)).isError).toBe(true)
      const read = await execute('wiki_material_read', { coverageId })
      expect(read.isError).toBe(prompts > readsAllowed)
      if (prompts === 1) throw new Error('fixture interrupted after reservation')
      const submit = await execute('wiki_task_submit', submission)
      expect(submit.isError).toBe(readsAllowed === 1)
      appendCompletedTurn(agent.session, message)
    }, {}, { maxTaskMaterialBytes: readsAllowed * byteSize })
    await expect(test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)).rejects.toThrow('fixture interrupted')
    expect(test.current().tasks[0]!.status).toBe('running')
    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(test.resumes()).toBe(1)
    expect(result.tasks[0]).toMatchObject({ attemptCount: 1, status: readsAllowed === 1 ? 'failed' : 'succeeded' })
    expect(test.reads()).toBe(readsAllowed)
    expect(await test.store.getWikiMaterialReadBudget({ runId: result.run.id, taskId: result.tasks[0]!.id }))
      .toMatchObject({ reservedBytes: readsAllowed * byteSize, reservationCount: readsAllowed })
  })

  it('材料校验失败也保留预扣，重试不能以失败退款绕过额度', async () => {
    const content = '内容哈希失败。\n'
    let prompts = 0
    const test = await bench(content, async (agent, message, planned) => {
      prompts += 1
      const read = await agent.ctx.tools.execute({ name: 'wiki_material_read',
        arguments: { coverageId: planned.coverage[0]!.id }, agent,
        callId: ToolCallId(`bad-hash-${prompts}`), signal: new AbortController().signal,
      })
      expect(read.isError).toBe(true)
      appendCompletedTurn(agent.session, message)
    }, { contentHash: `sha256:${'0'.repeat(64)}` }, { maxTaskMaterialBytes: Buffer.byteLength(content) })
    await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    const failed = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(test.reads()).toBe(1)
    expect(failed.run.failure).toContain('预算不足')
    expect(failed.claims).toEqual([])
  })

  it('requires and preserves the exact assigned range for prepared large-file evidence', async () => {
    const test = await bench('大文件区间中的可验证事实。\n', async (agent, message, _planned) => {
      const context = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-range-context'),
        name: 'wiki_task_context',
        arguments: {},
        agent,
      })
      expect(context.isError).toBe(false)
      const value = context.value as {
        coverage: Array<{ coverageId: string }>
        materialRanges: Array<{ rangeId: string; coverageId: string }>
      }
      const coverageId = value.coverage[0]!.coverageId
      const rangeId = value.materialRanges[0]!.rangeId
      expect(value.materialRanges).toEqual([{
        rangeId,
        coverageId,
        ordinal: 0,
        coreStartByte: 0,
        coreEndByte: expect.any(Number),
        contentStartByte: 0,
        contentEndByte: expect.any(Number),
        contentStartLine: 1,
        contentEndLine: 1,
      }])
      const missingRange = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-range-missing'),
        name: 'wiki_material_read',
        arguments: { coverageId },
        agent,
      })
      expect(missingRange.isError).toBe(true)
      const read = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-range-read'),
        name: 'wiki_material_read',
        arguments: { coverageId, rangeId },
        agent,
      })
      expect(read).toMatchObject({
        isError: false,
        value: { status: 'content', coverageId, rangeId, contentHash: expect.any(String) },
      })
      const submit = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-range-submit'),
        name: 'wiki_task_submit',
        arguments: {
          coverage: [{ coverageId, outcome: 'analyzed' }],
          citations: [{ key: 'range-source', coverageId, rangeId, role: 'supports', startLine: 1, endLine: 1 }],
          claims: [{
            kind: 'assertion',
            statement: '材料区间明确记录了一项可验证事实。',
            citationKeys: ['range-source'],
            coverageIds: [coverageId],
          }],
          questions: businessQuestionArgs(1),
        },
        agent,
      })
      expect(submit.isError).toBe(false)
      appendCompletedTurn(agent.session, message)
    }, {}, { ranged: true })

    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result.run).toMatchObject({
      status: 'verifying',
      materialRanges: { rangeCount: 1, analyzedBytes: result.coverage[0]!.byteSize, succeeded: 1 },
    })
    expect(result.coverage[0]).toMatchObject({ status: 'analyzed' })
    expect(result.citations[0]).toMatchObject({ rangeId: test.planned.tasks[0]!.materialRanges[0]!.id })
  })

  it.each([1, 2])('每区间 %i 条声明时，各层综合均须回读原始支持证据', async claimsPerRange => {
    const test = await bench('entry produces a result\nresult is persisted\n', async (agent, message) => {
      const toolNames = agent.ctx.tools.schemas(agent).map(value => value.name).sort()
      if (toolNames.includes('wiki_task_context')) {
        const context = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`wiki-file-analysis-context-${agent.id}`),
          name: 'wiki_task_context',
          arguments: {},
          agent,
        })
        const value = context.value as {
          coverage: Array<{ coverageId: string }>
          materialRanges: Array<{ rangeId: string; ordinal: number; contentStartLine: number; contentEndLine: number }>
        }
        const coverageId = value.coverage[0]!.coverageId
        const range = value.materialRanges[0]!
        const read = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`wiki-file-analysis-read-${range.ordinal}`),
          name: 'wiki_material_read',
          arguments: { coverageId, rangeId: range.rangeId },
          agent,
        })
        expect(read.isError).toBe(false)
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`wiki-file-analysis-submit-${range.ordinal}`),
          name: 'wiki_task_submit',
          arguments: {
            coverage: [{ coverageId, outcome: 'analyzed' }],
            citations: [{
              key: `source-${range.ordinal}`,
              coverageId,
              rangeId: range.rangeId,
              role: 'supports',
              startLine: range.contentStartLine,
              endLine: range.contentEndLine,
            }],
            claims: Array.from({ length: claimsPerRange }, (_, index) => ({
              kind: 'assertion',
              statement: `${range.ordinal === 0 ? '入口产生结果。' : '结果进入持久化。'}说明 ${index}。`,
              citationKeys: [`source-${range.ordinal}`],
              coverageIds: [coverageId],
            })),
            questions: businessQuestionArgs(claimsPerRange),
          },
          agent,
        })
        expect(submit.isError).toBe(false)
        appendCompletedTurn(agent.session, message)
        return
      }

      expect(toolNames).toEqual(['wiki_file_synthesis_context', 'wiki_file_synthesis_submit', 'wiki_material_read'])
      const context = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-file-synthesis-context'),
        name: 'wiki_file_synthesis_context',
        arguments: {},
        agent,
      })
      const value = context.value as {
        coverageId: string
        batchCountForFile: number
        jointReview: boolean
        level: number
        claims: Array<{
          claimId: string
          evidence: Array<{ citationId: string; rangeId: string }>
        }>
      }
      expect(value).toMatchObject({ batchCountForFile: value.level === 0 ? claimsPerRange : 1,
        jointReview: value.level > 0 || claimsPerRange === 1 })
      if (value.level > 0) expect(value.claims.every(claim => 'sourceTaskId' in claim)).toBe(true)
      expect(value.claims).toHaveLength(2)
      const sourceClaimIds = value.claims.map(claim => claim.claimId)
      const sourceCitationIds = [...new Set(value.claims.flatMap(claim => claim.evidence.map(evidence => evidence.citationId)))]
      const ranges = [...new Set(value.claims.flatMap(claim => claim.evidence.map(evidence => evidence.rangeId)))]
      const firstRead = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-file-synthesis-first-read'),
        name: 'wiki_material_read',
        arguments: { coverageId: value.coverageId, rangeId: ranges[0] },
        agent,
      })
      expect(firstRead.isError).toBe(false)
      const premature = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-file-synthesis-premature'),
        name: 'wiki_file_synthesis_submit',
        arguments: {
          retainedClaimIds: [],
          claims: [{
            kind: 'assertion',
            statement: '入口结果进入持久化。',
            sourceClaimIds,
            sourceCitationIds,
          }],
        },
        agent,
      })
      expect(premature.isError).toBe(true)
      const secondRead = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-file-synthesis-second-read'),
        name: 'wiki_material_read',
        arguments: { coverageId: value.coverageId, rangeId: ranges[1] },
        agent,
      })
      expect(secondRead.isError).toBe(false)
      const submit = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-file-synthesis-submit'),
        name: 'wiki_file_synthesis_submit',
        arguments: {
          retainedClaimIds: [],
          claims: [{
            kind: 'assertion',
            statement: '入口结果进入持久化。',
            sourceClaimIds,
            sourceCitationIds,
          }],
        },
        agent,
      })
      expect(submit).toMatchObject({ isError: false, value: { retained: 0, synthesized: 1 } })
      appendCompletedTurn(agent.session, message)
    }, {}, { ranged: true, twoRanges: true, fileSynthesisMaxClaimsPerTask: 2 })

    let result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result).toMatchObject({
      run: { status: 'analyzing', fileSynthesis: { fileCount: 1, taskCount: claimsPerRange, status: 'running' } },
    })
    for (let index = 0; index < (claimsPerRange === 1 ? 1 : 3); index += 1) {
      result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    }
    expect(result.run.status).toBe('verifying')
    expect(result.claims).toHaveLength(claimsPerRange === 1 ? 3 : 7)
    const synthesized = activeWikiClaims(result.claims)[0]!
    expect(synthesized).toMatchObject({
      statement: '入口结果进入持久化。',
      sourceTaskId: expect.any(String),
    })
    expect(result.run.fileSynthesis).toMatchObject({ status: 'complete', levelCount: claimsPerRange })
    expect(result.tasks.find(task => task.kind === 'verification')?.claimIds).toEqual([synthesized.id])
  })

  it('isolates global tools and accepts only completely read, cited shard claims', async () => {
    const test = await bench('项目使用 SQLite。\n', async (agent, message, planned) => {
      const toolNames = agent.ctx.tools.schemas(agent).map(value => value.name).sort()
      if (toolNames.includes('wiki_page_context')) {
        expect(toolNames).toEqual(['wiki_page_context', 'wiki_page_submit'])
        const context = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-page-context'),
          name: 'wiki_page_context',
          arguments: {},
          agent,
        })
        expect(context.isError).toBe(false)
        const value = context.value as { claims: Array<{ claimId: string; status: string }> }
        expect(value.claims).toEqual([expect.objectContaining({ status: 'verified' })])
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-page-submit'),
          name: 'wiki_page_submit',
          arguments: {
            pages: [{
              slug: 'storage',
              title: '存储',
              claimIds: value.claims.map(claim => claim.claimId),
              childSlugs: [],
            }],
          },
          agent,
        })
        expect(submit.isError).toBe(false)
        appendCompletedTurn(agent.session, message)
        return
      }
      if (toolNames.includes('wiki_verification_context')) {
        expect(toolNames).toEqual([
          'wiki_catalog_ranges',
          'wiki_catalog_search',
          'wiki_material_read',
          'wiki_verification_context',
          'wiki_verification_submit',
        ])
        const context = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-verification-context'),
          name: 'wiki_verification_context',
          arguments: {},
          agent,
        })
        expect(context.isError).toBe(false)
        const value = context.value as {
          claims: Array<{ claimId: string }>
          coverage: Array<{ coverageId: string }>
        }
        await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-verification-read'),
          name: 'wiki_material_read',
          arguments: { coverageId: value.coverage[0]!.coverageId },
          agent,
        })
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-verification-submit'),
          name: 'wiki_verification_submit',
          arguments: {
            decisions: [{ claimId: value.claims[0]!.claimId, outcome: 'verified' }],
            conflicts: [],
          },
          agent,
        })
        expect(submit.isError).toBe(false)
        appendCompletedTurn(agent.session, message)
        return
      }
      expect(toolNames).toEqual(['wiki_catalog_ranges', 'wiki_catalog_search', 'wiki_material_read', 'wiki_task_context', 'wiki_task_submit'])
      const coverageId = String(planned.coverage[0]!.id)
      const read = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-read'),
        name: 'wiki_material_read',
        arguments: { coverageId },
        agent,
      })
      expect(read.isError).toBe(false)
      const submit = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-submit'),
        name: 'wiki_task_submit',
        arguments: {
          coverage: [{ coverageId, outcome: 'analyzed' }],
          citations: [{ key: 'readme', coverageId, role: 'supports' }],
          claims: [{
            kind: 'assertion',
            statement: '项目材料明确写明使用 SQLite。',
            citationKeys: ['readme'],
            coverageIds: [coverageId],
          }],
          questions: businessQuestionArgs(1),
        },
        agent,
      })
      expect(submit.isError).toBe(false)
      appendCompletedTurn(agent.session, message)
    })

    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result.run.status).toBe('verifying')
    expect(result.tasks[0]).toMatchObject({ status: 'succeeded', attemptCount: 1 })
    expect(result.coverage[0]).toMatchObject({ status: 'analyzed' })
    expect(result.claims[0]).toMatchObject({
      kind: 'assertion',
      status: 'proposed',
      statement: '项目材料明确写明使用 SQLite。',
    })
    expect(result.tasks[1]).toMatchObject({ kind: 'verification', status: 'planned' })

    const verified = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(verified.run.status).toBe('synthesizing')
    expect(verified.tasks.find(task => task.kind === 'verification'))
      .toMatchObject({ status: 'succeeded', attemptCount: 1 })
    expect(verified.claims[0]).toMatchObject({ kind: 'assertion', status: 'verified' })
    const paged = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(paged.run.status).toBe('needs-review')
    expect(paged.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '存储',
        status: 'verified',
        sourceTaskId: paged.tasks.find(task => task.kind === 'page')!.id,
      }),
      expect.objectContaining({ title: 'Wiki', status: 'verified' }),
    ]))
  })

  it('executes recalled cross-batch candidates as a separate bounded consistency task', async () => {
    const taskKinds: string[] = []
    const test = await bench('运行模式由项目材料定义。\n', async (agent, message, planned) => {
      const toolNames = agent.ctx.tools.schemas(agent).map(value => value.name)
      const contextName = toolNames.includes('wiki_page_context')
        ? 'wiki_page_context'
        : toolNames.includes('wiki_verification_context')
          ? 'wiki_verification_context'
          : 'wiki_task_context'
      const context = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`wiki-consistency-context-${taskKinds.length}`),
        name: contextName,
        arguments: {},
        agent,
      })
      expect(context.isError).toBe(false)
      if (contextName === 'wiki_page_context') {
        taskKinds.push('page')
        const value = context.value as { claims: Array<{ claimId: string }> }
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-consistency-page-submit'),
          name: 'wiki_page_submit',
          arguments: {
            pages: [{
              slug: 'runtime-mode',
              title: '运行模式',
              claimIds: value.claims.map(claim => claim.claimId),
              childSlugs: [],
            }],
          },
          agent,
        })
        expect(submit.isError).toBe(false)
      } else if (contextName === 'wiki_task_context') {
        taskKinds.push('analysis')
        const coverageId = String(planned.coverage[0]!.id)
        await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-consistency-analysis-read'),
          name: 'wiki_material_read',
          arguments: { coverageId },
          agent,
        })
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-consistency-analysis-submit'),
          name: 'wiki_task_submit',
          arguments: {
            coverage: [{ coverageId, outcome: 'analyzed' }],
            citations: [{ key: 'material', coverageId, role: 'supports' }],
            claims: [{
              kind: 'assertion',
              statement: '运行模式使用安全配置。',
              citationKeys: ['material'],
              coverageIds: [coverageId],
            }, {
              kind: 'assertion',
              statement: '运行模式使用兼容配置。',
              citationKeys: ['material'],
              coverageIds: [coverageId],
            }],
            questions: businessQuestionArgs(2),
          },
          agent,
        })
        expect(submit.isError).toBe(false)
      } else {
        const value = context.value as {
          taskKind: 'verification' | 'consistency'
          claims: Array<{ claimId: string }>
          coverage: Array<{ coverageId: string }>
          candidatePairs: Array<{ claimIds: string[]; reasons: string[] }>
          consistency: { candidatePairCount: number; candidatePairsComplete: boolean }
        }
        taskKinds.push(value.taskKind)
        if (value.taskKind === 'consistency') {
          expect(value.candidatePairs).toEqual([expect.objectContaining({
            claimIds: expect.arrayContaining(value.claims.map(claim => claim.claimId)),
            reasons: expect.arrayContaining(['shared-coverage', 'statement-key']),
          })])
          expect(value.consistency).toMatchObject({ candidatePairCount: 1, candidatePairsComplete: true })
        } else {
          expect(value.candidatePairs).toEqual([])
        }
        await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`wiki-consistency-read-${taskKinds.length}`),
          name: 'wiki_material_read',
          arguments: { coverageId: value.coverage[0]!.coverageId },
          agent,
        })
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`wiki-consistency-submit-${taskKinds.length}`),
          name: 'wiki_verification_submit',
          arguments: {
            decisions: value.claims.map(claim => ({ claimId: claim.claimId, outcome: 'verified' })),
            conflicts: [],
          },
          agent,
        })
        expect(submit.isError).toBe(false)
      }
      appendCompletedTurn(agent.session, message)
    }, {}, { verificationBatchClaims: 1 })

    for (let index = 0; index < 5; index += 1) {
      await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    }
    expect(taskKinds).toEqual(['analysis', 'verification', 'verification', 'consistency', 'page'])
    expect(test.current().run).toMatchObject({
      status: 'needs-review',
      consistency: { planned: true, candidatePairCount: 1, candidatePairsComplete: true },
    })
  })

  it('marks a completed model turn failed when it never calls wiki_task_submit', async () => {
    const test = await bench('没有提交。\n', (agent, message) => {
      appendCompletedTurn(agent.session, message)
    })

    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result.run).toMatchObject({ status: 'failed', coverage: { pending: 1 } })
    expect(result.tasks[0]).toMatchObject({
      status: 'failed',
      failure: 'Wiki Agent 回合结束但未提交任务：completed',
    })
  })

  it.each([false, true])('核验缺少重读或累计超额时不得 verified（累计超额 %s）', async exceedBudget => {
    const test = await bench('项目使用 SQLite。\n', async (agent, message, planned) => {
      const names = agent.ctx.tools.schemas(agent).map(value => value.name)
      if (names.includes('wiki_task_submit')) {
        const coverageId = String(planned.coverage[0]!.id)
        await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-analysis-read-for-verifier'),
          name: 'wiki_material_read',
          arguments: { coverageId },
          agent,
        })
        await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-analysis-submit-for-verifier'),
          name: 'wiki_task_submit',
          arguments: {
            coverage: [{ coverageId, outcome: 'analyzed' }],
            citations: [{ key: 'support', coverageId, role: 'supports' }],
            claims: [{
              kind: 'assertion',
              statement: '项目材料明确写明使用 SQLite。',
              citationKeys: ['support'],
              coverageIds: [coverageId],
            }],
            questions: businessQuestionArgs(1),
          },
          agent,
        })
      } else {
        const context = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-verifier-context-without-read'),
          name: 'wiki_verification_context',
          arguments: {},
          agent,
        })
        const value = context.value as { claims: Array<{ claimId: string }> }
        if (exceedBudget) {
          for (let index = 0; index < 2; index += 1) {
            const read = await agent.ctx.tools.execute({
              signal: new AbortController().signal, callId: ToolCallId(`verify-budget-${index}`),
              name: 'wiki_material_read', arguments: { coverageId: planned.coverage[0]!.id }, agent,
            })
            expect(read.isError).toBe(index === 1)
          }
        }
        const submit = await agent.ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('wiki-verifier-submit-without-read'),
          name: 'wiki_verification_submit',
          arguments: {
            decisions: [{ claimId: value.claims[0]!.claimId, outcome: 'verified' }],
            conflicts: [],
          },
          agent,
        })
        expect(submit.isError).toBe(true)
      }
      appendCompletedTurn(agent.session, message)
    }, {}, { maxTaskMaterialBytes: Buffer.byteLength('项目使用 SQLite。\n') })

    await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    const failed = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(failed.run).toMatchObject({ status: 'verifying', coverage: { analyzed: 1, pending: 0 } })
    expect(failed.tasks[1]).toMatchObject({ kind: 'verification', status: 'failed' })
    expect(failed.claims[0]?.status).toBe('proposed')
  })

  it('rejects a material completion hash that does not match the streamed bytes', async () => {
    const test = await bench('必须校验哈希。\n', async (agent, message, planned) => {
      const read = await agent.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('wiki-read-invalid-hash'),
        name: 'wiki_material_read',
        arguments: { coverageId: String(planned.coverage[0]!.id) },
        agent,
      })
      expect(read.isError).toBe(true)
      appendCompletedTurn(agent.session, message)
    }, { contentHash: `sha256:${'0'.repeat(64)}` })

    const result = await test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot)
    expect(result.run.status).toBe('failed')
    expect(result.coverage[0]?.status).toBe('pending')
  })

  it('deduplicates concurrent execution across equivalent project paths', async () => {
    let promptCount = 0
    const test = await bench('同一路径只运行一次。\n', async (agent, message) => {
      promptCount += 1
      appendCompletedTurn(agent.session, message)
    })

    const [first, second] = await Promise.all([
      test.ctx.wikiGeneration.runNext(test.planned.run.projectRoot),
      test.ctx.wikiGeneration.runNext(`${test.planned.run.projectRoot}/.`),
    ])
    expect(first.snapshotHash).toBe(second.snapshotHash)
    expect(promptCount).toBe(1)
  })
})
