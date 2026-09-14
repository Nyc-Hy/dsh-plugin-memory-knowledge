import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { KnowledgeSourceId, KNOWLEDGE_SOURCE_ID_PATTERN } from './ids.js'
import type { SourceInventory, SourceInventoryBaseline, SourceInventoryFile } from './inventory.js'
import { PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'
import { parseSourceFileAnalysis, type SourceFileAnalysis } from './source-analysis.js'
import {
  DeterministicSourceRelationAnalyzer,
  parseSourceRelationGraph,
  type SourceRelationAnalyzer,
  type SourceRelationGraph,
} from './source-relations.js'
import {
  emptySourceSymbolGraph,
  parseSourceSymbolGraph,
  type SourceSymbolGraph,
} from './source-symbols.js'

/** Version of the deterministic inventory-to-record mapping. */
export const SOURCE_RECORD_MAP_VERSION = 7 as const

/** Role inferred only from a portable path and inventory language. */
export type SourceArtifactKind = 'code' | 'test' | 'documentation' | 'configuration' | 'asset' | 'other'

/** Deployment bounds that affect the deterministic Source record output. */
export interface SourceRecordConfig {
  maxRepresentativeFilesPerArea: number
}

/** Default Source record presentation bound. */
export const DEFAULT_SOURCE_RECORD_CONFIG: SourceRecordConfig = {
  maxRepresentativeFilesPerArea: 8,
}

/** One portable local record derived from a source inventory file. */
export interface SourceRecord {
  path: string
  contentHash: string
  size: number
  area: string
  artifactKind: SourceArtifactKind
  language?: string
  analysis?: SourceFileAnalysis
}

/** Count and byte summary for one language or artifact role. */
export interface SourceRecordGroup {
  name: string
  fileCount: number
  totalBytes: number
}

/** Deterministic top-level area summary used by bounded Card generation. */
export interface SourceAreaSummary {
  name: string
  fileCount: number
  totalBytes: number
  languages: SourceRecordGroup[]
  artifactKinds: SourceRecordGroup[]
  representativePaths: string[]
  omittedFileCount: number
}

/** Complete local checkpoint for one clean source inventory. */
export interface SourceUnderstanding {
  version: typeof SOURCE_RECORD_MAP_VERSION
  generator: 'source-record-map'
  checkpointKey: string
  sourceId: KnowledgeSourceId
  commit: string
  inventoryHash: string
  inventoryReuseKey: string
  outputHash: string
  config: SourceRecordConfig
  recordCount: number
  totalBytes: number
  records: SourceRecord[]
  areas: SourceAreaSummary[]
  relations: SourceRelationGraph
  symbols: SourceSymbolGraph
}

/** Browser-safe and CLI-safe summary of one local Source understanding. */
export interface SourceUnderstandingSummary {
  version: typeof SOURCE_RECORD_MAP_VERSION
  sourceId: KnowledgeSourceId
  commit: string
  inventoryHash: string
  outputHash: string
  recordCount: number
  evidenceCount: number
  totalBytes: number
  areaCount: number
  relationCount: number
  internalRelationCount: number
  externalRelationCount: number
  unresolvedRelationCount: number
  omittedRelationCount: number
  symbolDefinitionCount: number
  symbolReferenceCount: number
  omittedSymbolFileCount: number
  omittedSymbolReferenceCount: number
  symbolConfigMode: 'default' | 'tsconfig'
  symbolConfigFileCount: number
  symbolProjectReferenceCount: number
  symbolPathAliasCount: number
  symbolConfigDiagnosticCount: number
  omittedSymbolConfigFileCount: number
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sourceArea(path: string): string {
  const separator = path.indexOf('/')
  return separator === -1 ? '仓库根目录' : path.slice(0, separator)
}

const DOCUMENT_EXTENSIONS = new Set(['.adoc', '.md', '.mdx', '.rst', '.txt'])
const CONFIG_EXTENSIONS = new Set(['.ini', '.json', '.toml', '.xml', '.yaml', '.yml'])
const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mp3', '.mp4', '.ogg', '.otf', '.pdf', '.png',
  '.svg', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2',
])

function artifactKind(file: SourceInventoryFile): SourceArtifactKind {
  const segments = file.path.toLowerCase().split('/')
  const name = segments.at(-1) ?? ''
  const extension = extname(name)
  if (segments.some(segment => segment === '__tests__' || segment === 'test' || segment === 'tests')
    || /(?:^|[._-])(?:spec|test)\.[^.]+$/u.test(name)) return 'test'
  if (DOCUMENT_EXTENSIONS.has(extension) || /^readme(?:\.|$)/u.test(name)) return 'documentation'
  if (CONFIG_EXTENSIONS.has(extension) || /(?:^|[._-])config(?:\.|$)/u.test(name)
    || ['dockerfile', 'makefile'].includes(name)) return 'configuration'
  if (ASSET_EXTENSIONS.has(extension)) return 'asset'
  return file.language === undefined ? 'other' : 'code'
}

function groupRecords(records: readonly SourceRecord[], name: (record: SourceRecord) => string): SourceRecordGroup[] {
  const groups = new Map<string, SourceRecordGroup>()
  for (const record of records) {
    const key = name(record)
    const group = groups.get(key) ?? { name: key, fileCount: 0, totalBytes: 0 }
    group.fileCount += 1
    group.totalBytes += record.size
    groups.set(key, group)
  }
  return [...groups.values()].sort((left, right) => (
    right.fileCount - left.fileCount || right.totalBytes - left.totalBytes || compareText(left.name, right.name)
  ))
}

function assertConfig(config: SourceRecordConfig): void {
  if (!Number.isSafeInteger(config.maxRepresentativeFilesPerArea) || config.maxRepresentativeFilesPerArea < 1) {
    throw new Error('maxRepresentativeFilesPerArea must be a positive safe integer')
  }
}

/** Convert one complete, clean inventory into a stable local Source understanding checkpoint. */
export function buildSourceUnderstanding(
  inventory: SourceInventory,
  config: SourceRecordConfig,
  relationAnalyzer: SourceRelationAnalyzer = new DeterministicSourceRelationAnalyzer(),
  symbols: SourceSymbolGraph = emptySourceSymbolGraph(),
): SourceUnderstanding {
  assertConfig(config)
  if (inventory.state !== 'ready' || inventory.dirty || inventory.commit === undefined || inventory.inventoryHash === undefined) {
    throw new Error('Source understanding requires a clean, complete inventory revision')
  }
  const records = [...inventory.files]
    .sort((left, right) => compareText(left.path, right.path))
    .map((file): SourceRecord => ({
      path: file.path,
      contentHash: file.contentHash,
      size: file.size,
      area: sourceArea(file.path),
      artifactKind: artifactKind(file),
      ...(file.language === undefined ? {} : { language: file.language }),
      ...(file.analysis === undefined ? {} : { analysis: structuredClone(file.analysis) }),
    }))
  const areas = groupRecords(records, record => record.area).map((area): SourceAreaSummary => {
    const members = records.filter(record => record.area === area.name)
    const representativePaths = members
      .map(record => record.path)
      .slice(0, config.maxRepresentativeFilesPerArea)
    return {
      name: area.name,
      fileCount: area.fileCount,
      totalBytes: area.totalBytes,
      languages: groupRecords(members, record => record.language ?? '其他'),
      artifactKinds: groupRecords(members, record => record.artifactKind),
      representativePaths,
      omittedFileCount: members.length - representativePaths.length,
    }
  })
  const relations = relationAnalyzer.analyze({
    files: records.map(record => ({
      path: record.path,
      contentHash: record.contentHash,
      moduleReferences: structuredClone(record.analysis?.moduleReferences ?? []),
      omittedModuleReferenceCount: record.analysis?.omittedModuleReferenceCount ?? 0,
    })),
  })
  if (relations.providerKey !== relationAnalyzer.cacheKey) {
    throw new Error('Source relation Provider returned an inconsistent cache identity')
  }
  const recordByPath = new Map(records.map(record => [record.path, record]))
  for (const edge of relations.edges) {
    const from = recordByPath.get(edge.fromPath)
    if (from === undefined || from.contentHash !== edge.fromContentHash
      || edge.toPath !== undefined && !recordByPath.has(edge.toPath)) {
      throw new Error('Source relation graph does not match the current Source records')
    }
  }
  for (const definition of symbols.definitions) {
    const record = recordByPath.get(definition.path)
    if (record === undefined || record.contentHash !== definition.contentHash) {
      throw new Error('Source symbol definition does not match the current Source records')
    }
  }
  const definitionIds = new Set(symbols.definitions.map(definition => String(definition.id)))
  for (const reference of symbols.references) {
    const record = recordByPath.get(reference.fromPath)
    if (record === undefined || record.contentHash !== reference.fromContentHash
      || !definitionIds.has(String(reference.definitionId))) {
      throw new Error('Source symbol reference does not match the current Source records')
    }
  }
  for (const configPath of symbols.configuration.configPaths) {
    if (!recordByPath.has(configPath)) {
      throw new Error('Source symbol configuration does not match the current Source records')
    }
  }
  const outputHash = sha256(JSON.stringify({ version: SOURCE_RECORD_MAP_VERSION, records, areas, relations, symbols }))
  const checkpointKey = sha256(JSON.stringify({
    generator: 'source-record-map',
    version: SOURCE_RECORD_MAP_VERSION,
    sourceId: inventory.sourceId,
    commit: inventory.commit,
    inventoryHash: inventory.inventoryHash,
    inventoryReuseKey: inventory.reuseKey,
    relationProviderKey: relations.providerKey,
    symbolProviderKey: symbols.providerKey,
    config,
  }))
  return {
    version: SOURCE_RECORD_MAP_VERSION,
    generator: 'source-record-map',
    checkpointKey,
    sourceId: inventory.sourceId,
    commit: inventory.commit,
    inventoryHash: inventory.inventoryHash,
    inventoryReuseKey: inventory.reuseKey,
    outputHash,
    config: structuredClone(config),
    recordCount: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.size, 0),
    records,
    areas,
    relations,
    symbols: structuredClone(symbols),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`Source understanding ${key} is invalid`)
  return field
}

/** Validate and reconstruct one durable Source understanding payload. */
export function parseSourceUnderstanding(value: unknown): SourceUnderstanding {
  if (!isRecord(value) || value['version'] !== SOURCE_RECORD_MAP_VERSION || value['generator'] !== 'source-record-map') {
    throw new Error('Source understanding payload is invalid')
  }
  const sourceId = requiredString(value, 'sourceId')
  const commit = requiredString(value, 'commit')
  const inventoryHash = requiredString(value, 'inventoryHash')
  const inventoryReuseKey = requiredString(value, 'inventoryReuseKey')
  const configValue = value['config']
  const recordsValue = value['records']
  const relationsValue = value['relations']
  const symbolsValue = value['symbols']
  if (!new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u').test(sourceId)
    || !/^[0-9a-f]{40,64}$/u.test(commit)
    || !/^sha256:[0-9a-f]{64}$/u.test(inventoryHash)
    || !/^sha256:[0-9a-f]{64}$/u.test(inventoryReuseKey)
    || !isRecord(configValue)
    || !Array.isArray(recordsValue)) {
    throw new Error('Source understanding checkpoint fields are invalid')
  }
  const maxRepresentativeFilesPerArea = configValue['maxRepresentativeFilesPerArea']
  if (!Number.isSafeInteger(maxRepresentativeFilesPerArea)) throw new Error('Source understanding config is invalid')
  const files: SourceInventoryFile[] = recordsValue.map((recordValue): SourceInventoryFile => {
    if (!isRecord(recordValue)) throw new Error('Source record is invalid')
    const path = requiredString(recordValue, 'path')
    const contentHash = requiredString(recordValue, 'contentHash')
    const size = recordValue['size']
    const language = recordValue['language']
    const analysisValue = recordValue['analysis']
    if (!new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u').test(path)
      || !/^sha256:[0-9a-f]{64}$/u.test(contentHash)
      || !Number.isSafeInteger(size) || (size as number) < 0
      || (language !== undefined && (typeof language !== 'string' || language.length === 0))) {
      throw new Error('Source record fields are invalid')
    }
    const analysis = analysisValue === undefined ? undefined : parseSourceFileAnalysis(analysisValue)
    return {
      path,
      contentHash,
      size: size as number,
      ...(language === undefined ? {} : { language }),
      ...(analysis === undefined ? {} : { analysis }),
    }
  })
  if (new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error('Source record paths must be unique')
  }
  const relations = parseSourceRelationGraph(relationsValue)
  const symbols = parseSourceSymbolGraph(symbolsValue)
  const rebuilt = buildSourceUnderstanding({
    version: 3,
    sourceId: KnowledgeSourceId(sourceId),
    state: 'ready',
    commit,
    dirty: false,
    reuseKey: inventoryReuseKey,
    scanMode: 'full',
    reusedFileCount: 0,
    readFileCount: files.length,
    inventoryHash,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
    issues: [],
  }, { maxRepresentativeFilesPerArea: maxRepresentativeFilesPerArea as number }, {
    cacheKey: relations.providerKey,
    analyze: () => structuredClone(relations),
  }, symbols)
  if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error('Source understanding payload is inconsistent')
  return rebuilt
}

/** Project one durable Source checkpoint into a Git-diff inventory baseline. */
export function sourceInventoryBaseline(value: SourceUnderstanding): SourceInventoryBaseline {
  return {
    sourceId: value.sourceId,
    commit: value.commit,
    reuseKey: value.inventoryReuseKey,
    files: value.records.map(record => ({
      path: record.path,
      size: record.size,
      contentHash: record.contentHash,
      ...(record.language === undefined ? {} : { language: record.language }),
      ...(record.analysis === undefined ? {} : { analysis: structuredClone(record.analysis) }),
    })),
  }
}

/** Remove file paths and detailed groups before crossing the Host/browser boundary. */
export function summarizeSourceUnderstanding(value: SourceUnderstanding): SourceUnderstandingSummary {
  return {
    version: value.version,
    sourceId: value.sourceId,
    commit: value.commit,
    inventoryHash: value.inventoryHash,
    outputHash: value.outputHash,
    recordCount: value.recordCount,
    evidenceCount: value.records.reduce((sum, record) => sum + (record.analysis?.evidence.length ?? 0), 0),
    totalBytes: value.totalBytes,
    areaCount: value.areas.length,
    relationCount: value.relations.relationCount,
    internalRelationCount: value.relations.internalRelationCount,
    externalRelationCount: value.relations.externalRelationCount,
    unresolvedRelationCount: value.relations.unresolvedRelationCount,
    omittedRelationCount: value.relations.omittedRelationCount,
    symbolDefinitionCount: value.symbols.definitionCount,
    symbolReferenceCount: value.symbols.referenceCount,
    omittedSymbolFileCount: value.symbols.omittedFileCount,
    omittedSymbolReferenceCount: value.symbols.omittedReferenceCount,
    symbolConfigMode: value.symbols.configuration.mode,
    symbolConfigFileCount: value.symbols.configuration.configPaths.length,
    symbolProjectReferenceCount: value.symbols.configuration.projectReferenceCount,
    symbolPathAliasCount: value.symbols.configuration.pathAliasCount,
    symbolConfigDiagnosticCount: value.symbols.configuration.diagnosticCount,
    omittedSymbolConfigFileCount: value.symbols.configuration.omittedConfigFileCount,
  }
}
