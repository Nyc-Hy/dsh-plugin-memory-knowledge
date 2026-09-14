import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach } from 'vitest'

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repository')
const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Copy the canonical fixture into a fresh temporary project. */
export async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-knowledge-'))
  temporaryRoots.push(root)
  await cp(fixtureRoot, root, { recursive: true })
  return root
}

/** Create a fresh empty temporary directory tracked for test cleanup. */
export async function makeTempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-knowledge-empty-'))
  temporaryRoots.push(root)
  return root
}

/** Read one fixture JSON document. */
export async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** Write one fixture JSON document with canonical indentation. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Initialize and commit one temporary Git project with deterministic test identity. */
export async function initializeGitProject(root: string): Promise<string> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: root })
  await execFileAsync('git', ['config', 'user.name', 'DSH Memory Test'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'memory-test@example.invalid'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return stdout.trim()
}

/** Commit all current fixture changes and return the new revision. */
export async function commitProjectChanges(root: string, message: string): Promise<string> {
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '--quiet', '-m', message], { cwd: root })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return stdout.trim()
}

/** Return the canonical SHA-256 label used by file provenance. */
export async function fileContentHash(path: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
}
