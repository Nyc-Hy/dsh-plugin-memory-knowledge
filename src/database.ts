import { createHash } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { searchWikiCatalog, listWikiCatalogRanges, type SearchWikiCatalogRequest, type ListWikiCatalogRangesRequest, type WikiCatalogQueryPage, type WikiCatalogFileHit, type WikiCatalogRangeHit } from './wiki-catalog-query.js'
import {
  readWikiMaterialBudget, reserveWikiMaterialBudget, increaseWikiMaterialBudget, wikiMaterialBudgetFailure,
  listWikiMaterialBudgets,
  type ListWikiMaterialBudgetsRequest, type WikiMaterialBudgetPage, type WikiMaterialBudgetUpdateGuard,
  type WikiMaterialBudgetKey, type WikiMaterialReadBudget, type ReserveWikiMaterialRead,
} from './wiki-material-budget.js'
import {
  createKnowledgeCardId,
  createKnowledgeHumanRevisionId,
  createMemoryCandidateId,
  createMemoryId,
  KnowledgeCardId,
  KNOWLEDGE_CARD_ID_PATTERN,
  KnowledgeSourceId,
  KNOWLEDGE_SOURCE_ID_PATTERN,
  MemoryCandidateId,
  MEMORY_CANDIDATE_ID_PATTERN,
  MemoryId,
  MEMORY_ID_PATTERN,
  SourceSymbolId,
  SOURCE_SYMBOL_ID_PATTERN,
  WikiCoverageId,
  type KnowledgeEffectiveVersionId,
  type KnowledgeHumanRevisionRequestId,
  WikiRunId,
  WikiTaskId,
} from './ids.js'
import {
  activateKnowledgeSelection,
  createKnowledgeEffectiveVersion,
  createRevisedKnowledgeEffectiveVersion,
  parseKnowledgeEffectiveVersion,
  parseKnowledgeGeneratedVersion,
  parseKnowledgeSelection,
  reviseKnowledgeSelection,
  selectKnowledgeRun as advanceKnowledgeSelection,
  type KnowledgeActivationResult,
  type KnowledgeEffectiveVersion,
  type KnowledgeGeneratedVersion,
  type KnowledgeSelection,
  type KnowledgeVersionState,
} from './knowledge-version.js'
import {
  knowledgeHumanRevisionRequestFingerprint,
  parseCreateKnowledgeHumanRevisionInput,
  parseKnowledgeHumanRevision,
  parseKnowledgeHumanRevisionResult,
  type CreateKnowledgeHumanRevisionInput,
  type KnowledgeHumanRevision,
  type KnowledgeHumanRevisionResult,
} from './knowledge-revision.js'
import {
  SOURCE_EVIDENCE_RETRIEVER_VERSION,
  type SourceEvidenceHit,
  type SourceEvidencePack,
  type SourceEvidenceRevision,
  type SourceEvidenceSearchRequest,
} from './evidence-pack.js'
import {
  SOURCE_RELATION_RETRIEVER_VERSION,
  type SourceRelationQueryEdge,
  type SourceRelationQueryPack,
  type SourceRelationQueryRequest,
  type SourceRelationRevision,
} from './source-relation-query.js'
import {
  SOURCE_SYMBOL_RETRIEVER_VERSION,
  type SourceSymbolQueryEdge,
  type SourceSymbolQueryPack,
  type SourceSymbolQueryRequest,
  type SourceSymbolRevision,
} from './source-symbol-query.js'
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeCard, type MemoryEntry, type ProvenanceRef, type SharedKnowledgeScope } from './model.js'
import type {
  KnowledgeCardCandidate,
  KnowledgeCardDraft,
  KnowledgeCandidateGeneration,
  ConversationExtractionCheckpoint,
  CreateLocalMemoryEntryInput,
  ListLocalMemoryEntriesRequest,
  ListReviewCandidatesRequest,
  ListRecallableMemoryRequest,
  LocalMemoryEntry,
  LocalMemoryEntryStatus,
  LocalMemoryRevision,
  LocalMemoryRevisionKind,
  MemoryCandidateApplicability,
  MemoryRecordDomain,
  MemoryCandidate,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryScopeMode,
  MemoryTrace,
  RecallableMemoryRecord,
  ReviewCandidate,
  ReviewCandidateDecision,
  PrepareConversationExtractionRequest,
  RecordConversationExtractionRequest,
  RecordConversationExtractionResult,
  SaveKnowledgeCardCandidateInput,
  SaveMemoryCandidateInput,
  UpdateLocalMemoryEntryInput,
} from './runtime-model.js'
import { assertKnowledgeCard, assertProvenanceRefs, PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'
import { parseSourceUnderstanding, type SourceArtifactKind, type SourceUnderstanding } from './source-records.js'
import type { SourceCodeSymbolDeclaration, SourceEvidence, SourceModuleReferenceKind } from './source-analysis.js'
import type { SourceRelationResolution } from './source-relations.js'
import type { SourceSymbolReferenceKind } from './source-symbols.js'
import {
  createUnplannedWikiConsistencySummary,
  createUnassessedWikiFileSynthesisSummary,
  createUnplannedWikiPageGenerationSummary,
  createWikiConsistencyTasks,
  createWikiPageTasks,
  finalizeWikiRunSnapshot,
  createWikiVerificationTasks,
  parseWikiRun,
  parseWikiRunSnapshot,
  summarizeWikiMaterialRanges,
  summarizeWikiTasks,
  wikiTaskId,
  WIKI_RUN_SCHEMA_VERSION,
  type WikiRun,
  type WikiRunSnapshot,
  type WikiShardTask,
} from './wiki-model.js'

/** Current local candidate/search database schema. */
export const MEMORY_DATABASE_SCHEMA_VERSION = 23

const SOURCE_RECORD_REBUILD_SCHEMA_VERSION = 3
const SOURCE_RECORD_SCHEMA_VERSION = 4
const CONVERSATION_EXTRACTION_SCHEMA_VERSION = 5
const SOURCE_EVIDENCE_SCHEMA_VERSION = 6
const AST_SOURCE_ANALYSIS_SCHEMA_VERSION = 7
const INCREMENTAL_SOURCE_SCHEMA_VERSION = 8
const SOURCE_RELATION_SCHEMA_VERSION = 9
const SOURCE_SYMBOL_SCHEMA_VERSION = 10
const SOURCE_TSCONFIG_SCHEMA_VERSION = 11
const WIKI_RUNTIME_V1_SCHEMA_VERSION = 12
const WIKI_RUNTIME_V2_SCHEMA_VERSION = 13
const WIKI_RUNTIME_V3_SCHEMA_VERSION = 14
const WIKI_RUNTIME_V4_SCHEMA_VERSION = 15
const WIKI_RUNTIME_V5_SCHEMA_VERSION = 16
const WIKI_RUNTIME_V6_SCHEMA_VERSION = 17
const WIKI_RUNTIME_V7_SCHEMA_VERSION = 18
const PRE_MATERIAL_BUDGET_SCHEMA_VERSION = 19
const PRE_KNOWLEDGE_VERSION_SCHEMA_VERSION = 20
const PRE_LOCAL_MEMORY_ENTRY_SCHEMA_VERSION = 21
const PRE_KNOWLEDGE_HUMAN_REVISION_SCHEMA_VERSION = 22

/** SQLite application id protecting unrelated files from memory schema writes. */
export const MEMORY_DATABASE_APPLICATION_ID = 0x44534d4b

/** Supported durability modes for the local database. */
export type MemoryJournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** Prepared immutable records and selection revision required for one activation attempt. */
export interface ActivateKnowledgeVersionRequest {
  generatedVersion: KnowledgeGeneratedVersion
  effectiveVersion: KnowledgeEffectiveVersion
  expectedSelectionRevision: number
}

/** One canonical document prepared for the local derived search index. */
export interface IndexedMemoryDocument {
  id: MemorySearchHit['id']
  recordType: Exclude<MemorySearchHit['recordType'], 'personal-memory'>
  title: string
  content: string
  tags: string[]
  evidenceClass: MemoryEntry['evidenceClass']
  sensitivity: MemoryEntry['sensitivity']
  projectRoot: string
  scope: SharedKnowledgeScope
  provenance: ProvenanceRef[]
  updatedAt: string
}

interface StoredSearchDocument extends Omit<MemorySearchHit, 'score' | 'truncated'> {
  status: string
}

interface CandidateRow {
  payload_json: string
}

interface LocalMemoryEntryRow {
  payload_json: string
}

interface LocalMemoryRevisionRow {
  revision_kind: string
  payload_json: string
}

interface SourceUnderstandingRow {
  payload_json: string
}

interface SourceEvidenceRow {
  source_id: string
  commit_hash: string
  inventory_hash: string
  output_hash: string
  path: string
  content_hash: string
  area: string
  artifact_kind: string
  language: string | null
  evidence_kind: string
  evidence_name: string
  evidence_detail: string
  start_line: number
  end_line: number
  rank: number
}

interface SourceRelationRow {
  edge_key: string
  source_id: string
  commit_hash: string
  inventory_hash: string
  output_hash: string
  from_path: string
  from_content_hash: string
  to_path: string | null
  specifier: string
  relation_kind: string
  resolution: string
  start_line: number
  end_line: number
}

interface SourceSymbolRow {
  reference_key: string
  source_id: string
  commit_hash: string
  inventory_hash: string
  output_hash: string
  symbol_id: string
  symbol_name: string
  declaration_kind: string
  definition_path: string
  definition_content_hash: string
  definition_start_line: number
  definition_end_line: number
  reference_path: string
  reference_content_hash: string
  reference_kind: string
  reference_start_line: number
  reference_end_line: number
}

interface ConversationExtractionRow {
  session_id: string
  extractor: string
  extractor_version: number
  through_seq: number
  updated_at: string
}

interface SearchRow {
  payload_json: string
  rank: number
}

interface TraceRow {
  payload_json: string
  status: string
}

interface WikiPayloadRow {
  payload_json: string
}

interface WikiRunRow extends WikiPayloadRow {
  snapshot_hash: string
}

interface KnowledgeSelectionRow extends WikiPayloadRow {
  revision: number
}

interface KnowledgeHumanRevisionRow extends WikiPayloadRow {
  request_fingerprint: string
  result_json: string
}

/** Optional compare-and-swap guard for changing one project's knowledge selection. */
export interface KnowledgeSelectionUpdateGuard {
  expectedRevision: number | undefined
}

/** A browser or other concurrent reviewer acted on an obsolete candidate revision. */
export class MemoryCandidateRevisionConflictError extends Error {
  constructor(
    readonly id: MemoryCandidateId,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`memory candidate ${id} revision changed from ${expectedRevision} to ${actualRevision}`)
    this.name = 'MemoryCandidateRevisionConflictError'
  }
}

/** A local memory update was based on an obsolete entry revision. */
export class LocalMemoryRevisionConflictError extends Error {
  constructor(
    readonly id: MemoryId,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`local memory ${id} revision changed from ${expectedRevision} to ${actualRevision}`)
    this.name = 'LocalMemoryRevisionConflictError'
  }
}

/** A concurrent Wiki worker replaced the snapshot read by this worker. */
export class WikiRunRevisionConflictError extends Error {
  constructor(
    readonly id: WikiRunId,
    readonly expectedSnapshotHash: string,
    readonly actualSnapshotHash: string | undefined,
  ) {
    super(`Wiki run ${id} snapshot changed from ${expectedSnapshotHash} to ${actualSnapshotHash ?? 'missing'}`)
    this.name = 'WikiRunRevisionConflictError'
  }
}

/** A version activation was based on an obsolete project selection revision. */
export class KnowledgeSelectionRevisionConflictError extends Error {
  constructor(
    readonly projectRoot: string,
    readonly expectedRevision: number | undefined,
    readonly actualRevision: number | undefined,
  ) {
    super(`knowledge selection ${projectRoot} revision changed from ${expectedRevision ?? 'missing'} to ${actualRevision ?? 'missing'}`)
    this.name = 'KnowledgeSelectionRevisionConflictError'
  }
}

/** A human edit was based on an effective version that is no longer selected. */
export class KnowledgeEffectiveVersionConflictError extends Error {
  constructor(
    readonly projectRoot: string,
    readonly expectedId: KnowledgeEffectiveVersionId,
    readonly actualId: KnowledgeEffectiveVersionId | undefined,
  ) {
    super(`knowledge selection ${projectRoot} effective version changed from ${expectedId} to ${actualId ?? 'missing'}`)
    this.name = 'KnowledgeEffectiveVersionConflictError'
  }
}

/** One idempotency key was reused for different operator edit content. */
export class KnowledgeHumanRevisionRequestConflictError extends Error {
  constructor(readonly requestId: KnowledgeHumanRevisionRequestId) {
    super(`knowledge human revision request ${requestId} was reused with different content`)
    this.name = 'KnowledgeHumanRevisionRequestConflictError'
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
}

async function validateDatabaseParent(path: string): Promise<void> {
  const stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`memory-knowledge database parent must be an ordinary directory: ${path}`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && (stats.uid !== uid || (stats.mode & 0o022) !== 0)) {
    throw new Error(`memory-knowledge database parent must be user-owned and not group/world-writable: ${path}`)
  }
}

async function validateDatabaseFile(path: string): Promise<void> {
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`memory-knowledge database must be an ordinary file: ${path}`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && (stats.uid !== uid || (stats.mode & 0o077) !== 0)) {
    throw new Error(`memory-knowledge database must be user-owned and accessible only by that user: ${path}`)
  }
}

async function openDatabase(path: string, journalMode: MemoryJournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await validateDatabaseParent(dirname(actual))
    await createDatabaseFile(actual)
    await validateDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = database.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version: version } = database.prepare('PRAGMA user_version').get() as { user_version: number }
    const userTables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    ).all() as Array<{ name: string }>
    if (applicationId !== 0 && applicationId !== MEMORY_DATABASE_APPLICATION_ID) {
      throw new Error(`memory-knowledge database at ${JSON.stringify(actual)} belongs to another application`)
    }
    if (applicationId === 0 && userTables.length === 0 && version !== 0) {
      throw new Error(`memory-knowledge database at ${JSON.stringify(actual)} has unknown unowned schema version ${version}`)
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new Error(`memory-knowledge database at ${JSON.stringify(actual)} is not empty`)
    }
    if (applicationId === MEMORY_DATABASE_APPLICATION_ID
      && ![
        SOURCE_RECORD_REBUILD_SCHEMA_VERSION,
        SOURCE_RECORD_SCHEMA_VERSION,
        CONVERSATION_EXTRACTION_SCHEMA_VERSION,
        SOURCE_EVIDENCE_SCHEMA_VERSION,
        AST_SOURCE_ANALYSIS_SCHEMA_VERSION,
        INCREMENTAL_SOURCE_SCHEMA_VERSION,
        SOURCE_RELATION_SCHEMA_VERSION,
        SOURCE_SYMBOL_SCHEMA_VERSION,
        SOURCE_TSCONFIG_SCHEMA_VERSION,
        WIKI_RUNTIME_V1_SCHEMA_VERSION,
        WIKI_RUNTIME_V2_SCHEMA_VERSION,
        WIKI_RUNTIME_V3_SCHEMA_VERSION,
        WIKI_RUNTIME_V4_SCHEMA_VERSION,
        WIKI_RUNTIME_V5_SCHEMA_VERSION,
        WIKI_RUNTIME_V6_SCHEMA_VERSION,
        WIKI_RUNTIME_V7_SCHEMA_VERSION,
        PRE_MATERIAL_BUDGET_SCHEMA_VERSION,
        PRE_KNOWLEDGE_VERSION_SCHEMA_VERSION,
        PRE_LOCAL_MEMORY_ENTRY_SCHEMA_VERSION,
        PRE_KNOWLEDGE_HUMAN_REVISION_SCHEMA_VERSION,
        MEMORY_DATABASE_SCHEMA_VERSION,
      ].includes(version)) {
      throw new Error(
        `memory-knowledge database at ${JSON.stringify(actual)} has schema version ${version}, expected ${MEMORY_DATABASE_SCHEMA_VERSION}`,
      )
    }
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    withTransaction(database, () => {
      const rebuildSourceRecords = applicationId === MEMORY_DATABASE_APPLICATION_ID
        && version >= SOURCE_RECORD_REBUILD_SCHEMA_VERSION
        && version <= SOURCE_SYMBOL_SCHEMA_VERSION
      if (rebuildSourceRecords) {
        database.exec('DELETE FROM source_records')
        database.exec('DELETE FROM source_understandings')
      }
      ensureSchema(database)
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V1_SCHEMA_VERSION) {
        migrateWikiRuntimeV1(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V2_SCHEMA_VERSION) {
        migrateWikiRuntimeV2(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V3_SCHEMA_VERSION) {
        migrateWikiRuntimeV3(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V4_SCHEMA_VERSION) {
        migrateWikiRuntimeV4(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V5_SCHEMA_VERSION) {
        migrateWikiRuntimeV5(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V6_SCHEMA_VERSION) {
        migrateWikiRuntimeV6(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID && version === WIKI_RUNTIME_V7_SCHEMA_VERSION) {
        migrateWikiRuntimeV7(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID
        && version >= SOURCE_RECORD_REBUILD_SCHEMA_VERSION
        && version <= PRE_LOCAL_MEMORY_ENTRY_SCHEMA_VERSION) {
        migrateLocalMemoryEntries(database)
      }
      if (applicationId === MEMORY_DATABASE_APPLICATION_ID
        && version >= SOURCE_RECORD_REBUILD_SCHEMA_VERSION
        && version <= PRE_KNOWLEDGE_HUMAN_REVISION_SCHEMA_VERSION) {
        migrateKnowledgeHumanRevisions(database)
      }
      if (rebuildSourceRecords) {
        database.exec('DELETE FROM source_evidence_fts')
        database.exec('DELETE FROM source_evidence_documents')
      }
      database.exec(`PRAGMA user_version = ${MEMORY_DATABASE_SCHEMA_VERSION}`)
    })
    return database
  } catch (error: unknown) {
    database.close()
    throw error
  }
}

function ensureSchema(database: DatabaseSync): void {
  database.exec(`PRAGMA application_id = ${MEMORY_DATABASE_APPLICATION_ID}`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id            TEXT PRIMARY KEY,
      status        TEXT NOT NULL,
      project_root  TEXT,
      fingerprint   TEXT NOT NULL,
      generation_key TEXT,
      updated_at    TEXT NOT NULL,
      payload_json  TEXT NOT NULL
    ) STRICT
  `)
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS candidate_live_fingerprint
    ON candidates(fingerprint)
    WHERE status IN ('pending', 'accepted')
  `)
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS candidate_generation_key
    ON candidates(generation_key)
    WHERE generation_key IS NOT NULL
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      document_key  TEXT PRIMARY KEY,
      owner         TEXT NOT NULL,
      record_id     TEXT NOT NULL,
      record_type   TEXT NOT NULL,
      project_root  TEXT,
      sensitivity   TEXT NOT NULL,
      status        TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      payload_json  TEXT NOT NULL
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS search_documents_record_id ON search_documents(record_id)')
  database.exec('CREATE INDEX IF NOT EXISTS search_documents_project_root ON search_documents(project_root)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id                  TEXT PRIMARY KEY,
      current_revision    INTEGER NOT NULL,
      applicability       TEXT NOT NULL,
      project_root        TEXT,
      status              TEXT NOT NULL,
      sensitivity         TEXT NOT NULL,
      source_candidate_id TEXT UNIQUE,
      updated_at          TEXT NOT NULL,
      payload_json        TEXT NOT NULL
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS memory_entries_project_root ON memory_entries(project_root)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_entry_revisions (
      memory_id      TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      revision       INTEGER NOT NULL,
      revision_kind  TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      payload_json   TEXT NOT NULL,
      PRIMARY KEY(memory_id, revision)
    ) STRICT
  `)
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      document_key UNINDEXED,
      title,
      content,
      tags,
      tokenize = 'trigram'
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS canonical_generations (
      project_root  TEXT PRIMARY KEY,
      fingerprint   TEXT NOT NULL
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_understandings (
      checkpoint_key TEXT PRIMARY KEY,
      project_root   TEXT NOT NULL,
      source_id      TEXT NOT NULL,
      inventory_hash TEXT NOT NULL,
      output_hash    TEXT NOT NULL,
      record_count   INTEGER NOT NULL,
      payload_json   TEXT NOT NULL,
      UNIQUE(project_root, source_id)
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_records (
      checkpoint_key TEXT NOT NULL REFERENCES source_understandings(checkpoint_key) ON DELETE CASCADE,
      path           TEXT NOT NULL,
      payload_json   TEXT NOT NULL,
      PRIMARY KEY(checkpoint_key, path)
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_relation_edges (
      edge_key        TEXT PRIMARY KEY,
      checkpoint_key  TEXT NOT NULL REFERENCES source_understandings(checkpoint_key) ON DELETE CASCADE,
      project_root    TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      commit_hash     TEXT NOT NULL,
      inventory_hash  TEXT NOT NULL,
      output_hash     TEXT NOT NULL,
      from_path       TEXT NOT NULL,
      from_content_hash TEXT NOT NULL,
      to_path         TEXT,
      specifier       TEXT NOT NULL,
      relation_kind   TEXT NOT NULL,
      resolution      TEXT NOT NULL,
      start_line      INTEGER NOT NULL,
      end_line        INTEGER NOT NULL
    ) STRICT
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_relation_project_from
    ON source_relation_edges(project_root, from_path)
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_relation_project_to
    ON source_relation_edges(project_root, to_path)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_symbol_definitions (
      definition_key    TEXT PRIMARY KEY,
      checkpoint_key    TEXT NOT NULL REFERENCES source_understandings(checkpoint_key) ON DELETE CASCADE,
      project_root      TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      commit_hash       TEXT NOT NULL,
      inventory_hash    TEXT NOT NULL,
      output_hash       TEXT NOT NULL,
      symbol_id         TEXT NOT NULL,
      symbol_name       TEXT NOT NULL,
      declaration_kind  TEXT NOT NULL,
      definition_path   TEXT NOT NULL,
      definition_content_hash TEXT NOT NULL,
      definition_start_line INTEGER NOT NULL,
      definition_end_line INTEGER NOT NULL,
      UNIQUE(checkpoint_key, symbol_id)
    ) STRICT
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_symbol_definition_project_path
    ON source_symbol_definitions(project_root, definition_path)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_symbol_references (
      reference_key     TEXT PRIMARY KEY,
      checkpoint_key    TEXT NOT NULL REFERENCES source_understandings(checkpoint_key) ON DELETE CASCADE,
      definition_key    TEXT NOT NULL REFERENCES source_symbol_definitions(definition_key) ON DELETE CASCADE,
      project_root      TEXT NOT NULL,
      reference_path    TEXT NOT NULL,
      reference_content_hash TEXT NOT NULL,
      reference_kind    TEXT NOT NULL,
      reference_start_line INTEGER NOT NULL,
      reference_end_line INTEGER NOT NULL
    ) STRICT
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_symbol_reference_project_path
    ON source_symbol_references(project_root, reference_path)
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_symbol_reference_project_kind
    ON source_symbol_references(project_root, reference_kind)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_evidence_documents (
      evidence_key    TEXT PRIMARY KEY,
      checkpoint_key  TEXT NOT NULL REFERENCES source_understandings(checkpoint_key) ON DELETE CASCADE,
      project_root    TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      commit_hash     TEXT NOT NULL,
      inventory_hash  TEXT NOT NULL,
      output_hash     TEXT NOT NULL,
      path            TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      area            TEXT NOT NULL,
      artifact_kind   TEXT NOT NULL,
      language        TEXT,
      evidence_kind   TEXT NOT NULL,
      evidence_name   TEXT NOT NULL,
      evidence_detail TEXT NOT NULL,
      start_line      INTEGER NOT NULL,
      end_line        INTEGER NOT NULL
    ) STRICT
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_evidence_project_root
    ON source_evidence_documents(project_root)
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS source_evidence_checkpoint
    ON source_evidence_documents(checkpoint_key)
  `)
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS source_evidence_fts USING fts5(
      evidence_key UNINDEXED,
      path,
      name,
      area,
      metadata,
      tokenize = 'trigram'
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_extractions (
      session_id       TEXT NOT NULL,
      extractor        TEXT NOT NULL,
      extractor_version INTEGER NOT NULL,
      through_seq      INTEGER NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY(session_id, extractor, extractor_version)
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_runs (
      id            TEXT PRIMARY KEY,
      project_root  TEXT NOT NULL,
      status        TEXT NOT NULL,
      catalog_hash  TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      payload_json  TEXT NOT NULL
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS wiki_runs_project_updated ON wiki_runs(project_root, updated_at DESC)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_coverage (
      run_id        TEXT NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      path          TEXT NOT NULL,
      status        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY(run_id, id),
      UNIQUE(run_id, source_id, path)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS wiki_coverage_run_status ON wiki_coverage(run_id, status)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_tasks (
      run_id        TEXT NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      shard_key     TEXT NOT NULL,
      status        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY(run_id, id),
      UNIQUE(run_id, shard_key)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS wiki_tasks_run_status ON wiki_tasks(run_id, status)')
  // Wiki 快照替换会删除再插入任务；独立账本不能随语义快照级联删除。
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_material_budgets (
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(run_id, task_id)
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_citations (
      run_id        TEXT NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY(run_id, id)
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_claims (
      run_id        TEXT NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      status        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY(run_id, id)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS wiki_claims_run_status ON wiki_claims(run_id, status)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_conflicts (
      run_id        TEXT NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      status        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY(run_id, id)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS wiki_conflicts_run_status ON wiki_conflicts(run_id, status)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      run_id        TEXT NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      slug          TEXT NOT NULL,
      status        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY(run_id, id),
      UNIQUE(run_id, slug)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS wiki_pages_run_status ON wiki_pages(run_id, status)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_generated_versions (
      id                TEXT PRIMARY KEY,
      project_root      TEXT NOT NULL,
      run_id            TEXT NOT NULL,
      run_snapshot_hash TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      payload_json      TEXT NOT NULL,
      UNIQUE(run_id, run_snapshot_hash)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS knowledge_generated_versions_project_created ON knowledge_generated_versions(project_root, created_at DESC)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_effective_versions (
      id                   TEXT PRIMARY KEY,
      project_root         TEXT NOT NULL,
      generated_version_id TEXT NOT NULL,
      run_id               TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      payload_json         TEXT NOT NULL
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS knowledge_effective_versions_project_created ON knowledge_effective_versions(project_root, created_at DESC)')
  database.exec('CREATE INDEX IF NOT EXISTS knowledge_effective_versions_generated ON knowledge_effective_versions(generated_version_id, created_at DESC)')
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_selections (
      project_root         TEXT PRIMARY KEY,
      revision             INTEGER NOT NULL,
      mode                 TEXT NOT NULL,
      analysis_generation  INTEGER NOT NULL,
      current_run_id       TEXT,
      effective_version_id TEXT,
      updated_at           TEXT NOT NULL,
      payload_json         TEXT NOT NULL
    ) STRICT
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_human_revisions (
      id                        TEXT PRIMARY KEY,
      request_id                TEXT NOT NULL,
      request_fingerprint       TEXT NOT NULL,
      project_root              TEXT NOT NULL,
      revision                  INTEGER NOT NULL,
      generated_version_id      TEXT NOT NULL,
      base_effective_version_id TEXT NOT NULL,
      effective_version_id      TEXT NOT NULL,
      page_id                   TEXT NOT NULL,
      created_at                TEXT NOT NULL,
      payload_json              TEXT NOT NULL,
      result_json               TEXT NOT NULL,
      UNIQUE(project_root, request_id),
      UNIQUE(project_root, revision)
    ) STRICT
  `)
  database.exec('CREATE INDEX IF NOT EXISTS knowledge_human_revisions_effective ON knowledge_human_revisions(project_root, effective_version_id)')
  database.exec('CREATE INDEX IF NOT EXISTS knowledge_human_revisions_page ON knowledge_human_revisions(project_root, page_id, revision DESC)')
}

function wikiChildPayloads(database: DatabaseSync, table: string, runId: WikiRunId): unknown[] {
  const rows = database.prepare(`SELECT payload_json FROM ${table} WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as unknown as WikiPayloadRow[]
  return rows.map(row => parseJson(`${table} row`, row.payload_json))
}

function wikiRunSnapshotFromDatabase(database: DatabaseSync, id: WikiRunId): WikiRunSnapshot | undefined {
  const row = database.prepare(`
    SELECT payload_json, snapshot_hash FROM wiki_runs WHERE id = ?
  `).get(id) as WikiRunRow | undefined
  if (row === undefined) return undefined
  return parseWikiRunSnapshot({
    schemaVersion: WIKI_RUN_SCHEMA_VERSION,
    run: parseJson('Wiki run row', row.payload_json),
    coverage: wikiChildPayloads(database, 'wiki_coverage', id),
    tasks: wikiChildPayloads(database, 'wiki_tasks', id),
    citations: wikiChildPayloads(database, 'wiki_citations', id),
    claims: wikiChildPayloads(database, 'wiki_claims', id),
    conflicts: wikiChildPayloads(database, 'wiki_conflicts', id),
    pages: wikiChildPayloads(database, 'wiki_pages', id),
    snapshotHash: row.snapshot_hash,
  })
}

function wikiTaskWithEmptyMaterialRanges(value: unknown, label: string): WikiShardTask {
  if (!isRecord(value)) throw new Error(`memory-knowledge: ${label} task cannot be migrated`)
  return { ...structuredClone(value), materialRanges: [] } as unknown as WikiShardTask
}

function wikiClaimWithEmptySources(value: unknown, label: string): WikiRunSnapshot['claims'][number] {
  if (!isRecord(value)) throw new Error(`memory-knowledge: ${label} Claim cannot be migrated`)
  return { ...structuredClone(value), sourceClaimIds: [] } as unknown as WikiRunSnapshot['claims'][number]
}

function updateWikiClaimPayloads(
  database: DatabaseSync,
  runId: WikiRunId,
  claims: readonly WikiRunSnapshot['claims'][number][],
): void {
  const updateClaim = database.prepare('UPDATE wiki_claims SET payload_json = ? WHERE run_id = ? AND id = ?')
  for (const claim of claims) updateClaim.run(JSON.stringify(claim), runId, claim.id)
}

function migrateLocalMemoryEntries(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT payload_json FROM candidates
    WHERE status IN ('accepted', 'promoted')
    ORDER BY updated_at ASC, id ASC
  `).all() as unknown as CandidateRow[]
  for (const row of rows) {
    const candidate = candidateFromJson(parseJson('candidate migration row', row.payload_json))
    if (candidate.target !== 'memory') continue
    const existing = localMemoryEntryFromRow(database.prepare(
      'SELECT payload_json FROM memory_entries WHERE source_candidate_id = ?',
    ).get(candidate.id) as LocalMemoryEntryRow | undefined)
    const localMemoryId = existing?.id
      ?? candidate.localMemoryId
      ?? (candidate.applicability === 'project' ? candidate.promotedMemoryId : undefined)
      ?? createMemoryId()
    if (existing === undefined) insertLocalMemoryEntry(database, localMemoryFromCandidate(candidate, localMemoryId), 'created')
    if (candidate.localMemoryId === undefined) {
      const updated: MemoryCandidate = { ...candidate, localMemoryId }
      database.prepare('UPDATE candidates SET payload_json = ? WHERE id = ?').run(JSON.stringify(updated), candidate.id)
    }
    deleteSearchDocument(database, documentKey(candidateSearchDocument(candidate)))
  }
}

function migrateKnowledgeHumanRevisions(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT payload_json FROM knowledge_effective_versions
    ORDER BY created_at ASC, id ASC
  `).all() as unknown as WikiPayloadRow[]
  const effectiveVersions = rows.map(row => parseKnowledgeEffectiveVersion(
    parseJson('knowledge effective version migration row', row.payload_json),
  ))
  database.exec('ALTER TABLE knowledge_effective_versions RENAME TO knowledge_effective_versions_pre_human_revision')
  database.exec(`
    CREATE TABLE knowledge_effective_versions (
      id                   TEXT PRIMARY KEY,
      project_root         TEXT NOT NULL,
      generated_version_id TEXT NOT NULL,
      run_id               TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      payload_json         TEXT NOT NULL
    ) STRICT
  `)
  const insert = database.prepare(`
    INSERT INTO knowledge_effective_versions (
      id, project_root, generated_version_id, run_id, created_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const effective of effectiveVersions) {
    insert.run(
      effective.id,
      effective.projectRoot,
      effective.generatedVersionId,
      effective.runId,
      effective.createdAt,
      JSON.stringify(effective),
    )
  }
  database.exec('DROP TABLE knowledge_effective_versions_pre_human_revision')
  database.exec('CREATE INDEX knowledge_effective_versions_project_created ON knowledge_effective_versions(project_root, created_at DESC)')
  database.exec('CREATE INDEX knowledge_effective_versions_generated ON knowledge_effective_versions(generated_version_id, created_at DESC)')
}

function migrateWikiRuntimeV1(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  const insertTask = database.prepare(`
    INSERT INTO wiki_tasks (run_id, id, shard_key, status, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `)
  const updateRun = database.prepare(`
    UPDATE wiki_runs
    SET status = ?, catalog_hash = ?, snapshot_hash = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    const rawRun = parseJson('Wiki v1 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 1 || rawRun['id'] !== row.id
      || (rawRun['status'] !== 'planned' && rawRun['status'] !== 'blocked')
      || rawRun['agentSessionId'] !== undefined) {
      throw new Error('memory-knowledge: Wiki v1 run cannot be migrated without changing active execution state')
    }
    const runId = WikiRunId(row.id)
    const coverage = wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage']
    const tasks: WikiShardTask[] = []
    if (rawRun['status'] !== 'blocked') {
      const byShard = new Map<string, WikiCoverageId[]>()
      for (const value of coverage as unknown[]) {
        if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['shardKey'] !== 'string'
          || !['pending', 'analyzing', 'analyzed', 'deferred', 'excluded', 'blocked', 'stale'].includes(
            typeof value['status'] === 'string' ? value['status'] : '',
          )) {
          throw new Error('memory-knowledge: Wiki v1 coverage cannot be migrated')
        }
        if (!['pending', 'analyzing', 'analyzed'].includes(value['status'] as string)) continue
        const ids = byShard.get(value['shardKey']) ?? []
        ids.push(WikiCoverageId(value['id']))
        byShard.set(value['shardKey'], ids)
      }
      for (const [shardKey, coverageIds] of byShard) {
        tasks.push({
          id: wikiTaskId(runId, shardKey),
          runId,
          kind: 'analysis',
          shardKey,
          coverageIds: coverageIds.sort((left, right) => compareText(String(left), String(right))),
          claimIds: [],
          candidatePairs: [],
          materialRanges: [],
          status: 'planned',
          attemptCount: 0,
          createdAt: String(rawRun['createdAt']),
          updatedAt: String(rawRun['updatedAt']),
        })
      }
    }
    const migratedRun = structuredClone(rawRun)
    migratedRun['schemaVersion'] = WIKI_RUN_SCHEMA_VERSION
    migratedRun['tasks'] = summarizeWikiTasks(tasks)
    migratedRun['materialRanges'] = summarizeWikiMaterialRanges(tasks)
    migratedRun['fileSynthesis'] = createUnassessedWikiFileSynthesisSummary()
    migratedRun['consistency'] = createUnplannedWikiConsistencySummary()
    migratedRun['pageGeneration'] = createUnplannedWikiPageGenerationSummary()
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: migratedRun as unknown as WikiRun,
      coverage,
      tasks,
      citations: wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations'],
      claims: wikiChildPayloads(database, 'wiki_claims', runId)
        .map(value => wikiClaimWithEmptySources(value, 'Wiki v1')),
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages: wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages'],
    })
    for (const task of migrated.tasks) {
      insertTask.run(runId, task.id, task.shardKey, task.status, JSON.stringify(task))
    }
    updateWikiClaimPayloads(database, runId, migrated.claims)
    updateRun.run(
      migrated.run.status,
      migrated.run.catalogHash,
      migrated.snapshotHash,
      migrated.run.updatedAt,
      JSON.stringify(migrated.run),
      runId,
    )
  }
}

function migrateWikiRuntimeV2(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  const deleteTasks = database.prepare('DELETE FROM wiki_tasks WHERE run_id = ?')
  const insertTask = database.prepare(`
    INSERT INTO wiki_tasks (run_id, id, shard_key, status, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `)
  const updatePage = database.prepare(`
    UPDATE wiki_pages SET status = ?, payload_json = ? WHERE run_id = ? AND id = ?
  `)
  const updateRun = database.prepare(`
    UPDATE wiki_runs
    SET status = ?, catalog_hash = ?, snapshot_hash = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    const rawRun = parseJson('Wiki v2 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 2 || rawRun['id'] !== row.id) {
      throw new Error('memory-knowledge: Wiki v2 run cannot be migrated')
    }
    const runId = WikiRunId(row.id)
    const coverage = wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage']
    const rawTasks = wikiChildPayloads(database, 'wiki_tasks', runId)
    const tasks: WikiShardTask[] = rawTasks.map(value => {
      if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['shardKey'] !== 'string'
        || !Array.isArray(value['coverageIds'])) {
        throw new Error('memory-knowledge: Wiki v2 task cannot be migrated')
      }
      return {
        ...structuredClone(value),
        kind: 'analysis',
        claimIds: [],
        candidatePairs: [],
        materialRanges: [],
      } as unknown as WikiShardTask
    })
    const claims = wikiChildPayloads(database, 'wiki_claims', runId)
      .map(value => wikiClaimWithEmptySources(value, 'Wiki v2'))
    const citations = wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations']
    const pages = (wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages'])
      .map(page => ({ ...structuredClone(page), status: 'stale' as const, legacy: true as const }))
    const migratedRun = structuredClone(rawRun)
    migratedRun['schemaVersion'] = WIKI_RUN_SCHEMA_VERSION
    migratedRun['fileSynthesis'] = createUnassessedWikiFileSynthesisSummary()
    migratedRun['consistency'] = createUnplannedWikiConsistencySummary()
    migratedRun['pageGeneration'] = createUnplannedWikiPageGenerationSummary()
    migratedRun['rootPageIds'] = []
    if (migratedRun['status'] === 'verifying') {
      if (!tasks.every(task => task.status === 'succeeded')) {
        throw new Error('memory-knowledge: Wiki v2 verifying run has incomplete analysis tasks')
      }
      const verification = createWikiVerificationTasks(
        runId,
        coverage,
        claims,
        String(rawRun['updatedAt']),
      )
      tasks.push(...verification)
      if (verification.length === 0) {
        const consistency = createWikiConsistencyTasks(
          runId,
          coverage,
          citations,
          claims,
          tasks,
          String(rawRun['updatedAt']),
        )
        tasks.push(...consistency.tasks)
        migratedRun['consistency'] = consistency.summary
        if (consistency.tasks.length === 0) {
          const pageGeneration = createWikiPageTasks(runId, coverage, claims, String(rawRun['updatedAt']))
          tasks.push(...pageGeneration.tasks)
          migratedRun['pageGeneration'] = pageGeneration.summary
          migratedRun['status'] = pageGeneration.tasks.length === 0 ? 'needs-review' : 'synthesizing'
        }
      }
    }
    migratedRun['tasks'] = summarizeWikiTasks(tasks)
    migratedRun['materialRanges'] = summarizeWikiMaterialRanges(tasks)
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: migratedRun as unknown as WikiRun,
      coverage,
      tasks,
      citations,
      claims,
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages,
    })
    deleteTasks.run(runId)
    for (const task of migrated.tasks) {
      insertTask.run(runId, task.id, task.shardKey, task.status, JSON.stringify(task))
    }
    for (const page of migrated.pages) {
      updatePage.run(page.status, JSON.stringify(page), runId, page.id)
    }
    updateWikiClaimPayloads(database, runId, migrated.claims)
    updateRun.run(
      migrated.run.status,
      migrated.run.catalogHash,
      migrated.snapshotHash,
      migrated.run.updatedAt,
      JSON.stringify(migrated.run),
      runId,
    )
  }
}

function migrateWikiRuntimeV3(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  const deleteTasks = database.prepare('DELETE FROM wiki_tasks WHERE run_id = ?')
  const insertTask = database.prepare(`
    INSERT INTO wiki_tasks (run_id, id, shard_key, status, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `)
  const updatePage = database.prepare(`
    UPDATE wiki_pages SET status = ?, payload_json = ? WHERE run_id = ? AND id = ?
  `)
  const updateRun = database.prepare(`
    UPDATE wiki_runs
    SET status = ?, catalog_hash = ?, snapshot_hash = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    const rawRun = parseJson('Wiki v3 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 3 || rawRun['id'] !== row.id) {
      throw new Error('memory-knowledge: Wiki v3 run cannot be migrated')
    }
    const runId = WikiRunId(row.id)
    const coverage = wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage']
    const citations = wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations']
    const claims = wikiChildPayloads(database, 'wiki_claims', runId)
      .map(value => wikiClaimWithEmptySources(value, 'Wiki v3'))
    let pages = wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages']
    let tasks = wikiChildPayloads(database, 'wiki_tasks', runId).map(value => {
      if (!isRecord(value) || typeof value['kind'] !== 'string' || !Array.isArray(value['claimIds'])) {
        throw new Error('memory-knowledge: Wiki v3 task cannot be migrated')
      }
      return { ...structuredClone(value), candidatePairs: [], materialRanges: [] } as unknown as WikiShardTask
    })
    const migratedRun = structuredClone(rawRun)
    migratedRun['schemaVersion'] = WIKI_RUN_SCHEMA_VERSION
    migratedRun['fileSynthesis'] = createUnassessedWikiFileSynthesisSummary()
    migratedRun['consistency'] = createUnplannedWikiConsistencySummary()
    migratedRun['pageGeneration'] = createUnplannedWikiPageGenerationSummary()
    if (migratedRun['status'] === 'needs-review' || migratedRun['status'] === 'complete') {
      const verification = tasks.filter(task => task.kind === 'verification')
      if (verification.some(task => task.status !== 'succeeded')) {
        throw new Error('memory-knowledge: reviewed Wiki v3 run has incomplete verification tasks')
      }
      const consistency = createWikiConsistencyTasks(
        runId,
        coverage,
        citations,
        claims,
        tasks,
        String(rawRun['updatedAt']),
      )
      tasks = [...tasks, ...consistency.tasks]
      migratedRun['consistency'] = consistency.summary
      if (consistency.tasks.length === 0) {
        const pageGeneration = createWikiPageTasks(runId, coverage, claims, String(rawRun['updatedAt']))
        tasks = [...tasks, ...pageGeneration.tasks]
        migratedRun['pageGeneration'] = pageGeneration.summary
        migratedRun['status'] = pageGeneration.tasks.length === 0 ? 'needs-review' : 'synthesizing'
      } else {
        migratedRun['status'] = 'verifying'
      }
      migratedRun['rootPageIds'] = []
      pages = pages.map(page => ({ ...structuredClone(page), status: 'stale', legacy: true }))
      delete migratedRun['completedAt']
    }
    migratedRun['tasks'] = summarizeWikiTasks(tasks)
    migratedRun['materialRanges'] = summarizeWikiMaterialRanges(tasks)
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: migratedRun as unknown as WikiRun,
      coverage,
      tasks,
      citations,
      claims,
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages,
    })
    deleteTasks.run(runId)
    for (const task of migrated.tasks) {
      insertTask.run(runId, task.id, task.shardKey, task.status, JSON.stringify(task))
    }
    for (const page of migrated.pages) {
      updatePage.run(page.status, JSON.stringify(page), runId, page.id)
    }
    updateWikiClaimPayloads(database, runId, migrated.claims)
    updateRun.run(
      migrated.run.status,
      migrated.run.catalogHash,
      migrated.snapshotHash,
      migrated.run.updatedAt,
      JSON.stringify(migrated.run),
      runId,
    )
  }
}

function migrateWikiRuntimeV4(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  const deleteTasks = database.prepare('DELETE FROM wiki_tasks WHERE run_id = ?')
  const insertTask = database.prepare(`
    INSERT INTO wiki_tasks (run_id, id, shard_key, status, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `)
  const updatePage = database.prepare(`
    UPDATE wiki_pages SET status = ?, payload_json = ? WHERE run_id = ? AND id = ?
  `)
  const updateRun = database.prepare(`
    UPDATE wiki_runs
    SET status = ?, catalog_hash = ?, snapshot_hash = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    const rawRun = parseJson('Wiki v4 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 4 || rawRun['id'] !== row.id) {
      throw new Error('memory-knowledge: Wiki v4 run cannot be migrated')
    }
    const runId = WikiRunId(row.id)
    const coverage = wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage']
    const citations = wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations']
    const claims = wikiChildPayloads(database, 'wiki_claims', runId)
      .map(value => wikiClaimWithEmptySources(value, 'Wiki v4'))
    let tasks = wikiChildPayloads(database, 'wiki_tasks', runId)
      .map(value => wikiTaskWithEmptyMaterialRanges(value, 'Wiki v4'))
    const pages = (wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages'])
      .map(page => ({ ...structuredClone(page), status: 'stale' as const, legacy: true as const }))
    const migratedRun = structuredClone(rawRun)
    migratedRun['schemaVersion'] = WIKI_RUN_SCHEMA_VERSION
    migratedRun['fileSynthesis'] = createUnassessedWikiFileSynthesisSummary()
    migratedRun['pageGeneration'] = createUnplannedWikiPageGenerationSummary()
    migratedRun['rootPageIds'] = []
    if (migratedRun['status'] === 'needs-review' || migratedRun['status'] === 'complete') {
      const consistency = tasks.filter(task => task.kind === 'consistency')
      if (!isRecord(migratedRun['consistency']) || migratedRun['consistency']['planned'] !== true
        || consistency.some(task => task.status !== 'succeeded')) {
        throw new Error('memory-knowledge: reviewed Wiki v4 run has incomplete consistency verification')
      }
      const pageGeneration = createWikiPageTasks(runId, coverage, claims, String(rawRun['updatedAt']))
      tasks = [...tasks, ...pageGeneration.tasks]
      migratedRun['pageGeneration'] = pageGeneration.summary
      migratedRun['status'] = pageGeneration.tasks.length === 0 ? 'needs-review' : 'synthesizing'
      delete migratedRun['completedAt']
    }
    migratedRun['tasks'] = summarizeWikiTasks(tasks)
    migratedRun['materialRanges'] = summarizeWikiMaterialRanges(tasks)
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: migratedRun as unknown as WikiRun,
      coverage,
      tasks,
      citations,
      claims,
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages,
    })
    deleteTasks.run(runId)
    for (const task of migrated.tasks) {
      insertTask.run(runId, task.id, task.shardKey, task.status, JSON.stringify(task))
    }
    for (const page of migrated.pages) {
      updatePage.run(page.status, JSON.stringify(page), runId, page.id)
    }
    updateWikiClaimPayloads(database, runId, migrated.claims)
    updateRun.run(
      migrated.run.status,
      migrated.run.catalogHash,
      migrated.snapshotHash,
      migrated.run.updatedAt,
      JSON.stringify(migrated.run),
      runId,
    )
  }
}

function migrateWikiRuntimeV5(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  const updateTask = database.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE run_id = ? AND id = ?')
  const updateRun = database.prepare(`
    UPDATE wiki_runs
    SET status = ?, catalog_hash = ?, snapshot_hash = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    const rawRun = parseJson('Wiki v5 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 5 || rawRun['id'] !== row.id) {
      throw new Error('memory-knowledge: Wiki v5 run cannot be migrated')
    }
    const runId = WikiRunId(row.id)
    const tasks = wikiChildPayloads(database, 'wiki_tasks', runId)
      .map(value => wikiTaskWithEmptyMaterialRanges(value, 'Wiki v5'))
    const migratedRun = structuredClone(rawRun)
    migratedRun['schemaVersion'] = WIKI_RUN_SCHEMA_VERSION
    migratedRun['materialRanges'] = summarizeWikiMaterialRanges(tasks)
    migratedRun['fileSynthesis'] = createUnassessedWikiFileSynthesisSummary()
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: migratedRun as unknown as WikiRun,
      coverage: wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage'],
      tasks,
      citations: wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations'],
      claims: wikiChildPayloads(database, 'wiki_claims', runId)
        .map(value => wikiClaimWithEmptySources(value, 'Wiki v5')),
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages: wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages'],
    })
    for (const task of migrated.tasks) updateTask.run(JSON.stringify(task), runId, task.id)
    updateWikiClaimPayloads(database, runId, migrated.claims)
    updateRun.run(
      migrated.run.status,
      migrated.run.catalogHash,
      migrated.snapshotHash,
      migrated.run.updatedAt,
      JSON.stringify(migrated.run),
      runId,
    )
  }
}

function migrateWikiRuntimeV6(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  const updateRun = database.prepare(`
    UPDATE wiki_runs
    SET status = ?, catalog_hash = ?, snapshot_hash = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    const rawRun = parseJson('Wiki v6 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 6 || rawRun['id'] !== row.id) {
      throw new Error('memory-knowledge: Wiki v6 run cannot be migrated')
    }
    const runId = WikiRunId(row.id)
    const migratedRun = structuredClone(rawRun)
    migratedRun['schemaVersion'] = WIKI_RUN_SCHEMA_VERSION
    migratedRun['fileSynthesis'] = createUnassessedWikiFileSynthesisSummary()
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: migratedRun as unknown as WikiRun,
      coverage: wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage'],
      tasks: wikiChildPayloads(database, 'wiki_tasks', runId) as WikiRunSnapshot['tasks'],
      citations: wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations'],
      claims: wikiChildPayloads(database, 'wiki_claims', runId)
        .map(value => wikiClaimWithEmptySources(value, 'Wiki v6')),
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages: wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages'],
    })
    updateWikiClaimPayloads(database, runId, migrated.claims)
    updateRun.run(
      migrated.run.status,
      migrated.run.catalogHash,
      migrated.snapshotHash,
      migrated.run.updatedAt,
      JSON.stringify(migrated.run),
      runId,
    )
  }
}

function migrateWikiRuntimeV7(database: DatabaseSync): void {
  const rows = database.prepare('SELECT id, payload_json FROM wiki_runs ORDER BY id ASC')
    .all() as Array<{ id: string; payload_json: string }>
  for (const row of rows) {
    const rawRun = parseJson('Wiki v7 run row', row.payload_json)
    if (!isRecord(rawRun) || rawRun['schemaVersion'] !== 7 || rawRun['id'] !== row.id) {
      throw new Error('memory-knowledge: Wiki v7 run cannot be migrated')
    }
    const runId = WikiRunId(row.id)
    const tasks = wikiChildPayloads(database, 'wiki_tasks', runId) as WikiShardTask[]
    const byFile = Map.groupBy(tasks.filter(task => task.kind === 'file-synthesis'), task => String(task.coverageIds[0]))
    for (const fileTasks of byFile.values()) {
      fileTasks.sort((left, right) => compareText(left.shardKey, right.shardKey))
      for (const [index, task] of fileTasks.entries()) {
        task.fileSynthesis = { level: 0, batchIndex: index, batchCount: fileTasks.length }
      }
    }
    const claims = wikiChildPayloads(database, 'wiki_claims', runId) as WikiRunSnapshot['claims']
    for (const claim of claims) {
      if (!Array.isArray(claim.sourceClaimIds)) throw new Error('memory-knowledge: Wiki v7 Claim sources are invalid')
      if (claim.sourceClaimIds.length === 0) continue
      const owners = tasks.filter(task => task.kind === 'file-synthesis' && task.status === 'succeeded'
        && claim.sourceClaimIds.every(id => task.claimIds.includes(id)))
      if (owners.length !== 1) throw new Error('memory-knowledge: Wiki v7 综合声明没有唯一来源任务')
      claim.sourceTaskId = owners[0]!.id
    }
    const migrated = finalizeWikiRunSnapshot({
      schemaVersion: WIKI_RUN_SCHEMA_VERSION,
      run: { ...rawRun, schemaVersion: WIKI_RUN_SCHEMA_VERSION,
        fileSynthesis: createUnassessedWikiFileSynthesisSummary(tasks) } as unknown as WikiRun,
      coverage: wikiChildPayloads(database, 'wiki_coverage', runId) as WikiRunSnapshot['coverage'],
      tasks, claims,
      citations: wikiChildPayloads(database, 'wiki_citations', runId) as WikiRunSnapshot['citations'],
      conflicts: wikiChildPayloads(database, 'wiki_conflicts', runId) as WikiRunSnapshot['conflicts'],
      pages: wikiChildPayloads(database, 'wiki_pages', runId) as WikiRunSnapshot['pages'],
    })
    for (const task of tasks) {
      database.prepare('UPDATE wiki_tasks SET payload_json = ? WHERE run_id = ? AND id = ?')
        .run(JSON.stringify(task), runId, task.id)
    }
    updateWikiClaimPayloads(database, runId, claims)
    database.prepare('UPDATE wiki_runs SET snapshot_hash = ?, payload_json = ? WHERE id = ?')
      .run(migrated.snapshotHash, JSON.stringify(migrated.run), runId)
  }
}

function normalizedText(value: string, label: string): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
  if (normalized.length === 0) throw new Error(`memory-knowledge: ${label} must not be empty`)
  return normalized
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(tag => normalizedText(tag, 'tag')))].sort(compareText)
}

function normalizedMemoryIds(values: readonly MemoryId[], self: MemoryId, label: string): MemoryId[] {
  const normalized = [...new Set(values.map(String))].sort(compareText)
  if (normalized.includes(self)) throw new Error(`memory-knowledge: local memory cannot ${label} itself`)
  if (normalized.some(value => !new RegExp(MEMORY_ID_PATTERN, 'u').test(value))) {
    throw new Error(`memory-knowledge: local memory ${label} contains an invalid id`)
  }
  return normalized.map(MemoryId)
}

function candidateFingerprint(input: SaveMemoryCandidateInput): string {
  return createHash('sha256').update(JSON.stringify({
    target: input.target,
    applicability: input.applicability,
    ...input.projectRoot === undefined ? {} : { projectRoot: resolve(input.projectRoot) },
    kind: input.kind,
    title: normalizedText(input.title, 'title'),
    content: normalizedText(input.content, 'content'),
    tags: normalizedTags(input.tags),
    sensitivity: input.sensitivity,
  })).digest('hex')
}

function knowledgeCandidateFingerprint(input: SaveKnowledgeCardCandidateInput): string {
  return createHash('sha256').update(input.generation.key).digest('hex')
}

function assertExtractionKey(
  request: Pick<PrepareConversationExtractionRequest, 'sessionId' | 'extractor' | 'version'>,
): void {
  normalizedText(request.sessionId, 'conversation extraction sessionId')
  normalizedText(request.extractor, 'conversation extraction extractor')
  if (!Number.isSafeInteger(request.version) || request.version < 1) {
    throw new Error('memory-knowledge: conversation extraction version must be a positive safe integer')
  }
}

function extractionCheckpointFromRow(row: ConversationExtractionRow): ConversationExtractionCheckpoint {
  return {
    sessionId: row.session_id as ConversationExtractionCheckpoint['sessionId'],
    extractor: row.extractor,
    version: row.extractor_version,
    throughSeq: row.through_seq,
    updatedAt: row.updated_at,
  }
}

function assertConversationCandidate(request: RecordConversationExtractionRequest): void {
  if (request.candidate === undefined) return
  const candidate = request.candidate
  if (candidate.target !== 'memory' || candidate.suggestedBy !== 'conversation') {
    throw new Error('memory-knowledge: conversation extraction candidate has an invalid producer')
  }
  if (candidate.provenance.length !== 1 || candidate.provenance[0]?.kind !== 'session') {
    throw new Error('memory-knowledge: conversation extraction candidate requires one session provenance reference')
  }
  const provenance = candidate.provenance[0]
  if (provenance.sessionId !== request.sessionId || provenance.eventSeqs.length === 0
    || provenance.eventSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq > request.turnEndSeq)) {
    throw new Error('memory-knowledge: conversation extraction candidate provenance does not match the checkpoint')
  }
}

function parseJson(label: string, value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error: unknown) {
    throw new Error(`memory-knowledge: invalid JSON in ${label}`, { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`memory-knowledge: candidate.${key} is invalid`)
  return value
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`memory-knowledge: candidate.${key} is invalid`)
  return value
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`memory-knowledge: candidate.${key} is invalid`)
  }
  return [...value]
}

function candidateFromJson(value: unknown): ReviewCandidate {
  if (!isRecord(value)) throw new Error('memory-knowledge: candidate payload must be an object')
  const id = stringField(value, 'id')
  if (!new RegExp(MEMORY_CANDIDATE_ID_PATTERN, 'u').test(id)) throw new Error('memory-knowledge: candidate.id is invalid')
  const revision = value['revision']
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('memory-knowledge: candidate.revision is invalid')
  const applicabilityValue = stringField(value, 'applicability')
  if (applicabilityValue !== 'global' && applicabilityValue !== 'project') throw new Error('memory-knowledge: candidate.applicability is invalid')
  const applicability: ReviewCandidate['applicability'] = applicabilityValue
  const projectRoot = optionalStringField(value, 'projectRoot')
  if ((applicability === 'project') !== (projectRoot !== undefined) || (projectRoot !== undefined && !isAbsolute(projectRoot))) {
    throw new Error('memory-knowledge: candidate.projectRoot is inconsistent with applicability')
  }
  const kind = stringField(value, 'kind')
  const sensitivityValue = stringField(value, 'sensitivity')
  if (sensitivityValue !== 'normal' && sensitivityValue !== 'restricted') throw new Error('memory-knowledge: candidate.sensitivity is invalid')
  const sensitivity: ReviewCandidate['sensitivity'] = sensitivityValue
  const status = stringField(value, 'status')
  if (!['pending', 'accepted', 'rejected', 'promoted'].includes(status)) {
    throw new Error('memory-knowledge: candidate.status is invalid')
  }
  const suggestedBy = stringField(value, 'suggestedBy')
  const provenance = value['provenance']
  assertProvenanceRefs(provenance)
  const createdAt = stringField(value, 'createdAt')
  const updatedAt = stringField(value, 'updatedAt')
  const reviewedAt = optionalStringField(value, 'reviewedAt')
  const common = {
    id: MemoryCandidateId(id),
    revision: revision as number,
    applicability,
    ...projectRoot === undefined ? {} : { projectRoot },
    title: stringField(value, 'title'),
    content: stringField(value, 'content'),
    tags: stringArrayField(value, 'tags'),
    sensitivity,
    status: status as ReviewCandidate['status'],
    provenance,
    createdAt,
    updatedAt,
    ...reviewedAt === undefined ? {} : { reviewedAt },
  }
  const target = stringField(value, 'target')
  if (target === 'memory') {
    if (!['fact', 'decision', 'lesson', 'method', 'preference', 'constraint'].includes(kind)) {
      throw new Error('memory-knowledge: candidate.kind is invalid')
    }
    if (suggestedBy !== 'model' && suggestedBy !== 'human' && suggestedBy !== 'conversation') {
      throw new Error('memory-knowledge: candidate.suggestedBy is invalid')
    }
    const localMemoryId = optionalStringField(value, 'localMemoryId')
    const promotedMemoryId = optionalStringField(value, 'promotedMemoryId')
    if (localMemoryId !== undefined && !new RegExp(MEMORY_ID_PATTERN, 'u').test(localMemoryId)) {
      throw new Error('memory-knowledge: candidate.localMemoryId is invalid')
    }
    return {
      ...common,
      target,
      kind: kind as MemoryCandidate['kind'],
      suggestedBy,
      ...localMemoryId === undefined ? {} : { localMemoryId: MemoryId(localMemoryId) },
      ...promotedMemoryId === undefined ? {} : { promotedMemoryId: promotedMemoryId as MemoryId },
    }
  }
  if (target !== 'knowledge-card') throw new Error('memory-knowledge: candidate.target is invalid')
  if (applicability !== 'project' || projectRoot === undefined || sensitivity !== 'normal'
    || (suggestedBy !== 'inventory' && suggestedBy !== 'wiki')) {
    throw new Error('memory-knowledge: Knowledge Card candidate review fields are invalid')
  }
  if (!['overview', 'architecture', 'module', 'flow', 'decision', 'stack'].includes(kind)) {
    throw new Error('memory-knowledge: candidate.kind is invalid')
  }
  const generationValue = value['generation']
  if (!isRecord(generationValue)) throw new Error('memory-knowledge: candidate.generation is invalid')
  const generator = stringField(generationValue, 'generator')
  const generationVersion = generationValue['version']
  const sourceId = stringField(generationValue, 'sourceId')
  const inputHash = optionalStringField(generationValue, 'inputHash')
  const inventoryHash = optionalStringField(generationValue, 'inventoryHash')
  const catalogHash = optionalStringField(generationValue, 'catalogHash')
  if ((generator !== 'source-inventory' && generator !== 'source-record-map' && generator !== 'source-evidence-map'
    && generator !== 'wiki-page')
    || !Number.isSafeInteger(generationVersion) || (generationVersion as number) < 1
    || !new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u').test(sourceId)) {
    throw new Error('memory-knowledge: candidate.generation is invalid')
  }
  if ((generator !== 'source-inventory') !== (inputHash !== undefined)
    || (inputHash !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(inputHash))) {
    throw new Error('memory-knowledge: candidate.generation input hash is invalid')
  }
  if ((generator === 'wiki-page') !== (suggestedBy === 'wiki')) {
    throw new Error('memory-knowledge: Wiki Page candidates must use the wiki producer')
  }
  if (generator !== 'wiki-page' && suggestedBy !== 'inventory') {
    throw new Error('memory-knowledge: Source candidates must use the inventory producer')
  }
  const validCheckpointHash = (value: string | undefined): boolean => (
    value === undefined || /^sha256:[0-9a-f]{64}$/u.test(value)
  )
  if (!validCheckpointHash(inventoryHash) || !validCheckpointHash(catalogHash)
    || (generator === 'wiki-page'
      ? (inventoryHash === undefined) === (catalogHash === undefined)
      : inventoryHash === undefined || catalogHash !== undefined)) {
    throw new Error('memory-knowledge: candidate generation checkpoint is invalid')
  }
  const generation: KnowledgeCandidateGeneration = {
    key: stringField(generationValue, 'key'),
    generator,
    version: generationVersion as number,
    sourceId: KnowledgeSourceId(sourceId),
    ...inventoryHash === undefined ? {} : { inventoryHash },
    ...catalogHash === undefined ? {} : { catalogHash },
    ...inputHash === undefined ? {} : { inputHash },
  }
  const draftValue = value['card']
  if (!isRecord(draftValue)) throw new Error('memory-knowledge: candidate.card is invalid')
  const targetCardId = optionalStringField(draftValue, 'targetCardId')
  const baseRevision = draftValue['baseRevision']
  if ((baseRevision !== undefined && targetCardId === undefined)
    || (targetCardId !== undefined && !new RegExp(KNOWLEDGE_CARD_ID_PATTERN, 'u').test(targetCardId))
    || (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 1))) {
    throw new Error('memory-knowledge: candidate.card target revision is invalid')
  }
  const synthetic: KnowledgeCard = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    id: KnowledgeCardId(targetCardId ?? 'card_00000000-0000-4000-8000-000000000000'),
    revision: baseRevision === undefined ? 1 : (baseRevision as number) + 1,
    scope: draftValue['scope'] as KnowledgeCard['scope'],
    kind: draftValue['kind'] as KnowledgeCard['kind'],
    title: common.title,
    summary: draftValue['summary'] as string,
    sections: draftValue['sections'] as KnowledgeCard['sections'],
    provenance: draftValue['provenance'] as KnowledgeCard['provenance'],
    sourceRevisions: draftValue['sourceRevisions'] as KnowledgeCard['sourceRevisions'],
    status: 'needs-review',
    evidenceClass: draftValue['evidenceClass'] as KnowledgeCard['evidenceClass'],
    createdAt,
    updatedAt,
  }
  assertKnowledgeCard(synthetic)
  if (synthetic.kind !== kind || synthetic.scope.kind !== 'source' || synthetic.scope.sourceId !== generation.sourceId
    || synthetic.sourceRevisions.length !== 1 || synthetic.sourceRevisions[0]!.sourceId !== generation.sourceId
    || synthetic.sourceRevisions[0]!.inventoryHash !== generation.inventoryHash
    || synthetic.sourceRevisions[0]!.catalogHash !== generation.catalogHash) {
    throw new Error('memory-knowledge: candidate.card does not match its generation checkpoint')
  }
  const sourceRevision = synthetic.sourceRevisions[0]!
  const topLevelProvenance = synthetic.provenance
  if (JSON.stringify(common.provenance) !== JSON.stringify(topLevelProvenance)
    || topLevelProvenance.length !== 1
    || topLevelProvenance[0]!.kind !== 'git-commit'
    || topLevelProvenance[0]!.sourceId !== generation.sourceId
    || topLevelProvenance[0]!.commit !== sourceRevision.commit) {
    throw new Error('memory-knowledge: candidate provenance does not match its generation checkpoint')
  }
  for (const reference of synthetic.sections.flatMap(section => section.provenance)) {
    if (reference.kind === 'session' || reference.sourceId !== generation.sourceId
      || ((reference.kind === 'git-file' || reference.kind === 'git-commit') && reference.commit !== sourceRevision.commit)) {
      throw new Error('memory-knowledge: candidate section provenance does not match its generation checkpoint')
    }
  }
  const card: KnowledgeCardDraft = {
    ...targetCardId === undefined ? {} : { targetCardId: KnowledgeCardId(targetCardId) },
    ...baseRevision === undefined ? {} : { baseRevision: baseRevision as number },
    scope: structuredClone(synthetic.scope),
    kind: synthetic.kind,
    summary: synthetic.summary,
    sections: structuredClone(synthetic.sections),
    provenance: structuredClone(synthetic.provenance),
    sourceRevisions: structuredClone(synthetic.sourceRevisions),
    evidenceClass: synthetic.evidenceClass,
  }
  const promotedKnowledgeCardId = optionalStringField(value, 'promotedKnowledgeCardId')
  if (promotedKnowledgeCardId !== undefined && !new RegExp(KNOWLEDGE_CARD_ID_PATTERN, 'u').test(promotedKnowledgeCardId)) {
    throw new Error('memory-knowledge: candidate.promotedKnowledgeCardId is invalid')
  }
  return {
    ...common,
    target,
    applicability,
    projectRoot,
    kind: kind as KnowledgeCardCandidate['kind'],
    sensitivity,
    suggestedBy,
    generation,
    card,
    ...promotedKnowledgeCardId === undefined ? {} : { promotedKnowledgeCardId: KnowledgeCardId(promotedKnowledgeCardId) },
  }
}

function candidateFromRow(row: CandidateRow | undefined): ReviewCandidate | undefined {
  return row === undefined ? undefined : candidateFromJson(parseJson('candidate row', row.payload_json))
}

function localMemoryEntryFromJson(value: unknown): LocalMemoryEntry {
  if (!isRecord(value)) throw new Error('memory-knowledge: local memory payload must be an object')
  const id = stringField(value, 'id')
  if (!new RegExp(MEMORY_ID_PATTERN, 'u').test(id)) throw new Error('memory-knowledge: local memory id is invalid')
  const revision = value['revision']
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new Error('memory-knowledge: local memory revision is invalid')
  }
  const applicability = stringField(value, 'applicability')
  const projectRoot = optionalStringField(value, 'projectRoot')
  if ((applicability !== 'global' && applicability !== 'project')
    || (applicability === 'project') !== (projectRoot !== undefined)
    || (projectRoot !== undefined && !isAbsolute(projectRoot))) {
    throw new Error('memory-knowledge: local memory applicability is invalid')
  }
  const kind = stringField(value, 'kind')
  if (!['fact', 'decision', 'lesson', 'method', 'preference', 'constraint'].includes(kind)) {
    throw new Error('memory-knowledge: local memory kind is invalid')
  }
  const status = stringField(value, 'status')
  if (status !== 'active' && status !== 'deprecated' && status !== 'deleted') {
    throw new Error('memory-knowledge: local memory status is invalid')
  }
  const sensitivity = stringField(value, 'sensitivity')
  if (sensitivity !== 'normal' && sensitivity !== 'restricted') {
    throw new Error('memory-knowledge: local memory sensitivity is invalid')
  }
  const provenance = value['provenance']
  assertLocalMemoryProvenance(provenance)
  const sourceCandidateId = optionalStringField(value, 'sourceCandidateId')
  if (sourceCandidateId !== undefined && !new RegExp(MEMORY_CANDIDATE_ID_PATTERN, 'u').test(sourceCandidateId)) {
    throw new Error('memory-knowledge: local memory source candidate is invalid')
  }
  const memoryIds = (key: 'supersedes' | 'conflictsWith'): MemoryId[] => {
    const values = stringArrayField(value, key)
    if (values.some(candidate => !new RegExp(MEMORY_ID_PATTERN, 'u').test(candidate))) {
      throw new Error(`memory-knowledge: local memory ${key} is invalid`)
    }
    return values.map(MemoryId)
  }
  return {
    id: MemoryId(id),
    revision: revision as number,
    applicability,
    ...projectRoot === undefined ? {} : { projectRoot },
    kind: kind as LocalMemoryEntry['kind'],
    status,
    title: stringField(value, 'title'),
    content: stringField(value, 'content'),
    conditions: stringArrayField(value, 'conditions'),
    tags: stringArrayField(value, 'tags'),
    sensitivity,
    provenance,
    supersedes: memoryIds('supersedes'),
    conflictsWith: memoryIds('conflictsWith'),
    ...sourceCandidateId === undefined ? {} : { sourceCandidateId: MemoryCandidateId(sourceCandidateId) },
    createdAt: stringField(value, 'createdAt'),
    updatedAt: stringField(value, 'updatedAt'),
  }
}

function assertLocalMemoryProvenance(value: unknown): asserts value is ProvenanceRef[] {
  if (!Array.isArray(value)) throw new Error('memory-knowledge: local memory provenance must be an array')
  if (value.length > 0) assertProvenanceRefs(value)
}

function localMemoryEntryFromRow(row: LocalMemoryEntryRow | undefined): LocalMemoryEntry | undefined {
  return row === undefined ? undefined : localMemoryEntryFromJson(parseJson('local memory row', row.payload_json))
}

function storedDocumentFromJson(value: unknown): StoredSearchDocument {
  if (!isRecord(value)) throw new Error('memory-knowledge: search document payload must be an object')
  const provenance = value['provenance']
  assertLocalMemoryProvenance(provenance)
  const tags = value['tags']
  if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) {
    throw new Error('memory-knowledge: search document tags are invalid')
  }
  return value as unknown as StoredSearchDocument
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error: unknown) {
    database.exec('ROLLBACK')
    throw error
  }
}

function documentKey(document: Pick<StoredSearchDocument, 'recordType' | 'id' | 'projectRoot'>): string {
  return `${document.recordType}:${document.projectRoot ?? 'global'}:${document.id}`
}

function deleteSearchDocument(database: DatabaseSync, key: string): void {
  database.prepare('DELETE FROM search_fts WHERE document_key = ?').run(key)
  database.prepare('DELETE FROM search_documents WHERE document_key = ?').run(key)
}

function upsertSearchDocument(
  database: DatabaseSync,
  owner: 'candidate' | 'canonical' | 'local-memory',
  document: StoredSearchDocument,
): void {
  const key = documentKey(document)
  deleteSearchDocument(database, key)
  database.prepare(`
    INSERT INTO search_documents (
      document_key, owner, record_id, record_type, project_root, sensitivity,
      status, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    owner,
    document.id,
    document.recordType,
    document.projectRoot ?? null,
    document.sensitivity,
    document.status,
    document.updatedAt,
    JSON.stringify(document),
  )
  database.prepare('INSERT INTO search_fts (document_key, title, content, tags) VALUES (?, ?, ?, ?)').run(
    key,
    document.title,
    document.content,
    document.tags.join(' '),
  )
}

function candidateSearchDocument(candidate: MemoryCandidate): StoredSearchDocument {
  return {
    id: candidate.id,
    recordType: 'personal-memory',
    title: candidate.title,
    content: candidate.content,
    tags: [...candidate.tags],
    evidenceClass: 'human-verified',
    sensitivity: candidate.sensitivity,
    ...candidate.projectRoot === undefined ? {} : { projectRoot: candidate.projectRoot },
    provenance: structuredClone(candidate.provenance),
    updatedAt: candidate.updatedAt,
    status: candidate.status,
  }
}

function localMemorySearchDocument(entry: LocalMemoryEntry): StoredSearchDocument {
  return {
    id: entry.id,
    recordType: entry.applicability === 'global' ? 'personal-memory' : 'project-memory',
    title: entry.title,
    content: entry.content,
    tags: [...entry.tags],
    evidenceClass: 'human-verified',
    sensitivity: entry.sensitivity,
    ...entry.projectRoot === undefined ? {} : { projectRoot: entry.projectRoot },
    provenance: structuredClone(entry.provenance),
    updatedAt: entry.updatedAt,
    status: entry.status,
  }
}

function refreshLocalMemorySearchDocument(database: DatabaseSync, entry: LocalMemoryEntry): void {
  const document = localMemorySearchDocument(entry)
  if (entry.status === 'active') upsertSearchDocument(database, 'local-memory', document)
  else deleteSearchDocument(database, documentKey(document))
}

function insertLocalMemoryEntry(
  database: DatabaseSync,
  entry: LocalMemoryEntry,
  revisionKind: LocalMemoryRevisionKind,
): void {
  database.prepare(`
    INSERT INTO memory_entries (
      id, current_revision, applicability, project_root, status, sensitivity,
      source_candidate_id, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.revision,
    entry.applicability,
    entry.projectRoot ?? null,
    entry.status,
    entry.sensitivity,
    entry.sourceCandidateId ?? null,
    entry.updatedAt,
    JSON.stringify(entry),
  )
  insertLocalMemoryRevision(database, entry, revisionKind)
  refreshLocalMemorySearchDocument(database, entry)
}

function insertLocalMemoryRevision(
  database: DatabaseSync,
  entry: LocalMemoryEntry,
  revisionKind: LocalMemoryRevisionKind,
): void {
  database.prepare(`
    INSERT INTO memory_entry_revisions (memory_id, revision, revision_kind, created_at, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.id, entry.revision, revisionKind, entry.updatedAt, JSON.stringify(entry))
}

function localMemoryFromCandidate(candidate: MemoryCandidate, id: MemoryId): LocalMemoryEntry {
  return {
    id,
    revision: 1,
    applicability: candidate.applicability,
    ...candidate.projectRoot === undefined ? {} : { projectRoot: candidate.projectRoot },
    kind: candidate.kind,
    status: 'active',
    title: candidate.title,
    content: candidate.content,
    conditions: [],
    tags: [...candidate.tags],
    sensitivity: candidate.sensitivity,
    provenance: structuredClone(candidate.provenance),
    supersedes: [],
    conflictsWith: [],
    sourceCandidateId: candidate.id,
    createdAt: candidate.createdAt,
    updatedAt: candidate.reviewedAt ?? candidate.updatedAt,
  }
}

function assertLocalMemoryScope(applicability: MemoryCandidateApplicability, projectRoot: string | undefined): void {
  if ((applicability === 'project') !== (projectRoot !== undefined)) {
    throw new Error('memory-knowledge: local memory projectRoot is inconsistent with applicability')
  }
  if (projectRoot !== undefined && !isAbsolute(projectRoot)) {
    throw new Error('memory-knowledge: local memory projectRoot must be absolute')
  }
}

function requireLocalMemoryEntry(
  database: DatabaseSync,
  id: MemoryId,
  projectRoot?: string,
): LocalMemoryEntry {
  const row = database.prepare(`
    SELECT payload_json FROM memory_entries
    WHERE id = ? AND ${projectRoot === undefined ? 'project_root IS NULL' : 'project_root = ?'}
  `).get(id, ...projectRoot === undefined ? [] : [resolve(projectRoot)]) as LocalMemoryEntryRow | undefined
  const entry = localMemoryEntryFromRow(row)
  if (entry === undefined) throw new Error(`local memory not found: ${id}`)
  return entry
}

function assertExpectedLocalMemoryRevision(entry: LocalMemoryEntry, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('local memory expected revision must be a positive safe integer')
  }
  if (entry.revision !== expectedRevision) {
    throw new LocalMemoryRevisionConflictError(entry.id, expectedRevision, entry.revision)
  }
}

function assertLocalMemoryRelations(
  database: DatabaseSync,
  source: LocalMemoryEntry,
  targetIds: readonly MemoryId[],
): void {
  for (const targetId of new Set(targetIds)) {
    const target = localMemoryEntryFromRow(database.prepare(
      'SELECT payload_json FROM memory_entries WHERE id = ?',
    ).get(targetId) as LocalMemoryEntryRow | undefined)
    if (target === undefined) throw new Error(`related local memory not found: ${targetId}`)
    if (target.applicability !== source.applicability || target.projectRoot !== source.projectRoot) {
      throw new Error('local memory relations must stay inside one exact scope')
    }
  }
}

function updateLocalMemoryEntryRow(
  database: DatabaseSync,
  entry: LocalMemoryEntry,
  revisionKind: LocalMemoryRevisionKind,
): void {
  database.prepare(`
    UPDATE memory_entries
    SET current_revision = ?, status = ?, sensitivity = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `).run(entry.revision, entry.status, entry.sensitivity, entry.updatedAt, JSON.stringify(entry), entry.id)
  insertLocalMemoryRevision(database, entry, revisionKind)
  refreshLocalMemorySearchDocument(database, entry)
}

function indexedSearchDocument(document: IndexedMemoryDocument): StoredSearchDocument {
  return { ...structuredClone(document), status: 'verified' }
}

function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  const normalized = query.normalize('NFKC').toLocaleLowerCase('und')
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const points = [...match[0]]
    if (points.length < 3) continue
    const ascii = points.every(point => /^[\x00-\x7F]$/u.test(point))
    if (ascii) terms.add(points.join(''))
    else for (let index = 0; index <= points.length - 3; index += 1) terms.add(points.slice(index, index + 3).join(''))
    if (terms.size >= 32) break
  }
  return [...terms]
}

function ftsExpression(terms: readonly string[]): string {
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

function recordDomainClause(domain: MemoryRecordDomain | undefined, column: string): string | undefined {
  if (domain === 'memory') return `${column} IN ('personal-memory', 'project-memory')`
  if (domain === 'knowledge') return `${column} = 'knowledge-card'`
  return undefined
}

function recordScopeClause(
  projectRoot: string | undefined,
  scopeMode: MemoryScopeMode | undefined,
  column: string,
): { clause: string; parameter?: string } {
  if (projectRoot === undefined) return { clause: `${column} IS NULL` }
  const parameter = resolve(projectRoot)
  return scopeMode === 'selected'
    ? { clause: `${column} = ?`, parameter }
    : { clause: `(${column} IS NULL OR ${column} = ?)`, parameter }
}

function sourceEvidenceKey(checkpointKey: string, path: string, ordinal: number): string {
  return createHash('sha256').update(JSON.stringify([checkpointKey, path, ordinal])).digest('hex')
}

function indexSourceRelations(database: DatabaseSync, projectRoot: string, value: SourceUnderstanding): void {
  database.prepare('DELETE FROM source_relation_edges WHERE checkpoint_key = ?').run(value.checkpointKey)
  const insert = database.prepare(`
    INSERT INTO source_relation_edges (
      edge_key, checkpoint_key, project_root, source_id, commit_hash, inventory_hash, output_hash,
      from_path, from_content_hash, to_path, specifier, relation_kind, resolution, start_line, end_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const [ordinal, edge] of value.relations.edges.entries()) {
    const edgeKey = createHash('sha256').update(JSON.stringify([value.checkpointKey, 'relation', ordinal])).digest('hex')
    insert.run(
      edgeKey,
      value.checkpointKey,
      projectRoot,
      value.sourceId,
      value.commit,
      value.inventoryHash,
      value.outputHash,
      edge.fromPath,
      edge.fromContentHash,
      edge.toPath ?? null,
      edge.specifier,
      edge.kind,
      edge.resolution,
      edge.startLine,
      edge.endLine,
    )
  }
}

function indexSourceSymbols(database: DatabaseSync, projectRoot: string, value: SourceUnderstanding): void {
  database.prepare('DELETE FROM source_symbol_references WHERE checkpoint_key = ?').run(value.checkpointKey)
  database.prepare('DELETE FROM source_symbol_definitions WHERE checkpoint_key = ?').run(value.checkpointKey)
  const insertDefinition = database.prepare(`
    INSERT INTO source_symbol_definitions (
      definition_key, checkpoint_key, project_root, source_id, commit_hash, inventory_hash, output_hash,
      symbol_id, symbol_name, declaration_kind, definition_path, definition_content_hash,
      definition_start_line, definition_end_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const definitionKeys = new Map<string, string>()
  for (const definition of value.symbols.definitions) {
    const definitionKey = createHash('sha256').update(JSON.stringify([
      value.checkpointKey, 'symbol-definition', definition.id,
    ])).digest('hex')
    definitionKeys.set(String(definition.id), definitionKey)
    insertDefinition.run(
      definitionKey,
      value.checkpointKey,
      projectRoot,
      value.sourceId,
      value.commit,
      value.inventoryHash,
      value.outputHash,
      definition.id,
      definition.name,
      definition.declaration,
      definition.path,
      definition.contentHash,
      definition.startLine,
      definition.endLine,
    )
  }
  const insertReference = database.prepare(`
    INSERT INTO source_symbol_references (
      reference_key, checkpoint_key, definition_key, project_root, reference_path,
      reference_content_hash, reference_kind, reference_start_line, reference_end_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const [ordinal, reference] of value.symbols.references.entries()) {
    const definitionKey = definitionKeys.get(String(reference.definitionId))
    if (definitionKey === undefined) throw new Error('Source symbol reference has no indexed definition')
    const referenceKey = createHash('sha256').update(JSON.stringify([
      value.checkpointKey, 'symbol-reference', ordinal,
    ])).digest('hex')
    insertReference.run(
      referenceKey,
      value.checkpointKey,
      definitionKey,
      projectRoot,
      reference.fromPath,
      reference.fromContentHash,
      reference.kind,
      reference.startLine,
      reference.endLine,
    )
  }
}

function sourceEvidenceDetail(evidence: SourceEvidence): string {
  return evidence.kind === 'document-heading'
    ? String(evidence.level)
    : JSON.stringify({
        declaration: evidence.declaration,
        exported: evidence.exported,
        ...(evidence.containerName === undefined ? {} : { containerName: evidence.containerName }),
      })
}

function sourceEvidenceMetadata(
  evidence: SourceEvidence,
  language: string | undefined,
  artifactKind: SourceArtifactKind,
  sourceId: string,
): string {
  return evidence.kind === 'document-heading'
    ? [language, artifactKind, evidence.kind, `H${evidence.level}`, sourceId].filter(Boolean).join(' ')
    : [
        language,
        artifactKind,
        evidence.kind,
        evidence.declaration,
        evidence.exported ? 'export exported' : 'internal',
        evidence.containerName,
        sourceId,
      ].filter(Boolean).join(' ')
}

function deleteSourceEvidenceCheckpoint(database: DatabaseSync, checkpointKey: string): void {
  const keys = database.prepare(
    'SELECT evidence_key FROM source_evidence_documents WHERE checkpoint_key = ?',
  ).all(checkpointKey) as unknown as Array<{ evidence_key: string }>
  const deleteFts = database.prepare('DELETE FROM source_evidence_fts WHERE evidence_key = ?')
  for (const row of keys) deleteFts.run(row.evidence_key)
  database.prepare('DELETE FROM source_evidence_documents WHERE checkpoint_key = ?').run(checkpointKey)
}

function indexSourceUnderstanding(database: DatabaseSync, projectRoot: string, value: SourceUnderstanding): void {
  deleteSourceEvidenceCheckpoint(database, value.checkpointKey)
  const insertDocument = database.prepare(`
    INSERT INTO source_evidence_documents (
      evidence_key, checkpoint_key, project_root, source_id, commit_hash, inventory_hash, output_hash,
      path, content_hash, area, artifact_kind, language, evidence_kind, evidence_name, evidence_detail,
      start_line, end_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFts = database.prepare(`
    INSERT INTO source_evidence_fts (evidence_key, path, name, area, metadata) VALUES (?, ?, ?, ?, ?)
  `)
  for (const record of value.records) {
    for (const [ordinal, evidence] of (record.analysis?.evidence ?? []).entries()) {
      const key = sourceEvidenceKey(value.checkpointKey, record.path, ordinal)
      const detail = sourceEvidenceDetail(evidence)
      insertDocument.run(
        key,
        value.checkpointKey,
        projectRoot,
        value.sourceId,
        value.commit,
        value.inventoryHash,
        value.outputHash,
        record.path,
        record.contentHash,
        record.area,
        record.artifactKind,
        record.language ?? null,
        evidence.kind,
        evidence.name,
        detail,
        evidence.startLine,
        evidence.endLine,
      )
      insertFts.run(
        key,
        record.path,
        evidence.name,
        record.area,
        sourceEvidenceMetadata(evidence, record.language, record.artifactKind, value.sourceId),
      )
    }
  }
}

const SOURCE_ARTIFACT_KINDS = new Set<SourceArtifactKind>([
  'code', 'test', 'documentation', 'configuration', 'asset', 'other',
])

function sourceEvidenceHitFromRow(row: SourceEvidenceRow): SourceEvidenceHit {
  if (!new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u').test(row.source_id)
    || !/^[0-9a-f]{40,64}$/u.test(row.commit_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.inventory_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.output_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.content_hash)
    || !SOURCE_ARTIFACT_KINDS.has(row.artifact_kind as SourceArtifactKind)
    || !Number.isSafeInteger(row.start_line) || row.start_line < 1
    || !Number.isSafeInteger(row.end_line) || row.end_line < row.start_line) {
    throw new Error('Source evidence index row is invalid')
  }
  let evidence: SourceEvidence
  if (row.evidence_kind === 'document-heading') {
    const level = Number(row.evidence_detail)
    if (!Number.isSafeInteger(level) || level < 1 || level > 6) {
      throw new Error('Source evidence heading index row is invalid')
    }
    evidence = {
      kind: row.evidence_kind,
      name: row.evidence_name,
      level,
      startLine: row.start_line,
      endLine: row.end_line,
    }
  } else {
    const declarations = new Set<SourceCodeSymbolDeclaration>([
      'class', 'function', 'interface', 'type', 'enum', 'enum-member', 'namespace', 'variable', 'method',
      'property', 'constructor', 'getter', 'setter', 'default', 're-export',
    ])
    const detail = parseJson('Source evidence symbol detail', row.evidence_detail)
    if (row.evidence_kind !== 'code-symbol'
      || !isRecord(detail)
      || typeof detail['declaration'] !== 'string'
      || !declarations.has(detail['declaration'] as SourceCodeSymbolDeclaration)
      || typeof detail['exported'] !== 'boolean'
      || (detail['containerName'] !== undefined
        && (typeof detail['containerName'] !== 'string' || detail['containerName'].length === 0))) {
      throw new Error('Source evidence symbol index row is invalid')
    }
    const normalizedDetail = JSON.stringify({
      declaration: detail['declaration'],
      exported: detail['exported'],
      ...(detail['containerName'] === undefined ? {} : { containerName: detail['containerName'] }),
    })
    if (normalizedDetail !== row.evidence_detail) throw new Error('Source evidence symbol index detail is inconsistent')
    evidence = {
      kind: row.evidence_kind,
      name: row.evidence_name,
      declaration: detail['declaration'] as SourceCodeSymbolDeclaration,
      exported: detail['exported'],
      ...(detail['containerName'] === undefined ? {} : { containerName: detail['containerName'] as string }),
      startLine: row.start_line,
      endLine: row.end_line,
    }
  }
  return {
    sourceId: KnowledgeSourceId(row.source_id),
    commit: row.commit_hash,
    inventoryHash: row.inventory_hash,
    sourceRecordHash: row.output_hash,
    path: row.path,
    contentHash: row.content_hash,
    area: row.area,
    artifactKind: row.artifact_kind as SourceArtifactKind,
    ...(row.language === null ? {} : { language: row.language }),
    evidence,
  }
}

function sourceEvidenceRevision(hit: SourceEvidenceHit): SourceEvidenceRevision {
  return {
    sourceId: hit.sourceId,
    commit: hit.commit,
    inventoryHash: hit.inventoryHash,
    sourceRecordHash: hit.sourceRecordHash,
  }
}

const SOURCE_RELATION_KINDS = new Set<SourceModuleReferenceKind>([
  'import', 'type-import', 're-export', 'type-re-export', 'dynamic-import', 'require', 'import-equals',
])
const SOURCE_RELATION_RESOLUTIONS = new Set<SourceRelationResolution>(['internal', 'external', 'unresolved'])
const PORTABLE_PATH = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')

function sourceRelationEdgeFromRow(row: SourceRelationRow): SourceRelationQueryEdge {
  const internal = row.resolution === 'internal'
  if (!/^[0-9a-f]{64}$/u.test(row.edge_key)
    || !new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u').test(row.source_id)
    || !/^[0-9a-f]{40,64}$/u.test(row.commit_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.inventory_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.output_hash)
    || !PORTABLE_PATH.test(row.from_path)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.from_content_hash)
    || row.specifier.length === 0
    || !SOURCE_RELATION_KINDS.has(row.relation_kind as SourceModuleReferenceKind)
    || !SOURCE_RELATION_RESOLUTIONS.has(row.resolution as SourceRelationResolution)
    || internal !== (row.to_path !== null && PORTABLE_PATH.test(row.to_path))
    || !Number.isSafeInteger(row.start_line) || row.start_line < 1
    || !Number.isSafeInteger(row.end_line) || row.end_line < row.start_line) {
    throw new Error('Source relation index row is invalid')
  }
  return {
    edgeId: row.edge_key,
    sourceId: KnowledgeSourceId(row.source_id),
    commit: row.commit_hash,
    inventoryHash: row.inventory_hash,
    sourceRecordHash: row.output_hash,
    fromPath: row.from_path,
    fromContentHash: row.from_content_hash,
    ...(row.to_path === null ? {} : { toPath: row.to_path }),
    specifier: row.specifier,
    kind: row.relation_kind as SourceModuleReferenceKind,
    resolution: row.resolution as SourceRelationResolution,
    startLine: row.start_line,
    endLine: row.end_line,
  }
}

function sourceRelationRevision(
  edge: SourceRelationQueryEdge,
  understanding: SourceUnderstanding,
): SourceRelationRevision {
  if (edge.commit !== understanding.commit
    || edge.inventoryHash !== understanding.inventoryHash
    || edge.sourceRecordHash !== understanding.outputHash) {
    throw new Error('Source relation index revision is inconsistent')
  }
  return {
    sourceId: edge.sourceId,
    commit: edge.commit,
    inventoryHash: edge.inventoryHash,
    sourceRecordHash: edge.sourceRecordHash,
    relationProvider: understanding.relations.provider,
    relationProviderKey: understanding.relations.providerKey,
    relationOutputHash: understanding.relations.outputHash,
    graphOmittedEdgeCount: understanding.relations.omittedRelationCount,
  }
}

const SOURCE_SYMBOL_REFERENCE_KINDS = new Set<SourceSymbolReferenceKind>(['import', 'export', 'type', 'value'])

function sourceSymbolEdgeFromRow(row: SourceSymbolRow): SourceSymbolQueryEdge {
  if (!/^[0-9a-f]{64}$/u.test(row.reference_key)
    || !new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u').test(row.source_id)
    || !/^[0-9a-f]{40,64}$/u.test(row.commit_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.inventory_hash)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.output_hash)
    || !new RegExp(SOURCE_SYMBOL_ID_PATTERN, 'u').test(row.symbol_id)
    || row.symbol_name.length === 0 || row.declaration_kind.length === 0
    || !PORTABLE_PATH.test(row.definition_path)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.definition_content_hash)
    || !Number.isSafeInteger(row.definition_start_line) || row.definition_start_line < 1
    || !Number.isSafeInteger(row.definition_end_line) || row.definition_end_line < row.definition_start_line
    || !PORTABLE_PATH.test(row.reference_path)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.reference_content_hash)
    || !SOURCE_SYMBOL_REFERENCE_KINDS.has(row.reference_kind as SourceSymbolReferenceKind)
    || !Number.isSafeInteger(row.reference_start_line) || row.reference_start_line < 1
    || !Number.isSafeInteger(row.reference_end_line) || row.reference_end_line < row.reference_start_line) {
    throw new Error('Source symbol index row is invalid')
  }
  return {
    referenceId: row.reference_key,
    sourceId: KnowledgeSourceId(row.source_id),
    commit: row.commit_hash,
    inventoryHash: row.inventory_hash,
    sourceRecordHash: row.output_hash,
    definitionId: SourceSymbolId(row.symbol_id),
    symbolName: row.symbol_name,
    declaration: row.declaration_kind,
    definitionPath: row.definition_path,
    definitionContentHash: row.definition_content_hash,
    definitionStartLine: row.definition_start_line,
    definitionEndLine: row.definition_end_line,
    referencePath: row.reference_path,
    referenceContentHash: row.reference_content_hash,
    referenceKind: row.reference_kind as SourceSymbolReferenceKind,
    referenceStartLine: row.reference_start_line,
    referenceEndLine: row.reference_end_line,
  }
}

function sourceSymbolRevision(edge: SourceSymbolQueryEdge, understanding: SourceUnderstanding): SourceSymbolRevision {
  if (edge.commit !== understanding.commit
    || edge.inventoryHash !== understanding.inventoryHash
    || edge.sourceRecordHash !== understanding.outputHash) {
    throw new Error('Source symbol index revision is inconsistent')
  }
  return {
    sourceId: edge.sourceId,
    commit: edge.commit,
    inventoryHash: edge.inventoryHash,
    sourceRecordHash: edge.sourceRecordHash,
    symbolProvider: understanding.symbols.provider,
    symbolProviderKey: understanding.symbols.providerKey,
    symbolOutputHash: understanding.symbols.outputHash,
    graphOmittedFileCount: understanding.symbols.omittedFileCount,
    graphOmittedReferenceCount: understanding.symbols.omittedReferenceCount,
    configMode: understanding.symbols.configuration.mode,
    configPaths: [...understanding.symbols.configuration.configPaths],
    projectReferenceCount: understanding.symbols.configuration.projectReferenceCount,
    pathAliasCount: understanding.symbols.configuration.pathAliasCount,
    configDiagnosticCount: understanding.symbols.configuration.diagnosticCount,
    omittedConfigFileCount: understanding.symbols.configuration.omittedConfigFileCount,
  }
}

function waitWithAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function saveMemoryCandidate(database: DatabaseSync, input: SaveMemoryCandidateInput): MemoryCandidate {
  const fingerprint = candidateFingerprint(input)
  const existing = candidateFromRow(database.prepare(
    "SELECT payload_json FROM candidates WHERE fingerprint = ? AND status IN ('pending', 'accepted')",
  ).get(fingerprint) as CandidateRow | undefined)
  if (existing !== undefined) {
    if (existing.target !== 'memory') throw new Error('candidate fingerprint belongs to another target')
    return existing
  }
  const now = new Date().toISOString()
  const candidate: MemoryCandidate = {
    id: createMemoryCandidateId(),
    revision: 1,
    target: 'memory',
    applicability: input.applicability,
    ...input.projectRoot === undefined ? {} : { projectRoot: resolve(input.projectRoot) },
    kind: input.kind,
    title: normalizedText(input.title, 'title'),
    content: normalizedText(input.content, 'content'),
    tags: normalizedTags(input.tags),
    sensitivity: input.sensitivity,
    status: 'pending',
    suggestedBy: input.suggestedBy,
    provenance: structuredClone(input.provenance),
    createdAt: now,
    updatedAt: now,
  }
  database.prepare(`
    INSERT INTO candidates (id, status, project_root, fingerprint, generation_key, updated_at, payload_json)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(
    candidate.id,
    candidate.status,
    candidate.projectRoot ?? null,
    fingerprint,
    candidate.updatedAt,
    JSON.stringify(candidate),
  )
  return structuredClone(candidate)
}

/** Serialized owner of the canonical local candidate database and derived FTS index. */
export class MemoryKnowledgeDatabase {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closePromise: Promise<void> | undefined

  private constructor(private readonly database: DatabaseSync) {}

  /** Open and validate one dedicated local database. */
  static async open(path: string, journalMode: MemoryJournalMode): Promise<MemoryKnowledgeDatabase> {
    return new MemoryKnowledgeDatabase(await openDatabase(path, journalMode))
  }

  /** Close after all accepted operations reach quiescence. */
  close(): Promise<void> {
    this.closePromise ??= this.doClose()
    return this.closePromise
  }

  private async doClose(): Promise<void> {
    this.closed = true
    await this.tail
    this.database.close()
  }

  private async serialized<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error('memory-knowledge database is closed')
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const prior = this.tail
    this.tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
      if (this.closed) throw new Error('memory-knowledge database is closed')
      signal?.throwIfAborted()
      return operation()
    } finally {
      release()
    }
  }

  /** Save or return an existing live candidate with the same normalized content. */
  saveCandidate(input: SaveMemoryCandidateInput): Promise<MemoryCandidate> {
    return this.serialized(() => saveMemoryCandidate(this.database, input))
  }

  /** Create one immediately active local long-term memory entry. */
  createLocalMemoryEntry(input: CreateLocalMemoryEntryInput): Promise<LocalMemoryEntry> {
    return this.serialized(() => withTransaction(this.database, () => {
      assertLocalMemoryScope(input.applicability, input.projectRoot)
      assertLocalMemoryProvenance(input.provenance)
      const now = new Date().toISOString()
      const entry: LocalMemoryEntry = {
        id: createMemoryId(),
        revision: 1,
        applicability: input.applicability,
        ...input.projectRoot === undefined ? {} : { projectRoot: resolve(input.projectRoot) },
        kind: input.kind,
        status: 'active',
        title: normalizedText(input.title, 'memory title'),
        content: normalizedText(input.content, 'memory content'),
        conditions: normalizedTags(input.conditions),
        tags: normalizedTags(input.tags),
        sensitivity: input.sensitivity,
        provenance: structuredClone(input.provenance),
        supersedes: [],
        conflictsWith: [],
        createdAt: now,
        updatedAt: now,
      }
      localMemoryEntryFromJson(entry)
      insertLocalMemoryEntry(this.database, entry, 'created')
      return structuredClone(entry)
    }))
  }

  /** List one exact personal or project scope, including non-active lifecycle states on request. */
  listLocalMemoryEntries(request: ListLocalMemoryEntriesRequest): Promise<LocalMemoryEntry[]> {
    return this.serialized(() => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new Error('local memory list limit must be a positive safe integer')
      }
      const clauses = [request.projectRoot === undefined ? 'project_root IS NULL' : 'project_root = ?']
      const parameters: Array<string | number> = []
      if (request.projectRoot !== undefined) parameters.push(resolve(request.projectRoot))
      if (request.status !== undefined) {
        clauses.push('status = ?')
        parameters.push(request.status)
      }
      parameters.push(request.limit)
      const rows = this.database.prepare(`
        SELECT payload_json FROM memory_entries
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(...parameters) as unknown as LocalMemoryEntryRow[]
      return rows.map(row => structuredClone(localMemoryEntryFromJson(parseJson('local memory row', row.payload_json))))
    })
  }

  /** Read one local memory only when it belongs to the selected exact scope. */
  getLocalMemoryEntry(id: MemoryId, projectRoot?: string): Promise<LocalMemoryEntry | undefined> {
    return this.serialized(() => {
      const row = this.database.prepare(`
        SELECT payload_json FROM memory_entries
        WHERE id = ? AND ${projectRoot === undefined ? 'project_root IS NULL' : 'project_root = ?'}
      `).get(id, ...projectRoot === undefined ? [] : [resolve(projectRoot)]) as LocalMemoryEntryRow | undefined
      const entry = localMemoryEntryFromRow(row)
      return entry === undefined ? undefined : structuredClone(entry)
    })
  }

  /** Save editable memory fields as a new immutable revision. */
  updateLocalMemoryEntry(
    id: MemoryId,
    input: UpdateLocalMemoryEntryInput,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry> {
    return this.serialized(() => withTransaction(this.database, () => {
      const current = requireLocalMemoryEntry(this.database, id, projectRoot)
      assertExpectedLocalMemoryRevision(current, expectedRevision)
      if (current.status !== 'active') throw new Error(`local memory ${id} is ${current.status}; restore it before editing`)
      const supersedes = normalizedMemoryIds(input.supersedes, id, 'supersedes')
      const conflictsWith = normalizedMemoryIds(input.conflictsWith, id, 'conflictsWith')
      if (supersedes.some(candidate => conflictsWith.includes(candidate))) {
        throw new Error('local memory cannot both supersede and conflict with the same entry')
      }
      assertLocalMemoryRelations(this.database, current, [...supersedes, ...conflictsWith])
      const updated: LocalMemoryEntry = {
        ...current,
        revision: current.revision + 1,
        kind: input.kind,
        title: normalizedText(input.title, 'memory title'),
        content: normalizedText(input.content, 'memory content'),
        conditions: normalizedTags(input.conditions),
        tags: normalizedTags(input.tags),
        sensitivity: input.sensitivity,
        supersedes,
        conflictsWith,
        updatedAt: new Date().toISOString(),
      }
      localMemoryEntryFromJson(updated)
      updateLocalMemoryEntryRow(this.database, updated, 'edited')
      return structuredClone(updated)
    }))
  }

  /** Deprecate, delete, or restore one local memory through a new immutable revision. */
  setLocalMemoryEntryStatus(
    id: MemoryId,
    status: LocalMemoryEntryStatus,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry> {
    return this.serialized(() => withTransaction(this.database, () => {
      const current = requireLocalMemoryEntry(this.database, id, projectRoot)
      assertExpectedLocalMemoryRevision(current, expectedRevision)
      if (current.status === status) return structuredClone(current)
      if (status === 'deprecated' && current.status !== 'active') {
        throw new Error(`local memory ${id} must be active before deprecation`)
      }
      if (status === 'deleted' && current.status === 'deleted') return structuredClone(current)
      if (status === 'active' && current.status === 'active') return structuredClone(current)
      const revisionKind: LocalMemoryRevisionKind = status === 'active'
        ? 'restored'
        : status === 'deprecated' ? 'deprecated' : 'deleted'
      const updated: LocalMemoryEntry = {
        ...current,
        revision: current.revision + 1,
        status,
        updatedAt: new Date().toISOString(),
      }
      updateLocalMemoryEntryRow(this.database, updated, revisionKind)
      return structuredClone(updated)
    }))
  }

  /** List immutable history for one local memory in newest-first order. */
  listLocalMemoryRevisions(
    id: MemoryId,
    projectRoot: string | undefined,
    limit: number,
  ): Promise<LocalMemoryRevision[]> {
    return this.serialized(() => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('local memory history limit must be positive')
      requireLocalMemoryEntry(this.database, id, projectRoot)
      const rows = this.database.prepare(`
        SELECT revision_kind, payload_json FROM memory_entry_revisions
        WHERE memory_id = ?
        ORDER BY revision DESC
        LIMIT ?
      `).all(id, limit) as unknown as LocalMemoryRevisionRow[]
      return rows.map(row => ({
        entry: localMemoryEntryFromJson(parseJson('local memory revision row', row.payload_json)),
        kind: row.revision_kind as LocalMemoryRevisionKind,
      }))
    })
  }

  /** Create or read a durable extraction checkpoint without moving an existing one. */
  prepareConversationExtraction(
    request: PrepareConversationExtractionRequest,
  ): Promise<ConversationExtractionCheckpoint> {
    assertExtractionKey(request)
    if (!Number.isSafeInteger(request.baselineSeq) || request.baselineSeq < -1) {
      throw new Error('memory-knowledge: conversation extraction baselineSeq must be a safe integer at least -1')
    }
    return this.serialized(() => {
      const now = new Date().toISOString()
      this.database.prepare(`
        INSERT OR IGNORE INTO conversation_extractions (
          session_id, extractor, extractor_version, through_seq, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(request.sessionId, request.extractor, request.version, request.baselineSeq, now)
      const row = this.database.prepare(`
        SELECT session_id, extractor, extractor_version, through_seq, updated_at
        FROM conversation_extractions
        WHERE session_id = ? AND extractor = ? AND extractor_version = ?
      `).get(request.sessionId, request.extractor, request.version) as ConversationExtractionRow | undefined
      if (row === undefined) throw new Error('memory-knowledge: conversation extraction checkpoint was not created')
      return extractionCheckpointFromRow(row)
    })
  }

  /** Atomically save one extracted candidate and advance its durable session checkpoint. */
  recordConversationExtraction(
    request: RecordConversationExtractionRequest,
  ): Promise<RecordConversationExtractionResult> {
    assertExtractionKey(request)
    if (!Number.isSafeInteger(request.turnEndSeq) || request.turnEndSeq < 0) {
      throw new Error('memory-knowledge: conversation extraction turnEndSeq must be a non-negative safe integer')
    }
    assertConversationCandidate(request)
    return this.serialized(() => withTransaction(this.database, () => {
      const row = this.database.prepare(`
        SELECT session_id, extractor, extractor_version, through_seq, updated_at
        FROM conversation_extractions
        WHERE session_id = ? AND extractor = ? AND extractor_version = ?
      `).get(request.sessionId, request.extractor, request.version) as ConversationExtractionRow | undefined
      if (row === undefined) throw new Error('memory-knowledge: conversation extraction checkpoint is not prepared')
      if (request.turnEndSeq <= row.through_seq) {
        return { outcome: 'already-processed', throughSeq: row.through_seq }
      }
      const candidate = request.candidate === undefined
        ? undefined
        : saveMemoryCandidate(this.database, request.candidate)
      const now = new Date().toISOString()
      this.database.prepare(`
        UPDATE conversation_extractions
        SET through_seq = ?, updated_at = ?
        WHERE session_id = ? AND extractor = ? AND extractor_version = ?
      `).run(request.turnEndSeq, now, request.sessionId, request.extractor, request.version)
      return candidate === undefined
        ? { outcome: 'skipped', throughSeq: request.turnEndSeq }
        : { outcome: 'candidate', throughSeq: request.turnEndSeq, candidate: structuredClone(candidate) }
    }))
  }

  /** Save or return the candidate produced by one deterministic generation key. */
  saveKnowledgeCardCandidate(input: SaveKnowledgeCardCandidateInput): Promise<KnowledgeCardCandidate> {
    return this.serialized(() => {
      const existing = candidateFromRow(this.database.prepare(
        'SELECT payload_json FROM candidates WHERE generation_key = ?',
      ).get(input.generation.key) as CandidateRow | undefined)
      if (existing !== undefined) {
        if (existing.target !== 'knowledge-card') throw new Error('candidate generation key belongs to another target')
        return structuredClone(existing)
      }
      const now = new Date().toISOString()
      const candidate: KnowledgeCardCandidate = {
        id: createMemoryCandidateId(),
        revision: 1,
        target: 'knowledge-card',
        applicability: 'project',
        projectRoot: resolve(input.projectRoot),
        kind: input.kind,
        title: normalizedText(input.title, 'title'),
        content: normalizedText(input.content, 'content'),
        tags: normalizedTags(input.tags),
        sensitivity: 'normal',
        status: 'pending',
    suggestedBy: input.suggestedBy,
        provenance: structuredClone(input.provenance),
        generation: structuredClone(input.generation),
        card: structuredClone(input.card),
        createdAt: now,
        updatedAt: now,
      }
      const fingerprint = knowledgeCandidateFingerprint(input)
      this.database.prepare(`
        INSERT INTO candidates (id, status, project_root, fingerprint, generation_key, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.id,
        candidate.status,
        candidate.projectRoot,
        fingerprint,
        candidate.generation.key,
        candidate.updatedAt,
        JSON.stringify(candidate),
      )
      return structuredClone(candidate)
    })
  }

  /** 读取独立于语义快照的累计材料账本。
   * @param key Run 与 Task 身份。
   * @returns 已校验的账本或尚未开始记账。
   */
  getWikiMaterialReadBudget(key: WikiMaterialBudgetKey): Promise<WikiMaterialReadBudget | undefined> {
    return this.serialized(() => readWikiMaterialBudget(this.database, key))
  }

  /** 在同一事务中验证任务所有权并查询文件元数据。
   * @param request 当前任务、查询条件与分页预算。
   * @returns 有界的当前 Run 目录页。
   */
  searchWikiCatalog(request: SearchWikiCatalogRequest): Promise<WikiCatalogQueryPage<WikiCatalogFileHit>> {
    return this.serialized(() => withTransaction(this.database, () => searchWikiCatalog(this.database, request)))
  }

  /** 在同一事务中验证任务所有权并查询区间元数据。
   * @param request 当前任务、Coverage 与分页预算。
   * @returns 不含正文的材料区间页。
   */
  listWikiCatalogRanges(request: ListWikiCatalogRangesRequest): Promise<WikiCatalogQueryPage<WikiCatalogRangeHit>> {
    return this.serialized(() => withTransaction(this.database, () => listWikiCatalogRanges(this.database, request)))
  }

  /** 查询一页项目内账本；整个读取使用同一事务。
   * @param request 项目身份、游标与查询上限。
   * @returns 不含源码或 Session 的账本页。
   */
  listWikiMaterialReadBudgets(request: ListWikiMaterialBudgetsRequest): Promise<WikiMaterialBudgetPage> {
    return this.serialized(() => withTransaction(this.database, () => listWikiMaterialBudgets(this.database, request)))
  }

  /** 原子预扣当前任务的材料额度；拒绝结果同样持久化。
   * @param request 当前 Session、完整材料字节数及首次额度。
   * @returns 预扣或拒绝后的账本。
   */
  reserveWikiMaterialRead(request: ReserveWikiMaterialRead): Promise<WikiMaterialReadBudget> {
    return this.serialized(() => withTransaction(this.database, () => reserveWikiMaterialBudget(this.database, request)))
  }

  /** 显式提高任务额度，保留累计消耗。
   * @param key Run 与 Task 身份。
   * @param limitBytes 可容纳被拒绝读取的新总额度。
   * @param guard 可选项目与完整账本版本校验，浏览器操作必须提供。
   * @returns 扩额后保留消耗的账本。
   */
  increaseWikiMaterialReadBudget(key: WikiMaterialBudgetKey, limitBytes: number, guard?: WikiMaterialBudgetUpdateGuard): Promise<WikiMaterialReadBudget> {
    return this.serialized(() => withTransaction(this.database, () => increaseWikiMaterialBudget(this.database, key, limitBytes, guard)))
  }

  /** Read the current run and effective-version selection for one normalized project. */
  getKnowledgeSelection(projectRoot: string): Promise<KnowledgeSelection | undefined> {
    const root = resolve(projectRoot)
    return this.serialized(() => {
      const row = this.database.prepare('SELECT payload_json FROM knowledge_selections WHERE project_root = ?')
        .get(root) as WikiPayloadRow | undefined
      return row === undefined ? undefined : parseKnowledgeSelection(parseJson('knowledge selection row', row.payload_json))
    })
  }

  /** Read one internally consistent generated/effective version state. */
  getKnowledgeVersionState(projectRoot: string): Promise<KnowledgeVersionState> {
    const root = resolve(projectRoot)
    return this.serialized(() => {
      const selectionRow = this.database.prepare('SELECT payload_json FROM knowledge_selections WHERE project_root = ?')
        .get(root) as WikiPayloadRow | undefined
      if (selectionRow === undefined) return {}
      const selection = parseKnowledgeSelection(parseJson('knowledge selection row', selectionRow.payload_json))
      let effectiveVersion: KnowledgeEffectiveVersion | undefined
      let generatedVersion: KnowledgeGeneratedVersion | undefined
      if (selection.effectiveVersionId !== undefined) {
        const effectiveRow = this.database.prepare('SELECT payload_json FROM knowledge_effective_versions WHERE id = ?')
          .get(selection.effectiveVersionId) as WikiPayloadRow | undefined
        if (effectiveRow === undefined) throw new Error('knowledge selection references a missing effective version')
        effectiveVersion = parseKnowledgeEffectiveVersion(parseJson('knowledge effective version row', effectiveRow.payload_json))
        const generatedRow = this.database.prepare('SELECT payload_json FROM knowledge_generated_versions WHERE id = ?')
          .get(effectiveVersion.generatedVersionId) as WikiPayloadRow | undefined
        if (generatedRow === undefined) throw new Error('effective knowledge version references a missing generated version')
        generatedVersion = parseKnowledgeGeneratedVersion(parseJson('knowledge generated version row', generatedRow.payload_json))
      } else if (selection.currentRunId !== undefined) {
        const generatedRow = this.database.prepare(`
          SELECT payload_json FROM knowledge_generated_versions
          WHERE project_root = ? AND run_id = ? ORDER BY created_at DESC, id ASC LIMIT 1
        `).get(root, selection.currentRunId) as WikiPayloadRow | undefined
        if (generatedRow !== undefined) {
          generatedVersion = parseKnowledgeGeneratedVersion(parseJson('knowledge generated version row', generatedRow.payload_json))
        }
      }
      if (effectiveVersion !== undefined && (effectiveVersion.projectRoot !== root
        || generatedVersion?.projectRoot !== root
        || generatedVersion.id !== effectiveVersion.generatedVersionId)) {
        throw new Error('knowledge version state crosses project or generated-version ownership')
      }
      return {
        selection: structuredClone(selection),
        ...(generatedVersion === undefined ? {} : { generatedVersion: structuredClone(generatedVersion) }),
        ...(effectiveVersion === undefined ? {} : { effectiveVersion: structuredClone(effectiveVersion) }),
      }
    })
  }

  /** List immutable operator edits for one exact project in newest-first order. */
  listKnowledgeHumanRevisions(projectRoot: string, limit: number): Promise<KnowledgeHumanRevision[]> {
    const root = resolve(projectRoot)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('knowledge human revision limit must be between 1 and 200')
    }
    return this.serialized(() => {
      const rows = this.database.prepare(`
        SELECT payload_json FROM knowledge_human_revisions
        WHERE project_root = ? ORDER BY revision DESC LIMIT ?
      `).all(root, limit) as unknown as WikiPayloadRow[]
      return rows.map(row => parseKnowledgeHumanRevision(
        parseJson('knowledge human revision row', row.payload_json),
      ))
    })
  }

  /** Atomically layer one idempotent operator edit over the selected effective version. */
  applyKnowledgeHumanRevision(
    input: CreateKnowledgeHumanRevisionInput,
    createdAt = new Date().toISOString(),
  ): Promise<KnowledgeHumanRevisionResult> {
    const request = parseCreateKnowledgeHumanRevisionInput(structuredClone(input))
    const fingerprint = knowledgeHumanRevisionRequestFingerprint(request)
    return this.serialized(() => withTransaction(this.database, () => {
      const existing = this.database.prepare(`
        SELECT payload_json, request_fingerprint, result_json
        FROM knowledge_human_revisions WHERE project_root = ? AND request_id = ?
      `).get(request.projectRoot, request.requestId) as KnowledgeHumanRevisionRow | undefined
      if (existing !== undefined) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new KnowledgeHumanRevisionRequestConflictError(request.requestId)
        }
        const result = parseKnowledgeHumanRevisionResult(
          parseJson('knowledge human revision result row', existing.result_json),
        )
        if (result.revision.requestId !== request.requestId
          || result.revision.requestFingerprint !== fingerprint
          || JSON.stringify(result.revision) !== existing.payload_json) {
          throw new Error('knowledge human revision idempotent result is inconsistent')
        }
        return structuredClone(result)
      }

      const selectionRow = this.database.prepare(`
        SELECT revision, payload_json FROM knowledge_selections WHERE project_root = ?
      `).get(request.projectRoot) as KnowledgeSelectionRow | undefined
      const selection = selectionRow === undefined
        ? undefined
        : parseKnowledgeSelection(parseJson('knowledge selection row', selectionRow.payload_json))
      if (selection?.revision !== request.expectedSelectionRevision) {
        throw new KnowledgeSelectionRevisionConflictError(
          request.projectRoot,
          request.expectedSelectionRevision,
          selection?.revision,
        )
      }
      if (selection.effectiveVersionId !== request.baseEffectiveVersionId) {
        throw new KnowledgeEffectiveVersionConflictError(
          request.projectRoot,
          request.baseEffectiveVersionId,
          selection.effectiveVersionId,
        )
      }
      const effectiveRow = this.database.prepare(`
        SELECT payload_json FROM knowledge_effective_versions WHERE id = ?
      `).get(request.baseEffectiveVersionId) as WikiPayloadRow | undefined
      if (effectiveRow === undefined) throw new Error('selected effective knowledge version is missing')
      const baseEffective = parseKnowledgeEffectiveVersion(
        parseJson('knowledge effective version row', effectiveRow.payload_json),
      )
      if (baseEffective.projectRoot !== request.projectRoot || baseEffective.id !== selection.effectiveVersionId) {
        throw new Error('selected effective knowledge version crosses project ownership')
      }
      const generatedRow = this.database.prepare(`
        SELECT payload_json FROM knowledge_generated_versions WHERE id = ?
      `).get(baseEffective.generatedVersionId) as WikiPayloadRow | undefined
      if (generatedRow === undefined) throw new Error('selected effective knowledge version has no generated baseline')
      const generated = parseKnowledgeGeneratedVersion(
        parseJson('knowledge generated version row', generatedRow.payload_json),
      )
      if (generated.projectRoot !== request.projectRoot || generated.runId !== baseEffective.runId) {
        throw new Error('generated knowledge baseline crosses project ownership')
      }
      const snapshot = wikiRunSnapshotFromDatabase(this.database, baseEffective.runId)
      if (snapshot === undefined || snapshot.snapshotHash !== baseEffective.runSnapshotHash) {
        throw new Error('effective knowledge version references an unavailable Wiki snapshot')
      }
      const page = snapshot.pages.find(candidate => candidate.id === request.pageId)
      if (page === undefined || !generated.pageIds.includes(page.id)) {
        throw new Error('knowledge human revision target is not part of the generated version')
      }

      const sequenceRow = this.database.prepare(`
        SELECT MAX(revision) AS revision FROM knowledge_human_revisions WHERE project_root = ?
      `).get(request.projectRoot) as { revision: number | null }
      const revisionNumber = (sequenceRow.revision ?? 0) + 1
      const revisionId = createKnowledgeHumanRevisionId()
      const effectiveVersion = createRevisedKnowledgeEffectiveVersion(baseEffective, revisionId, createdAt)
      const revision = parseKnowledgeHumanRevision({
        schemaVersion: 1,
        id: revisionId,
        requestId: request.requestId,
        requestFingerprint: fingerprint,
        revision: revisionNumber,
        projectRoot: request.projectRoot,
        generatedVersionId: generated.id,
        baseEffectiveVersionId: baseEffective.id,
        effectiveVersionId: effectiveVersion.id,
        pageId: request.pageId,
        kind: request.kind,
        ...(request.title === undefined ? {} : { title: request.title }),
        content: request.content,
        affectedClaimIds: request.kind === 'replace-page-body' ? [...page.claimIds] : [],
        createdAt,
      })
      const revisedSelection = reviseKnowledgeSelection(
        selection,
        request.baseEffectiveVersionId,
        effectiveVersion,
        createdAt,
      )
      const result: KnowledgeHumanRevisionResult = {
        revision,
        effectiveVersion,
        selection: revisedSelection,
      }
      this.database.prepare(`
        INSERT INTO knowledge_effective_versions (
          id, project_root, generated_version_id, run_id, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        effectiveVersion.id,
        effectiveVersion.projectRoot,
        effectiveVersion.generatedVersionId,
        effectiveVersion.runId,
        effectiveVersion.createdAt,
        JSON.stringify(effectiveVersion),
      )
      const updated = this.database.prepare(`
        UPDATE knowledge_selections SET
          revision = ?, mode = ?, analysis_generation = ?, current_run_id = ?,
          effective_version_id = ?, updated_at = ?, payload_json = ?
        WHERE project_root = ? AND revision = ? AND effective_version_id = ?
      `).run(
        revisedSelection.revision,
        revisedSelection.mode,
        revisedSelection.analysisGeneration,
        revisedSelection.currentRunId ?? null,
        revisedSelection.effectiveVersionId ?? null,
        revisedSelection.updatedAt,
        JSON.stringify(revisedSelection),
        request.projectRoot,
        selection.revision,
        request.baseEffectiveVersionId,
      )
      if (updated.changes !== 1) {
        throw new KnowledgeSelectionRevisionConflictError(
          request.projectRoot,
          request.expectedSelectionRevision,
          undefined,
        )
      }
      this.database.prepare(`
        INSERT INTO knowledge_human_revisions (
          id, request_id, request_fingerprint, project_root, revision,
          generated_version_id, base_effective_version_id, effective_version_id,
          page_id, created_at, payload_json, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revision.id,
        revision.requestId,
        revision.requestFingerprint,
        revision.projectRoot,
        revision.revision,
        revision.generatedVersionId,
        revision.baseEffectiveVersionId,
        revision.effectiveVersionId,
        revision.pageId,
        revision.createdAt,
        JSON.stringify(revision),
        JSON.stringify(result),
      )
      return structuredClone(result)
    }))
  }

  /** Select a newly planned run without replacing the currently effective version. */
  selectKnowledgeRun(
    projectRoot: string,
    runId: WikiRunId,
    updatedAt?: string,
    guard?: KnowledgeSelectionUpdateGuard,
  ): Promise<KnowledgeSelection> {
    const root = resolve(projectRoot)
    if (guard?.expectedRevision !== undefined
      && (!Number.isSafeInteger(guard.expectedRevision) || guard.expectedRevision < 1)) {
      throw new Error('expected knowledge selection revision must be a positive safe integer')
    }
    return this.serialized(() => withTransaction(this.database, () => {
      const run = this.database.prepare('SELECT project_root FROM wiki_runs WHERE id = ?')
        .get(runId) as { project_root: string } | undefined
      if (run === undefined) throw new Error('cannot select a missing Wiki run')
      if (run.project_root !== root) throw new Error('cannot select a Wiki run from another project')
      const existingRow = this.database.prepare('SELECT payload_json FROM knowledge_selections WHERE project_root = ?')
        .get(root) as WikiPayloadRow | undefined
      const existing = existingRow === undefined
        ? undefined
        : parseKnowledgeSelection(parseJson('knowledge selection row', existingRow.payload_json))
      if (guard !== undefined && existing?.revision !== guard.expectedRevision) {
        throw new KnowledgeSelectionRevisionConflictError(root, guard.expectedRevision, existing?.revision)
      }
      const selected = advanceKnowledgeSelection(root, runId, existing, updatedAt)
      if (existing !== undefined && selected === existing) return structuredClone(existing)
      this.database.prepare(`
        INSERT INTO knowledge_selections (
          project_root, revision, mode, analysis_generation, current_run_id,
          effective_version_id, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_root) DO UPDATE SET
          revision = excluded.revision,
          mode = excluded.mode,
          analysis_generation = excluded.analysis_generation,
          current_run_id = excluded.current_run_id,
          effective_version_id = excluded.effective_version_id,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `).run(
        root,
        selected.revision,
        selected.mode,
        selected.analysisGeneration,
        selected.currentRunId ?? null,
        selected.effectiveVersionId ?? null,
        selected.updatedAt,
        JSON.stringify(selected),
      )
      return structuredClone(selected)
    }))
  }

  /** Atomically persist prepared immutable versions and move the automatic project pointer. */
  activateKnowledgeVersion(request: ActivateKnowledgeVersionRequest): Promise<KnowledgeActivationResult> {
    const requestedGenerated = parseKnowledgeGeneratedVersion(structuredClone(request.generatedVersion))
    const requestedEffective = parseKnowledgeEffectiveVersion(structuredClone(request.effectiveVersion))
    if (!Number.isSafeInteger(request.expectedSelectionRevision) || request.expectedSelectionRevision < 1) {
      throw new Error('expected knowledge selection revision must be a positive safe integer')
    }
    if (requestedEffective.projectRoot !== requestedGenerated.projectRoot
      || requestedEffective.generatedVersionId !== requestedGenerated.id
      || requestedEffective.runId !== requestedGenerated.runId
      || requestedEffective.runSnapshotHash !== requestedGenerated.runSnapshotHash) {
      throw new Error('prepared effective version does not match its generated version')
    }
    return this.serialized(() => withTransaction(this.database, () => {
      const root = requestedGenerated.projectRoot
      const run = this.database.prepare('SELECT project_root, status, snapshot_hash FROM wiki_runs WHERE id = ?')
        .get(requestedGenerated.runId) as { project_root: string; status: string; snapshot_hash: string } | undefined
      if (run === undefined) throw new Error('cannot activate a missing Wiki run')
      if (run.project_root !== root) throw new Error('cannot activate a Wiki run from another project')
      if (run.status !== 'complete') throw new Error('cannot activate a Wiki run before it is complete')
      if (run.snapshot_hash !== requestedGenerated.runSnapshotHash) {
        throw new WikiRunRevisionConflictError(requestedGenerated.runId, requestedGenerated.runSnapshotHash, run.snapshot_hash)
      }
      const selectionRow = this.database.prepare('SELECT revision, payload_json FROM knowledge_selections WHERE project_root = ?')
        .get(root) as KnowledgeSelectionRow | undefined
      const selection = selectionRow === undefined
        ? undefined
        : parseKnowledgeSelection(parseJson('knowledge selection row', selectionRow.payload_json))

      const storedGeneratedRow = this.database.prepare(`
        SELECT payload_json FROM knowledge_generated_versions WHERE run_id = ? AND run_snapshot_hash = ?
      `).get(requestedGenerated.runId, requestedGenerated.runSnapshotHash) as WikiPayloadRow | undefined
      const generatedVersion = storedGeneratedRow === undefined
        ? requestedGenerated
        : parseKnowledgeGeneratedVersion(parseJson('knowledge generated version row', storedGeneratedRow.payload_json))
      const storedEffectiveRow = this.database.prepare(`
        SELECT payload_json FROM knowledge_effective_versions
        WHERE generated_version_id = ?
          AND json_array_length(json_extract(payload_json, '$.humanRevisionIds')) = 0
        ORDER BY created_at ASC, id ASC LIMIT 1
      `).get(generatedVersion.id) as WikiPayloadRow | undefined
      const effectiveVersion = storedEffectiveRow === undefined
        ? generatedVersion.id === requestedGenerated.id
          ? requestedEffective
          : createKnowledgeEffectiveVersion(generatedVersion, requestedEffective.createdAt)
        : parseKnowledgeEffectiveVersion(parseJson('knowledge effective version row', storedEffectiveRow.payload_json))

      if (selection?.effectiveVersionId === effectiveVersion.id) {
        return {
          generatedVersion: structuredClone(generatedVersion),
          effectiveVersion: structuredClone(effectiveVersion),
          selection: structuredClone(selection),
        }
      }
      if (selection?.revision !== request.expectedSelectionRevision) {
        throw new KnowledgeSelectionRevisionConflictError(root, request.expectedSelectionRevision, selection?.revision)
      }
      if (selection.currentRunId !== generatedVersion.runId) {
        throw new Error('generated knowledge version is not the current analysis run')
      }
      const activated = activateKnowledgeSelection(selection, effectiveVersion)
      if (storedGeneratedRow === undefined) {
        this.database.prepare(`
          INSERT INTO knowledge_generated_versions (
            id, project_root, run_id, run_snapshot_hash, created_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          generatedVersion.id,
          root,
          generatedVersion.runId,
          generatedVersion.runSnapshotHash,
          generatedVersion.createdAt,
          JSON.stringify(generatedVersion),
        )
      }
      if (storedEffectiveRow === undefined) {
        this.database.prepare(`
          INSERT INTO knowledge_effective_versions (
            id, project_root, generated_version_id, run_id, created_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          effectiveVersion.id,
          root,
          effectiveVersion.generatedVersionId,
          effectiveVersion.runId,
          effectiveVersion.createdAt,
          JSON.stringify(effectiveVersion),
        )
      }
      this.database.prepare(`
        UPDATE knowledge_selections SET
          revision = ?, mode = ?, analysis_generation = ?, current_run_id = ?,
          effective_version_id = ?, updated_at = ?, payload_json = ?
        WHERE project_root = ? AND revision = ?
      `).run(
        activated.revision,
        activated.mode,
        activated.analysisGeneration,
        activated.currentRunId ?? null,
        activated.effectiveVersionId ?? null,
        activated.updatedAt,
        JSON.stringify(activated),
        root,
        selection.revision,
      )
      return {
        generatedVersion: structuredClone(generatedVersion),
        effectiveVersion: structuredClone(effectiveVersion),
        selection: structuredClone(activated),
      }
    }))
  }

  /** Atomically replace one complete local LLM Wiki runtime snapshot. */
  saveWikiRunSnapshot(value: WikiRunSnapshot, expectedSnapshotHash?: string): Promise<WikiRunSnapshot> {
    const validated = parseWikiRunSnapshot(structuredClone(value))
    const root = resolve(validated.run.projectRoot)
    if (root !== validated.run.projectRoot) {
      throw new Error('memory-knowledge: Wiki projectRoot must be normalized')
    }
    return this.serialized(() => withTransaction(this.database, () => {
      const existing = this.database.prepare('SELECT project_root, snapshot_hash FROM wiki_runs WHERE id = ?')
        .get(validated.run.id) as { project_root: string; snapshot_hash: string } | undefined
      if (existing !== undefined && existing.project_root !== root) {
        throw new Error('memory-knowledge: Wiki run id already belongs to another project')
      }
      if (expectedSnapshotHash !== undefined && existing?.snapshot_hash !== expectedSnapshotHash) {
        throw new WikiRunRevisionConflictError(validated.run.id, expectedSnapshotHash, existing?.snapshot_hash)
      }
      const sealed = this.database.prepare(`
        SELECT run_snapshot_hash FROM knowledge_generated_versions WHERE run_id = ? LIMIT 1
      `).get(validated.run.id) as { run_snapshot_hash: string } | undefined
      if (sealed !== undefined && sealed.run_snapshot_hash !== validated.snapshotHash) {
        throw new Error('generated knowledge version makes its Wiki run snapshot immutable')
      }
      const succeeded = new Set(validated.tasks.filter(task => task.status === 'succeeded').map(task => String(task.id)))
      const blocked = this.database.prepare(`SELECT task_id FROM wiki_material_budgets
        WHERE run_id = ? AND json_extract(payload_json, '$.blockedReadBytes') IS NOT NULL`)
        .all(validated.run.id) as Array<{ task_id: string }>
      for (const row of blocked) {
        if (!succeeded.has(row.task_id)) continue
        const budget = readWikiMaterialBudget(this.database, { runId: validated.run.id, taskId: WikiTaskId(row.task_id) })
        if (budget !== undefined && budget.blockedReadBytes !== null) throw new Error(wikiMaterialBudgetFailure(budget))
      }
      this.database.prepare('DELETE FROM wiki_runs WHERE id = ?').run(validated.run.id)
      this.database.prepare(`
        INSERT INTO wiki_runs (
          id, project_root, status, catalog_hash, snapshot_hash, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.run.id,
        root,
        validated.run.status,
        validated.run.catalogHash,
        validated.snapshotHash,
        validated.run.updatedAt,
        JSON.stringify(validated.run),
      )
      const insertCoverage = this.database.prepare(`
        INSERT INTO wiki_coverage (run_id, id, source_id, path, status, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const item of validated.coverage) {
        insertCoverage.run(validated.run.id, item.id, item.sourceId, item.path, item.status, JSON.stringify(item))
      }
      const insertTask = this.database.prepare(`
        INSERT INTO wiki_tasks (run_id, id, shard_key, status, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const task of validated.tasks) {
        insertTask.run(validated.run.id, task.id, task.shardKey, task.status, JSON.stringify(task))
      }
      const insertCitation = this.database.prepare(`
        INSERT INTO wiki_citations (run_id, id, payload_json) VALUES (?, ?, ?)
      `)
      for (const citation of validated.citations) {
        insertCitation.run(validated.run.id, citation.id, JSON.stringify(citation))
      }
      const insertClaim = this.database.prepare(`
        INSERT INTO wiki_claims (run_id, id, status, payload_json) VALUES (?, ?, ?, ?)
      `)
      for (const claim of validated.claims) {
        insertClaim.run(validated.run.id, claim.id, claim.status, JSON.stringify(claim))
      }
      const insertConflict = this.database.prepare(`
        INSERT INTO wiki_conflicts (run_id, id, status, payload_json) VALUES (?, ?, ?, ?)
      `)
      for (const conflict of validated.conflicts) {
        insertConflict.run(validated.run.id, conflict.id, conflict.status, JSON.stringify(conflict))
      }
      const insertPage = this.database.prepare(`
        INSERT INTO wiki_pages (run_id, id, slug, status, payload_json) VALUES (?, ?, ?, ?, ?)
      `)
      for (const page of validated.pages) {
        insertPage.run(validated.run.id, page.id, page.slug, page.status, JSON.stringify(page))
      }
      return structuredClone(validated)
    }))
  }

  /** Read and cross-check one complete local LLM Wiki runtime snapshot. */
  getWikiRunSnapshot(id: WikiRunId): Promise<WikiRunSnapshot | undefined> {
    return this.serialized(() => wikiRunSnapshotFromDatabase(this.database, id))
  }

  /** List durable LLM Wiki run headers for one project or all local projects. */
  listWikiRuns(projectRoot?: string, limit?: number): Promise<WikiRun[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Wiki run list limit must be a positive safe integer')
    }
    const root = projectRoot === undefined ? undefined : resolve(projectRoot)
    return this.serialized(() => {
      const rows = root === undefined
        ? limit === undefined
          ? this.database.prepare('SELECT payload_json FROM wiki_runs ORDER BY updated_at DESC, id ASC').all()
          : this.database.prepare(
              'SELECT payload_json FROM wiki_runs ORDER BY updated_at DESC, id ASC LIMIT ?',
            ).all(limit)
        : limit === undefined
          ? this.database.prepare(`
              SELECT payload_json FROM wiki_runs WHERE project_root = ? ORDER BY updated_at DESC, id ASC
            `).all(root)
          : this.database.prepare(`
              SELECT payload_json FROM wiki_runs WHERE project_root = ? ORDER BY updated_at DESC, id ASC LIMIT ?
            `).all(root, limit)
      return (rows as unknown as WikiPayloadRow[])
        .map(row => parseWikiRun(parseJson('Wiki run row', row.payload_json)))
    })
  }

  /** Atomically replace one source's local record map or return its current checkpoint. */
  saveSourceUnderstanding(projectRoot: string, value: SourceUnderstanding): Promise<SourceUnderstanding> {
    const root = resolve(projectRoot)
    const validated = parseSourceUnderstanding(structuredClone(value))
    return this.serialized(() => withTransaction(this.database, () => {
      const existing = this.database.prepare(`
        SELECT payload_json FROM source_understandings WHERE project_root = ? AND source_id = ?
      `).get(root, validated.sourceId) as SourceUnderstandingRow | undefined
      if (existing !== undefined) {
        const current = parseSourceUnderstanding(parseJson('source understanding row', existing.payload_json))
        if (current.checkpointKey === validated.checkpointKey) {
          indexSourceUnderstanding(this.database, root, current)
          indexSourceRelations(this.database, root, current)
          indexSourceSymbols(this.database, root, current)
          return current
        }
        deleteSourceEvidenceCheckpoint(this.database, current.checkpointKey)
        this.database.prepare(
          'DELETE FROM source_understandings WHERE project_root = ? AND source_id = ?',
        ).run(root, validated.sourceId)
      }
      this.database.prepare(`
        INSERT INTO source_understandings (
          checkpoint_key, project_root, source_id, inventory_hash, output_hash, record_count, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.checkpointKey,
        root,
        validated.sourceId,
        validated.inventoryHash,
        validated.outputHash,
        validated.recordCount,
        JSON.stringify(validated),
      )
      const insertRecord = this.database.prepare(`
        INSERT INTO source_records (checkpoint_key, path, payload_json) VALUES (?, ?, ?)
      `)
      for (const record of validated.records) {
        insertRecord.run(validated.checkpointKey, record.path, JSON.stringify(record))
      }
      indexSourceUnderstanding(this.database, root, validated)
      indexSourceRelations(this.database, root, validated)
      indexSourceSymbols(this.database, root, validated)
      return structuredClone(validated)
    }))
  }

  /** List current local Source understanding checkpoints for one project. */
  listSourceUnderstandings(projectRoot: string): Promise<SourceUnderstanding[]> {
    const root = resolve(projectRoot)
    return this.serialized(() => {
      const rows = this.database.prepare(`
        SELECT payload_json FROM source_understandings WHERE project_root = ? ORDER BY source_id ASC
      `).all(root) as unknown as SourceUnderstandingRow[]
      return rows.map(row => parseSourceUnderstanding(parseJson('source understanding row', row.payload_json)))
    })
  }

  /** Search the current Source evidence generation for one project. */
  searchSourceEvidence(request: SourceEvidenceSearchRequest): Promise<SourceEvidencePack> {
    return this.serialized(() => {
      const query = normalizedText(request.query, 'Source evidence query')
      const root = resolve(request.projectRoot)
      const terms = queryTerms(query)
      const parameters: Array<string | number> = []
      let from: string
      let where: string
      if (terms.length === 0) {
        from = `
          FROM source_evidence_documents d
          JOIN source_evidence_fts f ON f.evidence_key = d.evidence_key
        `
        where = `
          WHERE instr(lower(f.path || char(10) || f.name || char(10) || f.area || char(10) || f.metadata), lower(?)) > 0
            AND d.project_root = ?
        `
        parameters.push(query, root)
      } else {
        from = `
          FROM source_evidence_fts
          JOIN source_evidence_documents d ON d.evidence_key = source_evidence_fts.evidence_key
        `
        where = 'WHERE source_evidence_fts MATCH ? AND d.project_root = ?\n'
        parameters.push(ftsExpression(terms), root)
      }
      const countRow = this.database.prepare(`SELECT count(*) AS count ${from} ${where}`)
        .get(...parameters) as { count: number }
      const rows = this.database.prepare(`
        SELECT
          d.source_id,
          d.commit_hash,
          d.inventory_hash,
          d.output_hash,
          d.path,
          d.content_hash,
          d.area,
          d.artifact_kind,
          d.language,
          d.evidence_kind,
          d.evidence_name,
          d.evidence_detail,
          d.start_line,
          d.end_line,
          ${terms.length === 0 ? '0.0' : 'bm25(source_evidence_fts)'} AS rank
        ${from}
        ${where}
        ORDER BY rank ASC, d.path ASC, d.start_line ASC, d.evidence_key ASC
        LIMIT ?
      `).all(...parameters, request.limit) as unknown as SourceEvidenceRow[]
      const hits = rows.map(sourceEvidenceHitFromRow)
      const revisions = new Map<string, SourceEvidenceRevision>()
      for (const hit of hits) revisions.set(String(hit.sourceId), sourceEvidenceRevision(hit))
      const totalMatches = countRow.count
      return {
        retriever: 'source-evidence-fts',
        version: SOURCE_EVIDENCE_RETRIEVER_VERSION,
        query,
        totalMatches,
        omittedHitCount: totalMatches - hits.length,
        truncationReasons: totalMatches > hits.length ? ['result-limit'] : [],
        sourceRevisions: [...revisions.values()].sort((left, right) => compareText(String(left.sourceId), String(right.sourceId))),
        hits,
      }
    }, request.signal)
  }

  /** Query the current Source relation generation for one project. */
  querySourceRelations(request: SourceRelationQueryRequest): Promise<SourceRelationQueryPack> {
    return this.serialized(() => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new Error('Source relation query limit must be a positive safe integer')
      }
      const root = resolve(request.projectRoot)
      const query = request.query === undefined ? undefined : normalizedText(request.query, 'Source relation query')
      const area = request.area === undefined ? undefined : normalizedText(request.area, 'Source relation area')
      const clauses = ['project_root = ?']
      const parameters: Array<string | number> = [root]
      if (query !== undefined) {
        clauses.push(`instr(lower(
          from_path || char(10) || coalesce(to_path, '') || char(10) || specifier
        ), lower(?)) > 0`)
        parameters.push(query)
      }
      if (area !== undefined) {
        clauses.push(`(
          CASE instr(from_path, '/')
            WHEN 0 THEN '仓库根目录'
            ELSE substr(from_path, 1, instr(from_path, '/') - 1)
          END
        ) = ?`)
        parameters.push(area)
      }
      if (request.resolution !== undefined) {
        clauses.push('resolution = ?')
        parameters.push(request.resolution)
      }
      if (request.kind !== undefined) {
        clauses.push('relation_kind = ?')
        parameters.push(request.kind)
      }
      const where = `WHERE ${clauses.join('\n AND ')}`
      const countRow = this.database.prepare(`
        SELECT count(*) AS count FROM source_relation_edges ${where}
      `).get(...parameters) as { count: number }
      const rows = this.database.prepare(`
        SELECT
          edge_key,
          source_id,
          commit_hash,
          inventory_hash,
          output_hash,
          from_path,
          from_content_hash,
          to_path,
          specifier,
          relation_kind,
          resolution,
          start_line,
          end_line
        FROM source_relation_edges
        ${where}
        ORDER BY from_path ASC, start_line ASC, end_line ASC, specifier ASC, edge_key ASC
        LIMIT ?
      `).all(...parameters, request.limit) as unknown as SourceRelationRow[]
      const edges = rows.map(sourceRelationEdgeFromRow)
      const representedSources = new Set(edges.map(edge => String(edge.sourceId)))
      const understandings = this.database.prepare(`
        SELECT payload_json FROM source_understandings WHERE project_root = ? ORDER BY source_id ASC
      `).all(root) as unknown as SourceUnderstandingRow[]
      const understandingBySource = new Map(understandings
        .map(row => parseSourceUnderstanding(parseJson('source understanding row', row.payload_json)))
        .filter(value => representedSources.has(String(value.sourceId)))
        .map(value => [String(value.sourceId), value]))
      const revisions = new Map<string, SourceRelationRevision>()
      for (const edge of edges) {
        const understanding = understandingBySource.get(String(edge.sourceId))
        if (understanding === undefined) throw new Error('Source relation index has no current understanding')
        revisions.set(String(edge.sourceId), sourceRelationRevision(edge, understanding))
      }
      const totalMatches = countRow.count
      return {
        retriever: 'source-relations-sql',
        version: SOURCE_RELATION_RETRIEVER_VERSION,
        ...(query === undefined ? {} : { query }),
        ...(area === undefined ? {} : { area }),
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        totalMatches,
        omittedEdgeCount: totalMatches - edges.length,
        truncationReasons: totalMatches > edges.length ? ['result-limit'] : [],
        sourceRevisions: [...revisions.values()].sort((left, right) => compareText(String(left.sourceId), String(right.sourceId))),
        edges,
      }
    }, request.signal)
  }

  /** Query current cross-file symbol definitions and references for one project. */
  querySourceSymbols(request: SourceSymbolQueryRequest): Promise<SourceSymbolQueryPack> {
    return this.serialized(() => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new Error('Source symbol query limit must be a positive safe integer')
      }
      const root = resolve(request.projectRoot)
      const query = request.query === undefined ? undefined : normalizedText(request.query, 'Source symbol query')
      const definitionPath = request.definitionPath === undefined
        ? undefined
        : normalizedText(request.definitionPath, 'Source symbol definition path')
      const referencePath = request.referencePath === undefined
        ? undefined
        : normalizedText(request.referencePath, 'Source symbol reference path')
      const clauses = ['r.project_root = ?']
      const parameters: Array<string | number> = [root]
      if (query !== undefined) {
        clauses.push(`instr(lower(
          d.symbol_name || char(10) || d.declaration_kind || char(10)
            || d.definition_path || char(10) || r.reference_path
        ), lower(?)) > 0`)
        parameters.push(query)
      }
      if (definitionPath !== undefined) {
        clauses.push('instr(lower(d.definition_path), lower(?)) > 0')
        parameters.push(definitionPath)
      }
      if (referencePath !== undefined) {
        clauses.push('instr(lower(r.reference_path), lower(?)) > 0')
        parameters.push(referencePath)
      }
      if (request.referenceKind !== undefined) {
        clauses.push('r.reference_kind = ?')
        parameters.push(request.referenceKind)
      }
      const from = `
        FROM source_symbol_references r
        JOIN source_symbol_definitions d
          ON d.definition_key = r.definition_key
          AND d.project_root = r.project_root
          AND d.checkpoint_key = r.checkpoint_key
      `
      const where = `WHERE ${clauses.join('\n AND ')}`
      const countRow = this.database.prepare(`SELECT count(*) AS count ${from} ${where}`)
        .get(...parameters) as { count: number }
      const rows = this.database.prepare(`
        SELECT
          r.reference_key,
          d.source_id,
          d.commit_hash,
          d.inventory_hash,
          d.output_hash,
          d.symbol_id,
          d.symbol_name,
          d.declaration_kind,
          d.definition_path,
          d.definition_content_hash,
          d.definition_start_line,
          d.definition_end_line,
          r.reference_path,
          r.reference_content_hash,
          r.reference_kind,
          r.reference_start_line,
          r.reference_end_line
        ${from}
        ${where}
        ORDER BY d.symbol_name ASC, d.definition_path ASC, d.definition_start_line ASC,
          r.reference_path ASC, r.reference_start_line ASC, r.reference_key ASC
        LIMIT ?
      `).all(...parameters, request.limit) as unknown as SourceSymbolRow[]
      const edges = rows.map(sourceSymbolEdgeFromRow)
      const representedSources = new Set(edges.map(edge => String(edge.sourceId)))
      const understandings = this.database.prepare(`
        SELECT payload_json FROM source_understandings WHERE project_root = ? ORDER BY source_id ASC
      `).all(root) as unknown as SourceUnderstandingRow[]
      const understandingBySource = new Map(understandings
        .map(row => parseSourceUnderstanding(parseJson('source understanding row', row.payload_json)))
        .filter(value => representedSources.has(String(value.sourceId)))
        .map(value => [String(value.sourceId), value]))
      const revisions = new Map<string, SourceSymbolRevision>()
      for (const edge of edges) {
        const understanding = understandingBySource.get(String(edge.sourceId))
        if (understanding === undefined) throw new Error('Source symbol index has no current understanding')
        revisions.set(String(edge.sourceId), sourceSymbolRevision(edge, understanding))
      }
      const totalMatches = countRow.count
      return {
        retriever: 'source-symbols-sql',
        version: SOURCE_SYMBOL_RETRIEVER_VERSION,
        ...(query === undefined ? {} : { query }),
        ...(definitionPath === undefined ? {} : { definitionPath }),
        ...(referencePath === undefined ? {} : { referencePath }),
        ...(request.referenceKind === undefined ? {} : { referenceKind: request.referenceKind }),
        totalMatches,
        omittedReferenceCount: totalMatches - edges.length,
        truncationReasons: totalMatches > edges.length ? ['result-limit'] : [],
        sourceRevisions: [...revisions.values()].sort((left, right) => compareText(String(left.sourceId), String(right.sourceId))),
        edges,
      }
    }, request.signal)
  }

  /** List newest candidates under an optional project and status filter. */
  listCandidates(request: ListReviewCandidatesRequest): Promise<ReviewCandidate[]> {
    return this.serialized(() => {
      const clauses: string[] = []
      const parameters: Array<string | number> = []
      if (request.projectRoot !== undefined) {
        clauses.push('project_root = ?')
        parameters.push(resolve(request.projectRoot))
      }
      if (request.applicability !== undefined) {
        clauses.push(request.applicability === 'global' ? 'project_root IS NULL' : 'project_root IS NOT NULL')
      }
      if (request.status !== undefined) {
        clauses.push('status = ?')
        parameters.push(request.status)
      }
      parameters.push(request.limit)
      const rows = this.database.prepare(`
        SELECT payload_json FROM candidates
        ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(...parameters) as unknown as CandidateRow[]
      return rows.map(row => structuredClone(candidateFromRow(row)!))
    })
  }

  /** Read one candidate by opaque id. */
  getCandidate(id: MemoryCandidateId): Promise<ReviewCandidate | undefined> {
    return this.serialized(() => {
      const candidate = candidateFromRow(this.database.prepare(
        'SELECT payload_json FROM candidates WHERE id = ?',
      ).get(id) as CandidateRow | undefined)
      return candidate === undefined ? undefined : structuredClone(candidate)
    })
  }

  /** Apply one idempotent accept/reject decision. */
  reviewCandidate(
    id: MemoryCandidateId,
    decision: ReviewCandidateDecision,
    expectedRevision?: number,
  ): Promise<ReviewCandidate> {
    return this.serialized(() => withTransaction(this.database, () => {
      const candidate = candidateFromRow(this.database.prepare(
        'SELECT payload_json FROM candidates WHERE id = ?',
      ).get(id) as CandidateRow | undefined)
      if (candidate === undefined) throw new Error(`memory candidate not found: ${id}`)
      if (expectedRevision !== undefined && candidate.revision !== expectedRevision) {
        throw new MemoryCandidateRevisionConflictError(id, expectedRevision, candidate.revision)
      }
      const target = decision === 'accept' ? 'accepted' : 'rejected'
      if (candidate.status === target) return candidate
      if (candidate.status !== 'pending') {
        throw new Error(`memory candidate ${id} is ${candidate.status}; cannot ${decision}`)
      }
      const now = new Date().toISOString()
      const localMemoryId = candidate.target === 'memory' && target === 'accepted'
        ? candidate.localMemoryId ?? createMemoryId()
        : undefined
      const updated: ReviewCandidate = {
        ...candidate,
        revision: candidate.revision + 1,
        status: target,
        updatedAt: now,
        reviewedAt: now,
        ...localMemoryId === undefined ? {} : { localMemoryId },
      }
      this.database.prepare(
        'UPDATE candidates SET status = ?, updated_at = ?, payload_json = ? WHERE id = ?',
      ).run(updated.status, updated.updatedAt, JSON.stringify(updated), id)
      if (updated.target === 'memory') {
        deleteSearchDocument(this.database, documentKey(candidateSearchDocument(updated)))
        if (target === 'accepted' && localMemoryId !== undefined) {
          insertLocalMemoryEntry(this.database, localMemoryFromCandidate(updated, localMemoryId), 'created')
        }
      }
      return structuredClone(updated)
    }))
  }

  /** Reserve one stable canonical target id before an external promotion write. */
  reservePromotion(id: MemoryCandidateId, expectedRevision?: number): Promise<ReviewCandidate> {
    return this.serialized(() => {
      const candidate = candidateFromRow(this.database.prepare(
        'SELECT payload_json FROM candidates WHERE id = ?',
      ).get(id) as CandidateRow | undefined)
      if (candidate === undefined) throw new Error(`memory candidate not found: ${id}`)
      if (expectedRevision !== undefined && candidate.revision !== expectedRevision) {
        throw new MemoryCandidateRevisionConflictError(id, expectedRevision, candidate.revision)
      }
      if (candidate.sensitivity === 'restricted') {
        throw new Error('restricted candidates stay local and cannot be promoted to Git')
      }
      if (candidate.status === 'rejected') throw new Error(`memory candidate ${id} is rejected`)
      if (candidate.status === 'promoted'
        || (candidate.target === 'memory' && candidate.promotedMemoryId !== undefined)
        || (candidate.target === 'knowledge-card' && candidate.promotedKnowledgeCardId !== undefined)) return candidate
      if (candidate.status !== 'accepted') {
        throw new Error(`memory candidate ${id} must be accepted before promotion`)
      }
      const updated: ReviewCandidate = candidate.target === 'memory'
        ? {
            ...candidate,
            revision: candidate.revision + 1,
            promotedMemoryId: candidate.applicability === 'project'
              ? candidate.localMemoryId ?? createMemoryId()
              : createMemoryId(),
            updatedAt: new Date().toISOString(),
          }
        : {
            ...candidate,
            revision: candidate.revision + 1,
            promotedKnowledgeCardId: candidate.card.targetCardId ?? createKnowledgeCardId(),
            updatedAt: new Date().toISOString(),
          }
      this.database.prepare('UPDATE candidates SET updated_at = ?, payload_json = ? WHERE id = ?').run(
        updated.updatedAt,
        JSON.stringify(updated),
        id,
      )
      return structuredClone(updated)
    })
  }

  /** Mark a successfully materialized canonical promotion and remove its personal search copy. */
  completePromotion(id: MemoryCandidateId): Promise<ReviewCandidate> {
    return this.serialized(() => withTransaction(this.database, () => {
      const candidate = candidateFromRow(this.database.prepare(
        'SELECT payload_json FROM candidates WHERE id = ?',
      ).get(id) as CandidateRow | undefined)
      if (candidate === undefined) throw new Error(`memory candidate not found: ${id}`)
      if (candidate.status === 'promoted') return candidate
      if ((candidate.target === 'memory' && candidate.promotedMemoryId === undefined)
        || (candidate.target === 'knowledge-card' && candidate.promotedKnowledgeCardId === undefined)) {
        throw new Error(`review candidate ${id} has no reserved canonical id`)
      }
      const now = new Date().toISOString()
      const updated: ReviewCandidate = {
        ...candidate,
        revision: candidate.revision + 1,
        status: 'promoted',
        updatedAt: now,
        reviewedAt: candidate.reviewedAt ?? now,
      }
      this.database.prepare(
        'UPDATE candidates SET status = ?, updated_at = ?, payload_json = ? WHERE id = ?',
      ).run(updated.status, updated.updatedAt, JSON.stringify(updated), id)
      if (updated.target === 'memory') deleteSearchDocument(this.database, documentKey(candidateSearchDocument(updated)))
      return structuredClone(updated)
    }))
  }

  /** Replace one project's derived canonical documents when its fingerprint changes. */
  replaceCanonicalDocuments(
    projectRoot: string,
    fingerprint: string,
    documents: readonly IndexedMemoryDocument[],
  ): Promise<boolean> {
    return this.serialized(() => withTransaction(this.database, () => {
      const root = resolve(projectRoot)
      const generation = this.database.prepare(
        'SELECT fingerprint FROM canonical_generations WHERE project_root = ?',
      ).get(root) as { fingerprint: string } | undefined
      if (generation?.fingerprint === fingerprint) return false
      const keys = this.database.prepare(
        "SELECT document_key FROM search_documents WHERE owner = 'canonical' AND project_root = ?",
      ).all(root) as unknown as Array<{ document_key: string }>
      for (const { document_key: key } of keys) deleteSearchDocument(this.database, key)
      for (const document of documents) upsertSearchDocument(this.database, 'canonical', indexedSearchDocument(document))
      const localRows = this.database.prepare(`
        SELECT payload_json FROM memory_entries
        WHERE project_root = ? AND status = 'active'
        ORDER BY id ASC
      `).all(root) as unknown as LocalMemoryEntryRow[]
      for (const row of localRows) {
        refreshLocalMemorySearchDocument(this.database, localMemoryEntryFromJson(parseJson('local memory row', row.payload_json)))
      }
      this.database.prepare(`
        INSERT INTO canonical_generations (project_root, fingerprint) VALUES (?, ?)
        ON CONFLICT(project_root) DO UPDATE SET fingerprint = excluded.fingerprint
      `).run(root, fingerprint)
      return true
    }))
  }

  /** List newest normal-sensitivity records that are eligible for recall. */
  listRecallable(request: ListRecallableMemoryRequest): Promise<RecallableMemoryRecord[]> {
    return this.serialized(() => {
      const parameters: Array<string | number> = []
      const scope = recordScopeClause(request.projectRoot, request.scopeMode, 'project_root')
      const domain = recordDomainClause(request.domain, 'record_type')
      if (scope.parameter !== undefined) parameters.push(scope.parameter)
      parameters.push(request.limit)
      const rows = this.database.prepare(`
        SELECT payload_json, status FROM search_documents
        WHERE sensitivity = 'normal' AND ${scope.clause}${domain === undefined ? '' : ` AND ${domain}`}
        ORDER BY updated_at DESC, record_id ASC
        LIMIT ?
      `).all(...parameters) as unknown as TraceRow[]
      return rows.map((row): RecallableMemoryRecord => {
        const document = storedDocumentFromJson(parseJson('recallable document row', row.payload_json))
        return {
          id: document.id,
          recordType: document.recordType,
          title: document.title,
          content: document.content,
          tags: [...document.tags],
          evidenceClass: document.evidenceClass,
          sensitivity: document.sensitivity,
          status: row.status,
          ...document.projectRoot === undefined ? {} : { projectRoot: document.projectRoot },
          ...document.scope === undefined ? {} : { scope: structuredClone(document.scope) },
          provenance: structuredClone(document.provenance),
          updatedAt: document.updatedAt,
        }
      })
    })
  }

  /** Search the local index with FTS5 trigram terms and a short-query fallback. */
  search(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    return this.serialized(() => {
      const query = normalizedText(request.query, 'query')
      const terms = queryTerms(query)
      const parameters: Array<string | number> = []
      let matchClause: string
      if (terms.length === 0) {
        matchClause = `
          SELECT d.payload_json, 0.0 AS rank
          FROM search_documents d
          JOIN search_fts f ON f.document_key = d.document_key
          WHERE instr(lower(f.title || char(10) || f.content || char(10) || f.tags), lower(?)) > 0
        `
        parameters.push(query)
      } else {
        matchClause = `
          SELECT d.payload_json, bm25(search_fts) AS rank
          FROM search_fts
          JOIN search_documents d ON d.document_key = search_fts.document_key
          WHERE search_fts MATCH ?
        `
        parameters.push(ftsExpression(terms))
      }
      const scope = recordScopeClause(request.projectRoot, request.scopeMode, 'd.project_root')
      matchClause += ` AND ${scope.clause}\n`
      if (scope.parameter !== undefined) parameters.push(scope.parameter)
      const domain = recordDomainClause(request.domain, 'd.record_type')
      if (domain !== undefined) matchClause += ` AND ${domain}\n`
      if (request.includeRestricted !== true) matchClause += " AND d.sensitivity = 'normal'\n"
      matchClause += ' ORDER BY rank ASC, d.updated_at DESC, d.record_id ASC LIMIT ?'
      parameters.push(request.limit)
      const rows = this.database.prepare(matchClause).all(...parameters) as unknown as SearchRow[]
      const hits: MemorySearchHit[] = []
      let remaining = request.maxChars
      for (const row of rows) {
        if (remaining <= 0) break
        const document = storedDocumentFromJson(parseJson('search document row', row.payload_json))
        const content = document.content.slice(0, remaining)
        hits.push({
          ...document,
          content,
          score: Number.isFinite(row.rank) ? -row.rank : 0,
          truncated: content.length < document.content.length,
        })
        remaining -= content.length
      }
      return hits
    }, request.signal)
  }

  /** Read a candidate first, then an indexed document with the same id. */
  trace(id: string, projectRoot?: string): Promise<MemoryTrace | undefined> {
    return this.serialized(() => {
      const candidate = candidateFromRow(this.database.prepare(
        'SELECT payload_json FROM candidates WHERE id = ?',
      ).get(id) as CandidateRow | undefined)
      if (candidate !== undefined) {
        return {
          id: candidate.id,
          recordType: 'candidate',
          title: candidate.title,
          content: candidate.content,
          status: candidate.status,
          sensitivity: candidate.sensitivity,
          ...candidate.projectRoot === undefined ? {} : { projectRoot: candidate.projectRoot },
          provenance: structuredClone(candidate.provenance),
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
        }
      }
      const local = localMemoryEntryFromRow(this.database.prepare(`
        SELECT payload_json FROM memory_entries
        WHERE id = ? AND ${projectRoot === undefined ? 'project_root IS NULL' : 'project_root = ?'}
      `).get(id, ...projectRoot === undefined ? [] : [resolve(projectRoot)]) as LocalMemoryEntryRow | undefined)
      if (local !== undefined) {
        return {
          id: local.id,
          recordType: local.applicability === 'global' ? 'personal-memory' : 'project-memory',
          title: local.title,
          content: local.content,
          status: local.status,
          sensitivity: local.sensitivity,
          ...local.projectRoot === undefined ? {} : { projectRoot: local.projectRoot },
          provenance: structuredClone(local.provenance),
          createdAt: local.createdAt,
          updatedAt: local.updatedAt,
        }
      }
      const clauses = ['record_id = ?']
      const parameters: string[] = [id]
      if (projectRoot !== undefined) {
        clauses.push('(project_root IS NULL OR project_root = ?)')
        parameters.push(resolve(projectRoot))
      }
      const row = this.database.prepare(`
        SELECT payload_json, status FROM search_documents
        WHERE ${clauses.join(' AND ')}
        ORDER BY project_root IS NULL ASC
        LIMIT 1
      `).get(...parameters) as TraceRow | undefined
      if (row === undefined) return undefined
      const document = storedDocumentFromJson(parseJson('trace document row', row.payload_json))
      return {
        id: document.id,
        recordType: document.recordType,
        title: document.title,
        content: document.content,
        status: row.status,
        sensitivity: document.sensitivity,
        ...document.projectRoot === undefined ? {} : { projectRoot: document.projectRoot },
        ...document.scope === undefined ? {} : { scope: structuredClone(document.scope) },
        provenance: structuredClone(document.provenance),
        updatedAt: document.updatedAt,
      }
    })
  }
}

/** Stable fingerprint for one complete canonical store snapshot. */
export function canonicalFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
