import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { CanonicalStore } from './canonical.js'
import type { KnowledgeSourceId } from './ids.js'
import {
  detectSourceLanguage,
  sourcePathExclusionReason,
  type SourceInventoryBackend,
} from './inventory.js'
import { PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'
import type { PlanWikiRunInput, WikiCatalogEntry, WikiRunSnapshot } from './wiki-model.js'

/** Current language-neutral project-catalog format. */
export const WIKI_PROJECT_CATALOG_VERSION = 1 as const

/** Deployment-configurable limits for Git metadata cataloging. */
export interface WikiProjectCatalogConfig {
  maxEntries: number
  maxPathChars: number
  maxDepth: number
  gitOutputMaxBytes: number
  processGraceMs: number
}

/** Default limits that catalog project metadata without reading file contents. */
export const DEFAULT_WIKI_PROJECT_CATALOG_CONFIG: WikiProjectCatalogConfig = {
  maxEntries: 5_000_000,
  maxPathChars: 4_096,
  maxDepth: 256,
  gitOutputMaxBytes: 512 * 1024 * 1024,
  processGraceMs: 3_000,
}

/** One explicit reason a project catalog cannot represent the current Workspace completely. */
export interface WikiProjectCatalogIssue {
  kind: 'git-unavailable' | 'dirty-worktree' | 'invalid-git-entry' | 'invalid-path' | 'entry-budget'
  sourceId: KnowledgeSourceId
  path?: string
  affectedItemCount?: number
}

/** One Source revision summarized by the project catalog. */
export interface WikiCatalogSourceRevision {
  sourceId: KnowledgeSourceId
  commit?: string
  entryCount: number
  totalBytes: number
  complete: boolean
}

/** Complete or explicitly incomplete metadata catalog for one project. */
export interface WikiProjectCatalog {
  version: typeof WIKI_PROJECT_CATALOG_VERSION
  projectRoot: string
  state: 'complete' | 'incomplete'
  catalogHash: string
  omittedItemCount: number | null
  entryCount: number
  totalBytes: number
  excludedEntryCount: number
  blockedEntryCount: number
  sources: WikiCatalogSourceRevision[]
  entries: WikiCatalogEntry[]
  issues: WikiProjectCatalogIssue[]
}

/** Catalog and durable coverage run created by one explicit planning request. */
export interface PlanWikiProjectResult {
  catalog: WikiProjectCatalog
  run: WikiRunSnapshot
}

interface ParsedTreeEntry {
  mode: string
  type: 'blob' | 'commit'
  objectId: string
  byteSize: number
  path: string
}

const PORTABLE_PATH = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertConfig(config: WikiProjectCatalogConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  }
}

function nulRecords(value: string): string[] {
  const records = value.split('\0')
  if (records.at(-1) === '') records.pop()
  return records
}

function sourceRelativePath(rawPath: string): string | undefined {
  const normalized = rawPath.replaceAll('\\', '/')
  return normalized.length > 0 ? normalized : undefined
}

function parseTreeRecord(record: string): ParsedTreeEntry | undefined {
  const separator = record.indexOf('\t')
  if (separator === -1) return undefined
  const metadata = record.slice(0, separator)
  const rawPath = record.slice(separator + 1)
  const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40,64})\s+(-|[0-9]+)$/u.exec(metadata)
  if (match === null) return undefined
  const path = sourceRelativePath(rawPath)
  if (path === undefined) return undefined
  const sizeText = match[4]!
  const byteSize = sizeText === '-' ? 0 : Number(sizeText)
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) return undefined
  return {
    mode: match[1]!,
    type: match[2]! as ParsedTreeEntry['type'],
    objectId: match[3]!,
    byteSize,
    path,
  }
}

function statusPaths(value: string): string[] | undefined {
  const records = nulRecords(value)
  const paths: string[] = []
  for (let index = 0; index < records.length;) {
    const record = records[index++]!
    if (record.length < 4 || record[2] !== ' ') return undefined
    const status = record.slice(0, 2)
    const path = sourceRelativePath(record.slice(3))
    if (path === undefined) return undefined
    paths.push(path)
    if (/[RC]/u.test(status)) {
      const original = records[index++]
      if (original === undefined || sourceRelativePath(original) === undefined) return undefined
    }
  }
  return paths
}

function entryFromTree(
  sourceId: KnowledgeSourceId,
  commit: string,
  value: ParsedTreeEntry,
): WikiCatalogEntry {
  const exclusionReason = sourcePathExclusionReason(value.path)
  const artifactKind = value.type === 'commit'
    ? 'git-submodule'
    : value.mode === '120000' ? 'git-symlink' : undefined
  const disposition = value.type === 'commit'
    ? { status: 'blocked' as const, reason: 'Git 子模块必须注册为独立 Knowledge Source' }
    : exclusionReason === undefined
      ? undefined
      : { status: 'excluded' as const, reason: exclusionReason }
  const detectedLanguage = detectSourceLanguage(value.path)
  return {
    sourceId,
    path: value.path,
    byteSize: value.byteSize,
    revision: { kind: 'git-object', commit, objectId: value.objectId },
    ...(detectedLanguage === undefined ? {} : { language: detectedLanguage }),
    ...(artifactKind === undefined ? {} : { artifactKind }),
    ...(disposition === undefined ? {} : { disposition }),
  }
}

function hashCatalog(value: Omit<WikiProjectCatalog, 'catalogHash' | 'projectRoot'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/** Build a full Git metadata catalog without reading tracked file contents. */
export async function buildWikiProjectCatalog(
  backend: SourceInventoryBackend,
  store: Pick<CanonicalStore, 'projectRoot' | 'manifest'>,
  config: WikiProjectCatalogConfig = DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
  signal?: AbortSignal,
): Promise<WikiProjectCatalog> {
  assertConfig(config)
  const entries: WikiCatalogEntry[] = []
  const issues: WikiProjectCatalogIssue[] = []
  const sources: WikiCatalogSourceRevision[] = []
  let knownOmittedItemCount = 0
  let hasUnknownOmissions = false
  let totalBytes = 0

  for (const source of store.manifest.sources) {
    const sourceStart = entries.length
    const sourceBytesStart = totalBytes
    let commit: string | undefined
    let sourceComplete = true
    try {
      const root = await backend.resolveRoot(store.projectRoot, source.relativeRoot, signal)
      const head = await backend.runGit(root, ['rev-parse', '--verify', 'HEAD'], config, signal)
      if (head.exitCode !== 0 || head.stdout.trim() === '') {
        throw new Error('Git revision is unavailable')
      }
      commit = head.stdout.trim()
      const status = await backend.runGit(
        root,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
        config,
        signal,
      )
      const tree = await backend.runGit(root, ['ls-tree', '-rlz', commit, '--', '.'], config, signal)
      if (status.exitCode !== 0 || tree.exitCode !== 0) throw new Error('Git project catalog failed')

      const changedPaths = statusPaths(status.stdout)
      if (changedPaths === undefined) {
        sourceComplete = false
        hasUnknownOmissions = true
        issues.push({ kind: 'invalid-git-entry', sourceId: source.id })
      } else {
        const relevantDirtyPaths = [...new Set(changedPaths)]
          .filter(path => sourcePathExclusionReason(path) === undefined)
        if (relevantDirtyPaths.length > 0) {
          sourceComplete = false
          hasUnknownOmissions = true
          issues.push({ kind: 'dirty-worktree', sourceId: source.id, affectedItemCount: relevantDirtyPaths.length })
        }
      }

      const seenPaths = new Set<string>()
      const records = nulRecords(tree.stdout)
      let budgetIssueAdded = false
      for (const record of records) {
        const parsed = parseTreeRecord(record)
        if (parsed === undefined) {
          sourceComplete = false
          knownOmittedItemCount += 1
          issues.push({ kind: 'invalid-git-entry', sourceId: source.id })
          continue
        }
        if (!PORTABLE_PATH.test(parsed.path) || parsed.path.length > config.maxPathChars
          || parsed.path.split('/').length > config.maxDepth || seenPaths.has(parsed.path)) {
          sourceComplete = false
          knownOmittedItemCount += 1
          issues.push({ kind: 'invalid-path', sourceId: source.id })
          continue
        }
        seenPaths.add(parsed.path)
        if (entries.length >= config.maxEntries) {
          sourceComplete = false
          knownOmittedItemCount += 1
          if (!budgetIssueAdded) {
            issues.push({ kind: 'entry-budget', sourceId: source.id })
            budgetIssueAdded = true
          }
          continue
        }
        totalBytes += parsed.byteSize
        if (!Number.isSafeInteger(totalBytes)) throw new Error('Wiki project catalog byte total is unsafe')
        entries.push(entryFromTree(source.id, commit, parsed))
      }
    } catch {
      signal?.throwIfAborted()
      sourceComplete = false
      hasUnknownOmissions = true
      issues.push({ kind: 'git-unavailable', sourceId: source.id })
    }
    sources.push({
      sourceId: source.id,
      ...(commit === undefined ? {} : { commit }),
      entryCount: entries.length - sourceStart,
      totalBytes: totalBytes - sourceBytesStart,
      complete: sourceComplete,
    })
  }

  entries.sort((left, right) => compareText(String(left.sourceId), String(right.sourceId)) || compareText(left.path, right.path))
  sources.sort((left, right) => compareText(String(left.sourceId), String(right.sourceId)))
  issues.sort((left, right) => compareText(String(left.sourceId), String(right.sourceId))
    || compareText(left.kind, right.kind) || compareText(left.path ?? '', right.path ?? ''))
  const omittedItemCount = hasUnknownOmissions ? null : knownOmittedItemCount
  const state = issues.length === 0 ? 'complete' : 'incomplete'
  const payload: Omit<WikiProjectCatalog, 'catalogHash' | 'projectRoot'> = {
    version: WIKI_PROJECT_CATALOG_VERSION,
    state,
    omittedItemCount,
    entryCount: entries.length,
    totalBytes,
    excludedEntryCount: entries.filter(entry => entry.disposition?.status === 'excluded').length,
    blockedEntryCount: entries.filter(entry => entry.disposition?.status === 'blocked').length,
    sources,
    entries,
    issues,
  }
  return { ...payload, projectRoot: resolve(store.projectRoot), catalogHash: hashCatalog(payload) }
}

/** Convert one project catalog into a persisted Wiki coverage-plan request. */
export function wikiPlanInputFromCatalog(catalog: WikiProjectCatalog): PlanWikiRunInput {
  const catalogBlockingReasons = catalog.issues.map((issue): string => {
    const affected = issue.affectedItemCount === undefined ? '' : `（影响 ${issue.affectedItemCount} 项）`
    switch (issue.kind) {
      case 'git-unavailable':
        return `Source ${issue.sourceId} 无法读取 Git 目录${affected}`
      case 'dirty-worktree':
        return `Source ${issue.sourceId} 存在未纳入 Catalog 的工作树变更${affected}`
      case 'invalid-git-entry':
        return `Source ${issue.sourceId} 包含无法验证的 Git 目录记录${affected}`
      case 'invalid-path':
        return `Source ${issue.sourceId} 包含不可携带的路径${affected}`
      case 'entry-budget':
        return `Source ${issue.sourceId} 超过 Catalog 项目数上限${affected}`
      default:
        return assertNever(issue.kind)
    }
  })
  return {
    projectRoot: catalog.projectRoot,
    catalogHash: catalog.catalogHash,
    catalogComplete: catalog.state === 'complete',
    catalogOmittedItemCount: catalog.omittedItemCount,
    catalogBlockingReasons,
    entries: catalog.entries,
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled Wiki catalog issue: ${value}`)
}
