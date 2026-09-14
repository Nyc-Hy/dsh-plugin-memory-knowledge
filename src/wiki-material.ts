import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { CanonicalStore } from './canonical.js'
import type { InventoryRoot, SourceInventoryBackend } from './inventory.js'
import type { WikiCatalogEntry, WikiCoverageItem, WikiMaterialRange } from './wiki-model.js'

/** Bounded streaming settings for immutable project material. */
export interface WikiMaterialReadConfig {
  chunkBytes: number
  maxMaterialBytes: number
  rangeTargetBytes: number
  rangeContextBytes: number
  stderrMaxBytes: number
  processGraceMs: number
}

/** Defaults allow multi-gigabyte files while keeping each in-memory chunk small. */
export const DEFAULT_WIKI_MATERIAL_READ_CONFIG: WikiMaterialReadConfig = {
  chunkBytes: 64 * 1_024,
  maxMaterialBytes: 8 * 1_024 * 1_024 * 1_024,
  rangeTargetBytes: 384 * 1_024,
  rangeContextBytes: 32 * 1_024,
  stderrMaxBytes: 64 * 1_024,
  processGraceMs: 3_000,
}

/** One bounded byte range from an immutable Catalog object. */
export interface WikiMaterialChunk {
  kind: 'chunk'
  index: number
  startByte: number
  bytes: Uint8Array
}

/** Final identity emitted only after the complete object is read and sized. */
export interface WikiMaterialComplete {
  kind: 'complete'
  byteSize: number
  contentHash: string
  chunkCount: number
  objectByteSize: number
  objectContentHash: string
  startByte: number
  endByte: number
}

/** Streaming project-material output; consumers must wait for `complete` before saving claims. */
export type WikiMaterialStreamItem = WikiMaterialChunk | WikiMaterialComplete

/** Result of preparing one oversized immutable object for bounded Agent tasks. */
export type WikiMaterialPreparation =
  | { kind: 'whole' }
  | { kind: 'deferred'; reason: string }
  | {
      kind: 'ranges'
      contentHash: string
      ranges: Array<Omit<WikiMaterialRange, 'id' | 'coverageId'>>
    }

class NonTextWikiMaterialError extends Error {}

interface WikiMaterialCacheSignature {
  device: string
  inode: string
  size: string
  modifiedNanoseconds: string
  changedNanoseconds: string
}

interface VerifiedWikiMaterialCache {
  objectId: string
  byteSize: number
  contentHash: string
  signature: WikiMaterialCacheSignature
}

const verifiedWikiMaterialCaches = new Map<string, VerifiedWikiMaterialCache>()

function assertConfig(config: WikiMaterialReadConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`memory-knowledge: Wiki material ${name} must be a positive safe integer`)
    }
  }
  if (config.rangeTargetBytes + config.rangeContextBytes * 2 > config.maxMaterialBytes) {
    throw new Error('memory-knowledge: Wiki material range and context exceed the streaming bound')
  }
}

function gitObjectDigest(objectId: string, byteSize: number) {
  const algorithm = objectId.length === 40 ? 'sha1' : objectId.length === 64 ? 'sha256' : undefined
  if (algorithm === undefined) throw new Error('memory-knowledge: unsupported Git object id')
  return createHash(algorithm).update(`blob ${byteSize}\0`)
}

async function cacheSignature(path: string, byteSize: number): Promise<WikiMaterialCacheSignature> {
  const info = await stat(path, { bigint: true })
  if (!info.isFile() || info.size !== BigInt(byteSize)) {
    throw new Error('memory-knowledge: Wiki material cache size is invalid')
  }
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    size: info.size.toString(),
    modifiedNanoseconds: info.mtimeNs.toString(),
    changedNanoseconds: info.ctimeNs.toString(),
  }
}

function sameCacheSignature(left: WikiMaterialCacheSignature, right: WikiMaterialCacheSignature): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (written.bytesWritten < 1) throw new Error('memory-knowledge: Wiki material cache write made no progress')
    offset += written.bytesWritten
  }
}

async function scanCachedObject(
  path: string,
  objectId: string,
  byteSize: number,
  signal?: AbortSignal,
): Promise<{ contentHash: string; signature: WikiMaterialCacheSignature }> {
  const before = await cacheSignature(path, byteSize)
  const handle = await open(path, 'r')
  const contentDigest = createHash('sha256')
  const objectDigest = gitObjectDigest(objectId, byteSize)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const buffer = Buffer.alloc(256 * 1_024)
  let position = 0
  try {
    while (position < byteSize) {
      signal?.throwIfAborted()
      const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, byteSize - position), position)
      if (read.bytesRead < 1) throw new Error('memory-knowledge: Wiki material cache ended early')
      const bytes = buffer.subarray(0, read.bytesRead)
      if (bytes.includes(0)) throw new NonTextWikiMaterialError('材料包含 NUL 字节，不能作为 UTF-8 Wiki 文本分析')
      contentDigest.update(bytes)
      objectDigest.update(bytes)
      decoder.decode(bytes, { stream: true })
      position += read.bytesRead
    }
    decoder.decode()
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new NonTextWikiMaterialError('材料不是有效 UTF-8，不能进入文本 Wiki 分析')
    throw error
  } finally {
    await handle.close()
  }
  if (objectDigest.digest('hex') !== objectId) {
    throw new Error('memory-knowledge: Wiki material cache does not match its Git object id')
  }
  const after = await cacheSignature(path, byteSize)
  if (!sameCacheSignature(before, after)) {
    throw new Error('memory-knowledge: Wiki material cache changed during verification')
  }
  return { contentHash: `sha256:${contentDigest.digest('hex')}`, signature: after }
}

async function cacheGitObject(
  backend: SourceInventoryBackend,
  root: InventoryRoot,
  objectId: string,
  byteSize: number,
  config: WikiMaterialReadConfig,
  cachePath: string,
  signal?: AbortSignal,
): Promise<{ contentHash: string; signature: WikiMaterialCacheSignature }> {
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)
  const contentDigest = createHash('sha256')
  const objectDigest = gitObjectDigest(objectId, byteSize)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let totalBytes = 0
  try {
    for await (const incoming of backend.streamGitObject(root, objectId, config, signal)) {
      signal?.throwIfAborted()
      if (incoming.includes(0)) throw new NonTextWikiMaterialError('材料包含 NUL 字节，不能作为 UTF-8 Wiki 文本分析')
      totalBytes += incoming.byteLength
      if (!Number.isSafeInteger(totalBytes) || totalBytes > byteSize || totalBytes > config.maxMaterialBytes) {
        throw new Error('memory-knowledge: streamed Wiki material exceeds its declared byte size')
      }
      contentDigest.update(incoming)
      objectDigest.update(incoming)
      try {
        decoder.decode(incoming, { stream: true })
      } catch {
        throw new NonTextWikiMaterialError('材料不是有效 UTF-8，不能进入文本 Wiki 分析')
      }
      await writeAll(handle, incoming)
    }
    try {
      decoder.decode()
    } catch {
      throw new NonTextWikiMaterialError('材料不是有效 UTF-8，不能进入文本 Wiki 分析')
    }
    if (totalBytes !== byteSize) {
      throw new Error('memory-knowledge: streamed Wiki material does not match its declared byte size')
    }
    if (objectDigest.digest('hex') !== objectId) {
      throw new Error('memory-knowledge: streamed Wiki material does not match its Git object id')
    }
    await handle.sync()
    await handle.close()
    const contentHash = `sha256:${contentDigest.digest('hex')}`
    signal?.throwIfAborted()
    return withFileLock(cachePath, async () => {
      await unlink(cachePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      await rename(temporaryPath, cachePath)
      return { contentHash, signature: await cacheSignature(cachePath, byteSize) }
    })
  } catch (error: unknown) {
    await handle.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

async function ensureCachedGitObject(
  backend: SourceInventoryBackend,
  root: InventoryRoot,
  objectId: string,
  byteSize: number,
  config: WikiMaterialReadConfig,
  cacheRoot: string,
  signal?: AbortSignal,
): Promise<{ path: string; contentHash: string; signature: WikiMaterialCacheSignature }> {
  if (byteSize > config.maxMaterialBytes) {
    throw new Error('memory-knowledge: Wiki material exceeds the configured streaming bound')
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const path = join(cacheRoot, `${objectId}.blob`)
  try {
    const signature = await cacheSignature(path, byteSize)
    const verified = verifiedWikiMaterialCaches.get(path)
    if (verified?.objectId === objectId && verified.byteSize === byteSize
      && sameCacheSignature(verified.signature, signature)) {
      return { path, contentHash: verified.contentHash, signature }
    }
    const scanned = await scanCachedObject(path, objectId, byteSize, signal)
    verifiedWikiMaterialCaches.set(path, { objectId, byteSize, ...scanned })
    return { path, ...scanned }
  } catch (error: unknown) {
    if (error instanceof NonTextWikiMaterialError) throw error
    signal?.throwIfAborted()
  }
  const cached = await cacheGitObject(backend, root, objectId, byteSize, config, path, signal)
  verifiedWikiMaterialCaches.set(path, { objectId, byteSize, ...cached })
  return { path, ...cached }
}

async function readExact(handle: FileHandle, startByte: number, endByte: number): Promise<Buffer> {
  const result = Buffer.alloc(endByte - startByte)
  let offset = 0
  while (offset < result.byteLength) {
    const read = await handle.read(result, offset, result.byteLength - offset, startByte + offset)
    if (read.bytesRead < 1) throw new Error('memory-knowledge: Wiki material cache ended inside a range')
    offset += read.bytesRead
  }
  return result
}

function isUtf8Continuation(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80
}

async function safeBoundary(
  handle: FileHandle,
  startByte: number,
  objectByteSize: number,
  targetBytes: number,
): Promise<number> {
  const desired = Math.min(objectByteSize, startByte + targetBytes)
  if (desired === objectByteSize) return desired
  const sampleEnd = Math.min(objectByteSize, desired + 4)
  const sample = await readExact(handle, startByte, sampleEnd)
  const minimumNewline = Math.floor((desired - startByte) / 2)
  const newline = sample.subarray(0, desired - startByte).lastIndexOf(0x0a)
  if (newline >= minimumNewline) return startByte + newline + 1
  let boundary = desired
  while (boundary > startByte && isUtf8Continuation(sample[boundary - startByte])) boundary -= 1
  if (boundary === startByte) throw new Error('memory-knowledge: cannot find a UTF-8-safe Wiki material boundary')
  return boundary
}

async function contextBoundary(
  handle: FileHandle,
  candidate: number,
  objectByteSize: number,
  direction: 'forward' | 'backward',
): Promise<number> {
  let boundary = Math.max(0, Math.min(candidate, objectByteSize))
  if (boundary === 0 || boundary === objectByteSize) return boundary
  const origin = Math.max(0, boundary - 4)
  const bytes = await readExact(handle, origin, Math.min(objectByteSize, boundary + 4))
  if (direction === 'forward') {
    while (boundary < objectByteSize && isUtf8Continuation(bytes[boundary - origin])) boundary += 1
  } else {
    while (boundary > 0 && isUtf8Continuation(bytes[boundary - origin])) boundary -= 1
  }
  return boundary
}

function newlineCount(bytes: Uint8Array): number {
  let count = 0
  for (const value of bytes) if (value === 0x0a) count += 1
  return count
}

function inclusiveEndLine(startLine: number, bytes: Uint8Array): number {
  const trailingNewline = bytes.at(-1) === 0x0a ? 1 : 0
  return Math.max(startLine, startLine + newlineCount(bytes) - trailingNewline)
}

async function buildRanges(
  path: string,
  objectByteSize: number,
  config: WikiMaterialReadConfig,
): Promise<Array<Omit<WikiMaterialRange, 'id' | 'coverageId'>>> {
  const handle = await open(path, 'r')
  const ranges: Array<Omit<WikiMaterialRange, 'id' | 'coverageId'>> = []
  let startByte = 0
  let startLine = 1
  try {
    while (startByte < objectByteSize) {
      const endByte = await safeBoundary(handle, startByte, objectByteSize, config.rangeTargetBytes)
      const contentStartByte = await contextBoundary(
        handle,
        startByte - config.rangeContextBytes,
        objectByteSize,
        'forward',
      )
      const contentEndByte = await contextBoundary(
        handle,
        endByte + config.rangeContextBytes,
        objectByteSize,
        'backward',
      )
      const core = await readExact(handle, startByte, endByte)
      const content = contentStartByte === startByte && contentEndByte === endByte
        ? core
        : await readExact(handle, contentStartByte, contentEndByte)
      const prefixLines = newlineCount(content.subarray(0, startByte - contentStartByte))
      const coreLines = newlineCount(core)
      const contentStartLine = Math.max(1, startLine - prefixLines)
      ranges.push({
        ordinal: ranges.length,
        startByte,
        endByte,
        startLine,
        endLine: inclusiveEndLine(startLine, core),
        contentStartByte,
        contentEndByte,
        contentStartLine,
        contentEndLine: inclusiveEndLine(contentStartLine, content),
        contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      })
      startByte = endByte
      startLine += coreLines
    }
  } finally {
    await handle.close()
  }
  return ranges
}

async function sourceRoot(
  backend: SourceInventoryBackend,
  store: Pick<CanonicalStore, 'projectRoot' | 'manifest'>,
  sourceId: WikiCatalogEntry['sourceId'],
  signal?: AbortSignal,
): Promise<InventoryRoot> {
  const source = store.manifest.sources.find(candidate => candidate.id === sourceId)
  if (source === undefined) throw new Error('memory-knowledge: Wiki material Source is unavailable')
  return backend.resolveRoot(store.projectRoot, source.relativeRoot, signal)
}

/** Prepare an oversized Git object as exact, UTF-8-safe core ranges with bounded context. */
export async function prepareWikiMaterial(
  backend: SourceInventoryBackend,
  store: Pick<CanonicalStore, 'projectRoot' | 'manifest'>,
  entry: WikiCatalogEntry,
  cacheRoot: string,
  config: WikiMaterialReadConfig = DEFAULT_WIKI_MATERIAL_READ_CONFIG,
  signal?: AbortSignal,
): Promise<WikiMaterialPreparation> {
  assertConfig(config)
  if (entry.disposition !== undefined || entry.byteSize <= config.rangeTargetBytes) return { kind: 'whole' }
  if (entry.revision.kind !== 'git-object') {
    return { kind: 'deferred', reason: '超大 content-hash 材料需要提供可验证的 worktree 区间读取器' }
  }
  if (entry.byteSize > config.maxMaterialBytes) {
    return { kind: 'deferred', reason: `材料 ${entry.byteSize} 字节，超过本地流式准备上限 ${config.maxMaterialBytes} 字节` }
  }
  try {
    const cached = await ensureCachedGitObject(
      backend,
      await sourceRoot(backend, store, entry.sourceId, signal),
      entry.revision.objectId,
      entry.byteSize,
      config,
      cacheRoot,
      signal,
    )
    return {
      kind: 'ranges',
      contentHash: cached.contentHash,
      ranges: await buildRanges(cached.path, entry.byteSize, config),
    }
  } catch (error: unknown) {
    if (error instanceof NonTextWikiMaterialError) return { kind: 'deferred', reason: error.message }
    throw error
  }
}

/** Stream one exact Git object without reading the current worktree path. */
export async function* streamWikiMaterial(
  backend: SourceInventoryBackend,
  store: Pick<CanonicalStore, 'projectRoot' | 'manifest'>,
  coverage: WikiCoverageItem,
  config: WikiMaterialReadConfig = DEFAULT_WIKI_MATERIAL_READ_CONFIG,
  signal?: AbortSignal,
): AsyncIterable<WikiMaterialStreamItem> {
  assertConfig(config)
  if (coverage.status === 'excluded' || coverage.status === 'blocked') {
    throw new Error(`memory-knowledge: ${coverage.status} Wiki coverage cannot be read`)
  }
  if (coverage.revision.kind !== 'git-object') {
    throw new Error('memory-knowledge: content-hash Wiki material requires a worktree reader provider')
  }
  if (coverage.byteSize > config.maxMaterialBytes) {
    throw new Error('memory-knowledge: Wiki material exceeds the configured streaming bound')
  }
  const root = await sourceRoot(backend, store, coverage.sourceId, signal)
  const digest = createHash('sha256')
  const objectDigest = gitObjectDigest(coverage.revision.objectId, coverage.byteSize)
  let output = Buffer.alloc(config.chunkBytes)
  let outputBytes = 0
  let totalBytes = 0
  let chunkCount = 0
  for await (const incoming of backend.streamGitObject(root, coverage.revision.objectId, config, signal)) {
    signal?.throwIfAborted()
    digest.update(incoming)
    objectDigest.update(incoming)
    totalBytes += incoming.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > coverage.byteSize || totalBytes > config.maxMaterialBytes) {
      throw new Error('memory-knowledge: streamed Wiki material exceeds its declared byte size')
    }
    let inputOffset = 0
    while (inputOffset < incoming.byteLength) {
      const copied = Math.min(config.chunkBytes - outputBytes, incoming.byteLength - inputOffset)
      output.set(incoming.subarray(inputOffset, inputOffset + copied), outputBytes)
      outputBytes += copied
      inputOffset += copied
      if (outputBytes !== config.chunkBytes) continue
      yield {
        kind: 'chunk',
        index: chunkCount,
        startByte: totalBytes - incoming.byteLength + inputOffset - outputBytes,
        bytes: output,
      }
      chunkCount += 1
      output = Buffer.alloc(config.chunkBytes)
      outputBytes = 0
    }
  }
  if (outputBytes > 0) {
    yield {
      kind: 'chunk',
      index: chunkCount,
      startByte: totalBytes - outputBytes,
      bytes: new Uint8Array(output.subarray(0, outputBytes)),
    }
    chunkCount += 1
  }
  if (totalBytes !== coverage.byteSize) {
    throw new Error('memory-knowledge: streamed Wiki material does not match its declared byte size')
  }
  if (objectDigest.digest('hex') !== coverage.revision.objectId) {
    throw new Error('memory-knowledge: streamed Wiki material does not match its Git object id')
  }
  const contentHash = `sha256:${digest.digest('hex')}`
  yield {
    kind: 'complete',
    byteSize: totalBytes,
    contentHash,
    chunkCount,
    objectByteSize: totalBytes,
    objectContentHash: contentHash,
    startByte: 0,
    endByte: totalBytes,
  }
}

/** Read one prepared context window from the verified private object cache. */
export async function* streamWikiMaterialRange(
  backend: SourceInventoryBackend,
  store: Pick<CanonicalStore, 'projectRoot' | 'manifest'>,
  coverage: WikiCoverageItem,
  range: WikiMaterialRange,
  cacheRoot: string,
  config: WikiMaterialReadConfig = DEFAULT_WIKI_MATERIAL_READ_CONFIG,
  signal?: AbortSignal,
): AsyncIterable<WikiMaterialStreamItem> {
  assertConfig(config)
  if (coverage.revision.kind !== 'git-object' || coverage.preparedContentHash === undefined) {
    throw new Error('memory-knowledge: Wiki range requires prepared Git-object Coverage')
  }
  const coordinates = [
    range.startByte,
    range.endByte,
    range.contentStartByte,
    range.contentEndByte,
  ]
  if (
    range.coverageId !== coverage.id
    || coordinates.some(value => !Number.isSafeInteger(value))
    || range.contentStartByte < 0
    || range.contentStartByte > range.startByte
    || range.startByte >= range.endByte
    || range.endByte > range.contentEndByte
    || range.contentEndByte > coverage.byteSize
  ) {
    throw new Error('memory-knowledge: Wiki range does not belong to Coverage')
  }
  const cached = await ensureCachedGitObject(
    backend,
    await sourceRoot(backend, store, coverage.sourceId, signal),
    coverage.revision.objectId,
    coverage.byteSize,
    config,
    cacheRoot,
    signal,
  )
  if (cached.contentHash !== coverage.preparedContentHash) {
    throw new Error('memory-knowledge: prepared Wiki material content hash changed')
  }
  const handle = await open(cached.path, 'r')
  const digest = createHash('sha256')
  const byteSize = range.contentEndByte - range.contentStartByte
  let chunkCount = 0
  let position = range.contentStartByte
  try {
    while (position < range.contentEndByte) {
      signal?.throwIfAborted()
      const bytes = Buffer.alloc(Math.min(config.chunkBytes, range.contentEndByte - position))
      const read = await handle.read(bytes, 0, bytes.byteLength, position)
      if (read.bytesRead !== bytes.byteLength) throw new Error('memory-knowledge: Wiki material range ended early')
      digest.update(bytes)
      yield { kind: 'chunk', index: chunkCount, startByte: position, bytes }
      chunkCount += 1
      position += bytes.byteLength
    }
  } finally {
    await handle.close()
  }
  if (!sameCacheSignature(cached.signature, await cacheSignature(cached.path, coverage.byteSize))) {
    throw new Error('memory-knowledge: Wiki material cache changed during range reading')
  }
  const contentHash = `sha256:${digest.digest('hex')}`
  if (contentHash !== range.contentHash) {
    throw new Error('memory-knowledge: Wiki material range hash does not match its prepared identity')
  }
  yield {
    kind: 'complete',
    byteSize,
    contentHash,
    chunkCount,
    objectByteSize: coverage.byteSize,
    objectContentHash: coverage.preparedContentHash,
    startByte: range.contentStartByte,
    endByte: range.contentEndByte,
  }
}
