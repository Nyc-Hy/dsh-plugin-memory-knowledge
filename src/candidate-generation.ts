import { createHash } from 'node:crypto'
import type { CanonicalStore } from './canonical.js'
import type { KnowledgeSourceId } from './ids.js'
import type { ProjectKnowledgeStatus, SourceInventory, SourceInventoryFile } from './inventory.js'
import type { GitKnowledgeSource, KnowledgeCard, KnowledgeSection, ProvenanceRef } from './model.js'
import type { KnowledgeCardCandidateSkip, SaveKnowledgeCardCandidateInput } from './runtime-model.js'
import type { SourceAreaSummary, SourceRecordGroup, SourceUnderstanding } from './source-records.js'
import type { SourceEvidence } from './source-analysis.js'
import type { SourceRelationEdge, SourceRelationGraph } from './source-relations.js'

/** Stable implementation version included in every deterministic generation key. */
export const SOURCE_INVENTORY_CANDIDATE_VERSION = 1

/** Stable implementation version for Source-record architecture candidates. */
export const SOURCE_RECORD_ARCHITECTURE_CANDIDATE_VERSION = 2

/** Stable implementation version for line-addressable module-index candidates. */
export const SOURCE_EVIDENCE_MODULE_CANDIDATE_VERSION = 2

/** Bounded presentation settings for deterministic Source inventory candidates. */
export interface KnowledgeCardCandidateGenerationConfig {
  maxSources: number
  maxLanguages: number
  maxAreas: number
  maxEvidencePerArea: number
}

/** Default generation bounds used when a profile does not override them. */
export const DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG: KnowledgeCardCandidateGenerationConfig = {
  maxSources: 32,
  maxLanguages: 24,
  maxAreas: 40,
  maxEvidencePerArea: 40,
}

/** Pure, deterministic plan produced before candidates enter the local database. */
export interface KnowledgeCardCandidatePlan {
  inputs: SaveKnowledgeCardCandidateInput[]
  skipped: KnowledgeCardCandidateSkip[]
}

interface GroupSummary {
  name: string
  fileCount: number
  totalBytes: number
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareGroup(left: GroupSummary, right: GroupSummary): number {
  return right.fileCount - left.fileCount || right.totalBytes - left.totalBytes || compareText(left.name, right.name)
}

function groupFiles(
  files: readonly SourceInventoryFile[],
  name: (file: SourceInventoryFile) => string,
): GroupSummary[] {
  const groups = new Map<string, GroupSummary>()
  for (const file of files) {
    const key = name(file)
    const current = groups.get(key) ?? { name: key, fileCount: 0, totalBytes: 0 }
    current.fileCount += 1
    current.totalBytes += file.size
    groups.set(key, current)
  }
  return [...groups.values()].sort(compareGroup)
}

function boundedGroups(groups: readonly GroupSummary[], limit: number): GroupSummary[] {
  if (groups.length <= limit) return [...groups]
  const visible = groups.slice(0, limit - 1)
  const hidden = groups.slice(limit - 1)
  visible.push({
    name: `其他（${hidden.length} 类）`,
    fileCount: hidden.reduce((sum, group) => sum + group.fileCount, 0),
    totalBytes: hidden.reduce((sum, group) => sum + group.totalBytes, 0),
  })
  return visible
}

function groupContent(groups: readonly GroupSummary[]): string {
  return groups.map(group => `- ${group.name}：${group.fileCount} 个文件，${group.totalBytes} 字节`).join('\n')
}

function sourceTitle(source: GitKnowledgeSource): string {
  return source.relativeRoot === '.' ? '项目源码清单概览' : `${source.relativeRoot} 源码清单概览`
}

function existingCards(
  cards: readonly KnowledgeCard[],
  sourceId: KnowledgeSourceId,
  kind: 'overview' | 'architecture' | 'module',
): KnowledgeCard[] {
  return cards.filter(card => card.kind === kind && card.scope.kind === 'source' && card.scope.sourceId === sourceId)
}

function isCurrentCard(card: KnowledgeCard, inventory: SourceInventory): boolean {
  return card.status === 'verified' && card.sourceRevisions.some(revision => (
    revision.sourceId === inventory.sourceId
    && (revision.inventoryHash === undefined
      ? revision.commit === inventory.commit
      : revision.inventoryHash === inventory.inventoryHash)
  ))
}

function generationKey(
  inventory: SourceInventory,
  targetCard: KnowledgeCard | undefined,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    generator: 'source-inventory',
    version: SOURCE_INVENTORY_CANDIDATE_VERSION,
    sourceId: inventory.sourceId,
    commit: inventory.commit,
    inventoryHash: inventory.inventoryHash,
    kind: 'overview',
    targetCardId: targetCard?.id ?? null,
    baseRevision: targetCard?.revision ?? null,
  })).digest('hex')
  return `knowledge-card:source-inventory:${SOURCE_INVENTORY_CANDIDATE_VERSION}:${digest}`
}

function buildInput(
  store: CanonicalStore,
  source: GitKnowledgeSource,
  inventory: SourceInventory,
  targetCard: KnowledgeCard | undefined,
  config: KnowledgeCardCandidateGenerationConfig,
): SaveKnowledgeCardCandidateInput {
  const commit = inventory.commit!
  const provenance: ProvenanceRef[] = [{ kind: 'git-commit', sourceId: source.id, commit }]
  const languageGroups = boundedGroups(groupFiles(inventory.files, file => file.language ?? '其他'), config.maxLanguages)
  const areaGroups = boundedGroups(groupFiles(inventory.files, file => file.path.includes('/')
    ? file.path.slice(0, file.path.indexOf('/'))
    : '仓库根目录'), config.maxAreas)
  const summary = `该 Git 来源在 revision ${commit.slice(0, 12)} 包含 ${inventory.fileCount} 个文件，共 ${inventory.totalBytes} 字节；候选生成时工作树干净。`
  const sections: KnowledgeSection[] = [
    {
      id: 'source-state',
      title: '来源状态',
      content: [
        `Revision：${commit}`,
        `分支：${inventory.branch ?? 'detached HEAD'}`,
        `文件：${inventory.fileCount}`,
        `总字节：${inventory.totalBytes}`,
      ].join('\n'),
      provenance: structuredClone(provenance),
    },
    {
      id: 'language-boundaries',
      title: '语言边界',
      content: groupContent(languageGroups),
      provenance: structuredClone(provenance),
    },
    {
      id: 'top-level-areas',
      title: '顶层区域',
      content: groupContent(areaGroups),
      provenance: structuredClone(provenance),
    },
  ]
  return {
    target: 'knowledge-card',
    applicability: 'project',
    projectRoot: store.projectRoot,
    kind: 'overview',
    title: sourceTitle(source),
    content: [summary, ...sections.flatMap(section => [section.title, section.content])].join('\n\n'),
    tags: ['knowledge-card', 'source-inventory'],
    sensitivity: 'normal',
    suggestedBy: 'inventory',
    provenance: structuredClone(provenance),
    generation: {
      key: generationKey(inventory, targetCard),
      generator: 'source-inventory',
      version: SOURCE_INVENTORY_CANDIDATE_VERSION,
      sourceId: source.id,
      inventoryHash: inventory.inventoryHash!,
    },
    card: {
      ...(targetCard === undefined ? {} : { targetCardId: targetCard.id, baseRevision: targetCard.revision }),
      scope: { kind: 'source', sourceId: source.id },
      kind: 'overview',
      summary,
      sections,
      provenance: structuredClone(provenance),
      sourceRevisions: [{ sourceId: source.id, kind: 'git', commit, inventoryHash: inventory.inventoryHash! }],
      evidenceClass: 'deterministic',
    },
  }
}

function mergeRecordGroups(groups: readonly SourceRecordGroup[]): SourceRecordGroup[] {
  const merged = new Map<string, SourceRecordGroup>()
  for (const group of groups) {
    const current = merged.get(group.name) ?? { name: group.name, fileCount: 0, totalBytes: 0 }
    current.fileCount += group.fileCount
    current.totalBytes += group.totalBytes
    merged.set(group.name, current)
  }
  return [...merged.values()].sort(compareGroup)
}

function boundedAreas(areas: readonly SourceAreaSummary[], limit: number): SourceAreaSummary[] {
  if (areas.length <= limit) return [...structuredClone(areas)]
  const visible = structuredClone(areas.slice(0, limit - 1))
  const hidden = areas.slice(limit - 1)
  visible.push({
    name: `其他区域（${hidden.length} 个）`,
    fileCount: hidden.reduce((sum, area) => sum + area.fileCount, 0),
    totalBytes: hidden.reduce((sum, area) => sum + area.totalBytes, 0),
    languages: mergeRecordGroups(hidden.flatMap(area => area.languages)),
    artifactKinds: mergeRecordGroups(hidden.flatMap(area => area.artifactKinds)),
    representativePaths: [],
    omittedFileCount: hidden.reduce((sum, area) => sum + area.fileCount, 0),
  })
  return visible
}

const ARTIFACT_LABELS: Readonly<Record<string, string>> = {
  code: '代码',
  test: '测试',
  documentation: '文档',
  configuration: '配置',
  asset: '资源',
  other: '其他',
}

const MODULE_RELATION_OVERVIEW_SECTION_ID = 'module-relation-overview-v1'

function recordGroupContent(groups: readonly SourceRecordGroup[], labels: Readonly<Record<string, string>> = {}): string {
  return groups.map(group => `${labels[group.name] ?? group.name} ${group.fileCount} 个`).join('，')
}

function areaContent(area: SourceAreaSummary): string[] {
  const lines = [
    `文件：${area.fileCount}`,
    `总字节：${area.totalBytes}`,
    `工件角色：${recordGroupContent(area.artifactKinds, ARTIFACT_LABELS)}`,
    `语言：${recordGroupContent(area.languages)}`,
  ]
  if (area.representativePaths.length > 0) {
    lines.push('代表文件：', ...area.representativePaths.map(path => `- ${path}`))
  }
  if (area.omittedFileCount > 0) lines.push(`另有 ${area.omittedFileCount} 个文件未在本节逐项列出。`)
  return lines
}

function areaName(path: string): string {
  const separator = path.indexOf('/')
  return separator === -1 ? '仓库根目录' : path.slice(0, separator)
}

const RELATION_KIND_LABELS: Readonly<Record<SourceRelationEdge['kind'], string>> = {
  import: 'import',
  'type-import': 'import type',
  're-export': 're-export',
  'type-re-export': 'type re-export',
  'dynamic-import': 'dynamic import',
  require: 'require',
  'import-equals': 'import equals',
}

function relationLabel(edge: SourceRelationEdge): string {
  const target = edge.resolution === 'internal'
    ? edge.toPath!
    : edge.resolution === 'external' ? `外部模块 ${edge.specifier}` : `未解析 ${edge.specifier}`
  return `- ${edge.fromPath}:${edge.startLine}${edge.endLine === edge.startLine ? '' : `-${edge.endLine}`} → ${target}（${RELATION_KIND_LABELS[edge.kind]}）`
}

function relationProvenance(source: GitKnowledgeSource, commit: string, edge: SourceRelationEdge): ProvenanceRef {
  return {
    kind: 'git-file',
    sourceId: source.id,
    commit,
    path: edge.fromPath,
    startLine: edge.startLine,
    endLine: edge.endLine,
    contentHash: edge.fromContentHash,
  }
}

function relationOverview(graph: SourceRelationGraph, maxAreas: number): string {
  const visibleAreas = graph.areaRelations.slice(0, maxAreas)
  return [
    `静态模块引用：${graph.relationCount} 条`,
    `内部：${graph.internalRelationCount}，外部：${graph.externalRelationCount}，未解析：${graph.unresolvedRelationCount}`,
    ...(visibleAreas.length === 0 ? [] : [
      '区域关系：',
      ...visibleAreas.map(relation => `- ${relation.fromArea} → ${relation.toArea}：${relation.relationCount} 条`),
    ]),
    ...(graph.areaRelations.length <= visibleAreas.length
      ? [] : [`另有 ${graph.areaRelations.length - visibleAreas.length} 组区域关系未列出。`]),
    ...(graph.omittedRelationCount === 0
      ? [] : [`另有 ${graph.omittedRelationCount} 条模块引用因解析或全局预算未进入关系图。`]),
    '这些边只描述源码中的静态模块 specifier 及其本地解析结果，不证明调用关系、运行时加载顺序或业务职责。',
  ].join('\n')
}

function architectureGenerationKey(
  inventory: SourceInventory,
  understanding: SourceUnderstanding,
  targetCard: KnowledgeCard | undefined,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    generator: 'source-record-map',
    version: SOURCE_RECORD_ARCHITECTURE_CANDIDATE_VERSION,
    sourceId: inventory.sourceId,
    commit: inventory.commit,
    inventoryHash: inventory.inventoryHash,
    inputHash: understanding.outputHash,
    kind: 'architecture',
    targetCardId: targetCard?.id ?? null,
    baseRevision: targetCard?.revision ?? null,
  })).digest('hex')
  return `knowledge-card:source-record-map:${SOURCE_RECORD_ARCHITECTURE_CANDIDATE_VERSION}:${digest}`
}

function architectureTitle(source: GitKnowledgeSource): string {
  return source.relativeRoot === '.' ? '项目结构地图' : `${source.relativeRoot} 结构地图`
}

function buildArchitectureInput(
  store: CanonicalStore,
  source: GitKnowledgeSource,
  inventory: SourceInventory,
  understanding: SourceUnderstanding,
  targetCard: KnowledgeCard | undefined,
  config: KnowledgeCardCandidateGenerationConfig,
): SaveKnowledgeCardCandidateInput {
  const commit = inventory.commit!
  const inventoryHash = inventory.inventoryHash!
  const provenance: ProvenanceRef[] = [{ kind: 'git-commit', sourceId: source.id, commit }]
  const areas = boundedAreas(understanding.areas, config.maxAreas)
  const summary = `该来源的 ${understanding.recordCount} 条 Source records 按 portable path 聚合为 ${understanding.areas.length} 个顶层区域，并形成 ${understanding.relations.relationCount} 条有来源的静态模块引用；内容不推断模块职责、调用关系或运行时语义。`
  const sections: KnowledgeSection[] = [{
    id: MODULE_RELATION_OVERVIEW_SECTION_ID,
    title: '静态模块关系概览',
    content: relationOverview(understanding.relations, config.maxAreas),
    provenance: structuredClone(provenance),
  }, ...areas.map((area, index): KnowledgeSection => {
    const availableRelations = understanding.relations.edges.filter(edge => areaName(edge.fromPath) === area.name)
    const visibleRelations = availableRelations.slice(0, config.maxEvidencePerArea)
    const lines = areaContent(area)
    if (visibleRelations.length > 0) lines.push('模块引用：', ...visibleRelations.map(relationLabel))
    if (availableRelations.length > visibleRelations.length) {
      lines.push(`另有 ${availableRelations.length - visibleRelations.length} 条该区域模块引用未列出。`)
    }
    return {
      id: `area-${index + 1}`,
      title: area.name,
      content: lines.join('\n'),
      provenance: [
        ...structuredClone(provenance),
        ...visibleRelations.map(edge => relationProvenance(source, commit, edge)),
      ],
    }
  })]
  return {
    target: 'knowledge-card',
    applicability: 'project',
    projectRoot: store.projectRoot,
    kind: 'architecture',
    title: architectureTitle(source),
    content: [summary, ...sections.flatMap(section => [section.title, section.content])].join('\n\n'),
    tags: ['knowledge-card', 'source-record-map', 'source-relations'],
    sensitivity: 'normal',
    suggestedBy: 'inventory',
    provenance: structuredClone(provenance),
    generation: {
      key: architectureGenerationKey(inventory, understanding, targetCard),
      generator: 'source-record-map',
      version: SOURCE_RECORD_ARCHITECTURE_CANDIDATE_VERSION,
      sourceId: source.id,
      inventoryHash,
      inputHash: understanding.outputHash,
    },
    card: {
      ...(targetCard === undefined ? {} : { targetCardId: targetCard.id, baseRevision: targetCard.revision }),
      scope: { kind: 'source', sourceId: source.id },
      kind: 'architecture',
      summary,
      sections,
      provenance: structuredClone(provenance),
      sourceRevisions: [{ sourceId: source.id, kind: 'git', commit, inventoryHash }],
      evidenceClass: 'deterministic',
    },
  }
}

interface RecordEvidence {
  path: string
  contentHash: string
  evidence: SourceEvidence
}

function evidenceLabel(item: RecordEvidence): string {
  const location = `${item.path}:${item.evidence.startLine}${item.evidence.endLine === item.evidence.startLine ? '' : `-${item.evidence.endLine}`}`
  if (item.evidence.kind === 'document-heading') {
    return `- 文档标题 H${item.evidence.level}「${item.evidence.name}」— ${location}`
  }
  const labels: Readonly<Record<Extract<SourceEvidence, { kind: 'code-symbol' }>['declaration'], string>> = {
    class: '类',
    function: '函数',
    interface: '接口',
    type: '类型',
    enum: '枚举',
    'enum-member': '枚举成员',
    namespace: '命名空间',
    variable: '变量',
    method: '方法',
    property: '属性',
    constructor: '构造函数',
    getter: 'getter',
    setter: 'setter',
    default: '默认导出',
    're-export': '重导出',
  }
  const container = item.evidence.containerName === undefined ? '' : `，容器「${item.evidence.containerName}」`
  return `- 代码符号 ${labels[item.evidence.declaration]}「${item.evidence.name}」${container}，${item.evidence.exported ? '模块导出' : '模块内部'} — ${location}`
}

function evidenceProvenance(source: GitKnowledgeSource, commit: string, item: RecordEvidence): ProvenanceRef {
  return {
    kind: 'git-file',
    sourceId: source.id,
    commit,
    path: item.path,
    startLine: item.evidence.startLine,
    endLine: item.evidence.endLine,
    contentHash: item.contentHash,
  }
}

function moduleGenerationKey(
  inventory: SourceInventory,
  understanding: SourceUnderstanding,
  targetCard: KnowledgeCard | undefined,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    generator: 'source-evidence-map',
    version: SOURCE_EVIDENCE_MODULE_CANDIDATE_VERSION,
    sourceId: inventory.sourceId,
    commit: inventory.commit,
    inventoryHash: inventory.inventoryHash,
    inputHash: understanding.outputHash,
    kind: 'module',
    targetCardId: targetCard?.id ?? null,
    baseRevision: targetCard?.revision ?? null,
  })).digest('hex')
  return `knowledge-card:source-evidence-map:${SOURCE_EVIDENCE_MODULE_CANDIDATE_VERSION}:${digest}`
}

function moduleTitle(source: GitKnowledgeSource): string {
  return source.relativeRoot === '.' ? '项目模块证据索引' : `${source.relativeRoot} 模块证据索引`
}

function buildModuleInput(
  store: CanonicalStore,
  source: GitKnowledgeSource,
  inventory: SourceInventory,
  understanding: SourceUnderstanding,
  targetCard: KnowledgeCard | undefined,
  config: KnowledgeCardCandidateGenerationConfig,
): SaveKnowledgeCardCandidateInput | undefined {
  const commit = inventory.commit!
  const inventoryHash = inventory.inventoryHash!
  const sections: KnowledgeSection[] = []
  const areas = boundedAreas(understanding.areas, config.maxAreas)
  for (const area of areas) {
    const records = understanding.records.filter(record => record.area === area.name && record.analysis !== undefined)
    const available = records.flatMap(record => record.analysis!.evidence.map(evidence => ({
      path: record.path,
      contentHash: record.contentHash,
      evidence,
    })))
    const visible = available.slice(0, config.maxEvidencePerArea)
    if (visible.length === 0) continue
    const providerOmitted = records.reduce((sum, record) => sum + record.analysis!.omittedEvidenceCount, 0)
    const omitted = providerOmitted + Math.max(0, available.length - visible.length)
    sections.push({
      id: `module-area-${sections.length + 1}`,
      title: area.name,
      content: [
        ...visible.map(evidenceLabel),
        ...(omitted === 0 ? [] : [`另有 ${omitted} 条证据因解析或展示预算未列出。`]),
        '这些条目只证明 AST 声明或文档标题的位置，不证明模块职责、调用关系或业务语义。',
      ].join('\n'),
      provenance: visible.map(item => evidenceProvenance(source, commit, item)),
    })
  }
  if (sections.length === 0) return undefined
  const provenance: ProvenanceRef[] = [{ kind: 'git-commit', sourceId: source.id, commit }]
  const evidenceCount = sections.reduce((sum, section) => sum + section.provenance.length, 0)
  const summary = `该来源从 JavaScript/TypeScript AST 模块符号与 Markdown 标题中形成 ${evidenceCount} 条可复核的文件行号证据；它是待人工审核的模块边界索引，不推断职责或依赖关系。`
  return {
    target: 'knowledge-card',
    applicability: 'project',
    projectRoot: store.projectRoot,
    kind: 'module',
    title: moduleTitle(source),
    content: [summary, ...sections.flatMap(section => [section.title, section.content])].join('\n\n'),
    tags: ['knowledge-card', 'source-evidence-map'],
    sensitivity: 'normal',
    suggestedBy: 'inventory',
    provenance: structuredClone(provenance),
    generation: {
      key: moduleGenerationKey(inventory, understanding, targetCard),
      generator: 'source-evidence-map',
      version: SOURCE_EVIDENCE_MODULE_CANDIDATE_VERSION,
      sourceId: source.id,
      inventoryHash,
      inputHash: understanding.outputHash,
    },
    card: {
      ...(targetCard === undefined ? {} : { targetCardId: targetCard.id, baseRevision: targetCard.revision }),
      scope: { kind: 'source', sourceId: source.id },
      kind: 'module',
      summary,
      sections,
      provenance: structuredClone(provenance),
      sourceRevisions: [{ sourceId: source.id, kind: 'git', commit, inventoryHash }],
      evidenceClass: 'deterministic',
    },
  }
}

function assertConfig(config: KnowledgeCardCandidateGenerationConfig): void {
  if (!Number.isSafeInteger(config.maxSources) || config.maxSources < 1) {
    throw new Error('maxSources must be a positive safe integer')
  }
  for (const [name, value] of Object.entries({
    maxLanguages: config.maxLanguages,
    maxAreas: config.maxAreas,
    maxEvidencePerArea: config.maxEvidencePerArea,
  })) {
    if (!Number.isSafeInteger(value) || value < 2) throw new Error(`${name} must be a safe integer of at least 2`)
  }
}

/** Build bounded deterministic overview and architecture candidates for clean, complete Git sources. */
export function planKnowledgeCardCandidates(
  store: CanonicalStore,
  status: ProjectKnowledgeStatus,
  config: KnowledgeCardCandidateGenerationConfig,
  understandings?: readonly SourceUnderstanding[],
): KnowledgeCardCandidatePlan {
  assertConfig(config)
  if (store.manifest.sources.length > config.maxSources) {
    return { inputs: [], skipped: [{ kind: 'source-limit' }] }
  }
  const inventoryBySource = new Map(status.sources.map(inventory => [inventory.sourceId, inventory]))
  const understandingBySource = new Map(understandings?.map(understanding => [understanding.sourceId, understanding]) ?? [])
  const inputs: SaveKnowledgeCardCandidateInput[] = []
  const skipped: KnowledgeCardCandidateSkip[] = []
  for (const source of [...store.manifest.sources].sort((left, right) => compareText(left.id, right.id))) {
    const inventory = inventoryBySource.get(source.id)
    if (inventory === undefined || inventory.state !== 'ready') {
      skipped.push({ sourceId: source.id, kind: 'source-degraded' })
      continue
    }
    if (inventory.commit === undefined || inventory.inventoryHash === undefined) {
      skipped.push({ sourceId: source.id, kind: 'missing-revision' })
      continue
    }
    if (inventory.dirty) {
      skipped.push({ sourceId: source.id, kind: 'source-dirty' })
      continue
    }
    const overviews = existingCards(store.cards, source.id, 'overview')
    if (overviews.length > 1) {
      skipped.push({ sourceId: source.id, cardKind: 'overview', kind: 'ambiguous-overview' })
    } else {
      const target = overviews[0]
      if (target !== undefined && isCurrentCard(target, inventory)) {
        skipped.push({ sourceId: source.id, cardKind: 'overview', kind: 'already-current' })
      } else {
        inputs.push(buildInput(store, source, inventory, target, config))
      }
    }
    if (understandings === undefined) continue
    const understanding = understandingBySource.get(source.id)
    if (understanding === undefined || understanding.inventoryHash !== inventory.inventoryHash
      || understanding.commit !== inventory.commit) {
      skipped.push({ sourceId: source.id, cardKind: 'architecture', kind: 'missing-understanding' })
      continue
    }
    const architectureCards = existingCards(store.cards, source.id, 'architecture')
    if (architectureCards.length > 1) {
      skipped.push({ sourceId: source.id, cardKind: 'architecture', kind: 'ambiguous-architecture' })
    } else {
      const architectureTarget = architectureCards[0]
      if (architectureTarget !== undefined && isCurrentCard(architectureTarget, inventory)
        && architectureTarget.sections.some(section => section.id === MODULE_RELATION_OVERVIEW_SECTION_ID)) {
        skipped.push({ sourceId: source.id, cardKind: 'architecture', kind: 'already-current' })
      } else {
        inputs.push(buildArchitectureInput(store, source, inventory, understanding, architectureTarget, config))
      }
    }
    const moduleCards = existingCards(store.cards, source.id, 'module')
    if (moduleCards.length > 1) {
      skipped.push({ sourceId: source.id, cardKind: 'module', kind: 'ambiguous-module' })
      continue
    }
    const moduleTarget = moduleCards[0]
    if (moduleTarget !== undefined && isCurrentCard(moduleTarget, inventory)) {
      skipped.push({ sourceId: source.id, cardKind: 'module', kind: 'already-current' })
      continue
    }
    const moduleInput = buildModuleInput(store, source, inventory, understanding, moduleTarget, config)
    if (moduleInput === undefined) {
      skipped.push({ sourceId: source.id, cardKind: 'module', kind: 'missing-evidence' })
      continue
    }
    inputs.push(moduleInput)
  }
  return { inputs, skipped }
}
