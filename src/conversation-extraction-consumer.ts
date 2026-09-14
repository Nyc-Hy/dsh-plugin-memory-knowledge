import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  CONVERSATION_EXTRACTOR_VERSION,
  DEFAULT_CONVERSATION_EXTRACTION_MAX_CONTENT_CHARS,
  DEFAULT_CONVERSATION_EXTRACTION_MAX_INPUT_CHARS,
  DEFAULT_CONVERSATION_EXTRACTION_MAX_TITLE_CHARS,
  extractExplicitMemory,
  type ConversationExtractionConfig,
} from './conversation-extraction.js'
import type { SaveMemoryCandidateInput } from './runtime-model.js'
import type {} from './service.js'
import { DEFAULT_PROJECT_ROOT_MARKERS, findProjectRoot } from './workspace.js'

/** Cordis plugin name and durable extractor key. */
export const name = 'memory-knowledge-conversation-extraction'

/** Session lifecycle, persistence, prompt, and local memory services required by extraction. */
export const inject = ['agents', 'sessions', 'memoryKnowledge', 'systemPrompt']

const EXTRACTOR_KEY = 'explicit-memory'
const PROMPT = [
  '用户直接说“请记住”、明确陈述长期偏好或项目决定时，系统会在回合结束后自动生成本地待审核候选。',
  '本段存在时，不要为这类明确表达重复调用 memory_candidate_save；该工具仍可用于未使用明确表达、但确有长期价值的信息。',
].join('\n')

/** Automatic explicit-memory extraction configuration. */
export interface Config {
  enabled?: boolean
  maxInputChars?: number
  maxContentChars?: number
  maxTitleChars?: number
  projectRootMarkers?: string[]
  cwdFallback?: 'process' | 'none'
}

/** Schemastery configuration for deterministic post-turn extraction. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxInputChars: z.number().step(1).min(1).default(DEFAULT_CONVERSATION_EXTRACTION_MAX_INPUT_CHARS),
  maxContentChars: z.number().step(1).min(3).default(DEFAULT_CONVERSATION_EXTRACTION_MAX_CONTENT_CHARS),
  maxTitleChars: z.number().step(1).min(3).default(DEFAULT_CONVERSATION_EXTRACTION_MAX_TITLE_CHARS),
  projectRootMarkers: z.array(z.string()).min(1).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  cwdFallback: z.union(['process', 'none'] as const).default('none'),
})

interface ResolvedConfig extends ConversationExtractionConfig {
  enabled: boolean
  projectRootMarkers: string[]
  cwdFallback: 'process' | 'none'
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    enabled: config.enabled ?? true,
    maxInputChars: config.maxInputChars ?? DEFAULT_CONVERSATION_EXTRACTION_MAX_INPUT_CHARS,
    maxContentChars: config.maxContentChars ?? DEFAULT_CONVERSATION_EXTRACTION_MAX_CONTENT_CHARS,
    maxTitleChars: config.maxTitleChars ?? DEFAULT_CONVERSATION_EXTRACTION_MAX_TITLE_CHARS,
    projectRootMarkers: [...(config.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS)],
    cwdFallback: config.cwdFallback ?? 'none',
  }
  for (const [key, value] of Object.entries({
    maxInputChars: resolved.maxInputChars,
    maxContentChars: resolved.maxContentChars,
    maxTitleChars: resolved.maxTitleChars,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`conversation extraction ${key} must be a positive safe integer`)
    }
  }
  if (resolved.maxContentChars < 3 || resolved.maxTitleChars < 3) {
    throw new Error('conversation extraction content and title limits must be at least 3')
  }
  if (resolved.projectRootMarkers.length === 0
    || resolved.projectRootMarkers.some(marker => marker.trim().length === 0)) {
    throw new Error('conversation extraction projectRootMarkers must contain non-empty paths')
  }
  return resolved
}

function turnStartSeq(events: readonly SessionEvent[], turnEnd: SessionEvent<'turn/end'>): number | undefined {
  for (let index = turnEnd.seq - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turnEnd.data.turn) return event.seq
  }
  return undefined
}

function directUserText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const text = event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return text.length === 0 ? undefined : text
}

async function turnCandidate(
  session: Session,
  events: readonly SessionEvent[],
  turnEnd: SessionEvent<'turn/end'>,
  config: ResolvedConfig,
  projectRoot: () => Promise<string | undefined>,
): Promise<SaveMemoryCandidateInput | undefined> {
  const startSeq = turnStartSeq(events, turnEnd)
  if (startSeq === undefined) return undefined
  for (const event of events.slice(startSeq + 1, turnEnd.seq)) {
    const text = directUserText(event)
    if (text === undefined) continue
    const result = extractExplicitMemory(text, config)
    if (result.kind === 'skipped') continue
    const root = result.value.applicability === 'project' ? await projectRoot() : undefined
    if (result.value.applicability === 'project' && root === undefined) continue
    return {
      target: 'memory',
      applicability: result.value.applicability,
      ...result.value.applicability === 'project' ? { projectRoot: root! } : {},
      kind: result.value.kind,
      title: result.value.title,
      content: result.value.content,
      tags: result.value.tags,
      sensitivity: result.value.sensitivity,
      suggestedBy: 'conversation',
      provenance: [{ kind: 'session', sessionId: session.id, eventSeqs: [event.seq] }],
    }
  }
  return undefined
}

async function projectRootForSession(session: Session, config: ResolvedConfig): Promise<string | undefined> {
  const cwd = session.header.cwd ?? (config.cwdFallback === 'process' ? process.cwd() : undefined)
  return cwd === undefined ? undefined : findProjectRoot(cwd, config.projectRootMarkers)
}

/** Process every completed turn after one durable extraction checkpoint. */
export async function processConversationExtractions(
  ctx: Context,
  session: Session,
  triggeringTurnEndSeq: number,
  config: ResolvedConfig,
): Promise<void> {
  await ctx.sessions.flush(session)
  const events = session.events
  const triggeringEvent = events[triggeringTurnEndSeq]
  if (triggeringEvent?.type !== 'turn/end') return
  const startSeq = turnStartSeq(events, triggeringEvent)
  if (startSeq === undefined) return
  const checkpoint = await ctx.memoryKnowledge.prepareConversationExtraction({
    sessionId: session.id,
    extractor: EXTRACTOR_KEY,
    version: CONVERSATION_EXTRACTOR_VERSION,
    baselineSeq: startSeq - 1,
  })
  let projectRootPromise: Promise<string | undefined> | undefined
  const projectRoot = (): Promise<string | undefined> => {
    projectRootPromise ??= projectRootForSession(session, config)
    return projectRootPromise
  }
  for (const event of events) {
    if (event.seq <= checkpoint.throughSeq || event.seq > triggeringTurnEndSeq || event.type !== 'turn/end') continue
    const candidate = await turnCandidate(session, events, event, config, projectRoot)
    await ctx.memoryKnowledge.recordConversationExtraction({
      sessionId: session.id,
      extractor: EXTRACTOR_KEY,
      version: CONVERSATION_EXTRACTOR_VERSION,
      turnEndSeq: event.seq,
      ...candidate === undefined ? {} : { candidate },
    })
  }
}

/** Register post-turn deterministic extraction without delaying or failing the agent loop. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  ctx.systemPrompt.section({ name: 'memory-knowledge:conversation-extraction', order: 115, text: PROMPT })

  const tails = new Map<string, Promise<void>>()
  const schedule = (session: Session, task: () => Promise<void>): void => {
    const key = String(session.id)
    const prior = tails.get(key) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(task)
    tails.set(key, next)
    void next.catch((error: unknown) => {
      ctx.logger.warn(`memory conversation extraction failed for session "${session.id}": ${String(error)}`)
    }).finally(() => {
      if (tails.get(key) === next) tails.delete(key)
    })
  }

  ctx.on('agent/session-start', ({ agent }) => {
    const baselineSeq = agent.session.seq - 1
    schedule(agent.session, async () => {
      await ctx.memoryKnowledge.prepareConversationExtraction({
        sessionId: agent.session.id,
        extractor: EXTRACTOR_KEY,
        version: CONVERSATION_EXTRACTOR_VERSION,
        baselineSeq,
      })
    })
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    schedule(session, () => processConversationExtractions(ctx, session, event.seq, resolved))
  })
  ctx.effect(() => async () => {
    await Promise.allSettled([...tails.values()])
  }, 'memoryKnowledge.conversationExtraction.close')
}
