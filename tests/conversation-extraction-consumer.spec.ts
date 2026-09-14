import { Context } from '@deepseek-ai/cordis'
import { realpath } from 'node:fs/promises'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as consumer from '../src/conversation-extraction-consumer.js'
import type { MemoryCandidateId } from '../src/ids.js'
import type {
  ConversationExtractionCheckpoint,
  GenerateKnowledgeCardCandidatesResult,
  ListRecallableMemoryRequest,
  ListReviewCandidatesRequest,
  MemoryCandidate,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryTrace,
  PrepareConversationExtractionRequest,
  PromoteReviewCandidateResult,
  RecallableMemoryRecord,
  RecordConversationExtractionRequest,
  RecordConversationExtractionResult,
  ReviewCandidate,
  ReviewCandidateDecision,
  SaveMemoryCandidateInput,
} from '../src/runtime-model.js'
import { MemoryKnowledge } from '../src/service.js'
import { makeTempProject } from './helpers.js'

const contexts: Context[] = []

class ExtractionMemoryKnowledge extends MemoryKnowledge {
  override async searchEffectiveKnowledge(): Promise<[]> { return [] }
  readonly checkpoints = new Map<string, ConversationExtractionCheckpoint>()
  readonly candidates: MemoryCandidate[] = []

  private key(request: PrepareConversationExtractionRequest): string {
    return `${request.sessionId}:${request.extractor}:${request.version}`
  }

  override saveCandidate(_input: SaveMemoryCandidateInput): Promise<MemoryCandidate> {
    return Promise.reject(new Error('unused'))
  }

  override listSourceInventoryBaselines(): Promise<[]> {
    return Promise.resolve([])
  }

  override prepareConversationExtraction(
    request: PrepareConversationExtractionRequest,
  ): Promise<ConversationExtractionCheckpoint> {
    const key = this.key(request)
    const checkpoint = this.checkpoints.get(key) ?? {
      sessionId: request.sessionId,
      extractor: request.extractor,
      version: request.version,
      throughSeq: request.baselineSeq,
      updatedAt: new Date().toISOString(),
    }
    this.checkpoints.set(key, checkpoint)
    return Promise.resolve(structuredClone(checkpoint))
  }

  override recordConversationExtraction(
    request: RecordConversationExtractionRequest,
  ): Promise<RecordConversationExtractionResult> {
    const key = this.key({ ...request, baselineSeq: -1 })
    const checkpoint = this.checkpoints.get(key)
    if (checkpoint === undefined) return Promise.reject(new Error('checkpoint missing'))
    if (request.turnEndSeq <= checkpoint.throughSeq) {
      return Promise.resolve({ outcome: 'already-processed', throughSeq: checkpoint.throughSeq })
    }
    const updatedAt = new Date().toISOString()
    this.checkpoints.set(key, { ...checkpoint, throughSeq: request.turnEndSeq, updatedAt })
    if (request.candidate === undefined) {
      return Promise.resolve({ outcome: 'skipped', throughSeq: request.turnEndSeq })
    }
    const candidate: MemoryCandidate = {
      id: `candidate-${this.candidates.length + 1}` as never,
      revision: 1,
      ...structuredClone(request.candidate),
      status: 'pending',
      createdAt: updatedAt,
      updatedAt,
    }
    this.candidates.push(candidate)
    return Promise.resolve({ outcome: 'candidate', throughSeq: request.turnEndSeq, candidate })
  }

  override listCandidates(_request: ListReviewCandidatesRequest): Promise<ReviewCandidate[]> {
    return Promise.resolve([...this.candidates])
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

  override async querySourceSymbols(): Promise<never> {
    throw new Error('not used')
  }

  override listRecallable(_request: ListRecallableMemoryRequest): Promise<RecallableMemoryRecord[]> {
    return Promise.resolve([])
  }

  override promoteCandidate(_id: MemoryCandidateId, _projectRoot?: string): Promise<PromoteReviewCandidateResult> {
    return Promise.reject(new Error('unused'))
  }

  override search(_request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    return Promise.resolve([])
  }

  override async searchSourceEvidence(): Promise<never> {
    throw new Error('not used')
  }

  override async querySourceRelations(): Promise<never> {
    throw new Error('not used')
  }

  override trace(_id: string, _projectRoot?: string): Promise<MemoryTrace | undefined> {
    return Promise.resolve(undefined)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ExtractionMemoryKnowledge)
  return ctx
}

async function mounted(): Promise<Context> {
  const ctx = await baseContext()
  await ctx.plugin(consumer)
  return ctx
}

describe('conversation extraction Consumer', () => {
  it('creates a pending project candidate after a durable turn/end event', async () => {
    const project = await makeTempProject()
    const ctx = await mounted()
    const session = ctx.sessions.create(SessionId('conversation-extraction'), { meta: { cwd: project } })
    session.append('turn/start', { turn: 1 })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请记住：这个项目统一使用 pnpm。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const turnEnd = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const memory = ctx.memoryKnowledge as ExtractionMemoryKnowledge
    await vi.waitFor(() => expect(memory.candidates).toHaveLength(1))
    expect(memory.candidates[0]).toMatchObject({
      applicability: 'project',
      projectRoot: await realpath(project),
      kind: 'constraint',
      status: 'pending',
      suggestedBy: 'conversation',
      provenance: [{ kind: 'session', sessionId: session.id, eventSeqs: [user.seq] }],
    })
    expect([...memory.checkpoints.values()][0]?.throughSeq).toBe(turnEnd.seq)
  })

  it('checkpoints skipped turns and tells the model not to duplicate explicit saves', async () => {
    const ctx = await mounted()
    const session = ctx.sessions.create(SessionId('conversation-extraction-skip'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '帮我解释这段代码。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const turnEnd = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const memory = ctx.memoryKnowledge as ExtractionMemoryKnowledge
    await vi.waitFor(() => expect([...memory.checkpoints.values()][0]?.throughSeq).toBe(turnEnd.seq))
    expect(memory.candidates).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections).toContainEqual(expect.objectContaining({
      name: 'memory-knowledge:conversation-extraction',
      text: expect.stringContaining('不要为这类明确表达重复调用 memory_candidate_save'),
    }))
  })

  it('captures the resume baseline before a new turn can append', async () => {
    const ctx = await baseContext()
    const session = ctx.sessions.create(SessionId('conversation-extraction-resume'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请记住：旧历史不应回填。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await ctx.plugin(consumer)
    ctx.emit('agent/session-start', { agent: { session } as never, source: 'resume' })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请记住：我偏好新的回答使用中文。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const memory = ctx.memoryKnowledge as ExtractionMemoryKnowledge
    await vi.waitFor(() => expect(memory.candidates).toHaveLength(1))
    expect(memory.candidates[0]?.content).toBe('我偏好新的回答使用中文')
  })
})
