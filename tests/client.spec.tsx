// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryKnowledgeSection } from '../src/client/MemoryKnowledgeSection.js'
import type {
  MemoryKnowledgeSectionInjected,
  MemoryKnowledgeSectionProps,
} from '../src/client/MemoryKnowledgeSection.js'
import { zh, type MemoryKnowledgeLocaleKey } from '../src/client/locales.js'
import type {
  MemoryUiEvidencePack,
  MemoryUiOverview,
  MemoryUiRelationPack,
  MemoryUiSearchResult,
  MemoryUiSymbolPack,
  MemoryUiTrace,
  MemoryUiWikiRunSummary,
} from '../src/ui-contract.js'

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const overviewValue: MemoryUiOverview = {
  workspaces: [{ id: 'workspace-one', title: '示例项目' }],
  candidates: [{
    id: 'cand_11111111-1111-4111-8111-111111111111',
    revision: 2,
    target: 'memory',
    applicability: 'global',
    kind: 'preference',
    title: '候选标题',
    content: '候选完整正文',
    contentTruncated: false,
    tags: ['ui'],
    status: 'pending',
    suggestedBy: 'model',
    evidence: ['会话证据 · 1 个事件'],
    updatedAt: '2026-08-24T00:00:00.000Z',
  }],
  records: [{
    id: 'mem_11111111-1111-4111-8111-111111111111',
    recordType: 'personal-memory',
    title: '长期记忆标题',
    content: '长期记忆正文',
    contentTruncated: false,
    tags: ['memory'],
    evidenceClass: 'human-verified',
    status: 'accepted',
    evidence: ['src/example.ts:8 · 12345678'],
    updatedAt: '2026-08-24T00:00:00.000Z',
  }],
  restrictedCandidateCount: 1,
}

const knowledgeRecord: MemoryUiOverview['records'][number] = {
  ...overviewValue.records[0]!,
  id: 'card_22222222-2222-4222-8222-222222222222',
  recordType: 'knowledge-card',
  title: '项目知识标题',
  content: '项目知识正文',
}

const wikiRunValue: MemoryUiWikiRunSummary = {
  id: 'wrun_11111111-1111-4111-8111-111111111111',
  status: 'planned',
  catalogHash: `sha256:${'a'.repeat(64)}`,
  catalogComplete: true,
  catalogOmittedItemCount: 0,
    coverage: {
    itemCount: 4,
    totalBytes: 4_096,
    pending: 3,
    analyzing: 0,
    analyzed: 0,
    deferred: 0,
    excluded: 1,
    blocked: 0,
      stale: 0,
    },
    materialRanges: {
      rangeCount: 0,
      totalBytes: 0,
      analyzedBytes: 0,
      planned: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    tasks: {
    taskCount: 1,
    planned: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    },
    fileSynthesis: {
      rulesVersion: 2,
      status: 'unplanned',
      fileCount: 0,
      inputClaimCount: 0,
      taskCount: 0,
      levelCount: 0,
      completeFileCount: 0,
      incompleteFileCount: null,
      noReductionFileCount: 0,
      levelLimitFileCount: 0,
      limits: null,
    },
    consistency: {
    rulesVersion: 1,
    planned: false,
    candidatePairCount: 0,
    candidatePairsComplete: false,
    omittedCandidatePairCount: null,
  },
  pageGeneration: { rulesVersion: 1, planned: false, claimCount: 0, taskCount: 0 },
  businessQuestions: {
    state: 'pending',
    requiredQuestionCount: 9,
    analysisTaskCount: 1,
    completedTaskCount: 0,
    evidenceFindingCount: 0,
    unknownFindingCount: 0,
    notApplicableFindingCount: 0,
  },
  completion: {
    eligibleForActivation: false,
    checks: [{ id: 'catalog', state: 'pass', issueCount: 0 },
      { id: 'coverage', state: 'fail', issueCount: 3 },
      { id: 'analysis', state: 'fail', issueCount: 3 },
      { id: 'file-synthesis', state: 'pass', issueCount: 0 },
      { id: 'verification', state: 'fail', issueCount: 1 },
      { id: 'consistency', state: 'fail', issueCount: 1 },
      { id: 'pages', state: 'fail', issueCount: 1 },
      { id: 'material-exposure', state: 'fail', issueCount: 1 },
      { id: 'business-questions', state: 'unsupported', issueCount: 1 },
      { id: 'cross-module-flows', state: 'unsupported', issueCount: 1 }],
  },
  rootPageCount: 0,
  blockingReasons: [],
  omittedBlockingReasonCount: 0,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
}

const t = ((key: MemoryKnowledgeLocaleKey, params?: Record<string, unknown>): string => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as MemoryKnowledgeSectionProps['t']

function props(overrides: Partial<MemoryKnowledgeSectionInjected> = {}) {
  const injected: MemoryKnowledgeSectionInjected = {
    overview: vi.fn(async () => overviewValue),
    search: vi.fn(async () => ({ records: [] })),
    searchEvidence: vi.fn<MemoryKnowledgeSectionInjected['searchEvidence']>(async request => ({
      retriever: 'source-evidence-fts',
      version: 2,
      query: request.query,
      totalMatches: 0,
      omittedHitCount: 0,
      truncationReasons: [],
      sourceRevisions: [],
      hits: [],
    })),
    queryRelations: vi.fn<MemoryKnowledgeSectionInjected['queryRelations']>(async request => ({
      retriever: 'source-relations-sql',
      version: 1,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.area === undefined ? {} : { area: request.area }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      totalMatches: 0,
      omittedEdgeCount: 0,
      truncationReasons: [],
      sourceRevisions: [],
      edges: [],
    })),
    querySymbols: vi.fn<MemoryKnowledgeSectionInjected['querySymbols']>(async request => ({
      retriever: 'source-symbols-sql',
      version: 2,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.definitionPath === undefined ? {} : { definitionPath: request.definitionPath }),
      ...(request.referencePath === undefined ? {} : { referencePath: request.referencePath }),
      ...(request.referenceKind === undefined ? {} : { referenceKind: request.referenceKind }),
      totalMatches: 0,
      omittedReferenceCount: 0,
      truncationReasons: [],
      sourceRevisions: [],
      edges: [],
    })),
    trace: vi.fn<MemoryKnowledgeSectionInjected['trace']>(async () => ({
      id: overviewValue.records[0]!.id,
      recordType: 'personal-memory',
      title: '长期记忆标题',
      content: 'Trace 完整正文',
      contentTruncated: false,
      status: 'accepted',
      evidence: ['src/example.ts:8 · 12345678'],
      updatedAt: '2026-08-24T00:00:00.000Z',
    })),
    createMemory: vi.fn<MemoryKnowledgeSectionInjected['createMemory']>(async request => ({
      outcome: 'updated',
      record: {
        id: 'mem-018f2e36-6df0-7ac2-8c41-2a374d8e9b10',
        recordType: request.workspaceId === undefined ? 'personal-memory' : 'project-memory',
        title: request.title,
        content: request.content,
        contentTruncated: false,
        tags: request.tags,
        evidenceClass: 'human-verified',
        status: 'active',
        revision: 1,
        kind: request.kind,
        conditions: request.conditions,
        editable: true,
        evidence: [],
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    })),
    updateMemory: vi.fn<MemoryKnowledgeSectionInjected['updateMemory']>(async request => ({
      outcome: 'updated',
      record: {
        id: request.id,
        recordType: request.workspaceId === undefined ? 'personal-memory' : 'project-memory',
        title: request.title,
        content: request.content,
        contentTruncated: false,
        tags: request.tags,
        evidenceClass: 'human-verified',
        status: 'active',
        revision: request.revision + 1,
        kind: request.kind,
        conditions: request.conditions,
        editable: true,
        evidence: [],
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    })),
    setMemoryStatus: vi.fn<MemoryKnowledgeSectionInjected['setMemoryStatus']>(async () => ({ outcome: 'conflict' })),
    review: vi.fn<MemoryKnowledgeSectionInjected['review']>(async () => ({ outcome: 'updated', candidate: { ...overviewValue.candidates[0]!, status: 'accepted' } })),
    promote: vi.fn<MemoryKnowledgeSectionInjected['promote']>(async () => ({ outcome: 'updated', candidate: { ...overviewValue.candidates[0]!, status: 'promoted' } })),
    generate: vi.fn<MemoryKnowledgeSectionInjected['generate']>(async () => ({
      candidateCount: 0,
      skippedCount: 1,
      sourceCount: 0,
      sourceRecordCount: 0,
    })),
    planWiki: vi.fn<MemoryKnowledgeSectionInjected['planWiki']>(async () => ({ run: wikiRunValue })),
    wikiBudgets: vi.fn<MemoryKnowledgeSectionInjected['wikiBudgets']>(async request => ({ runId: request.runId, items: [] })),
    increaseWikiBudget: vi.fn<MemoryKnowledgeSectionInjected['increaseWikiBudget']>(async () => ({ outcome: 'updated' })),
    runWikiTask: vi.fn<MemoryKnowledgeSectionInjected['runWikiTask']>(async () => ({
      run: {
        ...wikiRunValue,
        status: 'verifying',
        tasks: { ...wikiRunValue.tasks, planned: 0, succeeded: 1 },
      },
    })),
    wikiTree: vi.fn<MemoryKnowledgeSectionInjected['wikiTree']>(async request => ({
      runId: request.runId,
      pageCount: 0,
      rootPageIds: [],
      pages: [],
      omittedPageCount: 0,
      omittedClaimCount: 0,
      omittedSourceCount: 0,
    })),
    saveKnowledgeRevision: vi.fn<MemoryKnowledgeSectionInjected['saveKnowledgeRevision']>(async () => ({ outcome: 'conflict' })),
    ...overrides,
  }
  return { injected, value: { ...injected, t } as unknown as MemoryKnowledgeSectionProps }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function selectKnowledgeProject(workspaceId = 'workspace-one'): void {
  fireEvent.click(screen.getByRole('tab', { name: zh.knowledge }))
  fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: workspaceId } })
}

function openKnowledgeAnalysis(workspaceId = 'workspace-one'): void {
  selectKnowledgeProject(workspaceId)
  fireEvent.click(screen.getByRole('button', { name: zh.analysisProgress }))
}

function openSourceDiagnostics(workspaceId = 'workspace-one'): void {
  selectKnowledgeProject(workspaceId)
  fireEvent.click(screen.getByRole('button', { name: zh.sourceDiagnostics }))
}

describe('MemoryKnowledgeSection', () => {
  it('labels candidates extracted automatically from conversation', async () => {
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async () => ({
      ...overviewValue,
      candidates: [{ ...overviewValue.candidates[0]!, suggestedBy: 'conversation' }],
    }))
    render(<MemoryKnowledgeSection {...props({ overview }).value} />)
    expect(await screen.findByText(zh.conversation)).toBeTruthy()
  })

  it('reviews a candidate with the displayed revision and keeps restricted data out of the page', async () => {
    const test = props()
    render(<MemoryKnowledgeSection {...test.value} />)
    expect(await screen.findByText('候选标题')).toBeTruthy()
    expect(screen.getByText('另有 1 条敏感候选，仅可在 CLI 中查看。')).toBeTruthy()
    fireEvent.click(screen.getByText('候选标题').closest('button')!)
    expect(screen.getByText('候选完整正文')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.accept }))
    await waitFor(() => {
      expect(test.injected.review).toHaveBeenCalledWith({
        id: overviewValue.candidates[0]!.id,
        revision: 2,
        decision: 'accept',
      })
    })
  })

  it('opens an exact Recall Trace from the memory library', async () => {
    const test = props()
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    fireEvent.click(screen.getByRole('tab', { name: zh.memory }))
    fireEvent.click(screen.getByRole('button', { name: /长期记忆标题/ }))
    expect(await screen.findByText('Trace 完整正文')).toBeTruthy()
    expect(test.injected.trace).toHaveBeenCalledWith({ id: overviewValue.records[0]!.id })
  })

  it('creates an immediately active memory from the memory library', async () => {
    const createMemory = vi.fn<MemoryKnowledgeSectionInjected['createMemory']>(async request => ({
      outcome: 'updated',
      record: {
        id: 'mem_22222222-2222-4222-8222-222222222222',
        recordType: 'personal-memory',
        title: request.title,
        content: request.content,
        contentTruncated: false,
        tags: request.tags,
        evidenceClass: 'human-verified',
        status: 'active',
        revision: 1,
        kind: request.kind,
        conditions: request.conditions,
        editable: true,
        evidence: [],
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    }))
    const test = props({ createMemory })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')

    fireEvent.click(screen.getByRole('tab', { name: zh.memoryEntries }))
    fireEvent.click(screen.getByRole('button', { name: zh.createMemory }))
    fireEvent.change(screen.getByRole('combobox', { name: zh.memoryKind }), { target: { value: 'method' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.memoryTitle }), { target: { value: '  发布流程  ' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.memoryContent }), { target: { value: '  发布前先运行验证。  ' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.memoryConditions }), { target: { value: '修改插件，准备发布' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.tags }), { target: { value: ' release, 流程 ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveMemory }))

    await waitFor(() => expect(createMemory).toHaveBeenCalledWith({
      kind: 'method',
      title: '发布流程',
      content: '发布前先运行验证。',
      conditions: ['修改插件', '准备发布'],
      tags: ['release', '流程'],
    }))
    expect(await screen.findByText(zh.memoryCreated)).toBeTruthy()
  })

  it('renders separate memory and knowledge tabs with a project-only knowledge browser', async () => {
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      records: request.domain === 'knowledge' ? [knowledgeRecord] : overviewValue.records,
      ...(request.domain === 'knowledge' && request.workspaceId !== undefined ? {
        knowledgeVersion: {
          status: 'draft' as const,
          mode: 'automatic' as const,
          selectionRevision: 1,
          analysisGeneration: 1,
          currentRunId: wikiRunValue.id,
          sourceRunId: wikiRunValue.id,
          humanRevisionCount: 0,
        },
        wikiRuns: [wikiRunValue],
      } : {}),
      ...(request.workspaceId === undefined ? {} : { selectedWorkspaceId: request.workspaceId }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview }).value} />)
    await screen.findByText('候选标题')

    expect(screen.getByRole('tab', { name: zh.memory })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: zh.knowledge }))
    expect(await screen.findByText(zh.selectWorkspaceForKnowledge)).toBeTruthy()
    expect(screen.getByRole('tab', { name: zh.projectWiki })).toBeTruthy()
    expect(screen.getByRole('tab', { name: zh.agentKnowledge })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: zh.wiki })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh.sources })).toBeNull()
    expect(screen.queryByRole('option', { name: zh.personal })).toBeNull()
    expect(screen.getByRole('button', { name: zh.analysisProgress })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.sourceDiagnostics })).toBeTruthy()
    expect(screen.queryByText('长期记忆标题')).toBeNull()
    expect(overview).not.toHaveBeenCalledWith({ domain: 'knowledge' })

    fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: 'workspace-one' } })
    fireEvent.click(screen.getByRole('tab', { name: zh.agentKnowledge }))
    expect(await screen.findByRole('heading', { name: zh.agentKnowledge })).toBeTruthy()
    expect(screen.getByText(zh.agentKnowledgeDraftNotice)).toBeTruthy()
    expect(screen.queryByText('项目知识标题')).toBeNull()
    expect(screen.queryByText(zh.agentKnowledgeLegacyNotice)).toBeNull()
    expect(screen.queryByRole('searchbox', { name: zh.searchKnowledge })).toBeNull()
    expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' })
    expect(screen.queryByText('长期记忆标题')).toBeNull()
  })

  it('uses the effective version run for both human and Agent knowledge views', async () => {
    const activeRun = {
      ...wikiRunValue,
      id: 'wrun_22222222-2222-4222-8222-222222222222',
      status: 'complete' as const,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      ...(request.domain === 'knowledge' ? {
        selectedWorkspaceId: request.workspaceId,
        wikiRuns: [wikiRunValue, activeRun],
        knowledgeVersion: {
          status: 'active' as const,
          mode: 'automatic' as const,
          selectionRevision: 3,
          analysisGeneration: 2,
          currentRunId: wikiRunValue.id,
          sourceRunId: activeRun.id,
          generatedVersionId: 'kgv_11111111-1111-4111-8111-111111111111',
          effectiveVersionId: 'kev_22222222-2222-4222-8222-222222222222',
          humanRevisionCount: 0,
        },
      } : {}),
    }))
    const test = props({ overview })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')

    selectKnowledgeProject()
    expect(await screen.findByText(zh.knowledgeActiveTitle)).toBeTruthy()
    expect(screen.getByText(zh.knowledgeActiveDescription)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wikiTreeView }))
    await waitFor(() => expect(test.injected.wikiTree).toHaveBeenCalledWith({
      workspaceId: 'workspace-one',
      runId: activeRun.id,
    }))

    fireEvent.click(screen.getByRole('tab', { name: zh.agentKnowledge }))
    expect(screen.getByText(zh.agentKnowledgeActiveNotice)).toBeTruthy()
    expect(screen.queryByText(zh.agentKnowledgeDraftNotice)).toBeNull()
  })

  it('saves a Wiki page revision and reloads the same effective content in both knowledge tabs', async () => {
    const activeRun: MemoryUiWikiRunSummary = {
      ...wikiRunValue,
      id: 'wrun_33333333-3333-4333-8333-333333333333',
      status: 'complete',
      rootPageCount: 1,
    }
    const baseEffectiveVersionId = 'kev_33333333-3333-4333-8333-333333333333'
    const revisedEffectiveVersionId = 'kev_44444444-4444-4444-8444-444444444444'
    let revised = false
    const knowledgeVersion = () => ({
      status: 'active' as const,
      mode: revised ? 'fixed' as const : 'automatic' as const,
      selectionRevision: revised ? 4 : 3,
      analysisGeneration: 2,
      currentRunId: activeRun.id,
      sourceRunId: activeRun.id,
      generatedVersionId: 'kgv_33333333-3333-4333-8333-333333333333',
      effectiveVersionId: revised ? revisedEffectiveVersionId : baseEffectiveVersionId,
      humanRevisionCount: revised ? 1 : 0,
    })
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => request.domain === 'knowledge'
      ? { ...overviewValue, selectedWorkspaceId: request.workspaceId, knowledgeVersion: knowledgeVersion(), wikiRuns: [activeRun] }
      : overviewValue)
    const wikiTree = vi.fn<MemoryKnowledgeSectionInjected['wikiTree']>(async request => ({
      runId: request.runId,
      pageCount: 1,
      rootPageIds: ['wpage-editor'],
      pages: [{
        id: 'wpage-editor',
        depth: 0,
        title: revised ? '人工项目入口' : '生成项目入口',
        status: 'verified',
        childCount: 0,
        claimCount: 1,
        claims: [{
          id: 'wclaim-editor',
          kind: 'assertion',
          status: 'verified',
          statement: '生成的项目入口说明。',
          statementTruncated: false,
          sourceCount: 1,
          sources: [{ role: 'supports', path: 'README.md', startLine: 1, endLine: 3 }],
          omittedSourceCount: 0,
          humanReviewPending: revised,
        }],
        omittedClaimCount: 0,
        ...(revised ? {
          bodyRevision: {
            id: 'khr_55555555-5555-4555-8555-555555555555',
            revision: 1,
            kind: 'replace-page-body' as const,
            title: '人工项目入口',
            content: '人工确认后的项目入口说明。',
            createdAt: '2026-09-12T00:00:00.000Z',
          },
        } : {}),
        notes: [],
        omittedNoteCount: 0,
      }],
      omittedPageCount: 0,
      omittedClaimCount: 0,
      omittedSourceCount: 0,
    }))
    const saveKnowledgeRevision = vi.fn<MemoryKnowledgeSectionInjected['saveKnowledgeRevision']>(async () => {
      revised = true
      return {
        outcome: 'updated',
        revision: {
          id: 'khr_55555555-5555-4555-8555-555555555555',
          revision: 1,
          kind: 'replace-page-body',
          title: '人工项目入口',
          content: '人工确认后的项目入口说明。',
          createdAt: '2026-09-12T00:00:00.000Z',
        },
        knowledgeVersion: knowledgeVersion(),
      }
    })
    render(<MemoryKnowledgeSection {...props({ overview, wikiTree, saveKnowledgeRevision }).value} />)
    await screen.findByText('候选标题')
    selectKnowledgeProject()
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiTreeView }))
    expect(await screen.findByText('生成的项目入口说明。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.editWikiPage }))
    fireEvent.change(screen.getByRole('textbox', { name: zh.title }), { target: { value: '人工项目入口' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.wikiHumanBody }), { target: { value: '人工确认后的项目入口说明。' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveWikiRevision }))

    await waitFor(() => expect(saveKnowledgeRevision).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-one',
      requestId: expect.stringMatching(/^khreq_/u),
      expectedSelectionRevision: 3,
      baseEffectiveVersionId,
      pageId: 'wpage-editor',
      kind: 'replace-page-body',
      title: '人工项目入口',
      content: '人工确认后的项目入口说明。',
    })))
    expect(await screen.findByText(zh.wikiRevisionSaved)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiTreeView }))
    expect(await screen.findByText('人工确认后的项目入口说明。')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: zh.agentKnowledge }))
    expect(screen.getByText('人工确认后的项目入口说明。')).toBeTruthy()
    expect(screen.getByText(zh.wikiClaimHumanReviewPending)).toBeTruthy()
  })

  it('associates each tab with its panel and supports arrow-key navigation', async () => {
    render(<MemoryKnowledgeSection {...props().value} />)
    await screen.findByText('候选标题')

    const memory = screen.getByRole('tab', { name: zh.memory })
    const knowledge = screen.getByRole('tab', { name: zh.knowledge })
    expect(memory.getAttribute('aria-controls')).toBe('mk-domain-panel-memory')
    expect(screen.getByRole('tabpanel', { name: zh.memory })).toBeTruthy()

    fireEvent.keyDown(memory, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(knowledge)
    expect(knowledge.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: zh.knowledge })).toBeTruthy()

    const projectWiki = screen.getByRole('tab', { name: zh.projectWiki })
    const agentKnowledge = screen.getByRole('tab', { name: zh.agentKnowledge })
    fireEvent.keyDown(projectWiki, { key: 'End' })
    expect(document.activeElement).toBe(agentKnowledge)
    expect(agentKnowledge.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: zh.agentKnowledge })).toBeTruthy()
  })

  it('does not reopen a Recall Trace after the user closes its pending request', async () => {
    const pending = deferred<MemoryUiTrace | null>()
    const trace = vi.fn<MemoryKnowledgeSectionInjected['trace']>(() => pending.promise)
    render(<MemoryKnowledgeSection {...props({ trace }).value} />)
    await screen.findByText('候选标题')
    fireEvent.click(screen.getByRole('tab', { name: zh.memory }))
    fireEvent.click(screen.getByRole('button', { name: /长期记忆标题/ }))
    fireEvent.click(screen.getByRole('button', { name: zh.closeTrace }))

    await act(async () => {
      pending.resolve({
        id: overviewValue.records[0]!.id,
        recordType: 'personal-memory',
        title: '不应重新出现',
        content: '旧 Trace 正文',
        contentTruncated: false,
        status: 'accepted',
        evidence: [],
        updatedAt: '2026-08-24T00:00:00.000Z',
      })
      await pending.promise
    })

    expect(screen.queryByText('旧 Trace 正文')).toBeNull()
  })

  it('submits a trimmed query and replaces the library with search results', async () => {
    const hit = { ...overviewValue.records[0]!, id: 'mem_search-hit', title: '搜索命中' }
    const search = vi.fn<MemoryKnowledgeSectionInjected['search']>(async () => ({ records: [hit] }))
    const test = props({ search })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    fireEvent.click(screen.getByRole('tab', { name: zh.memory }))
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchMemory }), { target: { value: '  中文  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.searchAction }))

    expect(await screen.findByText('搜索命中')).toBeTruthy()
    expect(search).toHaveBeenCalledWith({ domain: 'memory', query: '中文' })
  })

  it('discards a memory search response after the workspace changes', async () => {
    const pending = deferred<MemoryUiSearchResult>()
    const search = vi.fn<MemoryKnowledgeSectionInjected['search']>(() => pending.promise)
    const scopedOverview = {
      ...overviewValue,
      workspaces: [...overviewValue.workspaces, { id: 'workspace-two', title: '另一个项目' }],
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...scopedOverview,
      ...(request.workspaceId === undefined ? {} : { selectedWorkspaceId: request.workspaceId }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview, search }).value} />)
    await screen.findByText('候选标题')
    fireEvent.click(screen.getByRole('tab', { name: zh.memory }))
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchMemory }), { target: { value: '旧查询' } })
    fireEvent.click(screen.getByRole('button', { name: zh.searchAction }))
    fireEvent.change(screen.getByRole('combobox', { name: zh.memoryScope }), { target: { value: 'workspace-two' } })
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'memory', workspaceId: 'workspace-two' }) })

    await act(async () => {
      pending.resolve({ records: [{ ...overviewValue.records[0]!, id: 'mem_stale', title: '旧项目结果' }] })
      await pending.promise
    })

    expect(screen.queryByText('旧项目结果')).toBeNull()
  })

  it('discards a memory search response after switching to knowledge', async () => {
    const pending = deferred<MemoryUiSearchResult>()
    const search = vi.fn<MemoryKnowledgeSectionInjected['search']>(() => pending.promise)
    render(<MemoryKnowledgeSection {...props({ search }).value} />)
    await screen.findByText('候选标题')
    fireEvent.click(screen.getByRole('tab', { name: zh.memory }))
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchMemory }), { target: { value: '旧查询' } })
    fireEvent.click(screen.getByRole('button', { name: zh.searchAction }))
    expect(search).toHaveBeenCalledWith({ domain: 'memory', query: '旧查询' })

    fireEvent.click(screen.getByRole('tab', { name: zh.knowledge }))
    expect(await screen.findByText(zh.selectWorkspaceForKnowledge)).toBeTruthy()
    await act(async () => {
      pending.resolve({ records: [{ ...overviewValue.records[0]!, id: 'mem_stale-domain', title: '旧域结果' }] })
      await pending.promise
    })

    expect(screen.queryByText('旧域结果')).toBeNull()
  })

  it('shows bounded source inventory and Knowledge Card freshness for a selected project', async () => {
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      projectStatus: {
        omittedSourceCount: 0,
        sources: [{
          id: 'src_11111111-1111-4111-8111-111111111111',
          state: 'ready',
          revision: '1234567890abcdef',
          branch: 'main',
          dirty: true,
          scanMode: 'full',
          reusedFileCount: 0,
          readFileCount: 12,
          fileCount: 12,
          totalBytes: 4_096,
          issueCount: 0,
          understandingState: 'missing',
          sourceEvidenceCount: 4,
        }],
        cards: [{
          id: 'card_11111111-1111-4111-8111-111111111111',
          title: '项目结构',
          canonicalStatus: 'verified',
          state: 'stale',
          reasons: [{ kind: 'file-changed', path: 'src/example.ts' }],
          omittedReasonCount: 0,
        }],
        omittedCardCount: 0,
        staleCardCount: 1,
        degradedCardCount: 0,
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : projectOverview
    ))
    const test = props({ overview })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })
    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.getByText('项目结构')).toBeTruthy()
    expect(screen.getByText(/来源文件内容已变化 · src\/example\.ts/u)).toBeTruthy()
    expect(screen.getByText('4 条可检索证据')).toBeTruthy()
    expect(screen.queryByText('/private/projects/secret-repository')).toBeNull()
  })

  it('searches and visualizes a structured Evidence Pack in project Sources', async () => {
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      projectStatus: {
        omittedSourceCount: 0,
        sources: [{
          id: 'src_11111111-1111-4111-8111-111111111111',
          state: 'ready',
          revision: '1234567890abcdef',
          branch: 'main',
          dirty: false,
          scanMode: 'incremental',
          reusedFileCount: 1,
          readFileCount: 0,
          fileCount: 1,
          totalBytes: 128,
          issueCount: 0,
          understandingState: 'current',
          sourceRecordCount: 1,
          sourceEvidenceCount: 1,
          sourceAreaCount: 1,
          sourceRelationCount: 3,
          sourceInternalRelationCount: 1,
          sourceExternalRelationCount: 1,
          sourceUnresolvedRelationCount: 1,
          sourceOmittedRelationCount: 2,
          understandingHash: `sha256:${'a'.repeat(64)}`,
        }],
        cards: [],
        omittedCardCount: 0,
        staleCardCount: 0,
        degradedCardCount: 0,
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : projectOverview
    ))
    const searchEvidence = vi.fn<MemoryKnowledgeSectionInjected['searchEvidence']>(async request => ({
      retriever: 'source-evidence-fts',
      version: 2,
      query: request.query,
      totalMatches: 1,
      omittedHitCount: 0,
      truncationReasons: [],
      sourceRevisions: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
      }],
      hits: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        path: 'src/example.ts',
        contentHash: `sha256:${'3'.repeat(64)}`,
        area: 'src',
        artifactKind: 'code',
        language: 'TypeScript',
        kind: 'code-symbol',
        detail: 'function',
        exported: true,
        name: 'greeting',
        startLine: 2,
        endLine: 2,
      }],
    }))
    const test = props({ overview, searchEvidence })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })
    fireEvent.change(screen.getByRole('searchbox', { name: zh.evidenceSearch }), { target: { value: '  greeting  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.searchAction }))

    expect(await screen.findByText('greeting')).toBeTruthy()
    expect(screen.getByText('src/example.ts:2')).toBeTruthy()
    expect(screen.getByText(zh.codeSymbol)).toBeTruthy()
    expect(screen.getByText(zh.exportedSymbol)).toBeTruthy()
    expect(screen.getByText('增量复用 1 个，读取 0 个')).toBeTruthy()
    expect(screen.getByText('3 条模块关系（内部 1，外部 1，未解析 1）')).toBeTruthy()
    expect(screen.getByText('另有 2 条模块引用未进入关系图')).toBeTruthy()
    expect(searchEvidence).toHaveBeenCalledWith({ query: 'greeting', workspaceId: 'workspace-one' })
    expect(screen.queryByText('/private/projects/secret-repository')).toBeNull()
  })

  it('loads, filters, and exposes an accessible bounded module relation graph', async () => {
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      projectStatus: {
        omittedSourceCount: 0,
        sources: [],
        cards: [],
        omittedCardCount: 0,
        staleCardCount: 0,
        degradedCardCount: 0,
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : projectOverview
    ))
    const relationPack: MemoryUiRelationPack = {
      retriever: 'source-relations-sql',
      version: 1,
      totalMatches: 3,
      omittedEdgeCount: 0,
      truncationReasons: [],
      sourceRevisions: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        relationProvider: 'deterministic-module-relations',
        relationProviderKey: 'deterministic-module-relations:1:100000',
        relationOutputHash: `sha256:${'3'.repeat(64)}`,
        graphOmittedEdgeCount: 2,
      }],
      edges: [{
        edgeId: '4'.repeat(64),
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        fromPath: 'src/example.ts',
        fromContentHash: `sha256:${'5'.repeat(64)}`,
        toPath: 'src/dependency.ts',
        specifier: './dependency.js',
        kind: 'import',
        resolution: 'internal',
        startLine: 1,
        endLine: 1,
      }, {
        edgeId: '6'.repeat(64),
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        fromPath: 'src/example.ts',
        fromContentHash: `sha256:${'5'.repeat(64)}`,
        specifier: 'react',
        kind: 'import',
        resolution: 'external',
        startLine: 2,
        endLine: 2,
      }, {
        edgeId: '7'.repeat(64),
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        fromPath: 'src/example.ts',
        fromContentHash: `sha256:${'5'.repeat(64)}`,
        specifier: './missing.js',
        kind: 're-export',
        resolution: 'unresolved',
        startLine: 3,
        endLine: 3,
      }],
    }
    const queryRelations = vi.fn<MemoryKnowledgeSectionInjected['queryRelations']>(async request => ({
      ...relationPack,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.area === undefined ? {} : { area: request.area }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(request.kind === undefined ? {} : { kind: request.kind }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview, queryRelations }).value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    expect(await screen.findByRole('img', { name: zh.relationGraph })).toBeTruthy()
    expect(queryRelations).toHaveBeenCalledWith({ workspaceId: 'workspace-one' })
    expect(screen.getByText('关系明细（3 条）')).toBeTruthy()
    expect(screen.getByText('Source 分析预算另有 2 条模块引用未进入持久化关系图。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.relationTextFilter), { target: { value: '  dependency  ' } })
    fireEvent.change(screen.getByLabelText(zh.relationAreaFilter), { target: { value: '  src  ' } })
    fireEvent.change(screen.getByLabelText(zh.relationResolutionFilter), { target: { value: 'internal' } })
    fireEvent.change(screen.getByLabelText(zh.relationKindFilter), { target: { value: 'import' } })
    fireEvent.click(screen.getByRole('button', { name: zh.relationApplyFilters }))
    await waitFor(() => {
      expect(queryRelations).toHaveBeenLastCalledWith({
        workspaceId: 'workspace-one',
        query: 'dependency',
        area: 'src',
        resolution: 'internal',
        kind: 'import',
      })
    })
    expect(screen.queryByText('/private/projects/secret-repository')).toBeNull()
  })

  it('discards a relation graph response after the workspace changes', async () => {
    const pending = deferred<MemoryUiRelationPack>()
    const emptyPack: MemoryUiRelationPack = {
      retriever: 'source-relations-sql',
      version: 1,
      totalMatches: 0,
      omittedEdgeCount: 0,
      truncationReasons: [],
      sourceRevisions: [],
      edges: [],
    }
    const queryRelations = vi.fn<MemoryKnowledgeSectionInjected['queryRelations']>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(emptyPack)
    const projectStatus = {
      omittedSourceCount: 0,
      sources: [],
      cards: [],
      omittedCardCount: 0,
      staleCardCount: 0,
      degradedCardCount: 0,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      workspaces: [...overviewValue.workspaces, { id: 'workspace-two', title: '另一个项目' }],
      ...(request.workspaceId === undefined ? {} : { selectedWorkspaceId: request.workspaceId, projectStatus }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview, queryRelations }).value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })
    await waitFor(() => { expect(queryRelations).toHaveBeenCalledWith({ workspaceId: 'workspace-one' }) })
    fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: 'workspace-two' } })
    await waitFor(() => { expect(queryRelations).toHaveBeenCalledWith({ workspaceId: 'workspace-two' }) })

    await act(async () => {
      pending.resolve({
        ...emptyPack,
        totalMatches: 1,
        sourceRevisions: [],
        edges: [{
          edgeId: '8'.repeat(64),
          sourceId: 'src_11111111-1111-4111-8111-111111111111',
          revision: '1234567890abcdef',
          fromPath: 'src/old-project.ts',
          fromContentHash: `sha256:${'9'.repeat(64)}`,
          specifier: '旧关系',
          kind: 'import',
          resolution: 'external',
          startLine: 1,
          endLine: 1,
        }],
      })
      await pending.promise
    })

    expect(screen.queryByText('旧关系')).toBeNull()
  })

  it('loads, filters, and exposes an accessible bounded symbol definition/reference graph', async () => {
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      projectStatus: {
        omittedSourceCount: 0,
        sources: [],
        cards: [],
        omittedCardCount: 0,
        staleCardCount: 0,
        degradedCardCount: 0,
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : projectOverview
    ))
    const symbolPack: MemoryUiSymbolPack = {
      retriever: 'source-symbols-sql',
      version: 2,
      totalMatches: 1,
      omittedReferenceCount: 0,
      truncationReasons: [],
      sourceRevisions: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        symbolProvider: 'typescript-program-symbols',
        symbolProviderKey: 'typescript-program-symbols:1:test',
        symbolOutputHash: `sha256:${'3'.repeat(64)}`,
        graphOmittedFileCount: 2,
        graphOmittedReferenceCount: 3,
        configMode: 'tsconfig',
        configPaths: ['tsconfig.json'],
        projectReferenceCount: 1,
        pathAliasCount: 2,
        configDiagnosticCount: 1,
        omittedConfigFileCount: 1,
      }],
      edges: [{
        referenceId: '4'.repeat(64),
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        revision: '1234567890abcdef',
        definitionId: `sym_${'5'.repeat(64)}`,
        symbolName: 'greet',
        declaration: 'FunctionDeclaration',
        definitionPath: 'src/model.ts',
        definitionContentHash: `sha256:${'6'.repeat(64)}`,
        definitionStartLine: 2,
        definitionEndLine: 2,
        referencePath: 'src/main.ts',
        referenceContentHash: `sha256:${'7'.repeat(64)}`,
        referenceKind: 'value',
        referenceStartLine: 4,
        referenceEndLine: 4,
      }],
    }
    const querySymbols = vi.fn<MemoryKnowledgeSectionInjected['querySymbols']>(async request => ({
      ...symbolPack,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.definitionPath === undefined ? {} : { definitionPath: request.definitionPath }),
      ...(request.referencePath === undefined ? {} : { referencePath: request.referencePath }),
      ...(request.referenceKind === undefined ? {} : { referenceKind: request.referenceKind }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview, querySymbols }).value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    expect(await screen.findByRole('img', { name: zh.symbolGraph })).toBeTruthy()
    expect(querySymbols).toHaveBeenCalledWith({ workspaceId: 'workspace-one' })
    expect(screen.getByText('符号引用明细（1 条）')).toBeTruthy()
    expect(screen.getByText('Source 分析预算另有 2 个源码文件未进入符号图。')).toBeTruthy()
    expect(screen.getByText('Source 分析预算另有 3 条符号引用未进入持久化图。')).toBeTruthy()
    expect(screen.getByText('1 个 tsconfig，2 个 path alias，1 个 project reference')).toBeTruthy()
    expect(screen.getByText('TypeScript 配置有 1 条诊断，部分 alias 或 project reference 可能未解析。')).toBeTruthy()
    expect(screen.getByText('符号分析配置预算省略 1 个 tsconfig 文件')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.symbolTextFilter), { target: { value: '  greet  ' } })
    fireEvent.change(screen.getByLabelText(zh.symbolDefinitionPathFilter), { target: { value: '  model.ts  ' } })
    fireEvent.change(screen.getByLabelText(zh.symbolReferencePathFilter), { target: { value: '  main.ts  ' } })
    fireEvent.change(screen.getByLabelText(zh.symbolReferenceKindFilter), { target: { value: 'value' } })
    fireEvent.click(screen.getByRole('button', { name: zh.symbolApplyFilters }))
    await waitFor(() => {
      expect(querySymbols).toHaveBeenLastCalledWith({
        workspaceId: 'workspace-one',
        query: 'greet',
        definitionPath: 'model.ts',
        referencePath: 'main.ts',
        referenceKind: 'value',
      })
    })
  })

  it('discards a symbol graph response after the workspace changes', async () => {
    const pending = deferred<MemoryUiSymbolPack>()
    const emptyPack: MemoryUiSymbolPack = {
      retriever: 'source-symbols-sql',
      version: 2,
      totalMatches: 0,
      omittedReferenceCount: 0,
      truncationReasons: [],
      sourceRevisions: [],
      edges: [],
    }
    const querySymbols = vi.fn<MemoryKnowledgeSectionInjected['querySymbols']>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(emptyPack)
    const projectStatus = {
      omittedSourceCount: 0,
      sources: [],
      cards: [],
      omittedCardCount: 0,
      staleCardCount: 0,
      degradedCardCount: 0,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      workspaces: [...overviewValue.workspaces, { id: 'workspace-two', title: '另一个项目' }],
      ...(request.workspaceId === undefined ? {} : { selectedWorkspaceId: request.workspaceId, projectStatus }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview, querySymbols }).value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })
    await waitFor(() => { expect(querySymbols).toHaveBeenCalledWith({ workspaceId: 'workspace-one' }) })
    fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: 'workspace-two' } })
    await waitFor(() => { expect(querySymbols).toHaveBeenCalledWith({ workspaceId: 'workspace-two' }) })

    await act(async () => {
      pending.resolve({
        ...emptyPack,
        totalMatches: 1,
        edges: [{
          referenceId: '8'.repeat(64),
          sourceId: 'src_11111111-1111-4111-8111-111111111111',
          revision: '1234567890abcdef',
          definitionId: `sym_${'9'.repeat(64)}`,
          symbolName: '旧项目符号引用',
          declaration: 'FunctionDeclaration',
          definitionPath: 'src/old-model.ts',
          definitionContentHash: `sha256:${'a'.repeat(64)}`,
          definitionStartLine: 1,
          definitionEndLine: 1,
          referencePath: 'src/old-main.ts',
          referenceContentHash: `sha256:${'b'.repeat(64)}`,
          referenceKind: 'value',
          referenceStartLine: 2,
          referenceEndLine: 2,
        }],
      })
      await pending.promise
    })

    expect(screen.queryByText('旧项目符号引用')).toBeNull()
  })

  it('discards an Evidence Pack response after the workspace changes', async () => {
    const pending = deferred<MemoryUiEvidencePack>()
    const searchEvidence = vi.fn<MemoryKnowledgeSectionInjected['searchEvidence']>(() => pending.promise)
    const workspaces = [...overviewValue.workspaces, { id: 'workspace-two', title: '另一个项目' }]
    const projectStatus = {
      omittedSourceCount: 0,
      sources: [],
      cards: [],
      omittedCardCount: 0,
      staleCardCount: 0,
      degradedCardCount: 0,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      workspaces,
      ...(request.workspaceId === undefined ? {} : { selectedWorkspaceId: request.workspaceId, projectStatus }),
    }))
    render(<MemoryKnowledgeSection {...props({ overview, searchEvidence }).value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })
    fireEvent.change(screen.getByRole('searchbox', { name: zh.evidenceSearch }), { target: { value: '旧项目符号' } })
    fireEvent.click(screen.getByRole('button', { name: zh.searchAction }))
    fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: 'workspace-two' } })
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-two' }) })

    await act(async () => {
      pending.resolve({
        retriever: 'source-evidence-fts',
        version: 2,
        query: '旧项目符号',
        totalMatches: 1,
        omittedHitCount: 0,
        truncationReasons: [],
        sourceRevisions: [],
        hits: [{
          sourceId: 'src_11111111-1111-4111-8111-111111111111',
          revision: '1234567890abcdef',
          path: 'src/old.ts',
          contentHash: `sha256:${'3'.repeat(64)}`,
          area: 'src',
          artifactKind: 'code',
          language: 'TypeScript',
          kind: 'code-symbol',
          detail: 'function',
          exported: true,
          name: '旧项目命中',
          startLine: 2,
          endLine: 2,
        }],
      })
      await pending.promise
    })

    expect(screen.queryByText('旧项目命中')).toBeNull()
  })

  it('generates Knowledge Card candidates from Sources and returns to the review inbox', async () => {
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      projectStatus: {
        omittedSourceCount: 0,
        sources: [{
          id: 'src_11111111-1111-4111-8111-111111111111',
          state: 'ready',
          revision: '1234567890abcdef',
          branch: 'main',
          dirty: false,
          scanMode: 'full',
          reusedFileCount: 0,
          readFileCount: 12,
          fileCount: 12,
          totalBytes: 4_096,
          issueCount: 0,
          understandingState: 'missing',
        }],
        cards: [],
        omittedCardCount: 0,
        staleCardCount: 0,
        degradedCardCount: 0,
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : projectOverview
    ))
    const generate = vi.fn<MemoryKnowledgeSectionInjected['generate']>(async () => ({
      candidateCount: 2,
      skippedCount: 0,
      sourceCount: 1,
      sourceRecordCount: 12,
    }))
    const test = props({ overview, generate })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    openSourceDiagnostics()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })
    fireEvent.click(await screen.findByRole('button', { name: zh.generateCandidates }))

    await waitFor(() => { expect(generate).toHaveBeenCalledWith({ workspaceId: 'workspace-one' }) })
    expect(await screen.findByText('已构建 12 条 Source records，生成或恢复 2 条候选，跳过 0 项。')).toBeTruthy()
    expect(screen.getByRole('tab', { name: zh.memoryCandidates }).getAttribute('aria-selected')).toBe('true')
  })

  it('visualizes bounded Wiki coverage and plans through a Workspace id', async () => {
    const blockedRun: MemoryUiWikiRunSummary = {
      ...wikiRunValue,
      status: 'blocked',
      catalogComplete: false,
      catalogOmittedItemCount: null,
      coverage: { ...wikiRunValue.coverage, pending: 2, blocked: 1 },
      blockingReasons: ['工作树存在未纳入 Catalog 的变更'],
    }
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      wikiRuns: [blockedRun],
      wikiRunHistoryTruncated: true,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : projectOverview
    ))
    const planWiki = vi.fn<MemoryKnowledgeSectionInjected['planWiki']>(async () => ({ run: wikiRunValue }))
    const test = props({ overview, planWiki })
    const rendered = render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    openKnowledgeAnalysis()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    expect(await screen.findByText(zh.wikiOmissionsUnknown)).toBeTruthy()
    expect(screen.getByText('工作树存在未纳入 Catalog 的变更')).toBeTruthy()
    expect(screen.getByText(zh.wikiCompletionBlocked)).toBeTruthy()
    expect(screen.getByText(`${zh.wikiCompletionBusinessQuestions}：${zh.wikiCompletionUnsupported} · 1 项待处理`)).toBeTruthy()
    expect(screen.getByText(zh.wikiHistoryTruncated)).toBeTruthy()
    expect(screen.getByRole('img', { name: '覆盖 4 个项目：已分析 0，排除 1，阻塞 1，陈旧 0。' })).toBeTruthy()
    expect(rendered.container.querySelectorAll('[data-wiki-run-id]')).toHaveLength(1)
    expect(test.injected.wikiBudgets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetShow }))
    expect(await screen.findByText(zh.wikiBudgetEmpty)).toBeTruthy()
    expect(test.injected.wikiBudgets).toHaveBeenCalledWith({ workspaceId: 'workspace-one', runId: blockedRun.id, onlyBlocked: false })
    expect(screen.getByText('任务 0/1 完成，0 运行中，1 待处理，0 失败')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.wikiRunNextTask }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: zh.wikiPlan }))
    await waitFor(() => { expect(planWiki).toHaveBeenCalledWith({ workspaceId: 'workspace-one' }) })
    expect(await screen.findByText('已为 4 个项目创建 Wiki 覆盖计划。')).toBeTruthy()
  })

  it('ignores a Wiki plan response after the knowledge workspace changes', async () => {
    const pending = deferred<Awaited<ReturnType<MemoryKnowledgeSectionInjected['planWiki']>>>()
    const workspaces = [...overviewValue.workspaces, { id: 'workspace-two', title: '另一个项目' }]
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      workspaces,
      ...(request.workspaceId === undefined ? {} : {
        selectedWorkspaceId: request.workspaceId,
        wikiRuns: [wikiRunValue],
      }),
    }))
    const planWiki = vi.fn<MemoryKnowledgeSectionInjected['planWiki']>(() => pending.promise)
    render(<MemoryKnowledgeSection {...props({ overview, planWiki }).value} />)
    await screen.findByText('候选标题')
    openKnowledgeAnalysis()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    fireEvent.click(screen.getByRole('button', { name: zh.wikiPlan }))
    await waitFor(() => { expect(planWiki).toHaveBeenCalledWith({ workspaceId: 'workspace-one' }) })
    fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: 'workspace-two' } })
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-two' }) })

    await act(async () => {
      pending.resolve({ run: { ...wikiRunValue, coverage: { ...wikiRunValue.coverage, itemCount: 99, pending: 98 } } })
      await pending.promise
    })

    expect(screen.queryByText('已为 99 个项目创建 Wiki 覆盖计划。')).toBeNull()
    expect(overview.mock.calls.filter(([request]) => request.workspaceId === 'workspace-two')).toHaveLength(1)
  })

  it('runs the next durable Wiki shard and reports persisted progress', async () => {
    const projectOverview: MemoryUiOverview = {
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      wikiRuns: [wikiRunValue],
      wikiRunHistoryTruncated: false,
    }
    let currentProjectOverview = projectOverview
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => (
      request.workspaceId === undefined ? overviewValue : currentProjectOverview
    ))
    const completedRun: MemoryUiWikiRunSummary = {
      ...wikiRunValue,
      status: 'verifying',
      tasks: { ...wikiRunValue.tasks, taskCount: 2, planned: 1, succeeded: 1 },
      materialRanges: {
        rangeCount: 2,
        totalBytes: 4_096,
        analyzedBytes: 2_048,
        planned: 1,
        running: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
      },
    }
    const runWikiTask = vi.fn<MemoryKnowledgeSectionInjected['runWikiTask']>(async () => {
      currentProjectOverview = { ...projectOverview, wikiRuns: [completedRun] }
      return { run: completedRun }
    })
    const test = props({ overview, runWikiTask })
    render(<MemoryKnowledgeSection {...test.value} />)
    await screen.findByText('候选标题')
    openKnowledgeAnalysis()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiRunNextTask }))
    expect(runWikiTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.wikiRunNextTask }))
    await waitFor(() => { expect(runWikiTask).toHaveBeenCalledWith({ workspaceId: 'workspace-one', dataEgressConfirmed: true }) })
    expect(await screen.findByText('Wiki 任务已推进：完成 1/2。')).toBeTruthy()
    expect(screen.getByText('大文件区间 1/2，已理解 2.0 KiB')).toBeTruthy()
    expect(await screen.findByRole('button', { name: zh.wikiVerifyNextTask })).toBeTruthy()
  })

  it('ignores a Wiki task response after the knowledge workspace changes', async () => {
    const pending = deferred<Awaited<ReturnType<MemoryKnowledgeSectionInjected['runWikiTask']>>>()
    const workspaces = [...overviewValue.workspaces, { id: 'workspace-two', title: '另一个项目' }]
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => ({
      ...overviewValue,
      workspaces,
      ...(request.workspaceId === undefined ? {} : {
        selectedWorkspaceId: request.workspaceId,
        wikiRuns: [wikiRunValue],
      }),
    }))
    const runWikiTask = vi.fn<MemoryKnowledgeSectionInjected['runWikiTask']>(() => pending.promise)
    render(<MemoryKnowledgeSection {...props({ overview, runWikiTask }).value} />)
    await screen.findByText('候选标题')
    openKnowledgeAnalysis()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    fireEvent.click(await screen.findByRole('button', { name: zh.wikiRunNextTask }))
    await waitFor(() => { expect(runWikiTask).toHaveBeenCalledWith({ workspaceId: 'workspace-one', dataEgressConfirmed: true }) })
    fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeProject }), { target: { value: 'workspace-two' } })
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-two' }) })

    await act(async () => {
      pending.resolve({
        run: {
          ...wikiRunValue,
          status: 'verifying',
          tasks: { ...wikiRunValue.tasks, taskCount: 9, planned: 2, succeeded: 7 },
        },
      })
      await pending.promise
    })

    expect(screen.queryByText('Wiki 任务已推进：完成 7/9。')).toBeNull()
    expect(overview.mock.calls.filter(([request]) => request.workspaceId === 'workspace-two')).toHaveLength(1)
  })

  it('shows file-level synthesis progress and a distinct next-task action', async () => {
    const synthesisRun: MemoryUiWikiRunSummary = {
      ...wikiRunValue,
      status: 'analyzing',
      tasks: { ...wikiRunValue.tasks, taskCount: 3, planned: 1, succeeded: 2 },
      fileSynthesis: {
        rulesVersion: 2,
        status: 'running',
        fileCount: 1,
        inputClaimCount: 24,
        taskCount: 2,
        levelCount: 1,
        completeFileCount: 0,
        incompleteFileCount: 0,
        noReductionFileCount: 0,
        levelLimitFileCount: 0,
        limits: { maxClaimsPerTask: 16, maxStatementCharactersPerTask: 64_000, maxLevels: 8 },
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => request.workspaceId === undefined
      ? overviewValue
      : { ...overviewValue, selectedWorkspaceId: 'workspace-one', wikiRuns: [synthesisRun] })
    const runWikiTask = vi.fn<MemoryKnowledgeSectionInjected['runWikiTask']>(async () => ({ run: synthesisRun }))
    render(<MemoryKnowledgeSection {...props({ overview, runWikiTask }).value} />)
    await screen.findByText('候选标题')
    openKnowledgeAnalysis()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    expect(await screen.findByText('文件综合进行中：1 层、2 批，0/1 个文件已完成共同审视')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wikiFileSynthesisNextTask }))
    await waitFor(() => { expect(runWikiTask).toHaveBeenCalledWith({ workspaceId: 'workspace-one', dataEgressConfirmed: true }) })
  })

  it('distinguishes bounded global consistency recall from ordinary Claim verification', async () => {
    const consistencyRun: MemoryUiWikiRunSummary = {
      ...wikiRunValue,
      status: 'verifying',
      tasks: { ...wikiRunValue.tasks, taskCount: 4, planned: 1, succeeded: 3 },
      consistency: {
        rulesVersion: 1,
        planned: true,
        candidatePairCount: 7,
        candidatePairsComplete: false,
        omittedCandidatePairCount: null,
      },
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => request.workspaceId === undefined
      ? overviewValue
      : { ...overviewValue, selectedWorkspaceId: 'workspace-one', wikiRuns: [consistencyRun] })
    const runWikiTask = vi.fn<MemoryKnowledgeSectionInjected['runWikiTask']>(async () => ({ run: consistencyRun }))
    render(<MemoryKnowledgeSection {...props({ overview, runWikiTask }).value} />)
    await screen.findByText('候选标题')
    openKnowledgeAnalysis()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    expect(await screen.findByText('全局候选 7 对，召回有遗漏且数量未知')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wikiConsistencyNextTask }))
    await waitFor(() => { expect(runWikiTask).toHaveBeenCalledWith({ workspaceId: 'workspace-one', dataEgressConfirmed: true }) })
  })

  it('loads a generated Wiki tree explicitly and renders Claim states with sources', async () => {
    const generatedRun: MemoryUiWikiRunSummary = {
      ...wikiRunValue,
      status: 'needs-review',
      tasks: { ...wikiRunValue.tasks, planned: 0, succeeded: 1 },
      consistency: {
        rulesVersion: 1,
        planned: true,
        candidatePairCount: 0,
        candidatePairsComplete: true,
        omittedCandidatePairCount: 0,
      },
      pageGeneration: { rulesVersion: 1, planned: true, claimCount: 1, taskCount: 1 },
      rootPageCount: 1,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async request => request.workspaceId === undefined
      ? overviewValue
      : { ...overviewValue, selectedWorkspaceId: 'workspace-one', wikiRuns: [generatedRun] })
    const wikiTree = vi.fn<MemoryKnowledgeSectionInjected['wikiTree']>(async request => ({
      runId: request.runId,
      pageCount: 2,
      rootPageIds: ['wpage-root'],
      pages: [{
        id: 'wpage-root',
        depth: 0,
        title: 'Wiki',
        status: 'draft',
        childCount: 1,
        claimCount: 0,
        claims: [],
        omittedClaimCount: 0,
        notes: [],
        omittedNoteCount: 0,
      }, {
        id: 'wpage-storage',
        parentId: 'wpage-root',
        depth: 1,
        title: '存储',
        status: 'conflicted',
        childCount: 0,
        claimCount: 1,
        claims: [{
          id: 'wclaim-storage',
          kind: 'assertion',
          status: 'conflicted',
          statement: '数据库配置存在互相矛盾的来源。',
          statementTruncated: false,
          sourceCount: 1,
          sources: [{ role: 'contradicts', path: 'config/storage.yml', startByte: 1_024, endByte: 2_048 }],
          omittedSourceCount: 0,
          humanReviewPending: false,
        }],
        omittedClaimCount: 0,
        notes: [],
        omittedNoteCount: 0,
      }],
      omittedPageCount: 0,
      omittedClaimCount: 0,
      omittedSourceCount: 0,
    }))
    render(<MemoryKnowledgeSection {...props({ overview, wikiTree }).value} />)
    await screen.findByText('候选标题')
    selectKnowledgeProject()
    await waitFor(() => { expect(overview).toHaveBeenCalledWith({ domain: 'knowledge', workspaceId: 'workspace-one' }) })

    fireEvent.click(await screen.findByRole('button', { name: zh.wikiTreeView }))
    await waitFor(() => { expect(wikiTree).toHaveBeenCalledWith({ workspaceId: 'workspace-one', runId: generatedRun.id }) })
    expect(await screen.findByText('数据库配置存在互相矛盾的来源。')).toBeTruthy()
    expect(screen.getByText(zh.wikiClaimConflicted)).toBeTruthy()
    expect(screen.getByText(zh.wikiSourceContradicts)).toBeTruthy()
    expect(screen.getByText('config/storage.yml@1024-2048')).toBeTruthy()
    expect(screen.getByText('此页面只组织子页面，不包含自由摘要。')).toBeTruthy()
  })

  it('names the promoted canonical record according to the candidate target', async () => {
    const cardCandidate = {
      ...overviewValue.candidates[0]!,
      target: 'knowledge-card' as const,
      applicability: 'project' as const,
      kind: 'overview' as const,
      status: 'accepted' as const,
      suggestedBy: 'inventory' as const,
    }
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>(async () => ({
      ...overviewValue,
      selectedWorkspaceId: 'workspace-one',
      candidates: [cardCandidate],
    }))
    const promote = vi.fn<MemoryKnowledgeSectionInjected['promote']>(async () => ({
      outcome: 'updated',
      candidate: { ...cardCandidate, status: 'promoted' },
    }))
    const test = props({ overview, promote })
    render(<MemoryKnowledgeSection {...test.value} />)

    fireEvent.click((await screen.findByText('候选标题')).closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: zh.promote }))

    await waitFor(() => {
      expect(promote).toHaveBeenCalledWith({ id: cardCandidate.id, revision: cardCandidate.revision })
    })
    expect(await screen.findByText(zh.promotedKnowledgeCardToast)).toBeTruthy()
    expect(screen.queryByText(zh.promotedMemoryToast)).toBeNull()
  })

  it('shows a generic load error and retries without exposing transport details', async () => {
    const overview = vi.fn<MemoryKnowledgeSectionInjected['overview']>()
      .mockRejectedValueOnce(new Error('private filesystem detail'))
      .mockResolvedValueOnce(overviewValue)
    const test = props({ overview })
    render(<MemoryKnowledgeSection {...test.value} />)
    expect((await screen.findByRole('alert')).textContent).toContain(zh.loadError)
    expect(screen.queryByText('private filesystem detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(await screen.findByText('候选标题')).toBeTruthy()
    expect(overview).toHaveBeenCalledTimes(2)
  })
})
