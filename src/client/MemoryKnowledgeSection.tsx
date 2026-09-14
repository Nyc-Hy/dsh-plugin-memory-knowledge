import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconCloseOutline16,
  IconSearchOutline16,
  StateDot,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MemoryUiCandidate,
  MemoryUiEvidencePack,
  MemoryUiEvidenceSearchRequest,
  MemoryUiFreshnessReason,
  MemoryUiGenerateRequest,
  MemoryUiGenerateResult,
  MemoryUiKnowledgeVersionSummary,
  MemoryUiKnowledgeRevisionSaveRequest,
  MemoryUiKnowledgeRevisionSaveResult,
  MemoryUiMemoryCreateRequest,
  MemoryUiMemoryMutationResult,
  MemoryUiMemoryStatusRequest,
  MemoryUiMemoryUpdateRequest,
  MemoryUiMutationResult,
  MemoryUiOverview,
  MemoryUiOverviewRequest,
  MemoryUiPromoteRequest,
  MemoryUiRelationPack,
  MemoryUiRelationQueryRequest,
  MemoryUiRecord,
  MemoryUiRecordDomain,
  MemoryUiReviewRequest,
  MemoryUiSearchRequest,
  MemoryUiSearchResult,
  MemoryUiSymbolPack,
  MemoryUiSymbolQueryRequest,
  MemoryUiTrace,
  MemoryUiTraceRequest,
  MemoryUiWikiCoverageSummary,
  MemoryUiWikiCompletionCheck,
  MemoryUiWikiPlanRequest,
  MemoryUiWikiPlanResult,
  MemoryUiWikiRunSummary,
  MemoryUiWikiTaskRunRequest,
  MemoryUiWikiTaskRunResult,
  MemoryUiWikiTreeRequest,
  MemoryUiWikiTreeResult,
} from '../ui-contract.js'
import type { MemoryKnowledgeLocaleKey } from './locales.js'
import { WikiBudgetPanel } from './WikiBudgetPanel.js'
import type { WikiBudgetPanelOperations } from './WikiBudgetPanel.js'

/** Host operations injected into the Settings section. */
export interface MemoryKnowledgeSectionInjected extends WikiBudgetPanelOperations {
  overview: (request: MemoryUiOverviewRequest) => Promise<MemoryUiOverview>
  search: (request: MemoryUiSearchRequest) => Promise<MemoryUiSearchResult>
  searchEvidence: (request: MemoryUiEvidenceSearchRequest) => Promise<MemoryUiEvidencePack>
  queryRelations: (request: MemoryUiRelationQueryRequest) => Promise<MemoryUiRelationPack>
  querySymbols: (request: MemoryUiSymbolQueryRequest) => Promise<MemoryUiSymbolPack>
  trace: (request: MemoryUiTraceRequest) => Promise<MemoryUiTrace | null>
  createMemory: (request: MemoryUiMemoryCreateRequest) => Promise<MemoryUiMemoryMutationResult>
  updateMemory: (request: MemoryUiMemoryUpdateRequest) => Promise<MemoryUiMemoryMutationResult>
  setMemoryStatus: (request: MemoryUiMemoryStatusRequest) => Promise<MemoryUiMemoryMutationResult>
  review: (request: MemoryUiReviewRequest) => Promise<MemoryUiMutationResult>
  promote: (request: MemoryUiPromoteRequest) => Promise<MemoryUiMutationResult>
  generate: (request: MemoryUiGenerateRequest) => Promise<MemoryUiGenerateResult>
  planWiki: (request: MemoryUiWikiPlanRequest) => Promise<MemoryUiWikiPlanResult>
  runWikiTask: (request: MemoryUiWikiTaskRunRequest) => Promise<MemoryUiWikiTaskRunResult>
  wikiTree: (request: MemoryUiWikiTreeRequest) => Promise<MemoryUiWikiTreeResult>
  saveKnowledgeRevision: (request: MemoryUiKnowledgeRevisionSaveRequest) => Promise<MemoryUiKnowledgeRevisionSaveResult>
}

/** Full props assembled by the Settings slot renderer. */
export type MemoryKnowledgeSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'memoryKnowledge'>
  & InjectFace<MemoryKnowledgeSectionInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; value: MemoryUiOverview }

type TraceState =
  | { status: 'closed' }
  | { status: 'loading'; id: string }
  | { status: 'error'; id: string }
  | { status: 'ready'; value: MemoryUiTrace | null }

type WikiTreeState =
  | { status: 'closed' }
  | { status: 'loading'; runId: string }
  | { status: 'error'; runId: string }
  | { status: 'ready'; value: MemoryUiWikiTreeResult }

type ProductDomain = 'memory' | 'knowledge'
type MemoryView = 'entries' | 'candidates'
type KnowledgeView = 'project-wiki' | 'agent-knowledge'
type KnowledgeAuxiliaryView = 'closed' | 'analysis' | 'sources'

const STATUS_KEYS = {
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  promoted: 'promoted',
} as const satisfies Record<MemoryUiCandidate['status'], MemoryKnowledgeLocaleKey>

const KIND_KEYS = {
  fact: 'fact',
  decision: 'decision',
  lesson: 'lesson',
  method: 'method',
  preference: 'preference',
  constraint: 'constraint',
  overview: 'overview',
  architecture: 'architecture',
  module: 'module',
  flow: 'flow',
  stack: 'stack',
} as const satisfies Record<MemoryUiCandidate['kind'], MemoryKnowledgeLocaleKey>

const RECORD_KEYS = {
  'personal-memory': 'personalMemory',
  'project-memory': 'projectMemory',
  'knowledge-card': 'knowledgeCard',
} as const satisfies Record<MemoryUiRecord['recordType'], MemoryKnowledgeLocaleKey>

const EVIDENCE_KEYS = {
  deterministic: 'deterministic',
  'human-verified': 'humanVerified',
  'ai-suggested': 'aiSuggested',
} as const satisfies Record<MemoryUiRecord['evidenceClass'], MemoryKnowledgeLocaleKey>

const ARTIFACT_KEYS = {
  code: 'artifactCode',
  test: 'artifactTest',
  documentation: 'artifactDocumentation',
  configuration: 'artifactConfiguration',
  asset: 'artifactAsset',
  other: 'artifactOther',
} as const satisfies Record<MemoryUiEvidencePack['hits'][number]['artifactKind'], MemoryKnowledgeLocaleKey>

const FRESHNESS_REASON_KEYS = {
  'canonical-stale': 'canonicalStale',
  'source-unavailable': 'sourceUnavailable',
  'file-missing': 'fileMissing',
  'file-changed': 'fileChanged',
  'source-revision-changed': 'sourceRevisionChanged',
} as const satisfies Record<MemoryUiFreshnessReason['kind'], MemoryKnowledgeLocaleKey>

const RELATION_KIND_KEYS = {
  import: 'relationImport',
  'type-import': 'relationTypeImport',
  're-export': 'relationReExport',
  'type-re-export': 'relationTypeReExport',
  'dynamic-import': 'relationDynamicImport',
  require: 'relationRequire',
  'import-equals': 'relationImportEquals',
} as const satisfies Record<MemoryUiRelationPack['edges'][number]['kind'], MemoryKnowledgeLocaleKey>

const RELATION_RESOLUTION_KEYS = {
  internal: 'relationInternal',
  external: 'relationExternal',
  unresolved: 'relationUnresolved',
} as const satisfies Record<MemoryUiRelationPack['edges'][number]['resolution'], MemoryKnowledgeLocaleKey>

const RELATION_GRAPH_NODE_LIMIT = 80

const SYMBOL_REFERENCE_KIND_KEYS = {
  import: 'symbolReferenceImport',
  export: 'symbolReferenceExport',
  type: 'symbolReferenceType',
  value: 'symbolReferenceValue',
} as const satisfies Record<MemoryUiSymbolPack['edges'][number]['referenceKind'], MemoryKnowledgeLocaleKey>

const SYMBOL_GRAPH_NODE_LIMIT = 80

const WIKI_RUN_STATUS_KEYS = {
  planned: 'wikiRunPlanned',
  analyzing: 'wikiRunAnalyzing',
  verifying: 'wikiRunVerifying',
  synthesizing: 'wikiRunSynthesizing',
  'needs-review': 'wikiRunNeedsReview',
  complete: 'wikiRunComplete',
  blocked: 'wikiRunBlocked',
  failed: 'wikiRunFailed',
  cancelled: 'wikiRunCancelled',
} as const satisfies Record<MemoryUiWikiRunSummary['status'], MemoryKnowledgeLocaleKey>

const WIKI_COMPLETION_CHECK_KEYS = {
  catalog: 'wikiCompletionCatalog',
  coverage: 'wikiCompletionCoverage',
  analysis: 'wikiCompletionAnalysis',
  'file-synthesis': 'wikiCompletionFileSynthesis',
  verification: 'wikiCompletionVerification',
  consistency: 'wikiCompletionConsistency',
  pages: 'wikiCompletionPages',
  'material-exposure': 'wikiCompletionMaterialExposure',
  'business-questions': 'wikiCompletionBusinessQuestions',
  'cross-module-flows': 'wikiCompletionCrossModuleFlows',
} as const satisfies Record<MemoryUiWikiCompletionCheck['id'], MemoryKnowledgeLocaleKey>

const WIKI_COMPLETION_STATE_KEYS = {
  pass: 'wikiCompletionPass',
  fail: 'wikiCompletionFail',
  unsupported: 'wikiCompletionUnsupported',
} as const satisfies Record<MemoryUiWikiCompletionCheck['state'], MemoryKnowledgeLocaleKey>

const WIKI_COVERAGE_KEYS = {
  pending: 'wikiCoveragePending',
  analyzing: 'wikiCoverageAnalyzing',
  analyzed: 'wikiCoverageAnalyzed',
  deferred: 'wikiCoverageDeferred',
  excluded: 'wikiCoverageExcluded',
  blocked: 'wikiCoverageBlocked',
  stale: 'wikiCoverageStale',
} as const satisfies Record<Exclude<keyof MemoryUiWikiCoverageSummary, 'itemCount' | 'totalBytes'>, MemoryKnowledgeLocaleKey>

type WikiTreeClaim = MemoryUiWikiTreeResult['pages'][number]['claims'][number]

const WIKI_PAGE_STATUS_KEYS = {
  draft: 'wikiPageDraft',
  verified: 'wikiPageVerified',
  conflicted: 'wikiPageConflicted',
  stale: 'wikiPageStale',
} as const satisfies Record<MemoryUiWikiTreeResult['pages'][number]['status'], MemoryKnowledgeLocaleKey>

const WIKI_CLAIM_KIND_KEYS = {
  assertion: 'wikiClaimAssertion',
  inference: 'wikiClaimInference',
  unknown: 'wikiClaimUnknown',
} as const satisfies Record<WikiTreeClaim['kind'], MemoryKnowledgeLocaleKey>

const WIKI_CLAIM_STATUS_KEYS = {
  proposed: 'wikiClaimProposed',
  verified: 'wikiClaimVerified',
  uncertain: 'wikiClaimUncertain',
  conflicted: 'wikiClaimConflicted',
  rejected: 'wikiClaimRejected',
  stale: 'wikiClaimStale',
} as const satisfies Record<WikiTreeClaim['status'], MemoryKnowledgeLocaleKey>

const WIKI_SOURCE_ROLE_KEYS = {
  supports: 'wikiSourceSupports',
  context: 'wikiSourceContext',
  contradicts: 'wikiSourceContradicts',
} as const satisfies Record<WikiTreeClaim['sources'][number]['role'], MemoryKnowledgeLocaleKey>

function formatTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.valueOf()) ? value : time.toLocaleString()
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`
}

function statusDot(status: MemoryUiCandidate['status']): 'done' | 'warning' | 'error' {
  if (status === 'pending') return 'warning'
  if (status === 'rejected') return 'error'
  return 'done'
}

function wikiStatusDot(status: MemoryUiWikiRunSummary['status']): 'done' | 'warning' | 'error' {
  if (status === 'complete') return 'done'
  if (status === 'blocked' || status === 'failed') return 'error'
  return 'warning'
}

function WikiCoverageBar({ run, t }: {
  run: MemoryUiWikiRunSummary
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  const states = Object.entries(WIKI_COVERAGE_KEYS) as Array<[
    Exclude<keyof MemoryUiWikiCoverageSummary, 'itemCount' | 'totalBytes'>,
    MemoryKnowledgeLocaleKey,
  ]>
  return (
    <div className="mk-wiki-coverage">
      <div
        className="mk-wiki-coverage-bar"
        role="img"
        aria-label={t('wikiCoverageDescription', {
          analyzed: run.coverage.analyzed,
          total: run.coverage.itemCount,
          excluded: run.coverage.excluded,
          blocked: run.coverage.blocked,
          stale: run.coverage.stale,
        })}
      >
        {states.map(([state]) => run.coverage[state] === 0 ? null : (
          <span
            key={state}
            data-state={state}
            style={{ width: `${run.coverage.itemCount === 0 ? 0 : run.coverage[state] / run.coverage.itemCount * 100}%` }}
            title={`${t(WIKI_COVERAGE_KEYS[state])}: ${run.coverage[state]}`}
          />
        ))}
      </div>
      <div className="mk-wiki-coverage-legend">
        {states.map(([state, key]) => run.coverage[state] === 0 ? null : (
          <span key={state} data-state={state}>{t(key)} {run.coverage[state]}</span>
        ))}
      </div>
    </div>
  )
}

type KnowledgeRevisionDraft =
  | { kind: 'replace-page-body'; title: string; content: string }
  | { kind: 'append-page-note'; title?: never; content: string }

function WikiPageRevisionEditor({ page, busy, onSave, t }: {
  page: MemoryUiWikiTreeResult['pages'][number]
  busy: boolean
  onSave: (pageId: string, draft: KnowledgeRevisionDraft) => Promise<boolean>
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState<KnowledgeRevisionDraft['kind']>('replace-page-body')
  const [title, setTitle] = useState(page.bodyRevision?.title ?? page.title)
  const [content, setContent] = useState(page.bodyRevision?.content ?? page.claims.map(claim => claim.statement).join('\n\n'))
  if (!editing) {
    return <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(true) }}>{t('editWikiPage')}</Button>
  }
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const normalizedContent = content.trim()
    const saved = await onSave(page.id, kind === 'replace-page-body'
      ? { kind, title: title.trim(), content: normalizedContent }
      : { kind, content: normalizedContent })
    if (saved) setEditing(false)
  }
  return (
    <form className="mk-memory-form mk-wiki-revision-form" onSubmit={(event) => { void submit(event) }}>
      <label>{t('wikiEditMode')}
        <select aria-label={t('wikiEditMode')} value={kind} onChange={(event) => {
          const value = event.currentTarget.value as KnowledgeRevisionDraft['kind']
          setKind(value)
          setContent(value === 'replace-page-body'
            ? page.bodyRevision?.content ?? page.claims.map(claim => claim.statement).join('\n\n')
            : '')
        }}>
          <option value="replace-page-body">{t('wikiReplaceBody')}</option>
          <option value="append-page-note">{t('wikiAppendNote')}</option>
        </select>
      </label>
      {kind === 'replace-page-body' ? <label>{t('title')}
        <input aria-label={t('title')} maxLength={300} required value={title} onChange={(event) => { setTitle(event.currentTarget.value) }} />
      </label> : null}
      <label>{t(kind === 'replace-page-body' ? 'wikiHumanBody' : 'wikiHumanNote')}
        <textarea aria-label={t(kind === 'replace-page-body' ? 'wikiHumanBody' : 'wikiHumanNote')} maxLength={20_000} required rows={6} value={content} onChange={(event) => { setContent(event.currentTarget.value) }} />
      </label>
      <p className="mk-warning">{t(kind === 'replace-page-body' ? 'wikiReplaceBodyWarning' : 'wikiAppendNoteNotice')}</p>
      <div className="mk-actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy || content.trim() === '' || (kind === 'replace-page-body' && title.trim() === '')}>{busy ? t('savingWikiRevision') : t('saveWikiRevision')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(false) }}>{t('cancel')}</Button>
      </div>
    </form>
  )
}

function WikiTree({ tree, editable = false, busy = false, onSave, t }: {
  tree: MemoryUiWikiTreeResult
  editable?: boolean
  busy?: boolean
  onSave?: (pageId: string, draft: KnowledgeRevisionDraft) => Promise<boolean>
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  return (
    <div className="mk-wiki-tree" data-wiki-tree-run-id={tree.runId}>
      <p className="mk-status">{t('wikiTreeSummary', { claims: tree.pages.reduce((total, page) => total + page.claimCount, 0), pages: tree.pageCount })}</p>
      {tree.pages.map(page => (
        <details className="mk-wiki-page" key={page.id} open={page.depth < 2} style={{ marginInlineStart: `${Math.min(page.depth, 8) * 18}px` }}>
          <summary>
            <span className="mk-state"><StateDot state={page.status === 'verified' ? 'done' : page.status === 'draft' ? 'warning' : 'error'} />{page.title}</span>
            <span className="mk-meta">{t(WIKI_PAGE_STATUS_KEYS[page.status])} · {t('wikiPageCounts', { children: page.childCount, claims: page.claimCount })}</span>
          </summary>
          {page.bodyRevision === undefined ? null : (
            <section className="mk-wiki-human-content">
              <div className="mk-chip-row"><span className="mk-chip">{t('wikiHumanRevision', { revision: page.bodyRevision.revision })}</span><span className="mk-chip">{t('wikiNeedsReview')}</span></div>
              <p className="mk-content">{page.bodyRevision.content}</p>
            </section>
          )}
          {page.notes.length === 0 ? null : (
            <section className="mk-wiki-human-content">
              <strong>{t('wikiHumanNotes')}</strong>
              <ul>{page.notes.map(note => <li key={note.id}><span className="mk-meta">v{note.revision}</span><p className="mk-content">{note.content}</p></li>)}</ul>
              {page.omittedNoteCount === 0 ? null : <p className="mk-warning">{t('wikiNotesOmitted', { count: page.omittedNoteCount })}</p>}
            </section>
          )}
          {page.claims.length === 0 ? <p className="mk-status">{t('wikiPageNoDirectClaims')}</p> : (
            <ul className="mk-wiki-claims">
              {page.claims.map(claim => (
                <li key={claim.id}>
                  <div className="mk-chip-row">
                    <span className="mk-chip">{t(WIKI_CLAIM_KIND_KEYS[claim.kind])}</span>
                    <span className="mk-chip">{t(WIKI_CLAIM_STATUS_KEYS[claim.status])}</span>
                  </div>
                  <p className="mk-content">{claim.statement}{claim.statementTruncated ? ` ${t('wikiStatementTruncated')}` : ''}</p>
                  {claim.humanReviewPending ? <p className="mk-warning">{t('wikiClaimHumanReviewPending')}</p> : null}
                  {claim.sources.length === 0 ? <p className="mk-status">{t('wikiClaimNoSources')}</p> : (
                    <ul className="mk-wiki-sources">{claim.sources.map((source, index) => (
                      <li key={`${source.role}:${source.path}:${source.startLine ?? 0}:${index}`}>
                        <span className="mk-chip">{t(WIKI_SOURCE_ROLE_KEYS[source.role])}</span>
                        <span className="mk-evidence-location">{source.path}{source.startLine === undefined
                          ? source.startByte === undefined ? '' : `@${source.startByte}-${source.endByte}`
                          : `:${source.startLine}${source.endLine === undefined || source.endLine === source.startLine ? '' : `-${source.endLine}`}`}</span>
                      </li>
                    ))}</ul>
                  )}
                  {claim.omittedSourceCount === 0 ? null : <p className="mk-warning">{t('wikiSourcesOmitted', { count: claim.omittedSourceCount })}</p>}
                </li>
              ))}
            </ul>
          )}
          {page.omittedClaimCount === 0 ? null : <p className="mk-warning">{t('wikiClaimsOmitted', { count: page.omittedClaimCount })}</p>}
          {!editable || onSave === undefined ? null : <WikiPageRevisionEditor page={page} busy={busy} onSave={onSave} t={t} />}
        </details>
      ))}
      {tree.omittedPageCount + tree.omittedClaimCount + tree.omittedSourceCount === 0 ? null : (
        <p className="mk-warning">{t('wikiTreeOmitted', {
          claims: tree.omittedClaimCount,
          pages: tree.omittedPageCount,
          sources: tree.omittedSourceCount,
        })}</p>
      )}
    </div>
  )
}

function KnowledgeWikiView({ mode, run, version, treeState, workspaceSelected, busy, onToggleTree, onSave, t }: {
  mode: KnowledgeView
  run: MemoryUiWikiRunSummary | undefined
  version: MemoryUiKnowledgeVersionSummary | undefined
  treeState: WikiTreeState
  workspaceSelected: boolean
  busy: boolean
  onToggleTree: (runId: string) => void
  onSave: (pageId: string, draft: KnowledgeRevisionDraft) => Promise<boolean>
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  if (!workspaceSelected) return <p className="mk-status">{t('selectWorkspaceForKnowledge')}</p>
  if (run === undefined) return <p className="mk-status">{t('emptyKnowledgeDraft')}</p>
  const treeOpen = treeState.status === 'ready' && treeState.value.runId === run.id
  const active = version?.status === 'active' && version.sourceRunId === run.id
  return (
    <div className="mk-knowledge-view">
      <div className="mk-results-heading">
        <div>
          <h3>{t(mode === 'project-wiki' ? 'projectWiki' : 'agentKnowledge')}</h3>
          <p className="mk-status">{t(mode === 'project-wiki' ? 'projectWikiDescription' : 'agentKnowledgeDescription')}</p>
        </div>
        <span className="mk-chip">{t(active ? 'knowledgeActive' : 'knowledgeDraft')}</span>
      </div>
      <div className="mk-knowledge-state">
        <strong>{t(active ? 'knowledgeActiveTitle' : 'knowledgeDraftTitle')}</strong>
        <p>{t(active
          ? 'knowledgeActiveDescription'
          : run.completion.eligibleForActivation ? 'knowledgeAwaitingVersion' : 'knowledgeDraftDescription')}</p>
        {mode === 'agent-knowledge' ? <p>{t(active ? 'agentKnowledgeActiveNotice' : 'agentKnowledgeDraftNotice')}</p> : null}
        <span className="mk-id">{t('wikiRunTitle', { id: run.id.slice(-8) })}</span>
        {active && version?.effectiveVersionId !== undefined
          ? <span className="mk-id">{t('knowledgeVersionTitle', { id: version.effectiveVersionId.slice(-8) })}</span>
          : null}
      </div>
      <div className="mk-actions">
        <Button size="sm" variant="outline" disabled={treeState.status === 'loading' && treeState.runId === run.id} onClick={() => { onToggleTree(run.id) }}>
          {treeState.status === 'loading' && treeState.runId === run.id
            ? t('wikiTreeLoading')
            : treeOpen ? t('wikiTreeHide') : t('wikiTreeView')}
        </Button>
      </div>
      {treeState.status === 'error' && treeState.runId === run.id ? <p className="mk-failure">{t('wikiTreeError')}</p> : null}
      {treeOpen ? <WikiTree tree={treeState.value} editable={active} busy={busy} onSave={onSave} t={t} /> : null}
    </div>
  )
}

function DetailList({ evidence, tags, t }: {
  evidence: readonly string[]
  tags: readonly string[]
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  return (
    <dl className="mk-detail">
      <div><dt>{t('evidence')}</dt><dd>{evidence.length === 0 ? '—' : evidence.join(' · ')}</dd></div>
      <div><dt>{t('tags')}</dt><dd>{tags.length === 0 ? '—' : tags.join(' · ')}</dd></div>
    </dl>
  )
}

const MEMORY_KINDS = ['preference', 'constraint', 'lesson', 'method', 'decision', 'fact'] as const

interface MemoryEntryDraft {
  title: string
  content: string
  kind: typeof MEMORY_KINDS[number]
  conditions: string
  tags: string
}

function MemoryEntryForm({ initial, busy, submitLabel, onSubmit, onCancel, t }: {
  initial?: MemoryEntryDraft
  busy: boolean
  submitLabel: string
  onSubmit: (draft: MemoryEntryDraft) => void
  onCancel: () => void
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  const [draft, setDraft] = useState<MemoryEntryDraft>(initial ?? {
    title: '', content: '', kind: 'preference', conditions: '', tags: '',
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (draft.title.trim() !== '' && draft.content.trim() !== '') onSubmit(draft)
  }
  return (
    <form className="mk-memory-editor" onSubmit={submit}>
      <label className="mk-field"><span>{t('memoryKind')}</span><select value={draft.kind} onChange={event => { const kind = event.currentTarget.value as MemoryEntryDraft['kind']; setDraft(value => ({ ...value, kind })) }}>
        {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{t(KIND_KEYS[kind])}</option>)}
      </select></label>
      <label className="mk-field"><span>{t('memoryTitle')}</span><input value={draft.title} maxLength={500} onChange={event => { const title = event.currentTarget.value; setDraft(value => ({ ...value, title })) }} /></label>
      <label className="mk-field"><span>{t('memoryContent')}</span><textarea value={draft.content} maxLength={20_000} rows={6} onChange={event => { const content = event.currentTarget.value; setDraft(value => ({ ...value, content })) }} /></label>
      <label className="mk-field"><span>{t('memoryConditions')}</span><input value={draft.conditions} placeholder={t('commaSeparated')} onChange={event => { const conditions = event.currentTarget.value; setDraft(value => ({ ...value, conditions })) }} /></label>
      <label className="mk-field"><span>{t('tags')}</span><input value={draft.tags} placeholder={t('commaSeparated')} onChange={event => { const tags = event.currentTarget.value; setDraft(value => ({ ...value, tags })) }} /></label>
      <div className="mk-actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy || draft.title.trim() === '' || draft.content.trim() === ''}>{submitLabel}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </form>
  )
}

function splitList(value: string): string[] {
  return value.split(/[,，\n]/u).map(item => item.trim()).filter(Boolean)
}

interface RelationGraphNode {
  id: string
  label: string
  category: 'file' | 'external' | 'unresolved'
}

function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabList = event.currentTarget.closest('[role="tablist"]')
  if (tabList === null) return
  const tabs = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
  const current = tabs.indexOf(event.currentTarget)
  if (current < 0 || tabs.length === 0) return
  event.preventDefault()
  const next = event.key === 'Home' ? tabs[0]
    : event.key === 'End' ? tabs.at(-1)
      : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
  next?.focus()
  next?.click()
}

function RelationGraph({ pack, t }: {
  pack: MemoryUiRelationPack
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  const nodes = new Map<string, RelationGraphNode>()
  const edges: Array<{ edge: MemoryUiRelationPack['edges'][number]; from: string; to: string }> = []
  for (const edge of pack.edges) {
    const from = `file:${edge.fromPath}`
    const to = edge.toPath === undefined ? `${edge.resolution}:${edge.specifier}` : `file:${edge.toPath}`
    const additions = Number(!nodes.has(from)) + Number(!nodes.has(to))
    if (nodes.size + additions > RELATION_GRAPH_NODE_LIMIT) continue
    nodes.set(from, { id: from, label: edge.fromPath, category: 'file' })
    nodes.set(to, {
      id: to,
      label: edge.toPath ?? edge.specifier,
      category: edge.toPath === undefined ? edge.resolution === 'external' ? 'external' : 'unresolved' : 'file',
    })
    edges.push({ edge, from, to })
  }
  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(sortedNodes.length))))
  const rows = Math.max(1, Math.ceil(sortedNodes.length / columns))
  const width = columns * 190 + 20
  const height = rows * 76 + 20
  const positions = new Map(sortedNodes.map((node, index) => [node.id, {
    x: 20 + (index % columns) * 190,
    y: 20 + Math.floor(index / columns) * 76,
  }]))
  const clientOmitted = pack.edges.length - edges.length
  return (
    <div className="mk-relation-visual">
      <div className="mk-relation-canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('relationGraph')}>
          <title>{t('relationGraph')}</title>
          <desc>{t('relationGraphDescription', { edges: edges.length, nodes: sortedNodes.length })}</desc>
          <defs>
            <marker id="mk-relation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>
          {edges.map(({ edge, from, to }) => {
            const start = positions.get(from)!
            const end = positions.get(to)!
            return (
              <line
                key={edge.edgeId}
                className={`mk-relation-edge mk-relation-edge-${edge.resolution}`}
                x1={start.x + 75}
                y1={start.y + 24}
                x2={end.x + 75}
                y2={end.y + 24}
                markerEnd="url(#mk-relation-arrow)"
              />
            )
          })}
          {sortedNodes.map(node => {
            const position = positions.get(node.id)!
            const shortLabel = node.label.length > 24 ? `${node.label.slice(0, 21)}…` : node.label
            return (
              <g
                key={node.id}
                className={`mk-relation-node mk-relation-node-${node.category}`}
                transform={`translate(${position.x} ${position.y})`}
                tabIndex={0}
                aria-label={node.label}
              >
                <title>{node.label}</title>
                <rect width="150" height="48" rx="8" />
                <text x="10" y="29">{shortLabel}</text>
              </g>
            )
          })}
        </svg>
      </div>
      {clientOmitted === 0 ? null : <p className="mk-warning">{t('relationVisualOmitted', { count: clientOmitted })}</p>}
      <details className="mk-relation-table">
        <summary>{t('relationTable', { count: pack.edges.length })}</summary>
        <div className="mk-table-scroll">
          <table>
            <thead><tr><th>{t('relationFrom')}</th><th>{t('relationTo')}</th><th>{t('relationType')}</th><th>{t('relationLocation')}</th></tr></thead>
            <tbody>{pack.edges.map(edge => (
              <tr key={edge.edgeId}>
                <td>{edge.fromPath}</td>
                <td>{edge.toPath ?? edge.specifier}</td>
                <td>{t(RELATION_KIND_KEYS[edge.kind])} · {t(RELATION_RESOLUTION_KEYS[edge.resolution])}</td>
                <td>{edge.fromPath}:{edge.startLine}{edge.endLine === edge.startLine ? '' : `-${edge.endLine}`}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

interface SymbolGraphNode {
  id: string
  label: string
  category: 'definition' | 'reference'
}

function SymbolGraph({ pack, t }: {
  pack: MemoryUiSymbolPack
  t: MemoryKnowledgeSectionProps['t']
}): ReactNode {
  const nodes = new Map<string, SymbolGraphNode>()
  const edges: Array<{ edge: MemoryUiSymbolPack['edges'][number]; from: string; to: string }> = []
  for (const edge of pack.edges) {
    const from = `reference:${edge.referencePath}`
    const to = `definition:${edge.definitionId}`
    const additions = Number(!nodes.has(from)) + Number(!nodes.has(to))
    if (nodes.size + additions > SYMBOL_GRAPH_NODE_LIMIT) continue
    nodes.set(from, { id: from, label: edge.referencePath, category: 'reference' })
    nodes.set(to, {
      id: to,
      label: `${edge.symbolName} · ${edge.definitionPath}:${edge.definitionStartLine}`,
      category: 'definition',
    })
    edges.push({ edge, from, to })
  }
  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(sortedNodes.length))))
  const rows = Math.max(1, Math.ceil(sortedNodes.length / columns))
  const width = columns * 210 + 20
  const height = rows * 76 + 20
  const positions = new Map(sortedNodes.map((node, index) => [node.id, {
    x: 20 + (index % columns) * 210,
    y: 20 + Math.floor(index / columns) * 76,
  }]))
  const clientOmitted = pack.edges.length - edges.length
  return (
    <div className="mk-relation-visual">
      <div className="mk-relation-canvas mk-symbol-canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('symbolGraph')}>
          <title>{t('symbolGraph')}</title>
          <desc>{t('symbolGraphDescription', { edges: edges.length, nodes: sortedNodes.length })}</desc>
          <defs>
            <marker id="mk-symbol-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>
          {edges.map(({ edge, from, to }) => {
            const start = positions.get(from)!
            const end = positions.get(to)!
            return <line key={edge.referenceId} className="mk-symbol-edge" x1={start.x + 85} y1={start.y + 24} x2={end.x + 85} y2={end.y + 24} markerEnd="url(#mk-symbol-arrow)" />
          })}
          {sortedNodes.map(node => {
            const position = positions.get(node.id)!
            const shortLabel = node.label.length > 28 ? `${node.label.slice(0, 25)}…` : node.label
            return (
              <g key={node.id} className={`mk-symbol-node mk-symbol-node-${node.category}`} transform={`translate(${position.x} ${position.y})`} tabIndex={0} aria-label={node.label}>
                <title>{node.label}</title>
                <rect width="170" height="48" rx="8" />
                <text x="10" y="29">{shortLabel}</text>
              </g>
            )
          })}
        </svg>
      </div>
      {clientOmitted === 0 ? null : <p className="mk-warning">{t('symbolVisualOmitted', { count: clientOmitted })}</p>}
      <details className="mk-relation-table">
        <summary>{t('symbolTable', { count: pack.edges.length })}</summary>
        <div className="mk-table-scroll">
          <table>
            <thead><tr><th>{t('symbolName')}</th><th>{t('symbolDefinition')}</th><th>{t('symbolReference')}</th><th>{t('relationType')}</th></tr></thead>
            <tbody>{pack.edges.map(edge => (
              <tr key={edge.referenceId}>
                <td>{edge.symbolName} · {edge.declaration}</td>
                <td>{edge.definitionPath}:{edge.definitionStartLine}{edge.definitionEndLine === edge.definitionStartLine ? '' : `-${edge.definitionEndLine}`}</td>
                <td>{edge.referencePath}:{edge.referenceStartLine}{edge.referenceEndLine === edge.referenceStartLine ? '' : `-${edge.referenceEndLine}`}</td>
                <td>{t(SYMBOL_REFERENCE_KIND_KEYS[edge.referenceKind])}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/** Render candidate review, recallable records, search, and exact trace. */
export function MemoryKnowledgeSection(props: MemoryKnowledgeSectionProps): ReactNode {
  const { overview, search, searchEvidence, queryRelations, querySymbols, trace, createMemory, updateMemory, setMemoryStatus, review, promote, generate, planWiki, runWikiTask, wikiTree, saveKnowledgeRevision, t } = props
  const [domain, setDomain] = useState<ProductDomain>('memory')
  const [memoryWorkspaceId, setMemoryWorkspaceId] = useState('')
  const [knowledgeWorkspaceId, setKnowledgeWorkspaceId] = useState('')
  const [memoryView, setMemoryView] = useState<MemoryView>('candidates')
  const [knowledgeView, setKnowledgeView] = useState<KnowledgeView>('project-wiki')
  const [knowledgeAuxiliaryView, setKnowledgeAuxiliaryView] = useState<KnowledgeAuxiliaryView>('closed')
  const [workspaces, setWorkspaces] = useState<MemoryUiOverview['workspaces']>([])
  const [status, setStatus] = useState<MemoryUiCandidate['status'] | 'all'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [promotionTargets, setPromotionTargets] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchRecords, setSearchRecords] = useState<MemoryUiRecord[] | null>(null)
  const [evidenceQuery, setEvidenceQuery] = useState('')
  const [evidenceSearching, setEvidenceSearching] = useState(false)
  const [evidencePack, setEvidencePack] = useState<MemoryUiEvidencePack | null>(null)
  const [relationQuery, setRelationQuery] = useState('')
  const [relationArea, setRelationArea] = useState('')
  const [relationResolution, setRelationResolution] = useState<NonNullable<MemoryUiRelationQueryRequest['resolution']> | ''>('')
  const [relationKind, setRelationKind] = useState<NonNullable<MemoryUiRelationQueryRequest['kind']> | ''>('')
  const [relationSearching, setRelationSearching] = useState(false)
  const [relationPack, setRelationPack] = useState<MemoryUiRelationPack | null>(null)
  const [symbolQuery, setSymbolQuery] = useState('')
  const [symbolDefinitionPath, setSymbolDefinitionPath] = useState('')
  const [symbolReferencePath, setSymbolReferencePath] = useState('')
  const [symbolReferenceKind, setSymbolReferenceKind] = useState<NonNullable<MemoryUiSymbolQueryRequest['referenceKind']> | ''>('')
  const [symbolSearching, setSymbolSearching] = useState(false)
  const [symbolPack, setSymbolPack] = useState<MemoryUiSymbolPack | null>(null)
  const [traceState, setTraceState] = useState<TraceState>({ status: 'closed' })
  const [creatingMemory, setCreatingMemory] = useState(false)
  const [wikiTreeState, setWikiTreeState] = useState<WikiTreeState>({ status: 'closed' })
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const searchRequestId = useRef(0)
  const evidenceRequestId = useRef(0)
  const relationRequestId = useRef(0)
  const symbolRequestId = useRef(0)
  const traceRequestId = useRef(0)
  const wikiTreeRequestId = useRef(0)
  const operationRequestId = useRef(0)
  const workspaceId = domain === 'memory' ? memoryWorkspaceId : knowledgeWorkspaceId
  const recordDomain: MemoryUiRecordDomain = domain
  const operationScope = `${recordDomain}:${workspaceId}`
  const operationScopeRef = useRef(operationScope)
  operationScopeRef.current = operationScope

  useEffect(() => {
    let current = true
    operationRequestId.current += 1
    searchRequestId.current += 1
    evidenceRequestId.current += 1
    relationRequestId.current += 1
    symbolRequestId.current += 1
    traceRequestId.current += 1
    wikiTreeRequestId.current += 1
    setSearching(false)
    setEvidenceSearching(false)
    setRelationSearching(false)
    setSymbolSearching(false)
    setBusy(null)
    setSearchRecords(null)
    setEvidencePack(null)
    setRelationPack(null)
    setSymbolPack(null)
    setRelationQuery('')
    setRelationArea('')
    setRelationResolution('')
    setRelationKind('')
    setSymbolQuery('')
    setSymbolDefinitionPath('')
    setSymbolReferencePath('')
    setSymbolReferenceKind('')
    setTraceState({ status: 'closed' })
    setCreatingMemory(false)
    setWikiTreeState({ status: 'closed' })
    if (recordDomain === 'knowledge' && workspaceId === '') return () => { current = false }
    setState({ status: 'loading' })
    const request: MemoryUiOverviewRequest = recordDomain === 'knowledge'
      ? { domain: 'knowledge', workspaceId }
      : { domain: 'memory', ...(workspaceId === '' ? {} : { workspaceId }) }
    void overview(request).then(
      value => {
        if (current) {
          setWorkspaces(value.workspaces)
          setState({ status: 'ready', value })
        }
      },
      (error: unknown) => {
        console.error('memory-knowledge UI: overview failed', error)
        if (current) setState({ status: 'error' })
      },
    )
    return () => { current = false }
  }, [overview, recordDomain, refresh, workspaceId])

  useEffect(() => {
    if (domain !== 'knowledge' || knowledgeAuxiliaryView !== 'sources' || workspaceId === '' || state.status !== 'ready') return
    const requestId = ++relationRequestId.current
    setRelationSearching(true)
    void queryRelations({ workspaceId }).then(
      value => { if (relationRequestId.current === requestId) setRelationPack(value) },
      () => { if (relationRequestId.current === requestId) showToast(t('relationQueryError')) },
    ).finally(() => { if (relationRequestId.current === requestId) setRelationSearching(false) })
  }, [domain, knowledgeAuxiliaryView, queryRelations, state.status, workspaceId])

  useEffect(() => {
    if (domain !== 'knowledge' || knowledgeAuxiliaryView !== 'sources' || workspaceId === '' || state.status !== 'ready') return
    const requestId = ++symbolRequestId.current
    setSymbolSearching(true)
    void querySymbols({ workspaceId }).then(
      value => { if (symbolRequestId.current === requestId) setSymbolPack(value) },
      () => { if (symbolRequestId.current === requestId) showToast(t('symbolQueryError')) },
    ).finally(() => { if (symbolRequestId.current === requestId) setSymbolSearching(false) })
  }, [domain, knowledgeAuxiliaryView, querySymbols, state.status, workspaceId])

  const candidates = useMemo(() => state.status !== 'ready'
    ? []
    : state.value.candidates.filter(candidate => status === 'all' || candidate.status === status), [state, status])
  const records = searchRecords ?? (state.status === 'ready' ? state.value.records : [])

  const showToast = (text: string): void => {
    setToast(current => ({ id: (current?.id ?? 0) + 1, text }))
  }

  const beginScopedOperation = (): { id: number; scope: string } => ({
    id: ++operationRequestId.current,
    scope: operationScopeRef.current,
  })

  const operationIsCurrent = (operation: { id: number; scope: string }): boolean => (
    operationRequestId.current === operation.id && operationScopeRef.current === operation.scope
  )

  const mutate = async (
    candidate: MemoryUiCandidate,
    operation: () => Promise<MemoryUiMutationResult>,
    success: string,
  ): Promise<void> => {
    const scopedOperation = beginScopedOperation()
    setBusy(candidate.id)
    try {
      const result = await operation()
      if (!operationIsCurrent(scopedOperation)) return
      showToast(result.outcome === 'conflict' ? t('conflict') : success)
      setRefresh(value => value + 1)
    } catch {
      if (operationIsCurrent(scopedOperation)) showToast(t('mutationError'))
    } finally {
      if (operationIsCurrent(scopedOperation)) setBusy(null)
    }
  }

  const mutateMemory = async (
    id: string,
    operation: () => Promise<MemoryUiMemoryMutationResult>,
    success: string,
  ): Promise<void> => {
    const scopedOperation = beginScopedOperation()
    setBusy(id)
    try {
      const result = await operation()
      if (!operationIsCurrent(scopedOperation)) return
      showToast(result.outcome === 'conflict' ? t('memoryConflict') : success)
      if (result.outcome === 'updated') {
        setCreatingMemory(false)
        closeTrace()
      }
      setRefresh(value => value + 1)
    } catch {
      if (operationIsCurrent(scopedOperation)) showToast(t('mutationError'))
    } finally {
      if (operationIsCurrent(scopedOperation)) setBusy(null)
    }
  }

  const createMemoryEntry = (draft: MemoryEntryDraft): void => {
    void mutateMemory('memory-create', () => createMemory({
      ...(workspaceId === '' ? {} : { workspaceId }),
      kind: draft.kind,
      title: draft.title.trim(),
      content: draft.content.trim(),
      conditions: splitList(draft.conditions),
      tags: splitList(draft.tags),
    }), t('memoryCreated'))
  }

  const updateMemoryEntry = (value: MemoryUiTrace, draft: MemoryEntryDraft): void => {
    if (value.revision === undefined) return
    void mutateMemory(value.id, () => updateMemory({
      id: value.id,
      revision: value.revision!,
      ...(workspaceId === '' ? {} : { workspaceId }),
      kind: draft.kind,
      title: draft.title.trim(),
      content: draft.content.trim(),
      conditions: splitList(draft.conditions),
      tags: splitList(draft.tags),
    }), t('memorySaved'))
  }

  const changeMemoryStatus = (value: MemoryUiTrace, status: MemoryUiMemoryStatusRequest['status']): void => {
    if (value.revision === undefined) return
    void mutateMemory(value.id, () => setMemoryStatus({
      id: value.id,
      revision: value.revision!,
      ...(workspaceId === '' ? {} : { workspaceId }),
      status,
    }), t(status === 'active' ? 'memoryRestored' : status === 'deprecated' ? 'memoryDeprecated' : 'memoryDeleted'))
  }

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    if (recordDomain === 'knowledge' && workspaceId === '') return
    const requestId = ++searchRequestId.current
    const normalized = query.trim()
    if (normalized.length === 0) {
      setSearchRecords(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const request: MemoryUiSearchRequest = recordDomain === 'knowledge'
      ? { domain: 'knowledge', query: normalized, workspaceId }
      : { domain: 'memory', query: normalized, ...(workspaceId === '' ? {} : { workspaceId }) }
    void search(request).then(
      result => { if (searchRequestId.current === requestId) setSearchRecords(result.records) },
      () => { if (searchRequestId.current === requestId) showToast(t('loadError')) },
    ).finally(() => { if (searchRequestId.current === requestId) setSearching(false) })
  }

  const openTrace = (id: string): void => {
    const requestId = ++traceRequestId.current
    setTraceState({ status: 'loading', id })
    void trace({ id, ...(workspaceId === '' ? {} : { workspaceId }) }).then(
      value => { if (traceRequestId.current === requestId) setTraceState({ status: 'ready', value }) },
      () => { if (traceRequestId.current === requestId) setTraceState({ status: 'error', id }) },
    )
  }

  const closeTrace = (): void => {
    traceRequestId.current += 1
    setTraceState({ status: 'closed' })
  }

  const submitEvidenceSearch = (event: FormEvent): void => {
    event.preventDefault()
    const requestId = ++evidenceRequestId.current
    const normalized = evidenceQuery.trim()
    if (normalized.length === 0 || workspaceId === '') {
      setEvidencePack(null)
      setEvidenceSearching(false)
      return
    }
    setEvidenceSearching(true)
    void searchEvidence({ query: normalized, workspaceId }).then(
      value => { if (evidenceRequestId.current === requestId) setEvidencePack(value) },
      () => { if (evidenceRequestId.current === requestId) showToast(t('evidenceSearchError')) },
    ).finally(() => { if (evidenceRequestId.current === requestId) setEvidenceSearching(false) })
  }

  const submitRelationQuery = (event: FormEvent): void => {
    event.preventDefault()
    if (workspaceId === '') return
    const requestId = ++relationRequestId.current
    const query = relationQuery.trim()
    const area = relationArea.trim()
    const request: MemoryUiRelationQueryRequest = {
      workspaceId,
      ...(query.length === 0 ? {} : { query }),
      ...(area.length === 0 ? {} : { area }),
      ...(relationResolution === '' ? {} : { resolution: relationResolution }),
      ...(relationKind === '' ? {} : { kind: relationKind }),
    }
    setRelationSearching(true)
    void queryRelations(request).then(
      value => { if (relationRequestId.current === requestId) setRelationPack(value) },
      () => { if (relationRequestId.current === requestId) showToast(t('relationQueryError')) },
    ).finally(() => { if (relationRequestId.current === requestId) setRelationSearching(false) })
  }

  const submitSymbolQuery = (event: FormEvent): void => {
    event.preventDefault()
    if (workspaceId === '') return
    const requestId = ++symbolRequestId.current
    const query = symbolQuery.trim()
    const definitionPath = symbolDefinitionPath.trim()
    const referencePath = symbolReferencePath.trim()
    const request: MemoryUiSymbolQueryRequest = {
      workspaceId,
      ...(query.length === 0 ? {} : { query }),
      ...(definitionPath.length === 0 ? {} : { definitionPath }),
      ...(referencePath.length === 0 ? {} : { referencePath }),
      ...(symbolReferenceKind === '' ? {} : { referenceKind: symbolReferenceKind }),
    }
    setSymbolSearching(true)
    void querySymbols(request).then(
      value => { if (symbolRequestId.current === requestId) setSymbolPack(value) },
      () => { if (symbolRequestId.current === requestId) showToast(t('symbolQueryError')) },
    ).finally(() => { if (symbolRequestId.current === requestId) setSymbolSearching(false) })
  }

  const generateCandidates = async (): Promise<void> => {
    if (workspaceId === '') return
    const scopedOperation = beginScopedOperation()
    setBusy('generate')
    try {
      const result = await generate({ workspaceId })
      if (!operationIsCurrent(scopedOperation)) return
      showToast(t('generatedCandidates', {
        records: result.sourceRecordCount,
        count: result.candidateCount,
        skipped: result.skippedCount,
      }))
      setDomain('memory')
      setMemoryView('candidates')
      setRefresh(value => value + 1)
    } catch {
      if (operationIsCurrent(scopedOperation)) showToast(t('mutationError'))
    } finally {
      if (operationIsCurrent(scopedOperation)) setBusy(null)
    }
  }

  const loadWikiTree = (runId: string): void => {
    if (workspaceId === '') return
    if (wikiTreeState.status === 'ready' && wikiTreeState.value.runId === runId) {
      setWikiTreeState({ status: 'closed' })
      return
    }
    const requestId = ++wikiTreeRequestId.current
    setWikiTreeState({ status: 'loading', runId })
    void wikiTree({ workspaceId, runId }).then(
      value => { if (wikiTreeRequestId.current === requestId) setWikiTreeState({ status: 'ready', value }) },
      () => { if (wikiTreeRequestId.current === requestId) setWikiTreeState({ status: 'error', runId }) },
    )
  }

  const planWikiRun = async (): Promise<void> => {
    if (workspaceId === '') return
    const scopedOperation = beginScopedOperation()
    setBusy('wiki-plan')
    try {
      const result = await planWiki({ workspaceId })
      if (!operationIsCurrent(scopedOperation)) return
      showToast(t(result.run.status === 'blocked' ? 'wikiPlanBlockedToast' : 'wikiPlanCreatedToast', {
        count: result.run.coverage.itemCount,
      }))
      setRefresh(value => value + 1)
    } catch {
      if (operationIsCurrent(scopedOperation)) showToast(t('wikiPlanError'))
    } finally {
      if (operationIsCurrent(scopedOperation)) setBusy(null)
    }
  }

  const analyzeNextWikiTask = async (): Promise<void> => {
    if (workspaceId === '') return
    if (!window.confirm(t('wikiDataEgressConfirm'))) return
    const scopedOperation = beginScopedOperation()
    setBusy('wiki-task')
    try {
      const result = await runWikiTask({ workspaceId, dataEgressConfirmed: true })
      if (!operationIsCurrent(scopedOperation)) return
      const key = result.run.status === 'failed'
        ? 'wikiTaskFailedToast'
        : result.run.status === 'blocked'
          ? 'wikiTaskBlockedToast'
          : 'wikiTaskCompletedToast'
      showToast(t(key, {
        count: result.run.tasks.succeeded,
        total: result.run.tasks.taskCount,
      }))
      setRefresh(value => value + 1)
    } catch {
      if (operationIsCurrent(scopedOperation)) showToast(t('wikiTaskError'))
    } finally {
      if (operationIsCurrent(scopedOperation)) setBusy(null)
    }
  }

  const knowledgeVersion = state.status === 'ready' ? state.value.knowledgeVersion : undefined
  const analysisRun = state.status === 'ready'
    ? state.value.wikiRuns?.find(run => run.id === knowledgeVersion?.currentRunId) ?? state.value.wikiRuns?.[0]
    : undefined
  const knowledgeRun = state.status === 'ready'
    ? state.value.wikiRuns?.find(run => run.id === knowledgeVersion?.sourceRunId) ?? analysisRun
    : undefined
  const savePageRevision = async (pageId: string, draft: KnowledgeRevisionDraft): Promise<boolean> => {
    if (workspaceId === '' || knowledgeVersion?.effectiveVersionId === undefined || knowledgeRun === undefined) return false
    const scopedOperation = beginScopedOperation()
    setBusy(`knowledge-revision:${pageId}`)
    try {
      const baseRequest = {
        workspaceId,
        requestId: `khreq_${globalThis.crypto.randomUUID()}`,
        expectedSelectionRevision: knowledgeVersion.selectionRevision,
        baseEffectiveVersionId: knowledgeVersion.effectiveVersionId,
        pageId,
        content: draft.content,
      }
      const result = await saveKnowledgeRevision(draft.kind === 'replace-page-body'
        ? { ...baseRequest, kind: draft.kind, title: draft.title }
        : { ...baseRequest, kind: draft.kind })
      if (!operationIsCurrent(scopedOperation)) return false
      if (result.outcome === 'conflict') {
        showToast(t('wikiRevisionConflict'))
        setRefresh(value => value + 1)
        return false
      }
      setState(current => current.status === 'ready'
        ? { status: 'ready', value: { ...current.value, knowledgeVersion: result.knowledgeVersion } }
        : current)
      const tree = await wikiTree({ workspaceId, runId: knowledgeRun.id })
      if (!operationIsCurrent(scopedOperation)) return false
      setWikiTreeState({ status: 'ready', value: tree })
      showToast(t('wikiRevisionSaved'))
      setRefresh(value => value + 1)
      return true
    } catch {
      if (operationIsCurrent(scopedOperation)) showToast(t('wikiRevisionError'))
      return false
    } finally {
      if (operationIsCurrent(scopedOperation)) setBusy(null)
    }
  }
  const canRunWikiTask = analysisRun !== undefined
    && analysisRun.catalogComplete
    && analysisRun.tasks.running + analysisRun.tasks.planned + analysisRun.tasks.failed + analysisRun.tasks.cancelled > 0
  const wikiConsistencyPhase = analysisRun?.status === 'verifying' && analysisRun.consistency.planned
  const wikiFileSynthesisPhase = analysisRun?.status === 'analyzing'
    && ['running', 'unassessed'].includes(analysisRun.fileSynthesis.status)
    && analysisRun.fileSynthesis.taskCount > 0
    && analysisRun.tasks.succeeded < analysisRun.tasks.taskCount
  const wikiPagePhase = analysisRun?.status === 'synthesizing'

  return (
    <section className="mk-section" aria-busy={state.status === 'loading'}>
      <header className="mk-heading">
        <h2>{t('title')}</h2>
        <p>{t('description')}</p>
      </header>
      <div className="mk-privacy">{t('privacy')}</div>
      <div className="mk-domain-tabs" role="tablist" aria-label={t('productDomain')}>
        <button id="mk-domain-tab-memory" aria-controls="mk-domain-panel-memory" className="mk-domain-tab" data-active={domain === 'memory'} role="tab" aria-selected={domain === 'memory'} tabIndex={domain === 'memory' ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => { setDomain('memory'); setMemoryView('entries'); setKnowledgeAuxiliaryView('closed') }}>{t('memory')}</button>
        <button id="mk-domain-tab-knowledge" aria-controls="mk-domain-panel-knowledge" className="mk-domain-tab" data-active={domain === 'knowledge'} role="tab" aria-selected={domain === 'knowledge'} tabIndex={domain === 'knowledge' ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => { setDomain('knowledge'); setKnowledgeAuxiliaryView('closed') }}>{t('knowledge')}</button>
      </div>
      <div id={`mk-domain-panel-${domain}`} role="tabpanel" aria-labelledby={`mk-domain-tab-${domain}`}>
      {domain === 'memory' ? (
        <>
          <div className="mk-toolbar">
            <label className="mk-field">
              <span>{t('memoryScope')}</span>
              <select value={memoryWorkspaceId} onChange={(event) => { setMemoryWorkspaceId(event.currentTarget.value) }}>
                <option value="">{t('personal')}</option>
                {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{t('projectMemoryOption', { project: workspace.title })}</option>)}
              </select>
            </label>
          </div>
          <div className="mk-tabs" role="tablist" aria-label={t('memoryViews')}>
            <button id="mk-memory-tab-entries" aria-controls="mk-memory-panel-entries" className="mk-tab" data-active={memoryView === 'entries'} role="tab" aria-selected={memoryView === 'entries'} tabIndex={memoryView === 'entries' ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => { setMemoryView('entries') }}>{t('memoryEntries')}</button>
            <button id="mk-memory-tab-candidates" aria-controls="mk-memory-panel-candidates" className="mk-tab" data-active={memoryView === 'candidates'} role="tab" aria-selected={memoryView === 'candidates'} tabIndex={memoryView === 'candidates' ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => { setMemoryView('candidates') }}>{t('memoryCandidates')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="mk-toolbar">
            <label className="mk-field">
              <span>{t('knowledgeProject')}</span>
              <select value={knowledgeWorkspaceId} onChange={(event) => { setKnowledgeWorkspaceId(event.currentTarget.value) }}>
                <option value="">{t('selectProject')}</option>
                {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
              </select>
            </label>
            <div className="mk-aux-actions">
              <Button size="sm" variant={knowledgeAuxiliaryView === 'analysis' ? 'primary' : 'outline'} disabled={knowledgeWorkspaceId === ''} onClick={() => { setKnowledgeAuxiliaryView(value => value === 'analysis' ? 'closed' : 'analysis') }}>{t('analysisProgress')}</Button>
              <Button size="sm" variant={knowledgeAuxiliaryView === 'sources' ? 'primary' : 'outline'} disabled={knowledgeWorkspaceId === ''} onClick={() => { setKnowledgeAuxiliaryView(value => value === 'sources' ? 'closed' : 'sources') }}>{t('sourceDiagnostics')}</Button>
            </div>
          </div>
          <div className="mk-tabs" role="tablist" aria-label={t('knowledgeViews')}>
            <button id="mk-knowledge-tab-project-wiki" aria-controls="mk-knowledge-panel-project-wiki" className="mk-tab" data-active={knowledgeView === 'project-wiki'} role="tab" aria-selected={knowledgeView === 'project-wiki'} tabIndex={knowledgeView === 'project-wiki' ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => { setKnowledgeView('project-wiki'); setKnowledgeAuxiliaryView('closed') }}>{t('projectWiki')}</button>
            <button id="mk-knowledge-tab-agent-knowledge" aria-controls="mk-knowledge-panel-agent-knowledge" className="mk-tab" data-active={knowledgeView === 'agent-knowledge'} role="tab" aria-selected={knowledgeView === 'agent-knowledge'} tabIndex={knowledgeView === 'agent-knowledge' ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => { setKnowledgeView('agent-knowledge'); setKnowledgeAuxiliaryView('closed') }}>{t('agentKnowledge')}</button>
          </div>
        </>
      )}
      <div
        id={domain === 'memory' ? `mk-memory-panel-${memoryView}` : `mk-knowledge-panel-${knowledgeView}`}
        role="tabpanel"
        aria-labelledby={domain === 'memory' ? `mk-memory-tab-${memoryView}` : `mk-knowledge-tab-${knowledgeView}`}
      >
      {state.status === 'loading' ? <p className="mk-status">{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className="mk-failure" role="alert">
          <span>{t('loadError')}</span>
          <Button size="sm" variant="outline" onClick={() => { setRefresh(value => value + 1) }}>{t('retry')}</Button>
        </div>
      ) : null}
      {state.status === 'ready' && domain === 'memory' && memoryView === 'candidates' ? (
        <>
          {state.value.restrictedCandidateCount > 0 ? (
            <p className="mk-warning">{t('restrictedCount', { count: state.value.restrictedCandidateCount })}</p>
          ) : null}
          <div className="mk-filter">
            {(['all', 'pending', 'accepted', 'rejected', 'promoted'] as const).map(value => (
              <button key={value} type="button" data-active={status === value} onClick={() => { setStatus(value) }}>
                {t(value === 'all' ? 'allStatuses' : STATUS_KEYS[value])}
              </button>
            ))}
          </div>
          {candidates.length === 0 ? <p className="mk-status">{t('emptyCandidates')}</p> : (
            <ul className="mk-list">
              {candidates.map(candidate => {
                const open = expanded === candidate.id
                const target = promotionTargets[candidate.id] ?? state.value.workspaces[0]?.id ?? ''
                const canPromote = candidate.status === 'accepted'
                  && (candidate.applicability === 'project' || target !== '')
                return (
                  <li className="mk-card" key={candidate.id} data-candidate-id={candidate.id}>
                    <button className="mk-card-head" type="button" aria-expanded={open} onClick={() => { setExpanded(value => value === candidate.id ? null : candidate.id) }}>
                      <span className="mk-card-title">
                        <strong>{candidate.title}</strong>
                        <span className="mk-meta">
                          <span className="mk-state"><StateDot state={statusDot(candidate.status)} />{t(STATUS_KEYS[candidate.status])}</span>
                          <span className="mk-chip">{t(candidate.target === 'memory' ? 'memoryTarget' : 'knowledgeCardTarget')}</span>
                          <span>{t(KIND_KEYS[candidate.kind])}</span>
                          <span>{t(candidate.suggestedBy)}</span>
                          <span>{t('updatedAt', { time: formatTime(candidate.updatedAt) })}</span>
                        </span>
                      </span>
                      <span aria-hidden="true">{open ? '−' : '+'}</span>
                    </button>
                    {open ? (
                      <div className="mk-card-body">
                        <p className="mk-content">{candidate.content}</p>
                        {candidate.contentTruncated ? <p className="mk-warning">{t('truncated')}</p> : null}
                        <DetailList evidence={candidate.evidence} tags={candidate.tags} t={t} />
                        {!candidate.contentTruncated && candidate.status === 'pending' ? (
                          <div className="mk-actions">
                            <Button size="sm" variant="primary" icon={<IconCheckOutline16 />} disabled={busy !== null} onClick={() => void mutate(candidate, () => review({ id: candidate.id, revision: candidate.revision, decision: 'accept' }), t('updated'))}>{t('accept')}</Button>
                            <Button size="sm" variant="outline" icon={<IconCloseOutline16 />} disabled={busy !== null} onClick={() => void mutate(candidate, () => review({ id: candidate.id, revision: candidate.revision, decision: 'reject' }), t('updated'))}>{t('reject')}</Button>
                          </div>
                        ) : null}
                        {!candidate.contentTruncated && candidate.status === 'accepted' ? (
                          <div className="mk-actions">
                            {candidate.applicability === 'global' ? (
                              <select aria-label={t('selectProject')} value={target} onChange={(event) => { setPromotionTargets(values => ({ ...values, [candidate.id]: event.currentTarget.value })) }}>
                                {state.value.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
                              </select>
                            ) : null}
                            <Button size="sm" variant="primary" disabled={busy !== null || !canPromote} onClick={() => void mutate(candidate, () => promote({ id: candidate.id, revision: candidate.revision, ...(candidate.applicability === 'global' ? { workspaceId: target } : {}) }), t(candidate.target === 'memory' ? 'promotedMemoryToast' : 'promotedKnowledgeCardToast'))}>{t('promote')}</Button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : null}
      {domain === 'knowledge' && knowledgeAuxiliaryView === 'closed' ? (
        <KnowledgeWikiView
          mode={knowledgeView}
          run={knowledgeRun}
          version={knowledgeVersion}
          treeState={wikiTreeState}
          workspaceSelected={workspaceId !== ''}
          busy={busy !== null}
          onToggleTree={loadWikiTree}
          onSave={savePageRevision}
          t={t}
        />
      ) : null}
      {state.status === 'ready' && domain === 'memory' && memoryView === 'entries' ? (
        <>
          {domain === 'memory' ? (
            <div className="mk-memory-create">
              <div className="mk-actions">
                <Button size="sm" variant={creatingMemory ? 'outline' : 'primary'} disabled={busy !== null} onClick={() => { setCreatingMemory(value => !value) }}>
                  {creatingMemory ? t('cancelCreateMemory') : t('createMemory')}
                </Button>
              </div>
              {creatingMemory ? <MemoryEntryForm
                busy={busy !== null}
                submitLabel={t('saveMemory')}
                onSubmit={createMemoryEntry}
                onCancel={() => { setCreatingMemory(false) }}
                t={t}
              /> : null}
            </div>
          ) : null}
          <form className="mk-search" onSubmit={submitSearch}>
            <input type="search" aria-label={t(recordDomain === 'memory' ? 'searchMemory' : 'searchKnowledge')} placeholder={t(recordDomain === 'memory' ? 'searchMemory' : 'searchKnowledge')} value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} />
            <Button type="submit" variant="primary" icon={<IconSearchOutline16 />} disabled={searching}>{t('searchAction')}</Button>
            {searchRecords !== null ? <Button variant="outline" onClick={() => {
              searchRequestId.current += 1
              setSearching(false)
              setQuery('')
              setSearchRecords(null)
            }}>{t('clearSearch')}</Button> : null}
          </form>
          <div className="mk-results-heading"><h3>{t(recordDomain)}</h3><span className="mk-meta">{records.length}</span></div>
          {records.length === 0 ? <p className="mk-status">{searchRecords === null
            ? t(recordDomain === 'memory' ? 'emptyMemoryRecords' : 'emptyKnowledgeRecords')
            : t(recordDomain === 'memory' ? 'noMemorySearchResults' : 'noKnowledgeSearchResults')}</p> : (
            <ul className="mk-list">
              {records.map(record => (
                <li className="mk-card" key={`${record.recordType}:${record.id}`}>
                  <button className="mk-card-head mk-record-head" type="button" onClick={() => { openTrace(record.id) }}>
                    <span className="mk-card-title">
                      <strong>{record.title}</strong>
                      <span className="mk-meta">
                        <span className="mk-chip">{t(RECORD_KEYS[record.recordType])}</span>
                        {record.kind === undefined ? null : <span>{t(KIND_KEYS[record.kind])}</span>}
                        {record.editable === true ? <span>{t(record.status === 'active' ? 'activeMemory' : record.status === 'deprecated' ? 'deprecatedMemory' : 'deletedMemory')}</span> : null}
                        <span>{t(EVIDENCE_KEYS[record.evidenceClass])}</span>
                        <span>{t('updatedAt', { time: formatTime(record.updatedAt) })}</span>
                      </span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {traceState.status !== 'closed' ? (
            <aside className="mk-trace" aria-live="polite">
              <div className="mk-trace-head">
                <div><h3>{t('trace')}</h3>{traceState.status === 'ready' && traceState.value !== null ? <p className="mk-id">{traceState.value.id}</p> : null}</div>
                <Button size="sm" variant="ghost" onClick={closeTrace}>{t('closeTrace')}</Button>
              </div>
              {traceState.status === 'loading' ? <p className="mk-status">{t('traceLoading')}</p> : null}
              {traceState.status === 'error' ? <p className="mk-failure">{t('traceError')}</p> : null}
              {traceState.status === 'ready' && traceState.value === null ? <p className="mk-status">{t('traceMissing')}</p> : null}
              {traceState.status === 'ready' && traceState.value !== null ? (
                <>
                  <h3>{traceState.value.title}</h3>
                  {traceState.value.editable === true && traceState.value.revision !== undefined && traceState.value.kind !== undefined ? (
                    <>
                      {traceState.value.status === 'active' ? <MemoryEntryForm
                        key={`${traceState.value.id}:${traceState.value.revision}`}
                        initial={{
                          title: traceState.value.title,
                          content: traceState.value.content,
                          kind: traceState.value.kind,
                          conditions: (traceState.value.conditions ?? []).join('，'),
                          tags: (traceState.value.tags ?? []).join('，'),
                        }}
                        busy={busy !== null}
                        submitLabel={t('saveRevision')}
                        onSubmit={draft => { updateMemoryEntry(traceState.value!, draft) }}
                        onCancel={closeTrace}
                        t={t}
                      /> : (
                        <>
                          <p className="mk-content">{traceState.value.content}</p>
                          <div className="mk-actions">
                            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { changeMemoryStatus(traceState.value!, 'active') }}>{t('restoreMemory')}</Button>
                          </div>
                        </>
                      )}
                      {traceState.value.status === 'active' ? <div className="mk-actions">
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { changeMemoryStatus(traceState.value!, 'deprecated') }}>{t('deprecateMemory')}</Button>
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { changeMemoryStatus(traceState.value!, 'deleted') }}>{t('deleteMemory')}</Button>
                      </div> : null}
                      {(traceState.value.history ?? []).length === 0 ? null : <details className="mk-memory-history">
                        <summary>{t('memoryHistory', { count: traceState.value.history!.length })}</summary>
                        <ol>{traceState.value.history!.map(revision => <li key={revision.revision}>
                          <strong>v{revision.revision}</strong> · {t(`memoryRevision_${revision.kind}`)} · {formatTime(revision.updatedAt)}
                        </li>)}</ol>
                      </details>}
                    </>
                  ) : <><p className="mk-content">{traceState.value.content}</p><DetailList evidence={traceState.value.evidence} tags={[]} t={t} /></>}
                </>
              ) : null}
            </aside>
          ) : null}
        </>
      ) : null}
      {state.status === 'ready' && domain === 'knowledge' && knowledgeAuxiliaryView === 'analysis' ? (
        workspaceId === '' || state.value.wikiRuns === undefined ? (
          <p className="mk-status">{t('selectWorkspaceForWiki')}</p>
        ) : (
          <div className="mk-source-view">
            <div className="mk-results-heading mk-wiki-heading">
              <div>
                <h3>{t('wikiRuns')}</h3>
                <p className="mk-status">{t('wikiRunsDescription')}</p>
              </div>
              <div className="mk-actions">
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void planWikiRun()}>
                  {busy === 'wiki-plan' ? t('wikiPlanning') : t('wikiPlan')}
                </Button>
                <Button size="sm" variant="primary" disabled={busy !== null || !canRunWikiTask} onClick={() => void analyzeNextWikiTask()}>
                  {busy === 'wiki-task'
                    ? t(wikiPagePhase
                        ? 'wikiPageRunning'
                        : wikiConsistencyPhase
                          ? 'wikiConsistencyRunning'
                          : wikiFileSynthesisPhase
                            ? 'wikiFileSynthesisRunning'
                            : analysisRun?.status === 'verifying' ? 'wikiVerificationRunning' : 'wikiTaskRunning')
                    : t(wikiPagePhase
                        ? 'wikiPageNextTask'
                        : wikiConsistencyPhase
                          ? 'wikiConsistencyNextTask'
                          : wikiFileSynthesisPhase
                            ? 'wikiFileSynthesisNextTask'
                            : analysisRun?.status === 'verifying' ? 'wikiVerifyNextTask' : 'wikiRunNextTask')}
                </Button>
              </div>
            </div>
            {state.value.wikiRuns.length === 0 ? <p className="mk-status">{t('emptyWikiRuns')}</p> : (
              <ul className="mk-list">
                {state.value.wikiRuns.map(run => (
                  <li className="mk-card" key={run.id} data-wiki-run-id={run.id}>
                    <div className="mk-card-head mk-static-card">
                      <span className="mk-card-title">
                        <strong>{t('wikiRunTitle', { id: run.id.slice(-8) })}</strong>
                        <span className="mk-meta">
                          <span className="mk-state"><StateDot state={wikiStatusDot(run.status)} />{t(WIKI_RUN_STATUS_KEYS[run.status])}</span>
                          <span>{t(run.catalogComplete ? 'wikiCatalogComplete' : 'wikiCatalogIncomplete')}</span>
                          <span>{t('fileCount', { count: run.coverage.itemCount })}</span>
                          <span>{t('wikiTaskProgress', {
                            failed: run.tasks.failed,
                            pending: run.tasks.planned,
                            running: run.tasks.running,
                            succeeded: run.tasks.succeeded,
                            total: run.tasks.taskCount,
                          })}</span>
                          {run.materialRanges.rangeCount === 0 ? null : <span>{t('wikiMaterialRangeProgress', {
                            analyzed: run.materialRanges.succeeded,
                            total: run.materialRanges.rangeCount,
                            bytes: formatBytes(run.materialRanges.analyzedBytes),
                          })}</span>}
                          <span className="mk-wiki-summary">{t(run.fileSynthesis.status === 'unplanned'
                            ? 'wikiFileSynthesisPending'
                            : run.fileSynthesis.status === 'unassessed'
                              ? 'wikiFileSynthesisUnassessed'
                              : run.fileSynthesis.status === 'running'
                                ? 'wikiFileSynthesisProgress'
                                : run.fileSynthesis.status === 'complete'
                                  ? 'wikiFileSynthesisComplete'
                                  : 'wikiFileSynthesisIncomplete', {
                            claims: run.fileSynthesis.inputClaimCount,
                            files: run.fileSynthesis.fileCount,
                            incomplete: run.fileSynthesis.incompleteFileCount ?? 0,
                            tasks: run.fileSynthesis.taskCount,
                            levels: run.fileSynthesis.levelCount,
                            completed: run.fileSynthesis.completeFileCount,
                            noReduction: run.fileSynthesis.noReductionFileCount,
                            levelLimit: run.fileSynthesis.levelLimitFileCount,
                          })}</span>
                          <span>{t(!run.consistency.planned
                            ? 'wikiConsistencyPending'
                            : run.consistency.candidatePairsComplete
                              ? 'wikiConsistencyComplete'
                              : 'wikiConsistencyIncomplete', {
                            count: run.consistency.candidatePairCount,
                          })}</span>
                          <span>{t(run.pageGeneration.planned ? 'wikiPagePlan' : 'wikiPagePlanPending', {
                            claims: run.pageGeneration.claimCount,
                            tasks: run.pageGeneration.taskCount,
                          })}</span>
                          <span>{formatBytes(run.coverage.totalBytes)}</span>
                          <span>{t('wikiRootPages', { count: run.rootPageCount })}</span>
                          <span>{t('updatedAt', { time: formatTime(run.updatedAt) })}</span>
                          <span>{t('wikiCatalogHash', { hash: run.catalogHash.slice(7, 19) })}</span>
                        </span>
                        <WikiCoverageBar run={run} t={t} />
                        <span className="mk-wiki-completion">
                          <strong>{t(run.completion.eligibleForActivation
                            ? 'wikiCompletionReady'
                            : 'wikiCompletionBlocked')}</strong>
                          <span className="mk-wiki-completion-checks">
                            {run.completion.checks.map(check => (
                              <span key={check.id} data-state={check.state}>
                                {t(WIKI_COMPLETION_CHECK_KEYS[check.id])}：{t(WIKI_COMPLETION_STATE_KEYS[check.state])}
                                {check.issueCount === 0 ? null : ` · ${t('wikiCompletionIssues', { count: check.issueCount })}`}
                              </span>
                            ))}
                          </span>
                        </span>
                        {run.catalogComplete ? null : (
                          <span className="mk-warning">{run.catalogOmittedItemCount === null
                            ? t('wikiOmissionsUnknown')
                            : t('wikiOmissionsKnown', { count: run.catalogOmittedItemCount })}</span>
                        )}
                        {run.blockingReasons.length === 0 ? null : (
                          <span className="mk-reasons">{run.blockingReasons.map((reason, index) => (
                            <span key={`${index}:${reason}`}>{reason}</span>
                          ))}{run.omittedBlockingReasonCount === 0 ? null : (
                            <span>{t('omittedReasons', { count: run.omittedBlockingReasonCount })}</span>
                          )}</span>
                        )}
                      </span>
                    </div>
                    <WikiBudgetPanel key={`${workspaceId}:${run.id}`} workspaceId={workspaceId} runId={run.id}
                      refreshKey={run.updatedAt} disabled={busy !== null} operations={props} t={t} />
                    {run.rootPageCount === 0 ? null : (
                      <div className="mk-wiki-tree-action">
                        <Button size="sm" variant="ghost" disabled={wikiTreeState.status === 'loading'} onClick={() => { loadWikiTree(run.id) }}>
                          {wikiTreeState.status === 'loading' && wikiTreeState.runId === run.id
                            ? t('wikiTreeLoading')
                            : wikiTreeState.status === 'ready' && wikiTreeState.value.runId === run.id
                              ? t('wikiTreeHide')
                              : t('wikiTreeView')}
                        </Button>
                      </div>
                    )}
                    {wikiTreeState.status === 'error' && wikiTreeState.runId === run.id ? (
                      <p className="mk-failure">{t('wikiTreeError')}</p>
                    ) : null}
                    {wikiTreeState.status === 'ready' && wikiTreeState.value.runId === run.id ? (
                      <WikiTree tree={wikiTreeState.value} t={t} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {state.value.wikiRunHistoryTruncated === true ? <p className="mk-warning">{t('wikiHistoryTruncated')}</p> : null}
          </div>
        )
      ) : null}
      {state.status === 'ready' && domain === 'knowledge' && knowledgeAuxiliaryView === 'sources' ? (
        workspaceId === '' || state.value.projectStatus === undefined ? (
          <p className="mk-status">{t('selectWorkspaceForSources')}</p>
        ) : (
          <div className="mk-source-view">
            <div className="mk-results-heading">
              <h3>{t('sourceInventory')}</h3>
              <div className="mk-actions">
                <span className="mk-meta">{state.value.projectStatus.sources.length}</span>
                {state.value.projectStatus.omittedSourceCount === 0 ? null : (
                  <span className="mk-meta">{t('omittedItems', { count: state.value.projectStatus.omittedSourceCount })}</span>
                )}
                <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void generateCandidates()}>
                  {busy === 'generate' ? t('generatingCandidates') : t('generateCandidates')}
                </Button>
              </div>
            </div>
            <ul className="mk-list">
              {state.value.projectStatus.sources.map(source => (
                <li className="mk-card" key={source.id}>
                  <div className="mk-card-head mk-static-card">
                    <span className="mk-card-title">
                      <strong>{source.branch ?? source.id}</strong>
                      <span className="mk-meta">
                        <span className="mk-state"><StateDot state={source.state === 'ready' ? 'done' : 'warning'} />{t(source.state === 'ready' ? 'ready' : 'degraded')}</span>
                        {source.revision === undefined ? null : <span>{t('sourceRevision', { revision: source.revision.slice(0, 8) })}</span>}
                        <span>{t('fileCount', { count: source.fileCount })}</span>
                        <span>{formatBytes(source.totalBytes)}</span>
                        <span>{t(source.scanMode === 'incremental' ? 'incrementalScan' : 'fullScan', {
                          reused: source.reusedFileCount,
                          read: source.readFileCount,
                          count: source.readFileCount,
                        })}</span>
                        <span>{t(source.dirty ? 'worktreeDirty' : 'worktreeClean')}</span>
                        {source.issueCount === 0 ? null : <span>{t('inventoryIssues', { count: source.issueCount })}</span>}
                        <span>{t(source.understandingState === 'current'
                          ? 'understandingCurrent'
                          : source.understandingState === 'stale' ? 'understandingStale' : 'understandingMissing')}</span>
                        {source.sourceRecordCount === undefined ? null : <span>{t('sourceRecords', { count: source.sourceRecordCount })}</span>}
                        {source.sourceEvidenceCount === undefined ? null : <span>{t('sourceEvidence', { count: source.sourceEvidenceCount })}</span>}
                        {source.sourceAreaCount === undefined ? null : <span>{t('sourceAreas', { count: source.sourceAreaCount })}</span>}
                        {source.sourceRelationCount === undefined ? null : <span>{t('sourceRelations', {
                          count: source.sourceRelationCount,
                          internal: source.sourceInternalRelationCount ?? 0,
                          external: source.sourceExternalRelationCount ?? 0,
                          unresolved: source.sourceUnresolvedRelationCount ?? 0,
                        })}</span>}
                        {source.sourceOmittedRelationCount === undefined || source.sourceOmittedRelationCount === 0
                          ? null : <span>{t('omittedRelations', { count: source.sourceOmittedRelationCount })}</span>}
                        {source.sourceSymbolReferenceCount === undefined ? null : <span>{t('sourceSymbols', {
                          definitions: source.sourceSymbolDefinitionCount ?? 0,
                          references: source.sourceSymbolReferenceCount,
                        })}</span>}
                        {source.sourceSymbolConfigMode === undefined ? null : <span>{source.sourceSymbolConfigMode === 'tsconfig'
                          ? t('sourceSymbolConfig', {
                              configs: source.sourceSymbolConfigFileCount ?? 0,
                              aliases: source.sourceSymbolPathAliasCount ?? 0,
                              references: source.sourceSymbolProjectReferenceCount ?? 0,
                            })
                          : t('sourceSymbolDefaultConfig')}</span>}
                        {source.sourceSymbolConfigDiagnosticCount === undefined || source.sourceSymbolConfigDiagnosticCount === 0
                          ? null : <span>{t('symbolConfigDiagnostics', { count: source.sourceSymbolConfigDiagnosticCount })}</span>}
                        {source.sourceOmittedSymbolConfigFileCount === undefined || source.sourceOmittedSymbolConfigFileCount === 0
                          ? null : <span>{t('omittedSymbolConfigs', { count: source.sourceOmittedSymbolConfigFileCount })}</span>}
                        {source.sourceOmittedSymbolFileCount === undefined || source.sourceOmittedSymbolFileCount === 0
                          ? null : <span>{t('omittedSymbolFiles', { count: source.sourceOmittedSymbolFileCount })}</span>}
                        {source.sourceOmittedSymbolReferenceCount === undefined || source.sourceOmittedSymbolReferenceCount === 0
                          ? null : <span>{t('omittedSymbolReferences', { count: source.sourceOmittedSymbolReferenceCount })}</span>}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mk-results-heading">
              <div>
                <h3>{t('relationGraph')}</h3>
                <p className="mk-status">{t('relationQueryDescription')}</p>
              </div>
              {relationPack === null ? null : <span className="mk-meta">{t('relationMatches', {
                shown: relationPack.edges.length,
                total: relationPack.totalMatches,
                omitted: relationPack.omittedEdgeCount,
              })}</span>}
            </div>
            <form className="mk-relation-filter" onSubmit={submitRelationQuery}>
              <label><span>{t('relationTextFilter')}</span><input type="search" value={relationQuery} onChange={(event) => { setRelationQuery(event.currentTarget.value) }} /></label>
              <label><span>{t('relationAreaFilter')}</span><input type="text" value={relationArea} onChange={(event) => { setRelationArea(event.currentTarget.value) }} /></label>
              <label><span>{t('relationResolutionFilter')}</span><select value={relationResolution} onChange={(event) => { setRelationResolution(event.currentTarget.value as typeof relationResolution) }}>
                <option value="">{t('relationAll')}</option>
                <option value="internal">{t('relationInternal')}</option>
                <option value="external">{t('relationExternal')}</option>
                <option value="unresolved">{t('relationUnresolved')}</option>
              </select></label>
              <label><span>{t('relationKindFilter')}</span><select value={relationKind} onChange={(event) => { setRelationKind(event.currentTarget.value as typeof relationKind) }}>
                <option value="">{t('relationAll')}</option>
                {Object.entries(RELATION_KIND_KEYS).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
              </select></label>
              <Button type="submit" variant="primary" icon={<IconSearchOutline16 />} disabled={relationSearching}>{t('relationApplyFilters')}</Button>
            </form>
            {relationPack === null ? <p className="mk-status">{relationSearching ? t('relationLoading') : t('relationQueryHint')}</p> : null}
            {relationPack !== null && relationPack.edges.length === 0 ? <p className="mk-status">{t('emptyRelations')}</p> : null}
            {relationPack !== null && relationPack.edges.length > 0 ? (
              <>
                <div className="mk-relation-legend" aria-label={t('relationLegend')}>
                  {(['internal', 'external', 'unresolved'] as const).map(value => <span key={value} data-resolution={value}>{t(RELATION_RESOLUTION_KEYS[value])}</span>)}
                </div>
                <RelationGraph pack={relationPack} t={t} />
                {relationPack.sourceRevisions.reduce((sum, source) => sum + source.graphOmittedEdgeCount, 0) === 0 ? null : (
                  <p className="mk-warning">{t('relationAnalysisOmitted', {
                    count: relationPack.sourceRevisions.reduce((sum, source) => sum + source.graphOmittedEdgeCount, 0),
                  })}</p>
                )}
              </>
            ) : null}
            <div className="mk-results-heading">
              <div>
                <h3>{t('symbolGraph')}</h3>
                <p className="mk-status">{t('symbolQueryDescription')}</p>
              </div>
              {symbolPack === null ? null : <span className="mk-meta">{t('symbolMatches', {
                shown: symbolPack.edges.length,
                total: symbolPack.totalMatches,
                omitted: symbolPack.omittedReferenceCount,
              })}</span>}
            </div>
            <form className="mk-relation-filter" onSubmit={submitSymbolQuery}>
              <label><span>{t('symbolTextFilter')}</span><input type="search" value={symbolQuery} onChange={(event) => { setSymbolQuery(event.currentTarget.value) }} /></label>
              <label><span>{t('symbolDefinitionPathFilter')}</span><input type="text" value={symbolDefinitionPath} onChange={(event) => { setSymbolDefinitionPath(event.currentTarget.value) }} /></label>
              <label><span>{t('symbolReferencePathFilter')}</span><input type="text" value={symbolReferencePath} onChange={(event) => { setSymbolReferencePath(event.currentTarget.value) }} /></label>
              <label><span>{t('symbolReferenceKindFilter')}</span><select value={symbolReferenceKind} onChange={(event) => { setSymbolReferenceKind(event.currentTarget.value as typeof symbolReferenceKind) }}>
                <option value="">{t('relationAll')}</option>
                {Object.entries(SYMBOL_REFERENCE_KIND_KEYS).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
              </select></label>
              <Button type="submit" variant="primary" icon={<IconSearchOutline16 />} disabled={symbolSearching}>{t('symbolApplyFilters')}</Button>
            </form>
            {symbolPack === null ? null : symbolPack.sourceRevisions.map(source => (
              <p className="mk-meta" key={`${source.sourceId}:${source.symbolOutputHash}`}>
                {source.configMode === 'tsconfig' ? t('sourceSymbolConfig', {
                  configs: source.configPaths.length,
                  aliases: source.pathAliasCount,
                  references: source.projectReferenceCount,
                }) : t('sourceSymbolDefaultConfig')}
              </p>
            ))}
            {symbolPack === null ? <p className="mk-status">{symbolSearching ? t('symbolLoading') : t('symbolQueryHint')}</p> : null}
            {symbolPack !== null && symbolPack.edges.length === 0 ? <p className="mk-status">{t('emptySymbols')}</p> : null}
            {symbolPack !== null && symbolPack.edges.length > 0 ? (
              <>
                <div className="mk-relation-legend" aria-label={t('symbolLegend')}>
                  <span data-resolution="internal">{t('symbolDefinitionNode')}</span>
                  <span data-resolution="external">{t('symbolReferenceNode')}</span>
                </div>
                <SymbolGraph pack={symbolPack} t={t} />
                {symbolPack.sourceRevisions.reduce((sum, source) => sum + source.graphOmittedFileCount, 0) === 0 ? null : (
                  <p className="mk-warning">{t('symbolAnalysisOmittedFiles', {
                    count: symbolPack.sourceRevisions.reduce((sum, source) => sum + source.graphOmittedFileCount, 0),
                  })}</p>
                )}
                {symbolPack.sourceRevisions.reduce((sum, source) => sum + source.graphOmittedReferenceCount, 0) === 0 ? null : (
                  <p className="mk-warning">{t('symbolAnalysisOmittedReferences', {
                    count: symbolPack.sourceRevisions.reduce((sum, source) => sum + source.graphOmittedReferenceCount, 0),
                  })}</p>
                )}
              </>
            ) : null}
            {symbolPack === null || symbolPack.sourceRevisions.reduce((sum, source) => sum + source.configDiagnosticCount, 0) === 0 ? null : (
              <p className="mk-warning">{t('symbolConfigDiagnostics', {
                count: symbolPack.sourceRevisions.reduce((sum, source) => sum + source.configDiagnosticCount, 0),
              })}</p>
            )}
            {symbolPack === null || symbolPack.sourceRevisions.reduce((sum, source) => sum + source.omittedConfigFileCount, 0) === 0 ? null : (
              <p className="mk-warning">{t('omittedSymbolConfigs', {
                count: symbolPack.sourceRevisions.reduce((sum, source) => sum + source.omittedConfigFileCount, 0),
              })}</p>
            )}
            <div className="mk-results-heading">
              <div>
                <h3>{t('evidencePack')}</h3>
                <p className="mk-status">{t('evidencePackDescription')}</p>
              </div>
              {evidencePack === null ? null : <span className="mk-meta">{t('evidenceMatches', {
                shown: evidencePack.hits.length,
                total: evidencePack.totalMatches,
                omitted: evidencePack.omittedHitCount,
              })}</span>}
            </div>
            <form className="mk-search" onSubmit={submitEvidenceSearch}>
              <input
                type="search"
                aria-label={t('evidenceSearch')}
                placeholder={t('evidenceSearch')}
                value={evidenceQuery}
                onChange={(event) => { setEvidenceQuery(event.currentTarget.value) }}
              />
              <Button type="submit" variant="primary" icon={<IconSearchOutline16 />} disabled={evidenceSearching}>
                {t('searchAction')}
              </Button>
              {evidencePack === null ? null : (
                <Button type="button" variant="outline" onClick={() => {
                  evidenceRequestId.current += 1
                  setEvidenceSearching(false)
                  setEvidenceQuery('')
                  setEvidencePack(null)
                }}>
                  {t('clearSearch')}
                </Button>
              )}
            </form>
            {evidencePack === null ? <p className="mk-status">{t('evidenceSearchHint')}</p> : null}
            {evidencePack !== null && evidencePack.hits.length === 0 ? (
              <p className="mk-status">{t('emptyEvidence')}</p>
            ) : null}
            {evidencePack !== null && evidencePack.hits.length > 0 ? (
              <ul className="mk-list">
                {evidencePack.hits.map((hit, index) => (
                  <li className="mk-card" key={`${hit.sourceId}:${hit.path}:${hit.startLine}:${hit.kind}:${index}`}>
                    <div className="mk-card-head mk-static-card">
                      <span className="mk-card-title">
                        <strong>{hit.name}</strong>
                        <span className="mk-evidence-location">{hit.path}:{hit.startLine}{hit.endLine === hit.startLine ? '' : `-${hit.endLine}`}</span>
                        <span className="mk-meta">
                          <span className="mk-chip">{t(hit.kind === 'code-symbol' ? 'codeSymbol' : 'documentHeading')}</span>
                          <span>{hit.detail}</span>
                          {hit.exported === undefined ? null : <span>{t(hit.exported ? 'exportedSymbol' : 'internalSymbol')}</span>}
                          {hit.containerName === undefined ? null : <span>{t('symbolContainer', { name: hit.containerName })}</span>}
                          {hit.language === undefined ? null : <span>{hit.language}</span>}
                          <span>{t(ARTIFACT_KEYS[hit.artifactKind])}</span>
                          <span>{t('sourceRevision', { revision: hit.revision.slice(0, 8) })}</span>
                          <span>{t('contentHash', { hash: hit.contentHash.slice(7, 19) })}</span>
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mk-results-heading">
              <h3>{t('cardFreshness')}</h3>
              <span className="mk-meta">{t('staleSummary', {
                stale: state.value.projectStatus.staleCardCount,
                degraded: state.value.projectStatus.degradedCardCount,
              })}</span>
              {state.value.projectStatus.omittedCardCount === 0 ? null : (
                <span className="mk-meta">{t('omittedItems', { count: state.value.projectStatus.omittedCardCount })}</span>
              )}
            </div>
            {state.value.projectStatus.cards.length === 0 ? <p className="mk-status">{t('emptyKnowledgeCards')}</p> : (
              <ul className="mk-list">
                {state.value.projectStatus.cards.map(card => (
                  <li className="mk-card" key={card.id}>
                    <div className="mk-card-head mk-static-card">
                      <span className="mk-card-title">
                        <strong>{card.title}</strong>
                        <span className="mk-meta">
                          <span className="mk-state"><StateDot state={card.state === 'fresh' ? 'done' : card.state === 'stale' ? 'error' : 'warning'} />{t(card.state === 'fresh' ? 'fresh' : card.state === 'stale' ? 'stale' : card.state === 'degraded' ? 'degraded' : 'inactive')}</span>
                          <span>{t('canonicalStatus', { status: card.canonicalStatus })}</span>
                        </span>
                        {card.reasons.length === 0 ? null : (
                          <span className="mk-reasons">{card.reasons.map(reason => (
                            <span key={`${reason.kind}:${reason.path ?? ''}`}>{t(FRESHNESS_REASON_KEYS[reason.kind])}{reason.path === undefined ? '' : ` · ${reason.path}`}</span>
                          ))}{card.omittedReasonCount === 0 ? null : (
                            <span>{t('omittedReasons', { count: card.omittedReasonCount })}</span>
                          )}</span>
                        )}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      ) : null}
      </div>
      </div>
      {toast !== null ? <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} /> : null}
    </section>
  )
}
