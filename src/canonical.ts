import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { KnowledgeSourceId } from './ids.js'
import type { KnowledgeCard, KnowledgeManifest, MemoryEntry, ProvenanceRef, SharedKnowledgeScope } from './model.js'
import { assertKnowledgeCard, assertKnowledgeManifest, assertMemoryEntry, KnowledgeSchemaError } from './schema.js'

/** Project-relative directory that owns Git-shared canonical knowledge. */
export const KNOWLEDGE_ROOT_SEGMENTS = ['.dsh', 'knowledge'] as const

/** Stable failure codes exposed by canonical-store reads. */
export type CanonicalStoreErrorCode =
  | 'KNOWLEDGE_NOT_FOUND'
  | 'KNOWLEDGE_IO'
  | 'KNOWLEDGE_INVALID_JSON'
  | 'KNOWLEDGE_SCHEMA'
  | 'KNOWLEDGE_INVARIANT'

/** Failure while reading or validating a Git-shared knowledge store. */
export class CanonicalStoreError extends Error {
  readonly code: CanonicalStoreErrorCode
  readonly path: string

  constructor(code: CanonicalStoreErrorCode, path: string, message: string, options?: ErrorOptions) {
    super(`${message}: ${path}`, options)
    this.name = 'CanonicalStoreError'
    this.code = code
    this.path = path
  }
}

/** Complete validated canonical store from one project root. */
export interface CanonicalStore {
  projectRoot: string
  knowledgeRoot: string
  manifest: KnowledgeManifest
  memories: readonly MemoryEntry[]
  cards: readonly KnowledgeCard[]
}

/** Result of creating or confirming one canonical memory document. */
export interface CanonicalMemoryWrite {
  path: string
  created: boolean
}

/** Result of creating, confirming, or replacing one canonical Knowledge Card. */
export interface CanonicalCardWrite {
  path: string
  revision: number
  created?: boolean
}

/** Resolve the canonical knowledge directory below a project root. */
export function resolveKnowledgeRoot(projectRoot: string): string {
  return resolve(projectRoot, ...KNOWLEDGE_ROOT_SEGMENTS)
}

/** Whether a read failure means that the project has not initialized its canonical knowledge store. */
export function isCanonicalStoreAbsent(error: unknown, projectRoot: string): boolean {
  if (!(error instanceof CanonicalStoreError && error.code === 'KNOWLEDGE_NOT_FOUND')) return false
  const resolvedProjectRoot = resolve(projectRoot)
  const knowledgeRoot = resolveKnowledgeRoot(resolvedProjectRoot)
  return [
    join(resolvedProjectRoot, '.dsh'),
    knowledgeRoot,
    join(knowledgeRoot, 'manifest.json'),
  ].includes(error.path)
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function assertOrdinaryFile(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') {
      throw new CanonicalStoreError('KNOWLEDGE_NOT_FOUND', path, 'required knowledge file is missing', { cause: error })
    }
    throw new CanonicalStoreError('KNOWLEDGE_IO', path, 'cannot inspect knowledge file', { cause: error })
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'knowledge document must be an ordinary file')
  }
}

async function assertOrdinaryDirectory(path: string, optional = false): Promise<boolean> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') {
      if (optional) return false
      throw new CanonicalStoreError('KNOWLEDGE_NOT_FOUND', path, 'required knowledge directory is missing', { cause: error })
    }
    throw new CanonicalStoreError('KNOWLEDGE_IO', path, 'cannot inspect knowledge directory', { cause: error })
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'knowledge path must be an ordinary directory')
  }
  return true
}

async function parseJson(path: string): Promise<unknown> {
  await assertOrdinaryFile(path)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error: unknown) {
    throw new CanonicalStoreError('KNOWLEDGE_IO', path, 'cannot read knowledge file', { cause: error })
  }
  try {
    return JSON.parse(content) as unknown
  } catch (error: unknown) {
    throw new CanonicalStoreError('KNOWLEDGE_INVALID_JSON', path, 'knowledge file is not valid JSON', { cause: error })
  }
}

async function listJsonFiles(path: string): Promise<string[]> {
  if (!await assertOrdinaryDirectory(path, true)) return []
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return []
    throw new CanonicalStoreError('KNOWLEDGE_IO', path, 'cannot list knowledge directory', { cause: error })
  }
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (!entry.isFile() || entry.isSymbolicLink() || extname(entry.name) !== '.json') {
      throw new CanonicalStoreError(
        'KNOWLEDGE_INVARIANT',
        entryPath,
        'canonical directories may contain only ordinary .json files',
      )
    }
    files.push(entryPath)
  }
  return files.sort(compareText)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function schemaFailure(path: string, error: unknown): never {
  if (error instanceof KnowledgeSchemaError) {
    throw new CanonicalStoreError('KNOWLEDGE_SCHEMA', path, error.message, { cause: error })
  }
  throw error
}

async function readManifest(path: string): Promise<KnowledgeManifest> {
  const value = await parseJson(path)
  try {
    assertKnowledgeManifest(value)
    return value
  } catch (error: unknown) {
    return schemaFailure(path, error)
  }
}

async function readMemory(path: string): Promise<MemoryEntry> {
  const value = await parseJson(path)
  try {
    assertMemoryEntry(value)
    if (basename(path, '.json') !== value.id) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, `memory filename must equal id ${JSON.stringify(value.id)}`)
    }
    return value
  } catch (error: unknown) {
    if (error instanceof CanonicalStoreError) throw error
    return schemaFailure(path, error)
  }
}

async function readCard(path: string): Promise<KnowledgeCard> {
  const value = await parseJson(path)
  try {
    assertKnowledgeCard(value)
    if (basename(path, '.json') !== value.id) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, `card filename must equal id ${JSON.stringify(value.id)}`)
    }
    return value
  } catch (error: unknown) {
    if (error instanceof CanonicalStoreError) throw error
    return schemaFailure(path, error)
  }
}

function assertUnique(values: readonly string[], label: string, path: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, `${label} contains duplicate ${JSON.stringify(value)}`)
    }
    seen.add(value)
  }
}

function assertScope(scope: SharedKnowledgeScope, manifest: KnowledgeManifest, path: string): void {
  if (scope.kind === 'space') {
    if (scope.spaceId !== manifest.spaceId) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'record scope references another knowledge space')
    }
    return
  }
  if (!manifest.sources.some(source => source.id === scope.sourceId)) {
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, `record scope references unknown source ${JSON.stringify(scope.sourceId)}`)
  }
}

function provenanceSource(provenance: ProvenanceRef): KnowledgeSourceId | undefined {
  return provenance.kind === 'session' ? undefined : provenance.sourceId
}

function assertProvenance(
  provenance: readonly ProvenanceRef[],
  manifest: KnowledgeManifest,
  evidenceClass: MemoryEntry['evidenceClass'],
  path: string,
): void {
  const sourceIds = new Set(manifest.sources.map(source => source.id))
  for (const reference of provenance) {
    const sourceId = provenanceSource(reference)
    if (sourceId !== undefined && !sourceIds.has(sourceId)) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, `provenance references unknown source ${JSON.stringify(sourceId)}`)
    }
  }
  const onlyUnportableSessions = provenance.every(reference => (
    reference.kind === 'session' && reference.portableEvidence === undefined
  ))
  if (onlyUnportableSessions && evidenceClass !== 'human-verified') {
    throw new CanonicalStoreError(
      'KNOWLEDGE_INVARIANT',
      path,
      'session-only provenance needs portable evidence or explicit human verification',
    )
  }
}

function validateManifest(manifest: KnowledgeManifest, path: string): void {
  assertUnique(manifest.sources.map(source => source.id), 'manifest sources', path)
  const roots = manifest.sources.map(source => source.relativeRoot)
  assertUnique(roots, 'manifest source roots', path)
}

function validateMemory(memory: MemoryEntry, manifest: KnowledgeManifest, path: string): void {
  assertScope(memory.scope, manifest, path)
  assertProvenance(memory.provenance, manifest, memory.evidenceClass, path)
  if (memory.supersedes.includes(memory.id)) {
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'memory cannot supersede itself')
  }
  if (memory.conflictsWith.includes(memory.id)) {
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'memory cannot conflict with itself')
  }
}

function validateCard(card: KnowledgeCard, manifest: KnowledgeManifest, path: string): void {
  assertScope(card.scope, manifest, path)
  assertProvenance(card.provenance, manifest, card.evidenceClass, path)
  assertUnique(card.sections.map(section => section.id), 'card sections', path)
  assertUnique(card.sourceRevisions.map(revision => revision.sourceId), 'card source revisions', path)
  for (const section of card.sections) {
    assertProvenance(section.provenance, manifest, card.evidenceClass, path)
  }
  for (const revision of card.sourceRevisions) {
    if (!manifest.sources.some(source => source.id === revision.sourceId)) {
      throw new CanonicalStoreError(
        'KNOWLEDGE_INVARIANT',
        path,
        `card source revision references unknown source ${JSON.stringify(revision.sourceId)}`,
      )
    }
  }
}

/** Read, validate, and detach the complete canonical store below a project root. */
export async function readCanonicalStore(projectRoot: string): Promise<CanonicalStore> {
  const resolvedProjectRoot = resolve(projectRoot)
  const knowledgeRoot = resolveKnowledgeRoot(resolvedProjectRoot)
  await assertOrdinaryDirectory(join(resolvedProjectRoot, '.dsh'))
  await assertOrdinaryDirectory(knowledgeRoot)
  const manifestPath = join(knowledgeRoot, 'manifest.json')
  const manifest = await readManifest(manifestPath)
  validateManifest(manifest, manifestPath)

  const memoryPaths = await listJsonFiles(join(knowledgeRoot, 'entries'))
  const cardPaths = await listJsonFiles(join(knowledgeRoot, 'cards'))
  const memories = await Promise.all(memoryPaths.map(readMemory))
  const cards = await Promise.all(cardPaths.map(readCard))

  assertUnique(memories.map(memory => memory.id), 'memory ids', dirname(memoryPaths[0] ?? join(knowledgeRoot, 'entries', '.')))
  assertUnique(cards.map(card => card.id), 'card ids', dirname(cardPaths[0] ?? join(knowledgeRoot, 'cards', '.')))

  for (let index = 0; index < memories.length; index += 1) {
    validateMemory(memories[index]!, manifest, memoryPaths[index]!)
  }
  for (let index = 0; index < cards.length; index += 1) {
    validateCard(cards[index]!, manifest, cardPaths[index]!)
  }

  return {
    projectRoot: resolvedProjectRoot,
    knowledgeRoot,
    manifest: structuredClone(manifest),
    memories: memories.map(memory => structuredClone(memory)),
    cards: cards.map(card => structuredClone(card)),
  }
}

/** Create one validated canonical memory file without overwriting another record. */
export async function writeCanonicalMemory(
  store: CanonicalStore,
  memory: MemoryEntry,
): Promise<CanonicalMemoryWrite> {
  const path = join(store.knowledgeRoot, 'entries', `${memory.id}.json`)
  try {
    assertMemoryEntry(memory)
  } catch (error: unknown) {
    return schemaFailure(path, error)
  }
  validateMemory(memory, store.manifest, path)
  const existing = store.memories.find(entry => entry.id === memory.id)
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(memory)) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'canonical memory id already exists with different content')
    }
    return { path, created: false }
  }
  try {
    await assertOrdinaryFile(path)
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'canonical memory path already exists outside the loaded store')
  } catch (error: unknown) {
    if (!(error instanceof CanonicalStoreError && error.code === 'KNOWLEDGE_NOT_FOUND')) throw error
  }
  await writeFileAtomic(path, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o644, dirMode: 0o755 })
  return { path, created: true }
}

/** Create one validated Knowledge Card without overwriting another record. */
export async function writeCanonicalCard(
  store: CanonicalStore,
  card: KnowledgeCard,
): Promise<CanonicalCardWrite> {
  const path = join(store.knowledgeRoot, 'cards', `${card.id}.json`)
  try {
    assertKnowledgeCard(card)
  } catch (error: unknown) {
    return schemaFailure(path, error)
  }
  validateCard(card, store.manifest, path)
  const existing = store.cards.find(candidate => candidate.id === card.id)
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(card)) {
      throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'canonical Knowledge Card id already exists with different content')
    }
    return { path, revision: existing.revision, created: false }
  }
  try {
    await assertOrdinaryFile(path)
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'canonical Knowledge Card path already exists outside the loaded store')
  } catch (error: unknown) {
    if (!(error instanceof CanonicalStoreError && error.code === 'KNOWLEDGE_NOT_FOUND')) throw error
  }
  await writeFileAtomic(path, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o644, dirMode: 0o755 })
  return { path, revision: card.revision, created: true }
}

/** Replace one existing Knowledge Card with exactly its next validated revision. */
export async function writeCanonicalCardRevision(
  store: CanonicalStore,
  card: KnowledgeCard,
): Promise<CanonicalCardWrite> {
  const path = join(store.knowledgeRoot, 'cards', `${card.id}.json`)
  try {
    assertKnowledgeCard(card)
  } catch (error: unknown) {
    return schemaFailure(path, error)
  }
  validateCard(card, store.manifest, path)
  const existing = store.cards.find(candidate => candidate.id === card.id)
  if (existing === undefined) {
    throw new CanonicalStoreError('KNOWLEDGE_INVARIANT', path, 'canonical Knowledge Card does not exist')
  }
  if (card.revision !== existing.revision + 1) {
    throw new CanonicalStoreError(
      'KNOWLEDGE_INVARIANT',
      path,
      `canonical Knowledge Card revision must advance from ${existing.revision} to ${existing.revision + 1}`,
    )
  }
  await assertOrdinaryFile(path)
  await writeFileAtomic(path, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o644, dirMode: 0o755 })
  return { path, revision: card.revision }
}
