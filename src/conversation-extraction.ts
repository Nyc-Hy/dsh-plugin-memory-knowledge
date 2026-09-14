import type { MemoryEntry } from './model.js'
import type { MemoryCandidateApplicability } from './runtime-model.js'

/** Version of the deterministic explicit-memory rule set and its durable checkpoint. */
export const CONVERSATION_EXTRACTOR_VERSION = 1

/** Default input and candidate bounds for explicit conversation memory extraction. */
export const DEFAULT_CONVERSATION_EXTRACTION_MAX_INPUT_CHARS = 4_000
export const DEFAULT_CONVERSATION_EXTRACTION_MAX_CONTENT_CHARS = 500
export const DEFAULT_CONVERSATION_EXTRACTION_MAX_TITLE_CHARS = 80

/** Bounded deterministic extraction configuration. */
export interface ConversationExtractionConfig {
  maxInputChars: number
  maxContentChars: number
  maxTitleChars: number
}

/** One explicit user statement safe enough to enter the human review inbox. */
export interface ExplicitMemoryExtraction {
  ruleId: string
  applicability: MemoryCandidateApplicability
  kind: MemoryEntry['kind']
  title: string
  content: string
  tags: string[]
  sensitivity: 'normal'
}

/** Portable reason a direct user message did not produce an automatic candidate. */
export type ConversationExtractionSkipReason =
  | 'empty'
  | 'input-limit'
  | 'unsafe-content'
  | 'negative'
  | 'question'
  | 'conditional'
  | 'quoted-or-code'
  | 'multiple-statements'
  | 'ambiguous-reference'
  | 'not-explicit'
  | 'content-limit'

/** Deterministic outcome for one direct user text message. */
export type ConversationExtractionResult =
  | { kind: 'candidate'; value: ExplicitMemoryExtraction }
  | { kind: 'skipped'; reason: ConversationExtractionSkipReason }

interface RuleMatch {
  ruleId: string
  content: string
  defaultApplicability: MemoryCandidateApplicability
  forcedKind?: MemoryEntry['kind']
}

const SECRET_PATTERN = /(?:\b(?:api[-_ ]?key|access[-_ ]?key|secret(?:[-_ ]?key)?|password|passwd|passphrase|private[-_ ]?key|authorization|bearer|session[-_ ]?cookie|refresh[-_ ]?token|otp)\b|密码|口令|密钥|私钥|访问令牌|刷新令牌|验证码|授权头|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b[0-9a-f]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b)/iu
const NEGATIVE_MEMORY_PATTERN = /(?:不要|别|无需|不用|不必)(?:再|长期)?(?:记住|记录|保存)|(?:do not|don't|dont|never)\s+(?:remember|store|save)/iu
const CONDITIONAL_PATTERN = /^(?:如果|假如|假设|若|when\b|if\b|unless\b)/iu
const AMBIGUOUS_REFERENCE_PATTERN = /^(?:这个(?!项目|仓库|团队)|那个|这件事|那件事|上述|前面(?:的)?|它\b|this\b(?!\s+(?:project|repo|repository|team)\b)|that\b|it\b)/iu
const PERSONAL_PATTERN = /(?:^|[，,:：\s])(?:我|我的|本人|个人|\b(?:i|my|me)\b)/iu
const PROJECT_PATTERN = /(?:项目|仓库|代码库|团队|工作区|workspace|project|repo(?:sitory)?|team)/iu
const DECISION_PATTERN = /(?:决定|选定|选择|采用|decision|decided|chose|chosen|adopt(?:ed)?)/iu
const CONSTRAINT_PATTERN = /(?:必须|禁止|不得|只能|统一|约定|要求|constraint|required?|must|never|only|standard(?:ize|ized)?)/iu
const PREFERENCE_PATTERN = /(?:偏好|喜欢|习惯|希望|以后请|今后请|prefer|preference|always\s+(?:reply|respond|use|call))/iu
const LESSON_PATTERN = /(?:经验|教训|注意事项|踩坑|lesson|pitfall|learned)/iu

function codePointLength(value: string): number {
  return [...value].length
}

function truncateCodePoints(value: string, limit: number): string {
  const points = [...value]
  if (points.length <= limit) return value
  return limit === 1 ? '…' : `${points.slice(0, limit - 1).join('')}…`
}

function normalizeInput(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function trimTerminalPunctuation(value: string): string {
  return value.replace(/[。.!！]+$/u, '').trim()
}

function matchRule(text: string): RuleMatch | undefined {
  const rememberZh = /^(?:(?:请|麻烦)(?:你)?|帮我)?(?:长期)?(?:记住|记一下|记下来|保存为记忆)\s*[,:：，]?\s*(.+)$/iu.exec(text)
  if (rememberZh !== null) {
    return { ruleId: 'explicit-remember-zh', content: rememberZh[1]!, defaultApplicability: 'project' }
  }
  const rememberEn = /^(?:please\s+)?(?:remember|keep in mind|save as (?:a )?memory)\s*(?:that\s+)?[,:]?\s*(.+)$/iu.exec(text)
  if (rememberEn !== null) {
    return { ruleId: 'explicit-remember-en', content: rememberEn[1]!, defaultApplicability: 'project' }
  }
  if (/^(?:我|本人)(?:一直|长期)?(?:更)?(?:偏好|喜欢|习惯|希望)/u.test(text)
    || /^i\s+(?:always\s+)?(?:prefer|like|want)\b/iu.test(text)
    || /^(?:以后|今后|长期)(?:请|请你)\s*(?:用|使用|称呼|回复|回答|输出)/u.test(text)
    || /^always\s+(?:reply|respond|use|call)\b/iu.test(text)) {
    return { ruleId: /[\p{Script=Han}]/u.test(text) ? 'explicit-preference-zh' : 'explicit-preference-en', content: text, defaultApplicability: 'global', forcedKind: 'preference' }
  }
  if (/^(?:这个|本)?(?:项目|仓库|代码库|团队|工作区)(?:已经)?(?:决定|统一|规定|要求|约定|必须|禁止|不得|只能|使用|采用|选择)/u.test(text)
    || /^(?:this\s+)?(?:project|repo(?:sitory)?|team|workspace)\s+(?:has\s+)?(?:decided|uses?|requires?|must|only|standardizes?|adopts?|chose|chooses)\b/iu.test(text)) {
    return { ruleId: /[\p{Script=Han}]/u.test(text) ? 'explicit-project-zh' : 'explicit-project-en', content: text, defaultApplicability: 'project' }
  }
  return undefined
}

function inferKind(content: string, forced: MemoryEntry['kind'] | undefined): MemoryEntry['kind'] {
  if (forced !== undefined) return forced
  if (DECISION_PATTERN.test(content)) return 'decision'
  if (CONSTRAINT_PATTERN.test(content)) return 'constraint'
  if (PREFERENCE_PATTERN.test(content)) return 'preference'
  if (LESSON_PATTERN.test(content)) return 'lesson'
  return 'fact'
}

function inferApplicability(content: string, fallback: MemoryCandidateApplicability): MemoryCandidateApplicability {
  if (PERSONAL_PATTERN.test(content) && !PROJECT_PATTERN.test(content)) return 'global'
  if (PROJECT_PATTERN.test(content)) return 'project'
  return fallback
}

function statementCount(text: string): number {
  const withoutTerminal = text.replace(/[。.!！]+$/u, '')
  return (withoutTerminal.match(/[。！？?]|[.!](?=\s)/gu) ?? []).length + 1
}

function titleFor(kind: MemoryEntry['kind'], content: string, maxChars: number): string {
  const label: Record<MemoryEntry['kind'], string> = {
    fact: '事实',
    decision: '决定',
    lesson: '经验',
    method: '方法与流程',
    preference: '偏好',
    constraint: '约束',
  }
  return truncateCodePoints(`${label[kind]}：${content}`, maxChars)
}

/** Extract one low-false-positive review candidate from a direct user statement. */
export function extractExplicitMemory(
  input: string,
  config: ConversationExtractionConfig = {
    maxInputChars: DEFAULT_CONVERSATION_EXTRACTION_MAX_INPUT_CHARS,
    maxContentChars: DEFAULT_CONVERSATION_EXTRACTION_MAX_CONTENT_CHARS,
    maxTitleChars: DEFAULT_CONVERSATION_EXTRACTION_MAX_TITLE_CHARS,
  },
): ConversationExtractionResult {
  if (input.trim().length === 0) return { kind: 'skipped', reason: 'empty' }
  if (codePointLength(input) > config.maxInputChars) return { kind: 'skipped', reason: 'input-limit' }
  const text = normalizeInput(input)
  if (SECRET_PATTERN.test(text)) return { kind: 'skipped', reason: 'unsafe-content' }
  if (NEGATIVE_MEMORY_PATTERN.test(text)) return { kind: 'skipped', reason: 'negative' }
  if (/[?？]\s*$/u.test(text) || /^(?:你能|能否|可以|可不可以|could you\b|can you\b|would you\b)/iu.test(text)) {
    return { kind: 'skipped', reason: 'question' }
  }
  if (CONDITIONAL_PATTERN.test(text)) return { kind: 'skipped', reason: 'conditional' }
  if (/^(?:```|~~~|>|["'“”‘’])/u.test(text)) return { kind: 'skipped', reason: 'quoted-or-code' }
  if (statementCount(text) > 1) return { kind: 'skipped', reason: 'multiple-statements' }
  const match = matchRule(text)
  if (match === undefined) return { kind: 'skipped', reason: 'not-explicit' }
  const content = trimTerminalPunctuation(match.content)
  if (CONDITIONAL_PATTERN.test(content)) return { kind: 'skipped', reason: 'conditional' }
  if (/^(?:```|~~~|>|["'“”‘’])/u.test(content)) return { kind: 'skipped', reason: 'quoted-or-code' }
  if (AMBIGUOUS_REFERENCE_PATTERN.test(content)) return { kind: 'skipped', reason: 'ambiguous-reference' }
  if (codePointLength(content) < 3) return { kind: 'skipped', reason: 'not-explicit' }
  if (codePointLength(content) > config.maxContentChars) return { kind: 'skipped', reason: 'content-limit' }
  const kind = inferKind(content, match.forcedKind)
  const language = /[\p{Script=Han}]/u.test(content) ? 'zh' : 'en'
  return {
    kind: 'candidate',
    value: {
      ruleId: match.ruleId,
      applicability: inferApplicability(content, match.defaultApplicability),
      kind,
      title: titleFor(kind, content, config.maxTitleChars),
      content,
      tags: ['conversation-extraction', 'deterministic', language, match.ruleId],
      sensitivity: 'normal',
    },
  }
}
