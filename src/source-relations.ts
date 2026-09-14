import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'
import type { SourceModuleReference, SourceModuleReferenceKind } from './source-analysis.js'

/** Durable format version for deterministic cross-file module relations. */
export const SOURCE_RELATION_GRAPH_VERSION = 1 as const

/** Configuration that bounds the complete local relation graph. */
export interface SourceRelationConfig {
  maxRelations: number
}

/** Default relation bound for local profiles and the standalone CLI. */
export const DEFAULT_SOURCE_RELATION_CONFIG: SourceRelationConfig = {
  maxRelations: 100_000,
}

/** One portable file presented to a cross-file relation Provider. */
export interface SourceRelationFile {
  path: string
  contentHash: string
  moduleReferences: SourceModuleReference[]
  omittedModuleReferenceCount: number
}

/** Complete current-file input used to resolve syntax-level module references. */
export interface SourceRelationRequest {
  files: SourceRelationFile[]
}

/** Resolution class for one syntax-level module reference. */
export type SourceRelationResolution = 'internal' | 'external' | 'unresolved'

/** One line-addressable module relation retained with a Source checkpoint. */
export interface SourceRelationEdge {
  fromPath: string
  fromContentHash: string
  specifier: string
  kind: SourceModuleReferenceKind
  resolution: SourceRelationResolution
  toPath?: string
  startLine: number
  endLine: number
}

/** Aggregate internal dependency count between two portable top-level areas. */
export interface SourceAreaRelationSummary {
  fromArea: string
  toArea: string
  relationCount: number
}

/** Durable deterministic relation graph for one complete Source inventory. */
export interface SourceRelationGraph {
  version: typeof SOURCE_RELATION_GRAPH_VERSION
  provider: string
  providerKey: string
  outputHash: string
  relationCount: number
  internalRelationCount: number
  externalRelationCount: number
  unresolvedRelationCount: number
  omittedRelationCount: number
  edges: SourceRelationEdge[]
  areaRelations: SourceAreaRelationSummary[]
}

/** Replaceable resolver that maps per-file module specifiers onto the current file set. */
export interface SourceRelationAnalyzer {
  /** Stable output identity included in Source checkpoint keys. */
  readonly cacheKey: string

  /** Resolve one bounded, complete portable file set without reading file bodies. */
  analyze(request: SourceRelationRequest): SourceRelationGraph
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

function compareEdge(left: SourceRelationEdge, right: SourceRelationEdge): number {
  return compareText(left.fromPath, right.fromPath)
    || left.startLine - right.startLine
    || left.endLine - right.endLine
    || compareText(left.specifier, right.specifier)
    || compareText(left.kind, right.kind)
    || compareText(left.resolution, right.resolution)
    || compareText(left.toPath ?? '', right.toPath ?? '')
}

function areaRelations(edges: readonly SourceRelationEdge[]): SourceAreaRelationSummary[] {
  const counts = new Map<string, SourceAreaRelationSummary>()
  for (const edge of edges) {
    if (edge.resolution !== 'internal' || edge.toPath === undefined) continue
    const fromArea = sourceArea(edge.fromPath)
    const toArea = sourceArea(edge.toPath)
    const key = `${fromArea}\0${toArea}`
    const current = counts.get(key) ?? { fromArea, toArea, relationCount: 0 }
    current.relationCount += 1
    counts.set(key, current)
  }
  return [...counts.values()].sort((left, right) => (
    right.relationCount - left.relationCount
    || compareText(left.fromArea, right.fromArea)
    || compareText(left.toArea, right.toArea)
  ))
}

function finalizeGraph(
  provider: string,
  providerKey: string,
  edges: readonly SourceRelationEdge[],
  omittedRelationCount: number,
): SourceRelationGraph {
  const sortedEdges = [...structuredClone(edges)].sort(compareEdge)
  const areas = areaRelations(sortedEdges)
  const outputHash = sha256(JSON.stringify({
    version: SOURCE_RELATION_GRAPH_VERSION,
    provider,
    providerKey,
    edges: sortedEdges,
    areaRelations: areas,
    omittedRelationCount,
  }))
  return {
    version: SOURCE_RELATION_GRAPH_VERSION,
    provider,
    providerKey,
    outputHash,
    relationCount: sortedEdges.length,
    internalRelationCount: sortedEdges.filter(edge => edge.resolution === 'internal').length,
    externalRelationCount: sortedEdges.filter(edge => edge.resolution === 'external').length,
    unresolvedRelationCount: sortedEdges.filter(edge => edge.resolution === 'unresolved').length,
    omittedRelationCount,
    edges: sortedEdges,
    areaRelations: areas,
  }
}

function candidatePaths(fromPath: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return []
  const extension = posix.extname(base).toLowerCase()
  if (extension === '.js') return [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx', base, base.slice(0, -3) + '.jsx']
  if (extension === '.jsx') return [base.slice(0, -4) + '.tsx', base, base.slice(0, -4) + '.js']
  if (extension === '.mjs') return [base.slice(0, -4) + '.mts', base]
  if (extension === '.cjs') return [base.slice(0, -4) + '.cts', base]
  if (extension !== '') return [base]
  const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
  return [
    base,
    ...extensions.map(suffix => `${base}${suffix}`),
    ...extensions.map(suffix => `${base}/index${suffix}`),
  ]
}

/** Resolve one relative module specifier against a complete portable Source file set. */
export function resolveSourceModulePath(
  fromPath: string,
  specifier: string,
  paths: ReadonlySet<string>,
): string | undefined {
  return candidatePaths(fromPath, specifier).find(candidate => paths.has(candidate))
}

function resolveEdge(
  file: SourceRelationFile,
  reference: SourceModuleReference,
  files: ReadonlySet<string>,
): SourceRelationEdge {
  const relative = reference.specifier.startsWith('.')
  const rooted = reference.specifier.startsWith('/') || reference.specifier.startsWith('\\')
  const toPath = relative
    ? resolveSourceModulePath(file.path, reference.specifier, files)
    : undefined
  const resolution: SourceRelationResolution = toPath !== undefined
    ? 'internal'
    : relative || rooted ? 'unresolved' : 'external'
  return {
    fromPath: file.path,
    fromContentHash: file.contentHash,
    specifier: reference.specifier,
    kind: reference.kind,
    resolution,
    ...(toPath === undefined ? {} : { toPath }),
    startLine: reference.startLine,
    endLine: reference.endLine,
  }
}

function assertConfig(config: SourceRelationConfig): void {
  if (!Number.isSafeInteger(config.maxRelations) || config.maxRelations < 1) {
    throw new Error('maxRelations must be a positive safe integer')
  }
}

/** Built-in portable resolver for relative internal modules and explicit external specifiers. */
export class DeterministicSourceRelationAnalyzer implements SourceRelationAnalyzer {
  constructor(private readonly config: SourceRelationConfig = DEFAULT_SOURCE_RELATION_CONFIG) {
    assertConfig(config)
  }

  get cacheKey(): string {
    return ['deterministic-module-relations', SOURCE_RELATION_GRAPH_VERSION, this.config.maxRelations].join(':')
  }

  analyze(request: SourceRelationRequest): SourceRelationGraph {
    const files = [...request.files].sort((left, right) => compareText(left.path, right.path))
    const paths = new Set(files.map(file => file.path))
    const candidates = files.flatMap(file => file.moduleReferences.map(reference => resolveEdge(file, reference, paths)))
    const visible = candidates.sort(compareEdge).slice(0, this.config.maxRelations)
    const omitted = files.reduce((sum, file) => sum + file.omittedModuleReferenceCount, 0)
      + Math.max(0, candidates.length - visible.length)
    return finalizeGraph('deterministic-module-relations', this.cacheKey, visible, omitted)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate and reconstruct one durable Source relation graph. */
export function parseSourceRelationGraph(value: unknown): SourceRelationGraph {
  if (!isRecord(value)
    || value['version'] !== SOURCE_RELATION_GRAPH_VERSION
    || typeof value['provider'] !== 'string' || value['provider'].length === 0
    || typeof value['providerKey'] !== 'string' || value['providerKey'].length === 0
    || !Array.isArray(value['edges'])
    || !Number.isSafeInteger(value['omittedRelationCount']) || (value['omittedRelationCount'] as number) < 0) {
    throw new Error('Source relation graph is invalid')
  }
  const kinds: SourceModuleReferenceKind[] = [
    'import', 'type-import', 're-export', 'type-re-export', 'dynamic-import', 'require', 'import-equals',
  ]
  const resolutions: SourceRelationResolution[] = ['internal', 'external', 'unresolved']
  const pathPattern = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')
  const edges = value['edges'].map((edge): SourceRelationEdge => {
    if (!isRecord(edge)
      || typeof edge['fromPath'] !== 'string' || !pathPattern.test(edge['fromPath'])
      || typeof edge['fromContentHash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(edge['fromContentHash'])
      || typeof edge['specifier'] !== 'string' || edge['specifier'].length === 0
      || typeof edge['kind'] !== 'string' || !kinds.includes(edge['kind'] as SourceModuleReferenceKind)
      || typeof edge['resolution'] !== 'string' || !resolutions.includes(edge['resolution'] as SourceRelationResolution)
      || !Number.isSafeInteger(edge['startLine']) || (edge['startLine'] as number) < 1
      || !Number.isSafeInteger(edge['endLine']) || (edge['endLine'] as number) < (edge['startLine'] as number)) {
      throw new Error('Source relation edge is invalid')
    }
    const toPath = edge['toPath']
    if ((edge['resolution'] === 'internal') !== (typeof toPath === 'string' && pathPattern.test(toPath))) {
      throw new Error('Source relation target is invalid')
    }
    return {
      fromPath: edge['fromPath'],
      fromContentHash: edge['fromContentHash'],
      specifier: edge['specifier'],
      kind: edge['kind'] as SourceModuleReferenceKind,
      resolution: edge['resolution'] as SourceRelationResolution,
      ...(toPath === undefined ? {} : { toPath: toPath as string }),
      startLine: edge['startLine'] as number,
      endLine: edge['endLine'] as number,
    }
  })
  const rebuilt = finalizeGraph(
    value['provider'],
    value['providerKey'],
    edges,
    value['omittedRelationCount'] as number,
  )
  if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error('Source relation graph has unknown or inconsistent fields')
  return rebuilt
}
