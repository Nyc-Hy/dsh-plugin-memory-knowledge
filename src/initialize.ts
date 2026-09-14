import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readCanonicalStore, resolveKnowledgeRoot, type CanonicalStore } from './canonical.js'
import { createKnowledgeSourceId, createKnowledgeSpaceId } from './ids.js'
import {
  KNOWLEDGE_SCHEMA_VERSION,
  PROJECTION_GENERATOR,
  PROJECTION_VERSION,
  type KnowledgeManifest,
} from './model.js'
import { writeProjection } from './projection.js'

/** Result of safely creating or reopening one canonical knowledge root. */
export interface InitializeCanonicalStoreResult {
  created: boolean
  store: CanonicalStore
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function ensureOrdinaryDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode })
  const stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`memory-knowledge: initialization path must be an ordinary directory: ${path}`)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function assertRecoverableEmptyRoot(knowledgeRoot: string): Promise<void> {
  const allowedDirectories = new Set(['entries', 'cards'])
  for (const entry of await readdir(knowledgeRoot, { withFileTypes: true })) {
    if (entry.name === 'manifest.json.lock') continue
    if (!allowedDirectories.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`memory-knowledge: refusing to initialize non-empty knowledge root: ${join(knowledgeRoot, entry.name)}`)
    }
  }
}

/** Create an empty, Git-shareable canonical store without overwriting existing data. */
export async function initializeCanonicalStore(projectRoot: string): Promise<InitializeCanonicalStoreResult> {
  const root = await realpath(resolve(projectRoot))
  await ensureOrdinaryDirectory(join(root, '.dsh'), 0o755)
  const knowledgeRoot = resolveKnowledgeRoot(root)
  await ensureOrdinaryDirectory(knowledgeRoot, 0o755)
  const manifestPath = join(knowledgeRoot, 'manifest.json')
  return withFileLock(manifestPath, async () => {
    if (await fileExists(manifestPath)) {
      const store = await readCanonicalStore(root)
      await writeProjection(store)
      return { created: false, store }
    }
    await assertRecoverableEmptyRoot(knowledgeRoot)
    await ensureOrdinaryDirectory(join(knowledgeRoot, 'entries'), 0o755)
    await ensureOrdinaryDirectory(join(knowledgeRoot, 'cards'), 0o755)
    const manifest: KnowledgeManifest = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      spaceId: createKnowledgeSpaceId(),
      sources: [{ id: createKnowledgeSourceId(), kind: 'git', relativeRoot: '.' }],
      projection: { generator: PROJECTION_GENERATOR, version: PROJECTION_VERSION },
    }
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, dirMode: 0o755 })
    const store = await readCanonicalStore(root)
    await writeProjection(store)
    return { created: true, store }
  })
}
