import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Default project-root markers, in precedence order at each ancestor. */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.dsh/knowledge/manifest.json', '.git'] as const

async function markerExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isFile() || stats.isDirectory()
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Resolve the nearest marked project root from one session working directory. */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[] = DEFAULT_PROJECT_ROOT_MARKERS,
): Promise<string> {
  let current = await realpath(resolve(cwd))
  const stats = await lstat(current)
  if (!stats.isDirectory()) throw new Error(`memory-knowledge: session cwd is not a directory: ${current}`)
  for (;;) {
    for (const marker of markers) {
      if (await markerExists(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return await realpath(resolve(cwd))
    current = parent
  }
}
