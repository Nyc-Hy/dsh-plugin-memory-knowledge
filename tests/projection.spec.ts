import { execFile as execFileCallback } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCanonicalStore } from '../src/canonical.js'
import { checkProjection, writeProjection } from '../src/projection.js'
import { makeTempProject, readJson, writeJson } from './helpers.js'

const execFile = promisify(execFileCallback)
const memoryId = 'mem_33333333-3333-4333-8333-333333333333'

describe('deterministic projection', () => {
  it('writes schema and Markdown projections and detects drift', async () => {
    const project = await makeTempProject()
    const store = await readCanonicalStore(project)
    expect(await checkProjection(store)).toContainEqual({ kind: 'missing', path: 'wiki/index.md' })
    await writeProjection(store)
    expect(await checkProjection(store)).toEqual([])

    await appendFile(join(store.knowledgeRoot, 'wiki', 'index.md'), 'manual edit\n')
    expect(await checkProjection(store)).toContainEqual({ kind: 'changed', path: 'wiki/index.md' })

    const manualPath = join(store.knowledgeRoot, 'wiki', 'manual.md')
    await writeFile(manualPath, '# manual\n', 'utf8')
    expect(await checkProjection(store)).toContainEqual({ kind: 'unexpected', path: 'wiki/manual.md' })
  })

  it('keeps a canonical edit and its readable projection in one Git diff', async () => {
    const project = await makeTempProject()
    await writeProjection(await readCanonicalStore(project))
    await execFile('git', ['init'], { cwd: project })
    await execFile('git', ['add', '.'], { cwd: project })
    await execFile('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: project })

    const entryPath = join(project, '.dsh', 'knowledge', 'entries', `${memoryId}.json`)
    const entry = await readJson(entryPath)
    entry.revision = 2
    entry.content = '更新后的已验证内容。'
    entry.updatedAt = '2026-08-24T01:00:00.000Z'
    await writeJson(entryPath, entry)
    await writeProjection(await readCanonicalStore(project))

    const { stdout } = await execFile('git', ['diff', '--name-only'], { cwd: project })
    expect(stdout.trim().split('\n').sort()).toEqual([
      `.dsh/knowledge/entries/${memoryId}.json`,
      `.dsh/knowledge/wiki/memory/${memoryId}.md`,
    ])
  })

  it('does not delete unexpected files while writing expected projections', async () => {
    const project = await makeTempProject()
    const manualDirectory = join(project, '.dsh', 'knowledge', 'wiki')
    await mkdir(manualDirectory, { recursive: true })
    await writeFile(join(manualDirectory, 'manual.md'), '# manual\n', 'utf8')
    const store = await readCanonicalStore(project)
    await writeProjection(store)
    expect(await checkProjection(store)).toContainEqual({ kind: 'unexpected', path: 'wiki/manual.md' })
  })
})
