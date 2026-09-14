import { execFile, spawn as spawnProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Readable } from 'node:stream'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { KnowledgeCardId, KnowledgeSourceId } from './ids.js'
import type { CanonicalStore } from './canonical.js'
import type { KnowledgeCard, ProvenanceRef } from './model.js'
import { PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'
import {
  DeterministicSourceAnalyzer,
  type SourceAnalyzer,
  type SourceFileAnalysis,
} from './source-analysis.js'

const execFileAsync = promisify(execFile)
const portablePathPattern = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')

/** Version of the deterministic file inventory algorithm. */
export const SOURCE_INVENTORY_VERSION = 3 as const

/** Bounded Git process settings shared by project-catalog consumers. */
export interface GitCommandConfig {
  gitOutputMaxBytes: number
  processGraceMs: number
}

/** Process limits for streaming one immutable Git object. */
export interface GitObjectStreamConfig {
  stderrMaxBytes: number
  processGraceMs: number
}

/** Safe and deployment-configurable inventory limits. */
export interface SourceInventoryConfig extends GitCommandConfig {
  includeUntracked: boolean
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  maxPathChars: number
  maxDepth: number
}

/** One deterministic source file boundary without local filesystem identity. */
export interface SourceInventoryFile {
  path: string
  size: number
  contentHash: string
  language?: string
  analysis?: SourceFileAnalysis
}

/** One prior clean Source snapshot eligible for Git-diff reuse. */
export interface SourceInventoryBaseline {
  sourceId: KnowledgeSourceId
  commit: string
  reuseKey: string
  files: readonly SourceInventoryFile[]
}

/** One bounded problem encountered while building an inventory. */
export interface SourceInventoryIssue {
  kind: 'git-unavailable' | 'invalid-path' | 'missing-file' | 'symlink' | 'non-file' | 'oversized' | 'budget-exceeded'
  path?: string
}

/** Current Git and file snapshot for one manifest source. */
export interface SourceInventory {
  version: typeof SOURCE_INVENTORY_VERSION
  sourceId: KnowledgeSourceId
  state: 'ready' | 'degraded'
  commit?: string
  branch?: string
  dirty: boolean
  reuseKey: string
  scanMode: 'full' | 'incremental'
  reusedFileCount: number
  readFileCount: number
  inventoryHash?: string
  fileCount: number
  totalBytes: number
  files: readonly SourceInventoryFile[]
  issues: readonly SourceInventoryIssue[]
}

/** Why one Knowledge Card cannot be treated as fresh. */
export interface KnowledgeCardFreshnessReason {
  kind: 'canonical-stale' | 'source-unavailable' | 'file-missing' | 'file-changed' | 'source-revision-changed'
  sourceId?: KnowledgeSourceId
  path?: string
}

/** Effective freshness of one canonical Knowledge Card. */
export interface KnowledgeCardFreshness {
  cardId: KnowledgeCardId
  title: string
  canonicalStatus: KnowledgeCard['status']
  state: 'fresh' | 'stale' | 'degraded' | 'inactive'
  reasons: readonly KnowledgeCardFreshnessReason[]
}

/** Read-only source and card status for one canonical project. */
export interface ProjectKnowledgeStatus {
  sources: readonly SourceInventory[]
  cards: readonly KnowledgeCardFreshness[]
  staleCardCount: number
  degradedCardCount: number
}

/** Optional prior checkpoints and cancellation for one Source inspection. */
export interface SourceInventoryInspectionOptions {
  baselines?: readonly SourceInventoryBaseline[]
  signal?: AbortSignal
}

/** Opaque source-root handle shared by inventory consumers and backends. */
export interface InventoryRoot {
  processPath: string
  token: unknown
}

/** Bounded result of one Git command executed inside a Source root. */
export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

type InventoryFileRead =
  | { kind: 'file'; bytes: Uint8Array; size: number }
  | { kind: 'missing' | 'symlink' | 'non-file' | 'oversized' }

/** Execution-world operations required by the deterministic inventory algorithm. */
export interface SourceInventoryBackend {
  resolveRoot(projectRoot: string, relativeRoot: string, signal?: AbortSignal): Promise<InventoryRoot>
  runGit(root: InventoryRoot, args: readonly string[], config: GitCommandConfig, signal?: AbortSignal): Promise<GitResult>
  readFile(root: InventoryRoot, path: string, maxBytes: number, signal?: AbortSignal): Promise<InventoryFileRead>
  streamGitObject(
    root: InventoryRoot,
    objectId: string,
    config: GitObjectStreamConfig,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>
}

async function boundedStreamText(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let retained = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    if (retained >= maxBytes) continue
    const next = chunk.subarray(0, maxBytes - retained)
    chunks.push(next)
    retained += next.byteLength
  }
  return Buffer.concat(chunks).toString('utf8')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function portablePath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/')
  return portablePathPattern.test(normalized) ? normalized : undefined
}

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.cache', '.sessions', '.storages', 'coverage', 'dist', 'lib', 'node_modules',
])

/** Explain why one portable Source path is excluded from project knowledge. */
export function sourcePathExclusionReason(path: string): string | undefined {
  const segments = path.split('/')
  if (segments.some(segment => EXCLUDED_DIRECTORIES.has(segment))) return '依赖、生成物或本地缓存目录'
  if (path === '.dsh/knowledge' || path.startsWith('.dsh/knowledge/')) return '插件自身的 canonical knowledge'
  const name = segments.at(-1) ?? ''
  if (name === '.env' || name.startsWith('.env.') || name.startsWith('.credentials')) return '疑似凭据文件'
  if (['.db', '.sqlite', '.sqlite3'].includes(extname(name).toLowerCase()) || name.endsWith('-shm') || name.endsWith('-wal')) {
    return '本地数据库或数据库日志'
  }
  return ['.key', '.p12', '.pem'].includes(extname(name).toLowerCase()) ? '私钥或证书文件' : undefined
}

function isExcluded(path: string): boolean {
  return sourcePathExclusionReason(path) !== undefined
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.go': 'Go',
  '.html': 'HTML',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.json': 'JSON',
  '.jsx': 'JavaScript JSX',
  '.kt': 'Kotlin',
  '.md': 'Markdown',
  '.php': 'PHP',
  '.ps1': 'PowerShell',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.swift': 'Swift',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript JSX',
  '.xml': 'XML',
  '.yaml': 'YAML',
  '.yml': 'YAML',
}

/** Detect optional language metadata without deciding whether the file is understandable. */
export function detectSourceLanguage(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]
}

function assertPositiveLimits(config: SourceInventoryConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (name === 'includeUntracked') continue
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  }
}

function nulRecords(value: string): string[] {
  const records = value.split('\0')
  if (records.at(-1) === '') records.pop()
  return records
}

function hasRelevantWorktreeChange(value: string): boolean {
  return nulRecords(value).some(record => {
    const rawPath = record.length > 3 && record[2] === ' ' ? record.slice(3) : record
    const path = portablePath(rawPath)
    return path !== undefined && !isExcluded(path)
  })
}

function inventoryReuseKey(config: SourceInventoryConfig, analyzer: SourceAnalyzer): string {
  return sha256(JSON.stringify({
    version: SOURCE_INVENTORY_VERSION,
    config,
    analyzer: analyzer.cacheKey,
  }))
}

function gitIssue(sourceId: KnowledgeSourceId, reuseKey: string): SourceInventory {
  return {
    version: SOURCE_INVENTORY_VERSION,
    sourceId,
    state: 'degraded',
    dirty: false,
    reuseKey,
    scanMode: 'full',
    reusedFileCount: 0,
    readFileCount: 0,
    fileCount: 0,
    totalBytes: 0,
    files: [],
    issues: [{ kind: 'git-unavailable' }],
  }
}

function parseChangedPaths(value: string): Set<string> | undefined {
  const records = nulRecords(value)
  const paths = new Set<string>()
  for (let index = 0; index < records.length;) {
    const status = records[index++]!
    if (!/^(?:[ACDMTUXB]|[RC][0-9]{1,3})$/u.test(status)) return undefined
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1
    if (index + pathCount > records.length) return undefined
    for (let offset = 0; offset < pathCount; offset += 1) {
      const path = portablePath(records[index++]!)
      if (path === undefined) return undefined
      paths.add(path)
    }
  }
  return paths
}

async function changedPathsForBaseline(
  backend: SourceInventoryBackend,
  root: InventoryRoot,
  commit: string,
  baseline: SourceInventoryBaseline | undefined,
  reuseKey: string,
  dirty: boolean,
  config: SourceInventoryConfig,
  signal?: AbortSignal,
): Promise<Set<string> | undefined> {
  if (dirty || baseline === undefined || baseline.reuseKey !== reuseKey) return undefined
  try {
    const result = await backend.runGit(root, [
      'diff', '--name-status', '-z', '--find-renames', '--find-copies', `${baseline.commit}..${commit}`, '--', '.',
    ], config, signal)
    if (result.exitCode !== 0) return undefined
    return parseChangedPaths(result.stdout)
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

/** Build one bounded, deterministic inventory from a manifest Git source. */
export async function buildSourceInventory(
  backend: SourceInventoryBackend,
  projectRoot: string,
  source: CanonicalStore['manifest']['sources'][number],
  config: SourceInventoryConfig,
  analyzer: SourceAnalyzer = new DeterministicSourceAnalyzer(),
  baseline?: SourceInventoryBaseline,
  signal?: AbortSignal,
): Promise<SourceInventory> {
  assertPositiveLimits(config)
  const reuseKey = inventoryReuseKey(config, analyzer)
  const root = await backend.resolveRoot(projectRoot, source.relativeRoot, signal)
  const head = await backend.runGit(root, ['rev-parse', '--verify', 'HEAD'], config, signal)
  if (head.exitCode !== 0 || head.stdout.trim() === '') return gitIssue(source.id, reuseKey)
  const branchResult = await backend.runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], config, signal)
  const status = await backend.runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'], config, signal)
  if (status.exitCode !== 0) return gitIssue(source.id, reuseKey)
  const listArgs = ['ls-files', '-z', '--cached']
  if (config.includeUntracked) listArgs.push('--others', '--exclude-standard')
  listArgs.push('--', '.')
  const listed = await backend.runGit(root, listArgs, config, signal)
  if (listed.exitCode !== 0) return gitIssue(source.id, reuseKey)

  const issues: SourceInventoryIssue[] = []
  const files: SourceInventoryFile[] = []
  let totalBytes = 0
  let reusedFileCount = 0
  let readFileCount = 0
  const commit = head.stdout.trim()
  const dirty = hasRelevantWorktreeChange(status.stdout)
  const changedPaths = await changedPathsForBaseline(
    backend,
    root,
    commit,
    baseline?.sourceId === source.id ? baseline : undefined,
    reuseKey,
    dirty,
    config,
    signal,
  )
  const baselineFiles = changedPaths === undefined
    ? new Map<string, SourceInventoryFile>()
    : new Map(baseline!.files.map(file => [file.path, file]))
  const paths = [...new Set(nulRecords(listed.stdout))].sort(compareText)
  for (const rawPath of paths) {
    const path = portablePath(rawPath)
    if (path === undefined || path.length > config.maxPathChars || path.split('/').length > config.maxDepth) {
      issues.push({ kind: 'invalid-path' })
      continue
    }
    if (isExcluded(path)) continue
    if (files.length >= config.maxFiles) {
      issues.push({ kind: 'budget-exceeded' })
      break
    }
    const reusable = changedPaths?.has(path) === false ? baselineFiles.get(path) : undefined
    if (reusable !== undefined) {
      if (totalBytes + reusable.size > config.maxTotalBytes) {
        issues.push({ kind: 'budget-exceeded', path })
        break
      }
      totalBytes += reusable.size
      reusedFileCount += 1
      files.push(structuredClone(reusable))
      continue
    }
    const read = await backend.readFile(root, path, config.maxFileBytes, signal)
    readFileCount += 1
    if (read.kind !== 'file') {
      issues.push({
        kind: read.kind === 'missing' ? 'missing-file' : read.kind,
        path,
      })
      continue
    }
    if (totalBytes + read.size > config.maxTotalBytes) {
      issues.push({ kind: 'budget-exceeded', path })
      break
    }
    totalBytes += read.size
    const detectedLanguage = detectSourceLanguage(path)
    const analysis = analyzer.analyze({
      path,
      ...(detectedLanguage === undefined ? {} : { language: detectedLanguage }),
      bytes: read.bytes,
    })
    files.push({
      path,
      size: read.size,
      contentHash: sha256(read.bytes),
      ...(detectedLanguage === undefined ? {} : { language: detectedLanguage }),
      ...(analysis === undefined ? {} : { analysis }),
    })
  }

  const inventoryHash = sha256(JSON.stringify({
    version: SOURCE_INVENTORY_VERSION,
    sourceId: source.id,
    reuseKey,
    files,
  }))
  return {
    version: SOURCE_INVENTORY_VERSION,
    sourceId: source.id,
    state: issues.length === 0 ? 'ready' : 'degraded',
    commit,
    ...(branchResult.exitCode === 0 && branchResult.stdout.trim() !== '' ? { branch: branchResult.stdout.trim() } : {}),
    dirty,
    reuseKey,
    scanMode: changedPaths === undefined ? 'full' : 'incremental',
    reusedFileCount,
    readFileCount,
    inventoryHash,
    fileCount: files.length,
    totalBytes,
    files,
    issues,
  }
}

function cardReferences(card: KnowledgeCard): ProvenanceRef[] {
  return [...card.provenance, ...card.sections.flatMap(section => section.provenance)]
}

function uniqueReasons(reasons: KnowledgeCardFreshnessReason[]): KnowledgeCardFreshnessReason[] {
  const byKey = new Map<string, KnowledgeCardFreshnessReason>()
  for (const reason of reasons) byKey.set(JSON.stringify(reason), reason)
  return [...byKey.values()]
}

/** Compare Knowledge Card anchors with the current source inventories. */
export function detectKnowledgeCardFreshness(
  cards: readonly KnowledgeCard[],
  inventories: readonly SourceInventory[],
): KnowledgeCardFreshness[] {
  const inventoryBySource = new Map(inventories.map(inventory => [inventory.sourceId, inventory]))
  return cards.map((card): KnowledgeCardFreshness => {
    if (card.status === 'deprecated' || card.status === 'needs-review') {
      return { cardId: card.id, title: card.title, canonicalStatus: card.status, state: 'inactive', reasons: [] }
    }
    const reasons: KnowledgeCardFreshnessReason[] = card.status === 'stale' ? [{ kind: 'canonical-stale' }] : []
    let degraded = false
    const references = cardReferences(card)
    for (const revision of card.sourceRevisions) {
      const inventory = inventoryBySource.get(revision.sourceId)
      if (inventory === undefined || inventory.commit === undefined) {
        degraded = true
        reasons.push({ kind: 'source-unavailable', sourceId: revision.sourceId })
        continue
      }
      if (revision.catalogHash !== undefined) {
        if (inventory.dirty || inventory.commit !== revision.commit) {
          reasons.push({ kind: 'source-revision-changed', sourceId: revision.sourceId })
        }
        continue
      }
      if (inventory.state === 'degraded') {
        degraded = true
        reasons.push({ kind: 'source-unavailable', sourceId: revision.sourceId })
        continue
      }
      const sourceReferences = references.filter(reference => reference.kind !== 'session' && reference.sourceId === revision.sourceId)
      const fileReferences = sourceReferences.filter((reference): reference is Extract<ProvenanceRef, { kind: 'git-file' | 'document' }> => (
        reference.kind === 'git-file' || reference.kind === 'document'
      ))
      const files = new Map(inventory.files.map(file => [file.path, file]))
      for (const reference of fileReferences) {
        const current = files.get(reference.path)
        if (current === undefined) reasons.push({ kind: 'file-missing', sourceId: revision.sourceId, path: reference.path })
        else if (current.contentHash !== reference.contentHash) {
          reasons.push({ kind: 'file-changed', sourceId: revision.sourceId, path: reference.path })
        }
      }
      const hasCommitOnlyEvidence = sourceReferences.some(reference => reference.kind === 'git-commit')
      if (revision.inventoryHash !== undefined) {
        if (revision.inventoryHash !== inventory.inventoryHash) {
          reasons.push({ kind: 'source-revision-changed', sourceId: revision.sourceId })
        }
      } else if ((fileReferences.length === 0 || hasCommitOnlyEvidence) && (revision.commit !== inventory.commit || inventory.dirty)) {
        reasons.push({ kind: 'source-revision-changed', sourceId: revision.sourceId })
      }
    }
    const unique = uniqueReasons(reasons)
    const stale = unique.some(reason => reason.kind !== 'source-unavailable')
    return {
      cardId: card.id,
      title: card.title,
      canonicalStatus: card.status,
      state: stale ? 'stale' : degraded ? 'degraded' : 'fresh',
      reasons: unique,
    }
  })
}

/** Project one clean inventory into a reusable per-file baseline. */
export function createSourceInventoryBaseline(inventory: SourceInventory): SourceInventoryBaseline | undefined {
  if (inventory.state !== 'ready' || inventory.dirty || inventory.commit === undefined) return undefined
  return {
    sourceId: inventory.sourceId,
    commit: inventory.commit,
    reuseKey: inventory.reuseKey,
    files: structuredClone(inventory.files),
  }
}

/** Build source inventories and effective card freshness for one project. */
export async function inspectKnowledgeProject(
  backend: SourceInventoryBackend,
  store: CanonicalStore,
  config: SourceInventoryConfig,
  analyzer: SourceAnalyzer = new DeterministicSourceAnalyzer(),
  options: SourceInventoryInspectionOptions = {},
): Promise<ProjectKnowledgeStatus> {
  const baselineBySource = new Map(options.baselines?.map(value => [value.sourceId, value]) ?? [])
  const reuseKey = inventoryReuseKey(config, analyzer)
  const sources: SourceInventory[] = []
  for (const source of store.manifest.sources) {
    try {
      sources.push(await buildSourceInventory(
        backend,
        store.projectRoot,
        source,
        config,
        analyzer,
        baselineBySource.get(source.id),
        options.signal,
      ))
    } catch {
      options.signal?.throwIfAborted()
      sources.push(gitIssue(source.id, reuseKey))
    }
  }
  const cards = detectKnowledgeCardFreshness(store.cards, sources)
  return {
    sources,
    cards,
    staleCardCount: cards.filter(card => card.state === 'stale').length,
    degradedCardCount: cards.filter(card => card.state === 'degraded').length,
  }
}

/** Local Node backend used by the standalone CLI and tests. */
export class NodeSourceInventoryBackend implements SourceInventoryBackend {
  async resolveRoot(projectRoot: string, relativeRoot: string): Promise<InventoryRoot> {
    const project = await realpath(resolve(projectRoot))
    const requested = resolve(project, relativeRoot)
    const pathInfo = await lstat(requested)
    if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink()) throw new Error('source root must be an ordinary directory')
    const root = await realpath(requested)
    if (!containsPath(project, root)) throw new Error('source root escapes the project')
    return { processPath: root, token: root }
  }

  async runGit(
    root: InventoryRoot,
    args: readonly string[],
    config: GitCommandConfig,
    signal?: AbortSignal,
  ): Promise<GitResult> {
    try {
      const result = await execFileAsync('git', [...args], {
        cwd: root.processPath,
        encoding: 'utf8',
        maxBuffer: config.gitOutputMaxBytes,
        signal,
      })
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const value = error as Error & { code?: number; stdout: string; stderr: string }
        return {
          exitCode: typeof value.code === 'number' ? value.code : 1,
          stdout: value.stdout,
          stderr: value.stderr,
        }
      }
      throw error
    }
  }

  async readFile(root: InventoryRoot, path: string, maxBytes: number, signal?: AbortSignal): Promise<InventoryFileRead> {
    const absolute = resolve(root.processPath, path)
    if (!containsPath(root.processPath, absolute)) return { kind: 'non-file' }
    let pathInfo
    try {
      pathInfo = await lstat(absolute)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' }
      throw error
    }
    if (pathInfo.isSymbolicLink()) return { kind: 'symlink' }
    if (!pathInfo.isFile()) return { kind: 'non-file' }
    if (pathInfo.size > maxBytes) return { kind: 'oversized' }
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
    const handle = await open(absolute, constants.O_RDONLY | noFollow)
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return { kind: 'non-file' }
      if (stats.size > maxBytes) return { kind: 'oversized' }
      const bytes = Buffer.alloc(stats.size)
      let offset = 0
      while (offset < bytes.length) {
        signal?.throwIfAborted()
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      return { kind: 'file', bytes: bytes.subarray(0, offset), size: offset }
    } finally {
      await handle.close()
    }
  }

  async *streamGitObject(
    root: InventoryRoot,
    objectId: string,
    config: GitObjectStreamConfig,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted()
    const child = spawnProcess('git', ['cat-file', 'blob', objectId], {
      cwd: root.processPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal === undefined ? {} : { signal }),
    })
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, processSignal) => { accept({ code, signal: processSignal }) })
    })
    const stderr = boundedStreamText(child.stderr, config.stderrMaxBytes)
    let settled = false
    try {
      for await (const value of child.stdout) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      }
      const [outcome, diagnostics] = await Promise.all([done, stderr])
      settled = true
      if (outcome.code !== 0) {
        throw new Error(`git cat-file failed (${outcome.code ?? outcome.signal ?? 'unknown'}): ${diagnostics.trim()}`)
      }
    } finally {
      if (!settled) {
        child.kill('SIGTERM')
        const killTimer = setTimeout(() => { child.kill('SIGKILL') }, config.processGraceMs)
        killTimer.unref()
        await Promise.allSettled([done, stderr])
        clearTimeout(killTimer)
      }
    }
  }
}

interface DshInventoryRoot extends InventoryRoot {
  token: FsTarget
}

/** DSH capability-backed inventory backend for assembled Host runtimes. */
export class DshSourceInventoryBackend implements SourceInventoryBackend {
  constructor(
    private readonly fs: FileSystem,
    private readonly subprocess: SubprocessRuntime,
  ) {}

  async resolveRoot(projectRoot: string, relativeRoot: string, signal?: AbortSignal): Promise<DshInventoryRoot> {
    const project = await this.fs.resolve('.', { cwd: projectRoot, ...(signal === undefined ? {} : { signal }) })
    const sourceInfo = await this.fs.lstat(relativeRoot, { cwd: this.fs.processPath(project) }, signal)
    if (sourceInfo?.type !== 'directory') throw new Error('source root must be an ordinary directory')
    const source = await this.fs.resolve(relativeRoot, {
      cwd: this.fs.processPath(project),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!this.fs.contains(project, source)) throw new Error('source root escapes the project')
    return { processPath: this.fs.processPath(source), token: source }
  }

  async runGit(
    root: InventoryRoot,
    args: readonly string[],
    config: GitCommandConfig,
    signal?: AbortSignal,
  ): Promise<GitResult> {
    const executable = await this.subprocess.resolveExecutable('git', undefined, signal)
    const running = this.subprocess.spawn({
      argv: [executable, ...args],
      cwd: root.processPath,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.gitOutputMaxBytes },
        stderr: { maxBytes: config.gitOutputMaxBytes },
      },
      graceMs: config.processGraceMs,
      signal,
    })
    const outcome = await running.done
    const stdout = running.collected.stdout?.readFrom(0)
    const stderr = running.collected.stderr?.readFrom(0)
    if (stdout?.lossy === true || stderr?.lossy === true) throw new Error('git output exceeded the configured bound')
    return {
      exitCode: outcome.exitCode ?? 1,
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
    }
  }

  async readFile(root: InventoryRoot, path: string, maxBytes: number, signal?: AbortSignal): Promise<InventoryFileRead> {
    const typedRoot = root as DshInventoryRoot
    const info = await this.fs.lstat(path, { cwd: root.processPath }, signal)
    if (info === undefined) return { kind: 'missing' }
    if (info.type === 'symlink') return { kind: 'symlink' }
    if (info.type !== 'file') return { kind: 'non-file' }
    if (info.size !== undefined && info.size > maxBytes) return { kind: 'oversized' }
    const target = await this.fs.resolve(path, { cwd: root.processPath, ...(signal === undefined ? {} : { signal }) })
    if (!this.fs.contains(typedRoot.token, target)) return { kind: 'non-file' }
    try {
      const bytes = await this.fs.readBytes(target, signal, maxBytes)
      return { kind: 'file', bytes, size: bytes.byteLength }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'FS_TOO_LARGE') return { kind: 'oversized' }
      throw error
    }
  }

  async *streamGitObject(
    root: InventoryRoot,
    objectId: string,
    config: GitObjectStreamConfig,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const executable = await this.subprocess.resolveExecutable('git', undefined, signal)
    const running = this.subprocess.spawn({
      argv: [executable, 'cat-file', 'blob', objectId],
      cwd: root.processPath,
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: { maxBytes: config.stderrMaxBytes },
      },
      graceMs: config.processGraceMs,
      signal,
    })
    let settled = false
    try {
      if (running.stdout === undefined) throw new Error('git object stream has no stdout pipe')
      for await (const value of running.stdout) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      }
      const outcome = await running.done
      settled = true
      if (outcome.exitCode !== 0) {
        const stderr = running.collected.stderr?.readFrom(0)
        if (stderr?.lossy === true) throw new Error('git object stderr exceeded the configured bound')
        throw new Error(`git cat-file failed (${outcome.exitCode ?? outcome.signal ?? 'unknown'}): ${stderr?.text.trim() ?? ''}`)
      }
    } finally {
      if (!settled) {
        running.terminate()
        await running.done.catch(() => {})
      }
    }
  }
}
