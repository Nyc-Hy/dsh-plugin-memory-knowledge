import { Service, type Context } from '@deepseek-ai/cordis'
import type { SearchWikiCatalogRequest, ListWikiCatalogRangesRequest, WikiCatalogQueryPage, WikiCatalogFileHit, WikiCatalogRangeHit } from './wiki-catalog-query.js'
import z from '@deepseek-ai/schemastery'
import type { MemoryCandidateId, MemoryId, WikiRunId } from './ids.js'
import type { SourceEvidencePack, SourceEvidenceSearchRequest } from './evidence-pack.js'
import type { SourceRelationQueryPack, SourceRelationQueryRequest } from './source-relation-query.js'
import type { SourceSymbolQueryPack, SourceSymbolQueryRequest } from './source-symbol-query.js'
import { DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG } from './candidate-generation.js'
import { defaultMemoryDatabasePath, MemoryKnowledgeEngine } from './engine.js'
import type { MemoryJournalMode } from './database.js'
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
import { MemoryKnowledge } from './service.js'
import { DEFAULT_SOURCE_RECORD_CONFIG, type SourceUnderstandingSummary } from './source-records.js'
import type { PlanWikiProjectResult } from './wiki-catalog.js'
import type { WikiRun, WikiRunSnapshot } from './wiki-model.js'
import { DEFAULT_WIKI_SHARD_CONFIG } from './wiki-model.js'
import type { WikiMaterialBudgetKey, WikiMaterialReadBudget, ReserveWikiMaterialRead, ListWikiMaterialBudgetsRequest, WikiMaterialBudgetPage, WikiMaterialBudgetUpdateGuard } from './wiki-material-budget.js'
import type { KnowledgeActivationResult, KnowledgeVersionState } from './knowledge-version.js'
import type {
  CreateKnowledgeHumanRevisionInput,
  KnowledgeHumanRevision,
  KnowledgeHumanRevisionResult,
} from './knowledge-revision.js'

/** Local SQLite provider configuration. */
export interface Config {
  path?: string
  journalMode?: MemoryJournalMode
  candidateMaxSources?: number
  candidateMaxLanguages?: number
  candidateMaxAreas?: number
  candidateMaxEvidencePerArea?: number
  sourceRecordMaxRepresentativeFilesPerArea?: number
  wikiShardMaxItems?: number
  wikiShardMaxBytes?: number
}

/** Schemastery configuration for the local provider. */
export const Config: z<Config> = z.object({
  path: z.string(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
  candidateMaxSources: z.number().step(1).min(1).default(DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxSources),
  candidateMaxLanguages: z.number().step(1).min(2).default(DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxLanguages),
  candidateMaxAreas: z.number().step(1).min(2).default(DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxAreas),
  candidateMaxEvidencePerArea: z.number().step(1).min(2)
    .default(DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxEvidencePerArea),
  sourceRecordMaxRepresentativeFilesPerArea: z.number().step(1).min(1)
    .default(DEFAULT_SOURCE_RECORD_CONFIG.maxRepresentativeFilesPerArea),
  wikiShardMaxItems: z.number().step(1).min(1).default(DEFAULT_WIKI_SHARD_CONFIG.maxItems),
  wikiShardMaxBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_SHARD_CONFIG.maxBytes),
})

/** SQLite Service Provider for local candidates and the derived FTS index. */
export class LocalMemoryKnowledge extends MemoryKnowledge {
  static inject = ['knowledgeProject', 'sourceRelations', 'sourceSymbols']
  static Config = Config

  private readonly engine: Promise<MemoryKnowledgeEngine>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const path = config.path ?? defaultMemoryDatabasePath()
    const journalMode = config.journalMode ?? 'wal'
    this.engine = MemoryKnowledgeEngine.open({
      path,
      journalMode,
      candidateGeneration: {
        maxSources: config.candidateMaxSources ?? DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxSources,
        maxLanguages: config.candidateMaxLanguages ?? DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxLanguages,
        maxAreas: config.candidateMaxAreas ?? DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxAreas,
        maxEvidencePerArea: config.candidateMaxEvidencePerArea
          ?? DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG.maxEvidencePerArea,
      },
      sourceRecords: {
        maxRepresentativeFilesPerArea: config.sourceRecordMaxRepresentativeFilesPerArea
          ?? DEFAULT_SOURCE_RECORD_CONFIG.maxRepresentativeFilesPerArea,
      },
      wikiShards: {
        maxItems: config.wikiShardMaxItems ?? DEFAULT_WIKI_SHARD_CONFIG.maxItems,
        maxBytes: config.wikiShardMaxBytes ?? DEFAULT_WIKI_SHARD_CONFIG.maxBytes,
      },
    }, ctx.knowledgeProject, ctx.sourceRelations, ctx.sourceSymbols)
    this.engine.catch(() => {})
    ctx.effect(() => async () => {
      const engine = await this.engine.catch(() => undefined)
      await engine?.close()
    }, 'memoryKnowledge.close')
  }

  protected async [Service.init](): Promise<void> {
    await this.engine
  }

  override async saveCandidate(input: SaveMemoryCandidateInput): Promise<MemoryCandidate> {
    return (await this.engine).saveCandidate(input)
  }

  override async prepareConversationExtraction(
    request: PrepareConversationExtractionRequest,
  ): Promise<ConversationExtractionCheckpoint> {
    return (await this.engine).prepareConversationExtraction(request)
  }

  override async recordConversationExtraction(
    request: RecordConversationExtractionRequest,
  ): Promise<RecordConversationExtractionResult> {
    return (await this.engine).recordConversationExtraction(request)
  }

  override async listCandidates(request: ListReviewCandidatesRequest): Promise<ReviewCandidate[]> {
    return (await this.engine).listCandidates(request)
  }

  override async getCandidate(id: MemoryCandidateId): Promise<ReviewCandidate | undefined> {
    return (await this.engine).getCandidate(id)
  }

  override async reviewCandidate(
    id: MemoryCandidateId,
    decision: ReviewCandidateDecision,
    expectedRevision?: number,
  ): Promise<ReviewCandidate> {
    return (await this.engine).reviewCandidate(id, decision, expectedRevision)
  }

  override async createLocalMemoryEntry(input: CreateLocalMemoryEntryInput): Promise<LocalMemoryEntry> {
    return (await this.engine).createLocalMemoryEntry(input)
  }

  override async listLocalMemoryEntries(request: ListLocalMemoryEntriesRequest): Promise<LocalMemoryEntry[]> {
    return (await this.engine).listLocalMemoryEntries(request)
  }

  override async getLocalMemoryEntry(id: MemoryId, projectRoot?: string): Promise<LocalMemoryEntry | undefined> {
    return (await this.engine).getLocalMemoryEntry(id, projectRoot)
  }

  override async updateLocalMemoryEntry(
    id: MemoryId,
    input: UpdateLocalMemoryEntryInput,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry> {
    return (await this.engine).updateLocalMemoryEntry(id, input, expectedRevision, projectRoot)
  }

  override async setLocalMemoryEntryStatus(
    id: MemoryId,
    status: LocalMemoryEntryStatus,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry> {
    return (await this.engine).setLocalMemoryEntryStatus(id, status, expectedRevision, projectRoot)
  }

  override async listLocalMemoryRevisions(
    id: MemoryId,
    projectRoot: string | undefined,
    limit: number,
  ): Promise<LocalMemoryRevision[]> {
    return (await this.engine).listLocalMemoryRevisions(id, projectRoot, limit)
  }

  override async generateKnowledgeCardCandidates(projectRoot: string): Promise<GenerateKnowledgeCardCandidatesResult> {
    return (await this.engine).generateKnowledgeCardCandidates(projectRoot)
  }

  override async planWikiProject(projectRoot: string, signal?: AbortSignal): Promise<PlanWikiProjectResult> {
    return (await this.engine).planWikiProject(projectRoot, signal)
  }

  override async getKnowledgeVersionState(projectRoot: string): Promise<KnowledgeVersionState> {
    return (await this.engine).getKnowledgeVersionState(projectRoot)
  }

  override async listKnowledgeHumanRevisions(projectRoot: string, limit: number): Promise<KnowledgeHumanRevision[]> {
    return (await this.engine).listKnowledgeHumanRevisions(projectRoot, limit)
  }

  override async applyKnowledgeHumanRevision(
    input: CreateKnowledgeHumanRevisionInput,
  ): Promise<KnowledgeHumanRevisionResult> {
    return (await this.engine).applyKnowledgeHumanRevision(input)
  }

  override async activateWikiRun(runId: WikiRunId): Promise<KnowledgeActivationResult> {
    return (await this.engine).activateWikiRun(runId)
  }

  override async getWikiRunSnapshot(id: WikiRunId): Promise<WikiRunSnapshot | undefined> {
    return (await this.engine).getWikiRunSnapshot(id)
  }

  override async searchWikiCatalog(request: SearchWikiCatalogRequest): Promise<WikiCatalogQueryPage<WikiCatalogFileHit>> {
    return (await this.engine).searchWikiCatalog(request)
  }

  override async listWikiCatalogRanges(request: ListWikiCatalogRangesRequest): Promise<WikiCatalogQueryPage<WikiCatalogRangeHit>> {
    return (await this.engine).listWikiCatalogRanges(request)
  }

  override async getWikiMaterialReadBudget(key: WikiMaterialBudgetKey): Promise<WikiMaterialReadBudget | undefined> {
    return (await this.engine).getWikiMaterialReadBudget(key)
  }

  override async listWikiMaterialReadBudgets(request: ListWikiMaterialBudgetsRequest): Promise<WikiMaterialBudgetPage> {
    return (await this.engine).listWikiMaterialReadBudgets(request)
  }

  override async increaseWikiMaterialReadBudget(key: WikiMaterialBudgetKey, limitBytes: number, guard: WikiMaterialBudgetUpdateGuard): Promise<WikiMaterialReadBudget> {
    return (await this.engine).increaseWikiMaterialReadBudget(key, limitBytes, guard)
  }

  override async reserveWikiMaterialRead(request: ReserveWikiMaterialRead): Promise<WikiMaterialReadBudget> {
    return (await this.engine).reserveWikiMaterialRead(request)
  }

  override async saveWikiRunSnapshot(
    snapshot: WikiRunSnapshot,
    expectedSnapshotHash?: string,
  ): Promise<WikiRunSnapshot> {
    return (await this.engine).saveWikiRunSnapshot(snapshot, expectedSnapshotHash)
  }

  override async listWikiRuns(projectRoot?: string, limit?: number): Promise<WikiRun[]> {
    return (await this.engine).listWikiRuns(projectRoot, limit)
  }

  override async listSourceUnderstandings(projectRoot: string): Promise<SourceUnderstandingSummary[]> {
    return (await this.engine).listSourceUnderstandings(projectRoot)
  }

  override async listSourceInventoryBaselines(projectRoot: string) {
    return (await this.engine).listSourceInventoryBaselines(projectRoot)
  }

  override async searchSourceEvidence(request: SourceEvidenceSearchRequest): Promise<SourceEvidencePack> {
    return (await this.engine).searchSourceEvidence(request)
  }

  override async querySourceRelations(request: SourceRelationQueryRequest): Promise<SourceRelationQueryPack> {
    return (await this.engine).querySourceRelations(request)
  }

  override async querySourceSymbols(request: SourceSymbolQueryRequest): Promise<SourceSymbolQueryPack> {
    return (await this.engine).querySourceSymbols(request)
  }

  override async listRecallable(request: ListRecallableMemoryRequest): Promise<RecallableMemoryRecord[]> {
    return (await this.engine).listRecallable(request)
  }

  override async promoteCandidate(
    id: MemoryCandidateId,
    projectRoot?: string,
    expectedRevision?: number,
  ): Promise<PromoteReviewCandidateResult> {
    return (await this.engine).promoteCandidate(id, projectRoot, expectedRevision)
  }

  override async search(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    return (await this.engine).search(request)
  }

  override async trace(id: string, projectRoot?: string): Promise<MemoryTrace | undefined> {
    return (await this.engine).trace(id, projectRoot)
  }
}

export default LocalMemoryKnowledge
