import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import {
  KnowledgeEffectiveVersionConflictError,
  KnowledgeHumanRevisionRequestConflictError,
  KnowledgeSelectionRevisionConflictError,
  LocalMemoryRevisionConflictError,
  MemoryCandidateRevisionConflictError,
} from './database.js'
import { isCanonicalStoreAbsent } from './canonical.js'
import type { KnowledgeVersionState } from './knowledge-version.js'
import type { SourceEvidencePack } from './evidence-pack.js'
import type { SourceRelationQueryPack } from './source-relation-query.js'
import type { SourceSymbolQueryPack } from './source-symbol-query.js'
import {
  KnowledgeEffectiveVersionId,
  KnowledgeHumanRevisionRequestId,
  MemoryCandidateId,
  MemoryId,
  MEMORY_ID_PATTERN,
  WikiPageId,
  WikiRunId,
  WikiTaskId,
} from './ids.js'
import type { KnowledgeHumanRevision } from './knowledge-revision.js'
import { WikiMaterialBudgetConflictError } from './wiki-material-budget.js'
import type { ProjectKnowledgeStatus, SourceInventoryBaseline } from './inventory.js'
import type {} from './inventory-service.js'
import type { ProvenanceRef } from './model.js'
import { MEMORY_UI_HOST_CONTRIBUTION } from './remote-contract.js'
import type { LocalMemoryEntry, MemorySearchHit, MemoryTrace, RecallableMemoryRecord, ReviewCandidate } from './runtime-model.js'
import type { SourceUnderstandingSummary } from './source-records.js'
import type {} from './service.js'
import type {} from './wiki-agent-service.js'
import { assessWikiCompletion, type WikiCitation, type WikiPage, type WikiRun } from './wiki-model.js'
import type {
  MemoryUiCandidate,
  MemoryUiEvidencePack,
  MemoryUiEvidenceSearchRequest,
  MemoryUiGenerateRequest,
  MemoryUiGenerateResult,
  MemoryUiMemoryCreateRequest,
  MemoryUiMemoryMutationResult,
  MemoryUiMemoryStatusRequest,
  MemoryUiMemoryUpdateRequest,
  MemoryUiMutationResult,
  MemoryUiKnowledgeVersionSummary,
  MemoryUiKnowledgeRevisionSaveRequest,
  MemoryUiKnowledgeRevisionSaveResult,
  MemoryUiOverview,
  MemoryUiOverviewRequest,
  MemoryUiRelationPack,
  MemoryUiRelationQueryRequest,
  MemoryUiProjectStatus,
  MemoryUiPromoteRequest,
  MemoryUiRecord,
  MemoryUiReviewRequest,
  MemoryUiSearchRequest,
  MemoryUiSearchResult,
  MemoryUiSymbolPack,
  MemoryUiSymbolQueryRequest,
  MemoryUiTrace,
  MemoryUiTraceRequest,
  MemoryUiWorkspace,
  MemoryUiWikiPlanRequest,
  MemoryUiWikiPlanResult,
  MemoryUiWikiRunSummary,
  MemoryUiWikiTaskRunRequest,
  MemoryUiWikiTaskRunResult,
  MemoryUiWikiTreeRequest,
  MemoryUiWikiTreeResult,
  MemoryUiWikiBudgetsRequest, MemoryUiWikiBudgetsResult,
  MemoryUiWikiBudgetIncreaseRequest, MemoryUiWikiBudgetIncreaseResult,
} from './ui-contract.js'

const UI_CONTENT_LIMIT = 20_000
const UI_CANDIDATE_LIMIT = 120
const UI_RECORD_LIMIT = 120
const UI_SEARCH_LIMIT = 30
const UI_SEARCH_CHAR_LIMIT = 60_000
const UI_EVIDENCE_SEARCH_LIMIT = 50
const UI_RELATION_QUERY_LIMIT = 120
const UI_SYMBOL_QUERY_LIMIT = 120
const UI_SOURCE_STATUS_LIMIT = 120
const UI_CARD_STATUS_LIMIT = 120
const UI_FRESHNESS_REASON_LIMIT = 20
const UI_WIKI_RUN_LIMIT = 20
const UI_WIKI_BLOCKING_REASON_LIMIT = 20
const UI_WIKI_BLOCKING_REASON_CHAR_LIMIT = 2_000
const UI_WIKI_PAGE_LIMIT = 100
const UI_WIKI_CLAIM_LIMIT = 200
const UI_WIKI_SOURCE_LIMIT = 400
const UI_WIKI_SOURCES_PER_CLAIM_LIMIT = 8
const UI_WIKI_STATEMENT_CHAR_LIMIT = 1_000
const UI_WIKI_BUDGET_LIMIT = 20

function boundedContent(content: string): { content: string; contentTruncated: boolean } {
  return {
    content: content.slice(0, UI_CONTENT_LIMIT),
    contentTruncated: content.length > UI_CONTENT_LIMIT,
  }
}

function evidenceLabel(reference: ProvenanceRef): string {
  switch (reference.kind) {
    case 'git-file':
      return `${reference.path}${reference.startLine === undefined ? '' : `:${reference.startLine}${reference.endLine === undefined || reference.endLine === reference.startLine ? '' : `-${reference.endLine}`}`} · ${reference.commit.slice(0, 8)}`
    case 'git-commit':
      return `Git commit ${reference.commit.slice(0, 8)}`
    case 'session':
      return `会话证据 · ${reference.eventSeqs.length} 个事件`
    case 'document':
      return reference.path
    default:
      return assertNever(reference)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled provenance: ${JSON.stringify(value)}`)
}

function browserSafeSpecifier(specifier: string): string {
  return specifier.startsWith('/') || specifier.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(specifier)
    ? '[absolute specifier]'
    : specifier
}

/** Host Remote projection for the shared Web/Electron memory browser. */
export class MemoryKnowledgeGateway extends TypertRemoteService {
  static inject = ['memoryKnowledge', 'knowledgeProject', 'wikiGeneration', 'workspaceRegistry', 'typert']

  constructor(ctx: Context) {
    super(ctx, 'memoryKnowledgeUi')
    ctx.typert.register(MEMORY_UI_HOST_CONTRIBUTION)
  }

  /** Read a bounded personal or project browser snapshot. */
  async overview(request: MemoryUiOverviewRequest): Promise<MemoryUiOverview> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = this.resolveWorkspace(request.workspaceId, workspaces)
    if (request.domain === 'knowledge' && workspace === undefined) {
      throw new Error('knowledge browsing requires a workspace')
    }
    const baselines = workspace === undefined
      ? []
      : await this.ctx.memoryKnowledge.listSourceInventoryBaselines(workspace.path)
    const [candidates, records, localMemories, projectStatus, understandings, wikiRuns, knowledgeVersionState] = await Promise.all([
      this.ctx.memoryKnowledge.listCandidates({
        ...(workspace === undefined ? { applicability: 'global' as const } : { projectRoot: workspace.path }),
        limit: UI_CANDIDATE_LIMIT,
      }),
      this.ctx.memoryKnowledge.listRecallable({
        ...(workspace === undefined ? {} : { projectRoot: workspace.path }),
        domain: request.domain,
        scopeMode: 'selected',
        limit: UI_RECORD_LIMIT,
      }),
      request.domain === 'memory'
        ? this.ctx.memoryKnowledge.listLocalMemoryEntries({
            ...(workspace === undefined ? {} : { projectRoot: workspace.path }),
            limit: UI_RECORD_LIMIT,
          })
        : Promise.resolve([]),
      workspace === undefined
        ? Promise.resolve(undefined)
        : this.inspectProjectStatus(workspace, baselines),
      workspace === undefined ? Promise.resolve([]) : this.ctx.memoryKnowledge.listSourceUnderstandings(workspace.path),
      workspace === undefined
        ? Promise.resolve([])
        : this.ctx.memoryKnowledge.listWikiRuns(workspace.path, UI_WIKI_RUN_LIMIT + 1),
      workspace === undefined
        ? Promise.resolve({} as KnowledgeVersionState)
        : this.ctx.memoryKnowledge.getKnowledgeVersionState(workspace.path),
    ])
    const knowledgeVersion = this.projectKnowledgeVersion(knowledgeVersionState)
    let visibleWikiRuns = wikiRuns.slice(0, UI_WIKI_RUN_LIMIT)
    if (workspace !== undefined && knowledgeVersion !== undefined
      && !visibleWikiRuns.some(run => String(run.id) === knowledgeVersion.sourceRunId)) {
      const sourceSnapshot = await this.ctx.memoryKnowledge.getWikiRunSnapshot(WikiRunId(knowledgeVersion.sourceRunId))
      if (sourceSnapshot !== undefined && sourceSnapshot.run.projectRoot === workspace.path) {
        visibleWikiRuns = [sourceSnapshot.run, ...visibleWikiRuns].slice(0, UI_WIKI_RUN_LIMIT)
      }
    }
    return {
      workspaces: workspaces.map(candidate => this.projectWorkspace(candidate)),
      ...(workspace === undefined ? {} : { selectedWorkspaceId: String(workspace.id) }),
      candidates: candidates
        .filter(candidate => candidate.sensitivity === 'normal')
        .map(candidate => this.projectCandidate(candidate, workspaces)),
      records: [
        ...localMemories.filter(entry => entry.sensitivity === 'normal'),
        ...records.filter(record => !localMemories.some(entry => entry.id === record.id)),
      ].slice(0, UI_RECORD_LIMIT).map(record => this.projectRecord(record, workspaces)),
      restrictedCandidateCount: candidates.filter(candidate => candidate.sensitivity === 'restricted').length,
      ...(projectStatus === undefined ? {} : { projectStatus: this.projectKnowledgeStatus(projectStatus, understandings) }),
      ...(workspace === undefined ? {} : {
        ...(knowledgeVersion === undefined ? {} : { knowledgeVersion }),
        wikiRuns: visibleWikiRuns.map(run => this.projectWikiRun(run)),
        wikiRunHistoryTruncated: wikiRuns.length > visibleWikiRuns.length,
      }),
    }
  }

  private async inspectProjectStatus(
    workspace: Workspace,
    baselines: readonly SourceInventoryBaseline[],
  ): Promise<ProjectKnowledgeStatus | undefined> {
    try {
      return await this.ctx.knowledgeProject.inspect(workspace.path, { baselines })
    } catch (error: unknown) {
      if (isCanonicalStoreAbsent(error, workspace.path)) return undefined
      throw error
    }
  }

  /** Build a project catalog and persist one browser-safe Wiki coverage plan. */
  async planWiki(request: MemoryUiWikiPlanRequest, signal: AbortSignal): Promise<MemoryUiWikiPlanResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Wiki planning requires a workspace')
    const result = await this.ctx.memoryKnowledge.planWikiProject(workspace.path, signal)
    return { run: this.projectWikiRun(result.run.run) }
  }

  /** Execute or resume at most one durable Wiki shard task for a registered workspace. */
  async runWikiTask(request: MemoryUiWikiTaskRunRequest, signal: AbortSignal): Promise<MemoryUiWikiTaskRunResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Wiki task execution requires a workspace')
    const result = await this.ctx.wikiGeneration.runNext(
      workspace.path,
      { dataEgressConfirmed: request.dataEgressConfirmed },
      signal,
    )
    return { run: this.projectWikiRun(result.run) }
  }

  /** 查询项目内一页已记账任务，不加载源码或完整 Coverage。
   * @param request 已注册 Workspace、Run 和游标。
   * @returns 最多 20 条账本及下一页游标。
   */
  async wikiBudgets(request: MemoryUiWikiBudgetsRequest): Promise<MemoryUiWikiBudgetsResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Wiki 预算查看需要项目')
    const page = await this.ctx.memoryKnowledge.listWikiMaterialReadBudgets({
      projectRoot: workspace.path, runId: WikiRunId(request.runId), onlyBlocked: request.onlyBlocked,
      limit: UI_WIKI_BUDGET_LIMIT,
      ...(request.afterTaskId === undefined ? {} : { afterTaskId: WikiTaskId(request.afterTaskId) }),
    })
    return {
      runId: request.runId,
      items: page.items.map(({ budget, kind, status, budgetHash }) => ({
        taskId: String(budget.taskId), kind, status, budgetHash,
        limitBytes: budget.limitBytes, reservedBytes: budget.reservedBytes,
        reservationCount: budget.reservationCount, blockedReadBytes: budget.blockedReadBytes,
        startedAt: budget.startedAt, startedAtAttempt: budget.startedAtAttempt,
      })),
      ...(page.nextAfterTaskId === undefined ? {} : { nextAfterTaskId: String(page.nextAfterTaskId) }),
    }
  }

  /** 提交操作者核对后的扩额；不执行模型或清除消耗。
   * @param request 项目、任务、新总额度和确认时的账本 hash。
   * @returns 更新成功或需要重新确认的版本冲突。
   */
  async increaseWikiBudget(request: MemoryUiWikiBudgetIncreaseRequest): Promise<MemoryUiWikiBudgetIncreaseResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Wiki 扩额需要项目')
    try {
      await this.ctx.memoryKnowledge.increaseWikiMaterialReadBudget(
        { runId: WikiRunId(request.runId), taskId: WikiTaskId(request.taskId) }, request.limitBytes,
        { projectRoot: workspace.path, expectedBudgetHash: request.expectedBudgetHash },
      )
    } catch (error: unknown) {
      if (error instanceof WikiMaterialBudgetConflictError) return { outcome: 'conflict' }
      throw error
    }
    return { outcome: 'updated' }
  }

  /** Read one bounded generated Page tree without exposing project roots or Agent Sessions. */
  async wikiTree(request: MemoryUiWikiTreeRequest): Promise<MemoryUiWikiTreeResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Wiki tree requires a workspace')
    const snapshot = await this.ctx.memoryKnowledge.getWikiRunSnapshot(WikiRunId(request.runId))
    if (snapshot === undefined || snapshot.run.projectRoot !== workspace.path) {
      throw new Error('Wiki tree Run does not belong to this workspace')
    }
    const versionState = await this.ctx.memoryKnowledge.getKnowledgeVersionState(workspace.path)
    const effective = versionState.effectiveVersion
    const includedRevisionIds = effective?.runId === snapshot.run.id
      ? new Set(effective.humanRevisionIds.map(String))
      : new Set<string>()
    const humanRevisions = includedRevisionIds.size === 0
      ? []
      : (await this.ctx.memoryKnowledge.listKnowledgeHumanRevisions(workspace.path, 200))
        .filter(revision => includedRevisionIds.has(String(revision.id)))
    const pages = snapshot.pages.filter(page => page.legacy !== true)
    const pageById = new Map(pages.map(page => [String(page.id), page]))
    const claimById = new Map(snapshot.claims.map(claim => [String(claim.id), claim]))
    const citationById = new Map(snapshot.citations.map(citation => [String(citation.id), citation]))
    const rangeById = new Map(snapshot.tasks.flatMap(task => task.materialRanges)
      .map(range => [String(range.id), range]))
    const sourceFor = (citation: WikiCitation): MemoryUiWikiTreeResult['pages'][number]['claims'][number]['sources'][number] | undefined => {
      const provenance = citation.provenance
      if (provenance.kind !== 'git-file' && provenance.kind !== 'document') return undefined
      const range = citation.rangeId === undefined ? undefined : rangeById.get(String(citation.rangeId))
      return {
        role: citation.role,
        path: provenance.path,
        ...(provenance.kind !== 'git-file' || provenance.startLine === undefined
          ? {}
          : { startLine: provenance.startLine, endLine: provenance.endLine }),
        ...(range === undefined ? {} : { startByte: range.startByte, endByte: range.endByte }),
      }
    }
    const allPageClaimIds = pages.flatMap(page => page.claimIds.map(String))
    const totalSourceCount = allPageClaimIds.reduce((total, id) => {
      const claim = claimById.get(id)
      return total + (claim?.citationIds
        .map(citationId => citationById.get(String(citationId)))
        .filter((citation): citation is WikiCitation => citation !== undefined && sourceFor(citation) !== undefined)
        .length ?? 0)
    }, 0)
    const queue: Array<{ page: WikiPage; parentId?: string; depth: number }> = snapshot.run.rootPageIds.flatMap(id => {
      const page = pageById.get(String(id))
      return page === undefined ? [] : [{ page, depth: 0 }]
    })
    const projected: MemoryUiWikiTreeResult['pages'] = []
    const visited = new Set<string>()
    let projectedClaimCount = 0
    let projectedSourceCount = 0
    while (queue.length > 0 && projected.length < UI_WIKI_PAGE_LIMIT) {
      const current = queue.shift()!
      if (visited.has(String(current.page.id))) continue
      visited.add(String(current.page.id))
      const claims = current.page.claimIds.slice(0, Math.max(0, UI_WIKI_CLAIM_LIMIT - projectedClaimCount))
        .map(id => claimById.get(String(id)))
        .filter((claim): claim is NonNullable<typeof claim> => claim !== undefined)
        .map(claim => {
          const available = claim.citationIds.map(id => citationById.get(String(id)))
            .filter((citation): citation is WikiCitation => citation !== undefined)
            .flatMap(citation => {
              const source = sourceFor(citation)
              return source === undefined ? [] : [source]
            })
          const sourceBudget = Math.min(
            UI_WIKI_SOURCES_PER_CLAIM_LIMIT,
            Math.max(0, UI_WIKI_SOURCE_LIMIT - projectedSourceCount),
          )
          const sources = available.slice(0, sourceBudget)
          projectedSourceCount += sources.length
          return {
            id: String(claim.id),
            kind: claim.kind,
            status: claim.status,
            statement: claim.statement.slice(0, UI_WIKI_STATEMENT_CHAR_LIMIT),
            statementTruncated: claim.statement.length > UI_WIKI_STATEMENT_CHAR_LIMIT,
            sourceCount: available.length,
            sources,
            omittedSourceCount: available.length - sources.length,
            humanReviewPending: humanRevisions.some(revision => revision.kind === 'replace-page-body'
              && revision.pageId === current.page.id && revision.affectedClaimIds.includes(claim.id)),
          }
        })
      projectedClaimCount += claims.length
      const pageRevisions = humanRevisions.filter(revision => revision.pageId === current.page.id)
      const bodyRevision = pageRevisions.find(revision => revision.kind === 'replace-page-body')
      const allNotes = pageRevisions.filter(revision => revision.kind === 'append-page-note')
      const notes = allNotes.slice(0, 20)
      projected.push({
        id: String(current.page.id),
        ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
        depth: current.depth,
        title: bodyRevision?.title ?? current.page.title,
        status: current.page.status,
        childCount: current.page.childPageIds.length,
        claimCount: current.page.claimIds.length,
        claims,
        omittedClaimCount: current.page.claimIds.length - claims.length,
        ...(bodyRevision === undefined ? {} : { bodyRevision: this.projectKnowledgeHumanRevision(bodyRevision) }),
        notes: notes.map(revision => this.projectKnowledgeHumanRevision(revision)),
        omittedNoteCount: allNotes.length - notes.length,
      })
      for (const childId of current.page.childPageIds) {
        const child = pageById.get(String(childId))
        if (child !== undefined) queue.push({ page: child, parentId: String(current.page.id), depth: current.depth + 1 })
      }
    }
    return {
      runId: String(snapshot.run.id),
      pageCount: pages.length,
      rootPageIds: snapshot.run.rootPageIds.map(String).filter(id => visited.has(id)),
      pages: projected,
      omittedPageCount: pages.length - projected.length,
      omittedClaimCount: allPageClaimIds.length - projectedClaimCount,
      omittedSourceCount: totalSourceCount - projectedSourceCount,
    }
  }

  /** Save one operator edit while preserving the immutable generated Wiki snapshot. */
  async saveKnowledgeRevision(
    request: MemoryUiKnowledgeRevisionSaveRequest,
  ): Promise<MemoryUiKnowledgeRevisionSaveResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('knowledge revision requires a workspace')
    try {
      const result = await this.ctx.memoryKnowledge.applyKnowledgeHumanRevision({
        requestId: KnowledgeHumanRevisionRequestId(request.requestId),
        projectRoot: workspace.path,
        expectedSelectionRevision: request.expectedSelectionRevision,
        baseEffectiveVersionId: KnowledgeEffectiveVersionId(request.baseEffectiveVersionId),
        pageId: WikiPageId(request.pageId),
        kind: request.kind,
        ...(request.title === undefined ? {} : { title: request.title }),
        content: request.content,
      })
      const knowledgeVersion = this.projectKnowledgeVersion({
        selection: result.selection,
        effectiveVersion: result.effectiveVersion,
      })
      if (knowledgeVersion === undefined) throw new Error('knowledge revision did not produce an effective version')
      return {
        outcome: 'updated',
        revision: this.projectKnowledgeHumanRevision(result.revision),
        knowledgeVersion,
      }
    } catch (error: unknown) {
      if (error instanceof KnowledgeSelectionRevisionConflictError
        || error instanceof KnowledgeEffectiveVersionConflictError
        || error instanceof KnowledgeHumanRevisionRequestConflictError) {
        return { outcome: 'conflict' }
      }
      throw error
    }
  }

  /** Search normal-sensitivity recall data in one bounded scope. */
  async search(request: MemoryUiSearchRequest, signal: AbortSignal): Promise<MemoryUiSearchResult> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = this.resolveWorkspace(request.workspaceId, workspaces)
    if (request.domain === 'knowledge' && workspace === undefined) {
      throw new Error('knowledge search requires a workspace')
    }
    const hits = await this.ctx.memoryKnowledge.search({
      query: request.query,
      ...(workspace === undefined ? {} : { projectRoot: workspace.path }),
      domain: request.domain,
      scopeMode: 'selected',
      limit: UI_SEARCH_LIMIT,
      maxChars: UI_SEARCH_CHAR_LIMIT,
      signal,
    })
    return { records: hits.map(hit => this.projectRecord(hit, workspaces)) }
  }

  /** Search one registered workspace's portable Source evidence index. */
  async searchEvidence(request: MemoryUiEvidenceSearchRequest, signal: AbortSignal): Promise<MemoryUiEvidencePack> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Source evidence search requires a workspace')
    return this.projectEvidencePack(await this.ctx.memoryKnowledge.searchSourceEvidence({
      projectRoot: workspace.path,
      query: request.query,
      limit: UI_EVIDENCE_SEARCH_LIMIT,
      signal,
    }))
  }

  /** Query one registered workspace's bounded current module relation graph. */
  async queryRelations(request: MemoryUiRelationQueryRequest, signal: AbortSignal): Promise<MemoryUiRelationPack> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Source relation query requires a workspace')
    return this.projectRelationPack(await this.ctx.memoryKnowledge.querySourceRelations({
      projectRoot: workspace.path,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.area === undefined ? {} : { area: request.area }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      limit: UI_RELATION_QUERY_LIMIT,
      signal,
    }))
  }

  /** Query one registered workspace's bounded current symbol definition/reference graph. */
  async querySymbols(request: MemoryUiSymbolQueryRequest, signal: AbortSignal): Promise<MemoryUiSymbolPack> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('Source symbol query requires a workspace')
    return this.projectSymbolPack(await this.ctx.memoryKnowledge.querySourceSymbols({
      projectRoot: workspace.path,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.definitionPath === undefined ? {} : { definitionPath: request.definitionPath }),
      ...(request.referencePath === undefined ? {} : { referencePath: request.referencePath }),
      ...(request.referenceKind === undefined ? {} : { referenceKind: request.referenceKind }),
      limit: UI_SYMBOL_QUERY_LIMIT,
      signal,
    }))
  }

  /** Read one exact normal-sensitivity trace without local paths or raw Session ids. */
  async trace(request: MemoryUiTraceRequest): Promise<MemoryUiTrace | null> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = this.resolveWorkspace(request.workspaceId, workspaces)
    if (new RegExp(MEMORY_ID_PATTERN, 'u').test(request.id)) {
      const memory = await this.ctx.memoryKnowledge.getLocalMemoryEntry(MemoryId(request.id), workspace?.path)
      if (memory !== undefined) {
        if (memory.sensitivity === 'restricted' || memory.projectRoot !== workspace?.path) return null
        const history = await this.ctx.memoryKnowledge.listLocalMemoryRevisions(memory.id, workspace?.path, 50)
        return {
          id: String(memory.id),
          recordType: memory.applicability === 'global' ? 'personal-memory' : 'project-memory',
          title: memory.title,
          ...boundedContent(memory.content),
          status: memory.status,
          revision: memory.revision,
          kind: memory.kind,
          conditions: [...memory.conditions],
          tags: [...memory.tags],
          editable: true,
          history: history.map(revision => ({
            revision: revision.entry.revision,
            kind: revision.kind,
            status: revision.entry.status,
            title: revision.entry.title,
            updatedAt: revision.entry.updatedAt,
          })),
          evidence: memory.provenance.map(evidenceLabel),
          ...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspaceTitle: workspace.title }),
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        }
      }
    }
    const trace = await this.ctx.memoryKnowledge.trace(request.id, workspace?.path)
    if (trace === undefined || trace.sensitivity === 'restricted' || trace.projectRoot !== workspace?.path) return null
    return this.projectTrace(trace, workspaces)
  }

  /** Create an immediately active personal or project memory without a candidate review step. */
  async createMemory(request: MemoryUiMemoryCreateRequest): Promise<MemoryUiMemoryMutationResult> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = this.resolveWorkspace(request.workspaceId, workspaces)
    const entry = await this.ctx.memoryKnowledge.createLocalMemoryEntry({
      applicability: workspace === undefined ? 'global' : 'project',
      ...(workspace === undefined ? {} : { projectRoot: workspace.path }),
      kind: request.kind,
      title: request.title,
      content: request.content,
      conditions: request.conditions,
      tags: request.tags,
      sensitivity: 'normal',
      provenance: [],
    })
    return { outcome: 'updated', record: this.projectRecord(entry, workspaces) }
  }

  /** Save a guarded local-memory content revision without invoking an LLM. */
  async updateMemory(request: MemoryUiMemoryUpdateRequest): Promise<MemoryUiMemoryMutationResult> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = this.resolveWorkspace(request.workspaceId, workspaces)
    const id = MemoryId(request.id)
    const current = await this.ctx.memoryKnowledge.getLocalMemoryEntry(id, workspace?.path)
    if (current === undefined || current.sensitivity === 'restricted') throw new Error('local memory is unavailable')
    try {
      const entry = await this.ctx.memoryKnowledge.updateLocalMemoryEntry(id, {
        title: request.title,
        content: request.content,
        kind: request.kind,
        conditions: request.conditions,
        tags: request.tags,
        sensitivity: current.sensitivity,
        supersedes: current.supersedes,
        conflictsWith: current.conflictsWith,
      }, request.revision, workspace?.path)
      return { outcome: 'updated', record: this.projectRecord(entry, workspaces) }
    } catch (error: unknown) {
      if (error instanceof LocalMemoryRevisionConflictError) return { outcome: 'conflict' }
      throw error
    }
  }

  /** Apply a guarded local-memory lifecycle transition. */
  async setMemoryStatus(request: MemoryUiMemoryStatusRequest): Promise<MemoryUiMemoryMutationResult> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = this.resolveWorkspace(request.workspaceId, workspaces)
    const id = MemoryId(request.id)
    const current = await this.ctx.memoryKnowledge.getLocalMemoryEntry(id, workspace?.path)
    if (current === undefined || current.sensitivity === 'restricted') throw new Error('local memory is unavailable')
    try {
      const entry = await this.ctx.memoryKnowledge.setLocalMemoryEntryStatus(
        id, request.status, request.revision, workspace?.path,
      )
      return { outcome: 'updated', record: this.projectRecord(entry, workspaces) }
    } catch (error: unknown) {
      if (error instanceof LocalMemoryRevisionConflictError) return { outcome: 'conflict' }
      throw error
    }
  }

  /** Apply an accept/reject decision guarded by the displayed revision. */
  async review(request: MemoryUiReviewRequest): Promise<MemoryUiMutationResult> {
    try {
      const candidate = await this.ctx.memoryKnowledge.reviewCandidate(
        MemoryCandidateId(request.id),
        request.decision,
        request.revision,
      )
      return { outcome: 'updated', candidate: this.projectCandidate(candidate, this.ctx.workspaceRegistry.list()) }
    } catch (error: unknown) {
      if (error instanceof MemoryCandidateRevisionConflictError) return { outcome: 'conflict' }
      throw error
    }
  }

  /** Generate deterministic Knowledge Card candidates for one registered workspace. */
  async generate(request: MemoryUiGenerateRequest): Promise<MemoryUiGenerateResult> {
    const workspace = this.resolveWorkspace(request.workspaceId, this.ctx.workspaceRegistry.list())
    if (workspace === undefined) throw new Error('candidate generation requires a workspace')
    const result = await this.ctx.memoryKnowledge.generateKnowledgeCardCandidates(workspace.path)
    return {
      candidateCount: result.candidates.length,
      skippedCount: result.skipped.length,
      sourceCount: result.understandings.length,
      sourceRecordCount: result.understandings.reduce((sum, item) => sum + item.recordCount, 0),
    }
  }

  /** Promote an accepted candidate into its project, or an explicit target for global memory. */
  async promote(request: MemoryUiPromoteRequest): Promise<MemoryUiMutationResult> {
    const id = MemoryCandidateId(request.id)
    const current = await this.ctx.memoryKnowledge.getCandidate(id)
    if (current === undefined) throw new Error('memory candidate is unavailable')
    const workspaces = this.ctx.workspaceRegistry.list()
    const target = current.applicability === 'global'
      ? this.resolveWorkspace(request.workspaceId, workspaces)
      : undefined
    if (current.applicability === 'global' && target === undefined) {
      throw new Error('global memory promotion requires a workspace')
    }
    try {
      const promoted = await this.ctx.memoryKnowledge.promoteCandidate(
        id,
        target?.path,
        request.revision,
      )
      return {
        outcome: 'updated',
        candidate: this.projectCandidate(promoted.candidate, workspaces),
        promotedRecordId: String(promoted.recordType === 'memory' ? promoted.memory.id : promoted.card.id),
      }
    } catch (error: unknown) {
      if (error instanceof MemoryCandidateRevisionConflictError) return { outcome: 'conflict' }
      throw error
    }
  }

  private resolveWorkspace(id: string | undefined, workspaces: readonly Workspace[]): Workspace | undefined {
    if (id === undefined) return undefined
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(id))
    if (workspace === undefined || !workspaces.some(candidate => candidate.id === workspace.id)) {
      throw new Error('workspace is unavailable')
    }
    return workspace
  }

  private projectWorkspace(workspace: Workspace): MemoryUiWorkspace {
    return { id: String(workspace.id), title: workspace.title }
  }

  private projectKnowledgeStatus(
    status: ProjectKnowledgeStatus,
    understandings: readonly SourceUnderstandingSummary[],
  ): MemoryUiProjectStatus {
    const understandingBySource = new Map(understandings.map(value => [String(value.sourceId), value]))
    const sources = status.sources.slice(0, UI_SOURCE_STATUS_LIMIT)
    const cards = status.cards.slice(0, UI_CARD_STATUS_LIMIT)
    return {
      sources: sources.map(source => ({
        ...(() => {
          const understanding = understandingBySource.get(String(source.sourceId))
          const understandingState = understanding === undefined
            ? 'missing' as const
            : understanding.inventoryHash === source.inventoryHash ? 'current' as const : 'stale' as const
          return {
            understandingState,
            ...(understanding === undefined ? {} : {
              sourceRecordCount: understanding.recordCount,
              sourceEvidenceCount: understanding.evidenceCount,
              sourceAreaCount: understanding.areaCount,
              sourceRelationCount: understanding.relationCount,
              sourceInternalRelationCount: understanding.internalRelationCount,
              sourceExternalRelationCount: understanding.externalRelationCount,
              sourceUnresolvedRelationCount: understanding.unresolvedRelationCount,
              sourceOmittedRelationCount: understanding.omittedRelationCount,
              sourceSymbolDefinitionCount: understanding.symbolDefinitionCount,
              sourceSymbolReferenceCount: understanding.symbolReferenceCount,
              sourceOmittedSymbolFileCount: understanding.omittedSymbolFileCount,
              sourceOmittedSymbolReferenceCount: understanding.omittedSymbolReferenceCount,
              sourceSymbolConfigMode: understanding.symbolConfigMode,
              sourceSymbolConfigFileCount: understanding.symbolConfigFileCount,
              sourceSymbolProjectReferenceCount: understanding.symbolProjectReferenceCount,
              sourceSymbolPathAliasCount: understanding.symbolPathAliasCount,
              sourceSymbolConfigDiagnosticCount: understanding.symbolConfigDiagnosticCount,
              sourceOmittedSymbolConfigFileCount: understanding.omittedSymbolConfigFileCount,
              understandingHash: understanding.outputHash,
            }),
          }
        })(),
        id: String(source.sourceId),
        state: source.state,
        ...(source.commit === undefined ? {} : { revision: source.commit }),
        ...(source.branch === undefined ? {} : { branch: source.branch }),
        dirty: source.dirty,
        scanMode: source.scanMode,
        reusedFileCount: source.reusedFileCount,
        readFileCount: source.readFileCount,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
        issueCount: source.issues.length,
      })),
      omittedSourceCount: status.sources.length - sources.length,
      cards: cards.map(card => ({
        id: String(card.cardId),
        title: card.title,
        canonicalStatus: card.canonicalStatus,
        state: card.state,
        reasons: card.reasons.slice(0, UI_FRESHNESS_REASON_LIMIT).map(reason => ({
          kind: reason.kind,
          ...(reason.path === undefined ? {} : { path: reason.path }),
        })),
        omittedReasonCount: Math.max(0, card.reasons.length - UI_FRESHNESS_REASON_LIMIT),
      })),
      omittedCardCount: status.cards.length - cards.length,
      staleCardCount: status.staleCardCount,
      degradedCardCount: status.degradedCardCount,
    }
  }

  private projectWikiRun(run: WikiRun): MemoryUiWikiRunSummary {
    const blockingReasons = run.blockingReasons.slice(0, UI_WIKI_BLOCKING_REASON_LIMIT)
    return {
      id: String(run.id),
      status: run.status,
      catalogHash: run.catalogHash,
      catalogComplete: run.catalogComplete,
      catalogOmittedItemCount: run.catalogOmittedItemCount,
      coverage: { ...run.coverage },
      materialRanges: { ...run.materialRanges },
      tasks: { ...run.tasks },
      fileSynthesis: { ...run.fileSynthesis },
      consistency: { ...run.consistency },
      pageGeneration: { ...run.pageGeneration },
      completion: assessWikiCompletion(run),
      rootPageCount: run.rootPageIds.length,
      blockingReasons: blockingReasons.map(reason => reason.slice(0, UI_WIKI_BLOCKING_REASON_CHAR_LIMIT)),
      omittedBlockingReasonCount: run.blockingReasons.length - blockingReasons.length,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    }
  }

  private projectKnowledgeVersion(state: KnowledgeVersionState): MemoryUiKnowledgeVersionSummary | undefined {
    const selection = state.selection
    if (selection?.currentRunId === undefined) return undefined
    const effective = state.effectiveVersion
    return {
      status: effective === undefined ? 'draft' : 'active',
      mode: selection.mode,
      selectionRevision: selection.revision,
      analysisGeneration: selection.analysisGeneration,
      currentRunId: String(selection.currentRunId),
      sourceRunId: String(effective?.runId ?? selection.currentRunId),
      ...(state.generatedVersion === undefined ? {} : { generatedVersionId: String(state.generatedVersion.id) }),
      ...(effective === undefined ? {} : { effectiveVersionId: String(effective.id) }),
      humanRevisionCount: effective?.humanRevisionIds.length ?? 0,
    }
  }

  private projectKnowledgeHumanRevision(revision: KnowledgeHumanRevision): MemoryUiWikiTreeResult['pages'][number]['notes'][number] {
    return {
      id: String(revision.id),
      revision: revision.revision,
      kind: revision.kind,
      ...(revision.title === undefined ? {} : { title: revision.title }),
      content: revision.content,
      createdAt: revision.createdAt,
    }
  }

  private workspaceForPath(path: string | undefined, workspaces: readonly Workspace[]): Workspace | undefined {
    return path === undefined ? undefined : workspaces.find(workspace => workspace.path === path)
  }

  private projectCandidate(candidate: ReviewCandidate, workspaces: readonly Workspace[]): MemoryUiCandidate {
    const workspace = this.workspaceForPath(candidate.projectRoot, workspaces)
    return {
      id: String(candidate.id),
      revision: candidate.revision,
      target: candidate.target,
      applicability: candidate.applicability,
      kind: candidate.kind,
      title: candidate.title,
      ...boundedContent(candidate.content),
      tags: [...candidate.tags],
      status: candidate.status,
      suggestedBy: candidate.suggestedBy,
      evidence: candidate.provenance.map(evidenceLabel),
      ...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspaceTitle: workspace.title }),
      updatedAt: candidate.updatedAt,
    }
  }

  private projectRecord(
    record: LocalMemoryEntry | RecallableMemoryRecord | MemorySearchHit,
    workspaces: readonly Workspace[],
  ): MemoryUiRecord {
    const workspace = this.workspaceForPath(record.projectRoot, workspaces)
    if ('applicability' in record) {
      return {
        id: String(record.id),
        recordType: record.applicability === 'global' ? 'personal-memory' : 'project-memory',
        title: record.title,
        ...boundedContent(record.content),
        tags: [...record.tags],
        evidenceClass: 'human-verified',
        status: record.status,
        revision: record.revision,
        kind: record.kind,
        conditions: [...record.conditions],
        editable: true,
        evidence: record.provenance.map(evidenceLabel),
        ...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspaceTitle: workspace.title }),
        updatedAt: record.updatedAt,
      }
    }
    return {
      id: String(record.id),
      recordType: record.recordType,
      title: record.title,
      ...boundedContent(record.content),
      tags: [...record.tags],
      evidenceClass: record.evidenceClass,
      status: 'status' in record ? record.status : 'verified',
      editable: false,
      evidence: record.provenance.map(evidenceLabel),
      ...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspaceTitle: workspace.title }),
      updatedAt: record.updatedAt,
    }
  }

  private projectTrace(trace: MemoryTrace, workspaces: readonly Workspace[]): MemoryUiTrace {
    const workspace = this.workspaceForPath(trace.projectRoot, workspaces)
    return {
      id: String(trace.id),
      recordType: trace.recordType,
      title: trace.title,
      ...boundedContent(trace.content),
      status: trace.status,
      evidence: trace.provenance.map(evidenceLabel),
      ...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspaceTitle: workspace.title }),
      ...(trace.createdAt === undefined ? {} : { createdAt: trace.createdAt }),
      updatedAt: trace.updatedAt,
    }
  }

  private projectEvidencePack(pack: SourceEvidencePack): MemoryUiEvidencePack {
    return {
      retriever: pack.retriever,
      version: pack.version,
      query: pack.query,
      totalMatches: pack.totalMatches,
      omittedHitCount: pack.omittedHitCount,
      truncationReasons: [...pack.truncationReasons],
      sourceRevisions: pack.sourceRevisions.map(source => ({
        sourceId: String(source.sourceId),
        revision: source.commit,
        inventoryHash: source.inventoryHash,
        sourceRecordHash: source.sourceRecordHash,
      })),
      hits: pack.hits.map(hit => ({
        sourceId: String(hit.sourceId),
        revision: hit.commit,
        path: hit.path,
        contentHash: hit.contentHash,
        area: hit.area,
        artifactKind: hit.artifactKind,
        ...(hit.language === undefined ? {} : { language: hit.language }),
        kind: hit.evidence.kind,
        detail: hit.evidence.kind === 'code-symbol' ? hit.evidence.declaration : `H${hit.evidence.level}`,
        ...(hit.evidence.kind !== 'code-symbol' ? {} : {
          exported: hit.evidence.exported,
          ...(hit.evidence.containerName === undefined ? {} : { containerName: hit.evidence.containerName }),
        }),
        name: hit.evidence.name,
        startLine: hit.evidence.startLine,
        endLine: hit.evidence.endLine,
      })),
    }
  }

  private projectRelationPack(pack: SourceRelationQueryPack): MemoryUiRelationPack {
    return {
      retriever: pack.retriever,
      version: pack.version,
      ...(pack.query === undefined ? {} : { query: pack.query }),
      ...(pack.area === undefined ? {} : { area: pack.area }),
      ...(pack.resolution === undefined ? {} : { resolution: pack.resolution }),
      ...(pack.kind === undefined ? {} : { kind: pack.kind }),
      totalMatches: pack.totalMatches,
      omittedEdgeCount: pack.omittedEdgeCount,
      truncationReasons: [...pack.truncationReasons],
      sourceRevisions: pack.sourceRevisions.map(source => ({
        sourceId: String(source.sourceId),
        revision: source.commit,
        inventoryHash: source.inventoryHash,
        sourceRecordHash: source.sourceRecordHash,
        relationProvider: source.relationProvider,
        relationProviderKey: source.relationProviderKey,
        relationOutputHash: source.relationOutputHash,
        graphOmittedEdgeCount: source.graphOmittedEdgeCount,
      })),
      edges: pack.edges.map(edge => ({
        edgeId: edge.edgeId,
        sourceId: String(edge.sourceId),
        revision: edge.commit,
        fromPath: edge.fromPath,
        fromContentHash: edge.fromContentHash,
        ...(edge.toPath === undefined ? {} : { toPath: edge.toPath }),
        specifier: browserSafeSpecifier(edge.specifier),
        kind: edge.kind,
        resolution: edge.resolution,
        startLine: edge.startLine,
        endLine: edge.endLine,
      })),
    }
  }

  private projectSymbolPack(pack: SourceSymbolQueryPack): MemoryUiSymbolPack {
    return {
      retriever: pack.retriever,
      version: pack.version,
      ...(pack.query === undefined ? {} : { query: pack.query }),
      ...(pack.definitionPath === undefined ? {} : { definitionPath: pack.definitionPath }),
      ...(pack.referencePath === undefined ? {} : { referencePath: pack.referencePath }),
      ...(pack.referenceKind === undefined ? {} : { referenceKind: pack.referenceKind }),
      totalMatches: pack.totalMatches,
      omittedReferenceCount: pack.omittedReferenceCount,
      truncationReasons: [...pack.truncationReasons],
      sourceRevisions: pack.sourceRevisions.map(source => ({
        sourceId: String(source.sourceId),
        revision: source.commit,
        inventoryHash: source.inventoryHash,
        sourceRecordHash: source.sourceRecordHash,
        symbolProvider: source.symbolProvider,
        symbolProviderKey: source.symbolProviderKey,
        symbolOutputHash: source.symbolOutputHash,
        graphOmittedFileCount: source.graphOmittedFileCount,
        graphOmittedReferenceCount: source.graphOmittedReferenceCount,
        configMode: source.configMode,
        configPaths: [...source.configPaths],
        projectReferenceCount: source.projectReferenceCount,
        pathAliasCount: source.pathAliasCount,
        configDiagnosticCount: source.configDiagnosticCount,
        omittedConfigFileCount: source.omittedConfigFileCount,
      })),
      edges: pack.edges.map(edge => ({
        referenceId: edge.referenceId,
        sourceId: String(edge.sourceId),
        revision: edge.commit,
        definitionId: String(edge.definitionId),
        symbolName: edge.symbolName,
        declaration: edge.declaration,
        definitionPath: edge.definitionPath,
        definitionContentHash: edge.definitionContentHash,
        definitionStartLine: edge.definitionStartLine,
        definitionEndLine: edge.definitionEndLine,
        referencePath: edge.referencePath,
        referenceContentHash: edge.referenceContentHash,
        referenceKind: edge.referenceKind,
        referenceStartLine: edge.referenceStartLine,
        referenceEndLine: edge.referenceEndLine,
      })),
    }
  }
}

export default MemoryKnowledgeGateway
