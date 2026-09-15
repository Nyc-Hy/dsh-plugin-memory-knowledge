import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { realpath } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import * as recall from '../src/recall.js'
import type { EffectiveKnowledgeSearchHit, EffectiveKnowledgeSearchRequest } from '../src/effective-knowledge.js'
import type { MemoryCandidateId } from '../src/ids.js'
import type {
  GenerateKnowledgeCardCandidatesResult,
  ConversationExtractionCheckpoint,
  ListReviewCandidatesRequest,
  ListRecallableMemoryRequest,
  MemoryCandidate,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryTrace,
  PromoteReviewCandidateResult,
  PrepareConversationExtractionRequest,
  RecordConversationExtractionRequest,
  RecordConversationExtractionResult,
  RecallableMemoryRecord,
  ReviewCandidate,
  ReviewCandidateDecision,
  SaveMemoryCandidateInput,
} from '../src/runtime-model.js'
import { MemoryKnowledge } from '../src/service.js'
import { makeTempProject } from './helpers.js'

let searchHits: MemorySearchHit[] = []
let searchError: Error | undefined
let searchRequests: MemorySearchRequest[] = []
let effectiveSearchHits: EffectiveKnowledgeSearchHit[] = []
let effectiveSearchError: Error | undefined
let effectiveSearchRequests: EffectiveKnowledgeSearchRequest[] = []
const contexts: Context[] = []

class StubMemoryKnowledge extends MemoryKnowledge {
  override searchEffectiveKnowledge(request: EffectiveKnowledgeSearchRequest): Promise<EffectiveKnowledgeSearchHit[]> {
    effectiveSearchRequests.push(structuredClone(request))
    return effectiveSearchError === undefined
      ? Promise.resolve(structuredClone(effectiveSearchHits))
      : Promise.reject(effectiveSearchError)
  }
  override saveCandidate(_input: SaveMemoryCandidateInput): Promise<MemoryCandidate> {
    return Promise.reject(new Error('unused'))
  }

  override prepareConversationExtraction(
    _request: PrepareConversationExtractionRequest,
  ): Promise<ConversationExtractionCheckpoint> {
    return Promise.reject(new Error('unused'))
  }

  override recordConversationExtraction(
    _request: RecordConversationExtractionRequest,
  ): Promise<RecordConversationExtractionResult> {
    return Promise.reject(new Error('unused'))
  }

  override listCandidates(_request: ListReviewCandidatesRequest): Promise<ReviewCandidate[]> {
    return Promise.resolve([])
  }

  override getCandidate(_id: MemoryCandidateId): Promise<ReviewCandidate | undefined> {
    return Promise.resolve(undefined)
  }

  override reviewCandidate(_id: MemoryCandidateId, _decision: ReviewCandidateDecision): Promise<ReviewCandidate> {
    return Promise.reject(new Error('unused'))
  }

  override async createLocalMemoryEntry(): Promise<never> { throw new Error('not used') }
  override async listLocalMemoryEntries(): Promise<never> { throw new Error('not used') }
  override async getLocalMemoryEntry(): Promise<never> { throw new Error('not used') }
  override async updateLocalMemoryEntry(): Promise<never> { throw new Error('not used') }
  override async setLocalMemoryEntryStatus(): Promise<never> { throw new Error('not used') }
  override async listLocalMemoryRevisions(): Promise<never> { throw new Error('not used') }

  override generateKnowledgeCardCandidates(_projectRoot: string): Promise<GenerateKnowledgeCardCandidatesResult> {
    return Promise.resolve({ candidates: [], skipped: [], understandings: [] })
  }

  override async planWikiProject(): Promise<never> {
    throw new Error('not used')
  }

  override async getKnowledgeVersionState(): Promise<never> { throw new Error('not used') }
  override async listKnowledgeHumanRevisions(): Promise<never> { throw new Error('not used') }
  override async applyKnowledgeHumanRevision(): Promise<never> { throw new Error('not used') }
  override async activateWikiRun(): Promise<never> { throw new Error('not used') }

  override async getWikiRunSnapshot(): Promise<never> {
    throw new Error('not used')
  }

  override async getWikiMaterialReadBudget(): Promise<never> { throw new Error('not used') }
  override async searchWikiCatalog(): Promise<never> { throw new Error('not used') }
  override async listWikiCatalogRanges(): Promise<never> { throw new Error('not used') }
  override async listWikiMaterialReadBudgets(): Promise<never> { throw new Error('not used') }
  override async increaseWikiMaterialReadBudget(): Promise<never> { throw new Error('not used') }
  override async reserveWikiMaterialRead(): Promise<never> { throw new Error('not used') }

  override async saveWikiRunSnapshot(): Promise<never> {
    throw new Error('not used')
  }

  override async listWikiRuns(): Promise<never> {
    throw new Error('not used')
  }

  override listSourceUnderstandings(_projectRoot: string): Promise<[]> {
    return Promise.resolve([])
  }

  override listSourceInventoryBaselines(_projectRoot: string): Promise<[]> {
    return Promise.resolve([])
  }

  override listRecallable(_request: ListRecallableMemoryRequest): Promise<RecallableMemoryRecord[]> {
    return Promise.resolve([])
  }

  override promoteCandidate(_id: MemoryCandidateId, _projectRoot?: string): Promise<PromoteReviewCandidateResult> {
    return Promise.reject(new Error('unused'))
  }

  override search(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    searchRequests.push(structuredClone(request))
    return searchError === undefined ? Promise.resolve(structuredClone(searchHits)) : Promise.reject(searchError)
  }

  override async searchSourceEvidence(): Promise<never> {
    throw new Error('not used')
  }

  override async querySourceRelations(): Promise<never> {
    throw new Error('not used')
  }

  override async querySourceSymbols(): Promise<never> {
    throw new Error('not used')
  }

  override trace(_id: string, _projectRoot?: string): Promise<MemoryTrace | undefined> {
    return Promise.resolve(undefined)
  }
}

afterEach(async () => {
  searchHits = []
  searchError = undefined
  searchRequests = []
  effectiveSearchHits = []
  effectiveSearchError = undefined
  effectiveSearchRequests = []
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function sessionAgent(session: Session, provider = 'minimax-cn'): Agent {
  return {
    id: session.id,
    options: { provider, model: 'MiniMax-M3' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('recall must enter through pre-step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function mounted(
  project: string | undefined,
  config: recall.Config = {},
  provider = 'minimax-cn',
): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(StubMemoryKnowledge)
  await ctx.plugin(recall, { maxItems: 3, maxChars: 2_000, maxQueryChars: 500, ...config })
  const id = SessionId('recall-test')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: 1,
    ...project === undefined ? {} : { cwd: project },
  })
  return { ctx, agent: sessionAgent(session, provider) }
}

function effectiveHit(projectRoot: string): EffectiveKnowledgeSearchHit {
  return {
    pageId: 'wpage_11111111-1111-4111-8111-111111111111' as never,
    projectRoot,
    runId: 'wrun_22222222-2222-4222-8222-222222222222' as never,
    generatedVersionId: 'kgv_33333333-3333-4333-8333-333333333333' as never,
    effectiveVersionId: 'kev_44444444-4444-4444-8444-444444444444' as never,
    runSnapshotHash: `sha256:${'a'.repeat(64)}`,
    title: '订单流程',
    content: '[assertion:verified] 订单从 API 进入。\n\n[human-note:khr_55555555-5555-4555-8555-555555555555] 退款需人工复核。',
    status: 'verified',
    tags: ['effective-wiki-page', 'human-revision'],
    humanRevisionIds: ['khr_55555555-5555-4555-8555-555555555555' as never],
    noteRevisionIds: ['khr_55555555-5555-4555-8555-555555555555' as never],
    sources: [{
      claimId: 'wclaim_66666666-6666-4666-8666-666666666666' as never,
      citationId: 'wcite_77777777-7777-4777-8777-777777777777' as never,
      provenance: {
        kind: 'document',
        sourceId: 'src_22222222-2222-4222-8222-222222222222' as never,
        path: 'src/order.ts',
        contentHash: `sha256:${'b'.repeat(64)}`,
      },
    }],
    updatedAt: '2026-09-14T00:00:00.000Z',
    score: 1,
    truncated: false,
  }
}

async function fire(ctx: Context, agent: Agent, text: string, source: 'user' | 'plugin' = 'user') {
  const proposed = createUserMessage({
    content: [{ type: 'text', text }],
    source: source === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'test' },
  })
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
}

async function resolveRequest(ctx: Context, agent: Agent, provider: string) {
  return agentEvents(ctx, agent).waterfall(
    'agent/request',
    { turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ provider, model: provider === 'minimax-cn' ? 'MiniMax-M3' : 'other-model' }),
  )
}

describe('durable automatic recall', () => {
  it('extracts only direct user text', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: '真实问题' }], source: { kind: 'user' } })
    const plugin = createUserMessage({
      content: [{ type: 'text', text: '插件上下文' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(recall.recallQuery([plugin, user], 100)).toBe('真实问题')
    expect(recall.recallQuery([plugin], 100)).toBeUndefined()
  })

  it('adds one source-attributed recall message to the pre-step decision', async () => {
    const project = await makeTempProject()
    searchHits = [{
      id: 'mem_33333333-3333-4333-8333-333333333333' as never,
      recordType: 'project-memory',
      title: '固定问候语',
      content: 'greeting 返回 hello。',
      tags: ['example'],
      evidenceClass: 'deterministic',
      sensitivity: 'normal',
      scope: { kind: 'source', sourceId: 'src_22222222-2222-4222-8222-222222222222' as never },
      provenance: [{
        kind: 'git-file',
        sourceId: 'src_22222222-2222-4222-8222-222222222222' as never,
        commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        path: 'src/example.ts',
        contentHash: `sha256:${'0'.repeat(64)}`,
      }],
      updatedAt: '2026-08-24T00:00:00.000Z',
      score: 1,
      truncated: false,
    }]
    const { ctx, agent } = await mounted(project)
    const decision = await fire(ctx, agent, '问候语是什么？')
    expect(searchRequests).toEqual([expect.objectContaining({ domain: 'memory' })])
    expect(effectiveSearchRequests).toEqual([])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected entered step')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source).toMatchObject({
      kind: 'memory-knowledge-recall',
      plugin: recall.name,
      form: 'recall',
      memoryIds: ['mem_33333333-3333-4333-8333-333333333333'],
      effectiveVersionIds: [],
      pageIds: [],
    })
    expect(injected.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('mem_33333333') })
    const bounded = recall.renderRecall([{ ...searchHits[0]!, content: '证据'.repeat(1_000) }], 500)
    expect(bounded?.length).toBeLessThanOrEqual(500)

    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    expect(agent.session.deriveMessages().at(-1)?.source).toMatchObject({
      kind: 'memory-knowledge-recall',
      plugin: recall.name,
      form: 'recall',
    })
  })

  it('recalls only allowlisted effective knowledge and guards every later Provider request', async () => {
    const project = await makeTempProject()
    const canonicalProject = await realpath(project)
    effectiveSearchHits = [effectiveHit(canonicalProject)]
    const { ctx, agent } = await mounted(project, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [project],
      knowledgeAllowedProviders: ['minimax-cn'],
      knowledgeMaxItems: 2,
      knowledgeMaxChars: 4_000,
      maxTotalChars: 8_000,
    })

    const decision = await fire(ctx, agent, '订单和退款流程是什么？')
    expect(effectiveSearchRequests).toEqual([expect.objectContaining({
      projectRoot: canonicalProject,
      limit: 2,
      maxChars: 4_000,
    })])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected entered step')
    const injected = decision.messages.at(-1)!
    expect(injected.source).toMatchObject({
      kind: 'memory-knowledge-recall',
      plugin: recall.name,
      form: 'recall',
      projectRoot: canonicalProject,
      effectiveVersionIds: ['kev_44444444-4444-4444-8444-444444444444'],
      pageIds: ['wpage_11111111-1111-4111-8111-111111111111'],
    })
    expect(injected.content[0]).toMatchObject({ type: 'text' })
    const injectedText = injected.content[0]?.type === 'text' ? injected.content[0].text : ''
    expect(injectedText).toContain('EffectiveVersion: kev_44444444')
    expect(injectedText).toContain(`项目根：${canonicalProject}`)
    expect(injectedText).toContain('human-note:khr_55555555')
    expect(injectedText).toContain('src/order.ts')

    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    await expect(resolveRequest(ctx, agent, 'minimax-cn')).resolves.toMatchObject({ provider: 'minimax-cn' })
    await expect(resolveRequest(ctx, agent, 'other-provider'))
      .rejects.toThrow('blocks effective project knowledge egress')

    const disposeRewrite = ctx.on('agent/request', async (_payload, next) => ({
      ...await next(),
      provider: 'other-provider',
      model: 'other-model',
    }))
    await expect(resolveRequest(ctx, agent, 'minimax-cn'))
      .rejects.toThrow('blocks effective project knowledge egress')
    disposeRewrite()
  })

  it('keeps the knowledge egress guard after restoring the durable Session', async () => {
    const project = await makeTempProject()
    const canonicalProject = await realpath(project)
    effectiveSearchHits = [effectiveHit(canonicalProject)]
    const { ctx, agent } = await mounted(project, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [project],
      knowledgeAllowedProviders: ['minimax-cn'],
    })
    const decision = await fire(ctx, agent, '订单流程是什么？')
    if (decision.kind !== 'enter') throw new Error('expected entered step')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })

    const restoredSession = Session.fromRestore(
      agent.session.id,
      structuredClone([...agent.session.events]),
      structuredClone(agent.session.header),
    )
    const restoredAgent = sessionAgent(restoredSession)
    await expect(resolveRequest(ctx, restoredAgent, 'minimax-cn')).resolves.toMatchObject({ provider: 'minimax-cn' })
    await expect(resolveRequest(ctx, restoredAgent, 'other-provider'))
      .rejects.toThrow('blocks effective project knowledge egress')
  })

  it('guards restored legacy recall messages and every recorded project root', async () => {
    const project = await makeTempProject()
    const otherProject = await makeTempProject()
    const canonicalProject = await realpath(project)
    const canonicalOtherProject = await realpath(otherProject)
    const { ctx, agent } = await mounted(project, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [project],
      knowledgeAllowedProviders: ['minimax-cn'],
    })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{
        type: 'text',
        text: `# Agent 背景召回\n\n## 项目知识（当前 EffectiveVersion）\n项目根：${canonicalProject}\n项目根：${canonicalOtherProject}`,
      }],
      source: { kind: 'plugin', plugin: recall.name, form: 'recall' },
    }), { surfaceOp: 'append' })

    const restoredSession = Session.fromRestore(
      agent.session.id,
      structuredClone([...agent.session.events]),
      structuredClone(agent.session.header),
    )
    await expect(resolveRequest(ctx, sessionAgent(restoredSession), 'minimax-cn'))
      .rejects.toThrow('blocks effective project knowledge egress')
  })

  it('does not query project knowledge outside the explicit project allowlist', async () => {
    const project = await makeTempProject()
    const allowedProject = await makeTempProject()
    effectiveSearchHits = [effectiveHit(project)]
    const { ctx, agent } = await mounted(project, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [allowedProject],
      knowledgeAllowedProviders: ['minimax-cn'],
    })

    await fire(ctx, agent, '项目流程是什么？')
    expect(effectiveSearchRequests).toEqual([])
  })

  it('keeps personal memory recall when the Session has no project binding', async () => {
    const allowedProject = await makeTempProject()
    const { ctx, agent } = await mounted(undefined, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [allowedProject],
      knowledgeAllowedProviders: ['minimax-cn'],
    })

    await fire(ctx, agent, '我的偏好是什么？')
    expect(searchRequests).toEqual([expect.not.objectContaining({ projectRoot: expect.anything() })])
    expect(effectiveSearchRequests).toEqual([])
  })

  it('retains memory hits and emits one notice when effective knowledge search fails', async () => {
    const project = await makeTempProject()
    searchHits = [{
      id: 'mem_33333333-3333-4333-8333-333333333333' as never,
      recordType: 'personal-memory',
      title: '编码偏好',
      content: '使用中文回答。',
      tags: [],
      evidenceClass: 'human-verified',
      sensitivity: 'normal',
      provenance: [{ kind: 'session', sessionId: SessionId('source-session'), eventSeqs: [1] }],
      updatedAt: '2026-09-14T00:00:00.000Z',
      score: 1,
      truncated: false,
    }]
    effectiveSearchError = new Error('effective index unavailable')
    const { ctx, agent } = await mounted(project, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [project],
      knowledgeAllowedProviders: ['minimax-cn'],
    })

    const first = await fire(ctx, agent, '如何回答？')
    const second = await fire(ctx, agent, '再次回答？')
    expect(first.kind === 'enter' ? first.messages : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ form: 'notice', summary: '项目知识召回不可用' }) }),
      expect.objectContaining({ source: expect.objectContaining({ form: 'recall' }) }),
    ]))
    expect(second.kind === 'enter'
      ? second.messages.filter(message => message.source.kind === 'plugin' && message.source.form === 'notice')
      : [])
      .toEqual([])
  })

  it('drops cross-project effective results without dropping local memory hits', async () => {
    const project = await makeTempProject()
    const otherProject = await makeTempProject()
    searchHits = [{
      id: 'mem_33333333-3333-4333-8333-333333333333' as never,
      recordType: 'personal-memory',
      title: '编码偏好',
      content: '使用中文回答。',
      tags: [],
      evidenceClass: 'human-verified',
      sensitivity: 'normal',
      provenance: [{ kind: 'session', sessionId: SessionId('source-session'), eventSeqs: [1] }],
      updatedAt: '2026-09-14T00:00:00.000Z',
      score: 1,
      truncated: false,
    }]
    effectiveSearchHits = [effectiveHit(await realpath(otherProject))]
    const { ctx, agent } = await mounted(project, {
      knowledgeEgressMode: 'allow',
      knowledgeAllowedProjectRoots: [project],
      knowledgeAllowedProviders: ['minimax-cn'],
    })

    const decision = await fire(ctx, agent, '项目和偏好是什么？')
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected entered step')
    expect(decision.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ form: 'notice', summary: '项目知识召回不可用' }) }),
      expect.objectContaining({
        source: expect.objectContaining({
          kind: 'memory-knowledge-recall',
          memoryIds: ['mem_33333333-3333-4333-8333-333333333333'],
          effectiveVersionIds: [],
          pageIds: [],
        }),
      }),
    ]))
    const recalled = decision.messages.find(message => message.source.kind === 'memory-knowledge-recall')
    const text = recalled?.content[0]?.type === 'text' ? recalled.content[0].text : ''
    expect(text).toContain('使用中文回答。')
    expect(text).not.toContain('订单从 API 进入。')
  })

  it('records bounded query budgets and never exceeds the total recall envelope', () => {
    const project = '/workspace/allowed'
    const rendered = recall.renderAgentRecall([], [{ ...effectiveHit(project), content: '证据'.repeat(2_000) }], {
      memoryItems: 3,
      memoryChars: 2_000,
      knowledgeItems: 2,
      knowledgeChars: 4_000,
      totalChars: 1_600,
    })
    expect(rendered?.length).toBeLessThanOrEqual(1_600)
    expect(rendered).toContain('knowledge=2 页/4000 字符')
    expect(rendered).toContain('Agent 上下文总预算截断')
  })

  it('rejects incomplete or malformed knowledge egress configuration at load', async () => {
    const project = await makeTempProject()
    const cases: Array<{ config: recall.Config; message: string }> = [
      {
        config: { knowledgeEgressMode: 'allow' },
        message: 'allow mode requires project-root and Provider allowlists',
      },
      {
        config: { knowledgeAllowedProjectRoots: [`${project}/..`] },
        message: 'must contain normalized absolute paths',
      },
      {
        config: { knowledgeAllowedProviders: [''] },
        message: 'must contain non-empty Provider routes',
      },
      {
        config: { maxTotalChars: 0 },
        message: 'expected number >= 1',
      },
      {
        config: { knowledgeAllowedProjectRoots: [`${project}/missing`] },
        message: 'ENOENT',
      },
    ]

    for (const testCase of cases) {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubMemoryKnowledge)
      await expect(ctx.plugin(recall, testCase.config)).rejects.toThrow(testCase.message)
    }
  })

  it('does not recursively recall from plugin-only context', async () => {
    const { ctx, agent } = await mounted(await makeTempProject())
    searchHits = []
    const decision = await fire(ctx, agent, 'already recalled', 'plugin')
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
  })

  it('logs one degraded notice for a repeated workspace failure', async () => {
    const { ctx, agent } = await mounted(await makeTempProject())
    searchError = new Error('invalid canonical')
    const first = await fire(ctx, agent, '第一次')
    const second = await fire(ctx, agent, '第二次')
    expect(first.kind === 'enter' ? first.messages.at(-1)?.source : undefined).toMatchObject({ form: 'notice' })
    expect(second.kind === 'enter' ? second.messages : []).toHaveLength(1)
  })
})
