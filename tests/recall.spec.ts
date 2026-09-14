import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as recall from '../src/recall.js'
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
const contexts: Context[] = []

class StubMemoryKnowledge extends MemoryKnowledge {
  override async searchEffectiveKnowledge(): Promise<[]> { return [] }
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
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function sessionAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
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

async function mounted(project: string): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(StubMemoryKnowledge)
  await ctx.plugin(recall, { maxItems: 3, maxChars: 2_000, maxQueryChars: 500 })
  const id = SessionId('recall-test')
  const session = Session.create(id, undefined, { version: 0, id, createdAt: 1, cwd: project })
  return { ctx, agent: sessionAgent(session) }
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
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected entered step')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source).toEqual({ kind: 'plugin', plugin: recall.name, form: 'recall' })
    expect(injected.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('mem_33333333') })
    const bounded = recall.renderRecall([{ ...searchHits[0]!, content: '证据'.repeat(1_000) }], 500)
    expect(bounded?.length).toBeLessThanOrEqual(500)

    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    expect(agent.session.deriveMessages().at(-1)?.source).toEqual({ kind: 'plugin', plugin: recall.name, form: 'recall' })
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
