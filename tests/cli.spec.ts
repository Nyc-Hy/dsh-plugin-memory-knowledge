import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli.js'
import { MemoryKnowledgeEngine } from '../src/engine.js'
import { initializeGitProject, makeTempDirectory, makeTempProject, readJson } from './helpers.js'

function capture(): { io: CliIo; out: string[]; errors: string[] } {
  const out: string[] = []
  const errors: string[] = []
  return {
    out,
    errors,
    io: {
      out: message => { out.push(message) },
      error: message => { errors.push(message) },
    },
  }
}

describe('memory knowledge CLI', () => {
  it('initializes a new canonical project idempotently', async () => {
    const project = await makeTempDirectory()
    const first = capture()
    expect(await runCli(['init', project], first.io)).toBe(0)
    expect(first.out[0]).toContain('已初始化')
    const manifest = join(project, '.dsh', 'knowledge', 'manifest.json')
    await access(manifest)

    const second = capture()
    expect(await runCli(['init', project], second.io)).toBe(0)
    expect(second.out[0]).toContain('已存在')

    const fresh = capture()
    expect(await runCli(['check', project], fresh.io)).toBe(0)
  })

  it('validates, writes, and checks one canonical project', async () => {
    const project = await makeTempProject()
    const validation = capture()
    expect(await runCli(['validate', project], validation.io)).toBe(0)
    expect(validation.out[0]).toContain('1 条记忆')

    const missing = capture()
    expect(await runCli(['check', project], missing.io)).toBe(1)
    expect(missing.errors).toContain('missing: wiki/index.md')

    const write = capture()
    expect(await runCli(['project', project, '--write'], write.io)).toBe(0)

    const fresh = capture()
    expect(await runCli(['check', project], fresh.io)).toBe(0)
    expect(fresh.out).toEqual(['canonical 数据与投影一致。'])
  })

  it('reports source inventory and explicitly persists stale Knowledge Cards', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const inventory = capture()
    expect(await runCli(['inventory', project], inventory.io)).toBe(0)
    expect(inventory.out.join('\n')).toContain('"path": "src/example.ts"')
    expect(inventory.out.join('\n')).not.toContain(project)

    const preview = capture()
    expect(await runCli(['stale', project], preview.io)).toBe(1)
    expect(preview.out.join('\n')).toContain('"staleCardCount": 1')

    const write = capture()
    expect(await runCli(['stale', project, '--write'], write.io)).toBe(0)
    const card = await readJson(join(
      project,
      '.dsh',
      'knowledge',
      'cards',
      'card_44444444-4444-4444-8444-444444444444.json',
    ))
    expect(card).toMatchObject({ status: 'stale', revision: 2 })
  })

  it('builds Source records and three idempotent Knowledge Card candidates from a clean inventory', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const databaseRoot = await makeTempDirectory()
    const database = join(databaseRoot, 'memory.sqlite')

    const first = capture()
    expect(await runCli(['generate', project, '--db', database], first.io)).toBe(0)
    const firstResult = JSON.parse(first.out[0]!) as {
      candidateCount: number
      understandings: Array<{ recordCount: number; areaCount: number }>
      candidates: Array<{ id: string; generation: { generator: string } }>
    }
    expect(firstResult.candidateCount).toBe(3)
    expect(firstResult.understandings).toMatchObject([{ recordCount: 1, areaCount: 1 }])
    expect(firstResult.candidates.map(candidate => candidate.generation.generator))
      .toEqual(['source-inventory', 'source-record-map', 'source-evidence-map'])
    expect(first.out[0]).not.toContain(project)

    const repeated = capture()
    expect(await runCli(['generate', project, '--db', database], repeated.io)).toBe(0)
    const repeatedResult = JSON.parse(repeated.out[0]!) as { candidates: Array<{ id: string }> }
    expect(repeatedResult.candidates.map(candidate => candidate.id))
      .toEqual(firstResult.candidates.map(candidate => candidate.id))
  })

  it('plans a language-neutral Wiki catalog without printing local paths or file contents', async () => {
    const project = await makeTempProject()
    await initializeGitProject(project)
    const database = join(await makeTempDirectory(), 'wiki.sqlite')
    const output = capture()

    expect(await runCli(['wiki-plan', project, '--db', database], output.io)).toBe(0)
    expect(JSON.parse(output.out[0]!)).toMatchObject({ nextTaskId: expect.stringMatching(/^wtask_[0-9a-f]{64}$/) })
    const result = JSON.parse(output.out[0]!) as {
      runId: string
      status: string
      catalogState: string
      entryCount: number
      coverage: { itemCount: number }
    }
    expect(result).toMatchObject({
      runId: expect.stringMatching(/^wrun_/u),
      status: 'planned',
      catalogState: 'complete',
      entryCount: result.coverage.itemCount,
    })
    expect(output.out[0]).not.toContain(project)
    expect(output.out[0]).not.toContain('export function fixture')
  })

  it('reviews and searches a local candidate through a persistent database', async () => {
    const project = await makeTempProject()
    const database = join(project, 'memory.sqlite')
    const engine = await MemoryKnowledgeEngine.open({ path: database, journalMode: 'wal' })
    const candidate = await engine.saveCandidate({
      target: 'memory',
      applicability: 'project',
      projectRoot: project,
      kind: 'lesson',
      title: '候选检索唯一词',
      content: '这条内容用于验证 CLI 的人工审核和本地检索闭环。',
      tags: ['cli'],
      sensitivity: 'normal',
      suggestedBy: 'model',
      provenance: [{ kind: 'session', sessionId: 'session-cli-test' as never, eventSeqs: [2] }],
    })
    await engine.close()

    const accepted = capture()
    expect(await runCli(['accept', candidate.id, '--db', database], accepted.io)).toBe(0)
    expect(accepted.out.join('\n')).toContain('"status": "accepted"')
    const acceptedRecord = JSON.parse(accepted.out.join('\n')) as { localMemoryId: string }

    const searched = capture()
    expect(await runCli(['search', '候选检索唯一词', project, '--db', database], searched.io)).toBe(0)
    expect(searched.out.join('\n')).toContain(acceptedRecord.localMemoryId)

    const traced = capture()
    expect(await runCli(['trace', candidate.id, project, '--db', database], traced.io)).toBe(0)
    expect(traced.out.join('\n')).toContain('"recordType": "candidate"')
  })

  it('rejects an unknown command before creating its database', async () => {
    const project = await makeTempProject()
    const database = join(project, 'must-not-exist.sqlite')
    const result = capture()
    expect(await runCli(['unknown', '--db', database], result.io)).toBe(2)
    expect(result.errors).toEqual(['未知命令：unknown'])
    await expect(access(database)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
