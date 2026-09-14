import { Context, Service } from '@deepseek-ai/cordis'
import type { SearchWikiCatalogRequest, ListWikiCatalogRangesRequest, WikiCatalogQueryPage, WikiCatalogFileHit, WikiCatalogRangeHit } from './wiki-catalog-query.js'
import type { MemoryCandidateId, MemoryId, WikiRunId } from './ids.js'
import type { SourceEvidencePack, SourceEvidenceSearchRequest } from './evidence-pack.js'
import type { SourceRelationQueryPack, SourceRelationQueryRequest } from './source-relation-query.js'
import type { SourceSymbolQueryPack, SourceSymbolQueryRequest } from './source-symbol-query.js'
import type { SourceInventoryBaseline } from './inventory.js'
import type {
  GenerateKnowledgeCardCandidatesResult,
  ConversationExtractionCheckpoint,
  CreateLocalMemoryEntryInput,
  ListLocalMemoryEntriesRequest,
  ListReviewCandidatesRequest,
  ListRecallableMemoryRequest,
  MemoryCandidate,
  LocalMemoryEntry,
  LocalMemoryEntryStatus,
  LocalMemoryRevision,
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
  UpdateLocalMemoryEntryInput,
} from './runtime-model.js'
import type { SourceUnderstandingSummary } from './source-records.js'
import type { PlanWikiProjectResult } from './wiki-catalog.js'
import type { WikiRun, WikiRunSnapshot } from './wiki-model.js'
import type { WikiMaterialBudgetKey, WikiMaterialReadBudget, ReserveWikiMaterialRead, ListWikiMaterialBudgetsRequest, WikiMaterialBudgetPage, WikiMaterialBudgetUpdateGuard } from './wiki-material-budget.js'
import type { KnowledgeActivationResult, KnowledgeVersionState } from './knowledge-version.js'
import type {
  CreateKnowledgeHumanRevisionInput,
  KnowledgeHumanRevision,
  KnowledgeHumanRevisionResult,
} from './knowledge-revision.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryKnowledge: MemoryKnowledge
  }
}

/** Service Definition for local candidates, review, search, promotion, and trace reads. */
export abstract class MemoryKnowledge extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memoryKnowledge')
  }

  /** Save or deduplicate one local review candidate. */
  abstract saveCandidate(input: SaveMemoryCandidateInput): Promise<MemoryCandidate>

  /** Create or read one durable conversation extraction checkpoint. */
  abstract prepareConversationExtraction(
    request: PrepareConversationExtractionRequest,
  ): Promise<ConversationExtractionCheckpoint>

  /** Atomically save one extracted candidate and checkpoint its completed turn. */
  abstract recordConversationExtraction(
    request: RecordConversationExtractionRequest,
  ): Promise<RecordConversationExtractionResult>

  /** List bounded review candidates. */
  abstract listCandidates(request: ListReviewCandidatesRequest): Promise<ReviewCandidate[]>

  /** Read one candidate by opaque id. */
  abstract getCandidate(id: MemoryCandidateId): Promise<ReviewCandidate | undefined>

  /** Apply one human accept/reject decision. */
  abstract reviewCandidate(
    id: MemoryCandidateId,
    decision: ReviewCandidateDecision,
    expectedRevision?: number,
  ): Promise<ReviewCandidate>

  /** Create one explicitly saved local long-term memory entry. */
  abstract createLocalMemoryEntry(input: CreateLocalMemoryEntryInput): Promise<LocalMemoryEntry>

  /** List local long-term memory entries in one exact scope. */
  abstract listLocalMemoryEntries(request: ListLocalMemoryEntriesRequest): Promise<LocalMemoryEntry[]>

  /** Read one local long-term memory entry in one exact scope. */
  abstract getLocalMemoryEntry(id: MemoryId, projectRoot?: string): Promise<LocalMemoryEntry | undefined>

  /** Save editable fields as a new immutable local memory revision. */
  abstract updateLocalMemoryEntry(
    id: MemoryId,
    input: UpdateLocalMemoryEntryInput,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry>

  /** Change one local memory lifecycle state while retaining its history. */
  abstract setLocalMemoryEntryStatus(
    id: MemoryId,
    status: LocalMemoryEntryStatus,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry>

  /** Read immutable local memory revisions in newest-first order. */
  abstract listLocalMemoryRevisions(
    id: MemoryId,
    projectRoot: string | undefined,
    limit: number,
  ): Promise<LocalMemoryRevision[]>

  /** Generate deterministic Knowledge Card review candidates for one project. */
  abstract generateKnowledgeCardCandidates(projectRoot: string): Promise<GenerateKnowledgeCardCandidatesResult>

  /** Catalog one project and persist a language-neutral Wiki coverage run. */
  abstract planWikiProject(projectRoot: string, signal?: AbortSignal): Promise<PlanWikiProjectResult>

  /** Read the generated/effective version selection for one project. */
  abstract getKnowledgeVersionState(projectRoot: string): Promise<KnowledgeVersionState>

  /** Read immutable operator edits for one project in newest-first order. */
  abstract listKnowledgeHumanRevisions(projectRoot: string, limit: number): Promise<KnowledgeHumanRevision[]>

  /** Layer one idempotent operator edit over the selected effective version. */
  abstract applyKnowledgeHumanRevision(
    input: CreateKnowledgeHumanRevisionInput,
  ): Promise<KnowledgeHumanRevisionResult>

  /** Activate one complete Wiki run after every Host completion check passes. */
  abstract activateWikiRun(runId: WikiRunId): Promise<KnowledgeActivationResult>

  /** Read one complete local Wiki generation snapshot. */
  abstract getWikiRunSnapshot(id: WikiRunId): Promise<WikiRunSnapshot | undefined>

  /** 按字面路径查询当前 Run 元数据，不读取正文或加载完整快照。
   * @param request 当前运行任务、项目、筛选与分页预算。
   * @returns 有界文件页；任务外命中不授予读取或引用权限。
   */
  abstract searchWikiCatalog(request: SearchWikiCatalogRequest): Promise<WikiCatalogQueryPage<WikiCatalogFileHit>>

  /** 查询当前 Run 的材料区间元数据，不证明模型已阅读。
   * @param request 当前运行任务、项目、Coverage 与分页预算。
   * @returns 有界区间页及分配标记。
   */
  abstract listWikiCatalogRanges(request: ListWikiCatalogRangesRequest): Promise<WikiCatalogQueryPage<WikiCatalogRangeHit>>

  /** 读取任务的累计材料账本；缺失不代表历史消耗为零。
   * @param key Run 与 Task 身份。
   * @returns 当前账本或尚未开始记账。
   */
  abstract getWikiMaterialReadBudget(key: WikiMaterialBudgetKey): Promise<WikiMaterialReadBudget | undefined>

  /** 查询项目内已存在的账本，不加载全部 Coverage。
   * @param request 项目、Run、筛选、游标与条数。
   * @returns 有界账本页，未记账任务不在列表中。
   */
  abstract listWikiMaterialReadBudgets(request: ListWikiMaterialBudgetsRequest): Promise<WikiMaterialBudgetPage>

  /** 根据操作者确认的完整账本版本显式扩额，不执行模型。
   * @param key Run 与 Task 身份。
   * @param limitBytes 新的总额度。
   * @param guard 项目与操作者所见账本版本；过期版本拒绝写入。
   * @returns 保留消耗的新账本。
   */
  abstract increaseWikiMaterialReadBudget(key: WikiMaterialBudgetKey, limitBytes: number, guard: WikiMaterialBudgetUpdateGuard): Promise<WikiMaterialReadBudget>

  /** 在材料出域前原子预扣字节；恢复、重试和失败不退款。
   * @param request 当前 Session、材料字节数及首次额度。
   * @returns 预扣或拒绝后的账本；blockedReadBytes 非空时不得读取或提交。
   */
  abstract reserveWikiMaterialRead(request: ReserveWikiMaterialRead): Promise<WikiMaterialReadBudget>

  /** Replace one validated Wiki snapshot, optionally requiring the previously read hash. */
  abstract saveWikiRunSnapshot(
    snapshot: WikiRunSnapshot,
    expectedSnapshotHash?: string,
  ): Promise<WikiRunSnapshot>

  /** List local Wiki run headers under an optional project and result limit. */
  abstract listWikiRuns(projectRoot?: string, limit?: number): Promise<WikiRun[]>

  /** List current local Source record checkpoints without file-level details. */
  abstract listSourceUnderstandings(projectRoot: string): Promise<SourceUnderstandingSummary[]>

  /** Read file-level checkpoints for trusted same-process inventory reuse. */
  abstract listSourceInventoryBaselines(projectRoot: string): Promise<SourceInventoryBaseline[]>

  /** Search bounded, line-addressable evidence from the current project Source index. */
  abstract searchSourceEvidence(request: SourceEvidenceSearchRequest): Promise<SourceEvidencePack>

  /** Query bounded module relations from the current project Source checkpoint. */
  abstract querySourceRelations(request: SourceRelationQueryRequest): Promise<SourceRelationQueryPack>

  /** Query bounded cross-file symbol references from the current Source checkpoint. */
  abstract querySourceSymbols(request: SourceSymbolQueryRequest): Promise<SourceSymbolQueryPack>

  /** List records currently eligible for recall in one optional project. */
  abstract listRecallable(request: ListRecallableMemoryRequest): Promise<RecallableMemoryRecord[]>

  /** Promote a local candidate into Git-shared canonical memory and regenerate projections. */
  abstract promoteCandidate(
    id: MemoryCandidateId,
    projectRoot?: string,
    expectedRevision?: number,
  ): Promise<PromoteReviewCandidateResult>

  /** Search accepted personal memory and reviewed project knowledge. */
  abstract search(request: MemorySearchRequest): Promise<MemorySearchHit[]>

  /** Read the exact candidate or indexed document behind a recall id. */
  abstract trace(id: string, projectRoot?: string): Promise<MemoryTrace | undefined>
}
