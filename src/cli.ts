import { resolve } from 'node:path'
import { readCanonicalStore } from './canonical.js'
import { defaultMemoryDatabasePath, MemoryKnowledgeEngine } from './engine.js'
import { MemoryCandidateId, MEMORY_CANDIDATE_ID_PATTERN, WikiRunId, WIKI_RUN_ID_PATTERN, WikiTaskId, WIKI_TASK_ID_PATTERN } from './ids.js'
import { initializeCanonicalStore } from './initialize.js'
import { NodeSourceInventoryBackend } from './inventory.js'
import { DEFAULT_SOURCE_INVENTORY_CONFIG, KnowledgeProjectInspector } from './inventory-provider.js'
import { buildProjection, checkProjection, writeProjection } from './projection.js'
import type { MemoryCandidateStatus } from './runtime-model.js'

/** Minimal output interface used by the CLI and its tests. */
export interface CliIo {
  out(message: string): void
  error(message: string): void
}

const processIo: CliIo = {
  out: message => { process.stdout.write(`${message}\n`) },
  error: message => { process.stderr.write(`${message}\n`) },
}

interface ParsedArguments {
  positional: string[]
  flags: Set<string>
  values: Map<string, string>
}

const RUNTIME_COMMANDS = ['generate', 'wiki-plan', 'wiki-budget', 'candidates', 'accept', 'reject', 'promote', 'search', 'trace'] as const
type RuntimeCommand = typeof RUNTIME_COMMANDS[number]

const BOOLEAN_FLAGS = new Set(['write', 'include-restricted'])
const VALUE_FLAGS = new Set(['db', 'status', 'limit', 'max-chars'])

function usage(): string {
  return [
    '用法：dsh-memory-knowledge <command> [arguments] [options]',
    '',
    'Canonical：',
    '  init [project-root]                   初始化空 canonical store 与投影',
    '  validate [project-root]               校验 canonical 数据与跨文件不变量',
    '  check [project-root]                  校验 schema/Markdown 投影 freshness',
    '  project [project-root] [--write]      列出或写入确定性投影',
    '  inventory [project-root]              检查 Git source 文件边界与内容指纹',
    '  stale [project-root] [--write]        检测或显式标记陈旧 Knowledge Card',
    '',
    '本地候选与检索：',
    '  generate [project-root] [--db <path>]  构建 Source records 并生成确定性 Card 候选',
    '  wiki-plan [project-root] [--db <path>] 从 Git 元数据创建 LLM Wiki 覆盖计划',
    '  wiki-budget <run-id> <task-id> [--limit <bytes>] [--db <path>] 查看或显式提高材料读取总额度',
    '  candidates [project-root] [--status <status>] [--limit <n>] [--db <path>]',
    '  accept <candidate-id> [--db <path>]',
    '  reject <candidate-id> [--db <path>]',
    '  promote <candidate-id> [project-root] [--db <path>]',
    '  search <query> [project-root] [--limit <n>] [--max-chars <n>] [--db <path>]',
    '  trace <id> [project-root] [--db <path>]',
  ].join('\n')
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positional: string[] = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      if (flags.has(name)) throw new Error(`重复选项：--${name}`)
      flags.add(name)
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知选项：${argument}`)
    if (values.has(name)) throw new Error(`重复选项：--${name}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`选项 --${name} 需要一个值。`)
    values.set(name, value)
    index += 1
  }
  return { positional, flags, values }
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} 必须是正安全整数。`)
  return parsed
}

function assertOnlyOptions(parsed: ParsedArguments, allowedFlags: readonly string[], allowedValues: readonly string[]): void {
  for (const flag of parsed.flags) if (!allowedFlags.includes(flag)) throw new Error(`当前命令不接受 --${flag}。`)
  for (const key of parsed.values.keys()) if (!allowedValues.includes(key)) throw new Error(`当前命令不接受 --${key}。`)
}

function candidateStatus(value: string | undefined): MemoryCandidateStatus | undefined {
  if (value === undefined) return undefined
  if (value === 'pending' || value === 'accepted' || value === 'rejected' || value === 'promoted') return value
  throw new Error(`未知候选状态：${value}`)
}

function candidateId(value: string): MemoryCandidateId {
  if (!new RegExp(MEMORY_CANDIDATE_ID_PATTERN, 'u').test(value)) throw new Error(`无效 candidate id：${value}`)
  return MemoryCandidateId(value)
}

async function runCanonicalCommand(
  command: 'init' | 'validate' | 'check' | 'project' | 'inventory' | 'stale',
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number> {
  assertOnlyOptions(parsed, command === 'project' || command === 'stale' ? ['write'] : [], [])
  if (parsed.positional.length > 1) throw new Error('只允许指定一个 project-root。')
  const projectRoot = resolve(parsed.positional[0] ?? process.cwd())
  if (command === 'init') {
    const result = await initializeCanonicalStore(projectRoot)
    io.out(`${result.created ? '已初始化' : '已存在'}：${result.store.knowledgeRoot}`)
    return 0
  }
  const inspector = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
  if (command === 'inventory') {
    const status = await inspector.inspect(projectRoot)
    io.out(JSON.stringify(status.sources, null, 2))
    return status.sources.every(source => source.state === 'ready') ? 0 : 1
  }
  if (command === 'stale') {
    if (parsed.flags.has('write')) {
      io.out(JSON.stringify(await inspector.markStale(projectRoot), null, 2))
      return 0
    }
    const status = await inspector.inspect(projectRoot)
    io.out(JSON.stringify({
      staleCardCount: status.staleCardCount,
      degradedCardCount: status.degradedCardCount,
      cards: status.cards,
    }, null, 2))
    return status.staleCardCount === 0 && status.degradedCardCount === 0 ? 0 : 1
  }
  const store = await readCanonicalStore(projectRoot)
  switch (command) {
    case 'validate':
      io.out(`有效：${store.memories.length} 条记忆，${store.cards.length} 张 Knowledge Card。`)
      return 0
    case 'check': {
      const issues = await checkProjection(store)
      if (issues.length === 0) {
        io.out('canonical 数据与投影一致。')
        return 0
      }
      for (const issue of issues) io.error(`${issue.kind}: ${issue.path}`)
      return 1
    }
    case 'project': {
      const projection = buildProjection(store)
      if (parsed.flags.has('write')) {
        await writeProjection(store)
        const issues = await checkProjection(store)
        if (issues.length > 0) {
          for (const issue of issues) io.error(`${issue.kind}: ${issue.path}`)
          return 1
        }
        io.out(`已写入 ${projection.size} 个投影文件。`)
        return 0
      }
      for (const path of projection.keys()) io.out(path)
      return 0
    }
    default:
      return assertNever(command)
  }
}

async function runRuntimeCommand(command: RuntimeCommand, parsed: ParsedArguments, io: CliIo): Promise<number> {
  assertOnlyOptions(parsed, command === 'search' ? ['include-restricted'] : [], ['db', 'status', 'limit', 'max-chars'])
  const knowledgeProject = new KnowledgeProjectInspector(new NodeSourceInventoryBackend(), DEFAULT_SOURCE_INVENTORY_CONFIG)
  const engine = await MemoryKnowledgeEngine.open(
    {
      path: parsed.values.get('db') ?? defaultMemoryDatabasePath(),
      journalMode: 'wal',
    },
    knowledgeProject,
  )
  try {
    switch (command) {
      case 'wiki-budget': {
        assertOnlyOptions(parsed, [], ['db', 'limit'])
        const [runId, taskId] = parsed.positional
        if (parsed.positional.length !== 2 || !new RegExp(WIKI_RUN_ID_PATTERN).test(runId!) || !new RegExp(WIKI_TASK_ID_PATTERN).test(taskId!)) {
          throw new Error('wiki-budget 需要有效的 run-id 和 task-id。')
        }
        const key = { runId: WikiRunId(runId!), taskId: WikiTaskId(taskId!) }
        const budget = parsed.values.has('limit')
          ? await engine.increaseWikiMaterialReadBudget(key, positiveInteger(parsed.values.get('limit'), 0, '--limit'))
          : await engine.getWikiMaterialReadBudget(key)
        if (budget === undefined) throw new Error('Wiki 任务尚无材料读取账本；历史读取量未知。')
        io.out(JSON.stringify(budget, null, 2))
        return 0
      }
      case 'generate': {
        if (parsed.positional.length > 1) throw new Error('generate 最多接受一个 project-root。')
        if (parsed.values.has('status') || parsed.values.has('limit') || parsed.values.has('max-chars')) {
          throw new Error('generate 只接受 --db。')
        }
        const result = await engine.generateKnowledgeCardCandidates(resolve(parsed.positional[0] ?? process.cwd()))
        io.out(JSON.stringify({
          candidateCount: result.candidates.length,
          understandings: result.understandings,
          candidates: result.candidates.map(candidate => ({
            id: candidate.id,
            revision: candidate.revision,
            status: candidate.status,
            title: candidate.title,
            generation: candidate.generation,
          })),
          skipped: result.skipped,
        }, null, 2))
        return result.skipped.some(item => item.kind === 'source-limit' || item.kind === 'source-degraded'
          || item.kind === 'source-dirty' || item.kind === 'missing-revision' || item.kind === 'missing-understanding'
          || item.kind === 'ambiguous-overview' || item.kind === 'ambiguous-architecture'
          || item.kind === 'ambiguous-module' || item.kind === 'wiki-run-incomplete'
          || item.kind === 'wiki-page-not-verified' || item.kind === 'wiki-page-unsupported-evidence'
          || item.kind === 'wiki-source-changed') ? 1 : 0
      }
      case 'wiki-plan': {
        if (parsed.positional.length > 1) throw new Error('wiki-plan 最多接受一个 project-root。')
        if (parsed.values.has('status') || parsed.values.has('limit') || parsed.values.has('max-chars')) {
          throw new Error('wiki-plan 只接受 --db。')
        }
        const result = await engine.planWikiProject(resolve(parsed.positional[0] ?? process.cwd()))
        io.out(JSON.stringify({
          runId: result.run.run.id,
          nextTaskId: (result.run.tasks.find(task => task.status === 'running')
            ?? result.run.tasks.find(task => ['planned', 'failed', 'cancelled'].includes(task.status)))?.id ?? null,
          status: result.run.run.status,
          catalogHash: result.catalog.catalogHash,
          catalogState: result.catalog.state,
          omittedItemCount: result.catalog.omittedItemCount,
          entryCount: result.catalog.entryCount,
          totalBytes: result.catalog.totalBytes,
          excludedEntryCount: result.catalog.excludedEntryCount,
          blockedEntryCount: result.catalog.blockedEntryCount,
          coverage: result.run.run.coverage,
          sources: result.catalog.sources,
          issues: result.catalog.issues,
          blockingReasons: result.run.run.blockingReasons,
        }, null, 2))
        return result.run.run.status === 'planned' ? 0 : 1
      }
      case 'candidates': {
        if (parsed.positional.length > 1) throw new Error('candidates 最多接受一个 project-root。')
        if (parsed.values.has('max-chars')) throw new Error('candidates 不接受 --max-chars。')
        const status = candidateStatus(parsed.values.get('status'))
        const records = await engine.listCandidates({
          ...parsed.positional[0] === undefined ? {} : { projectRoot: resolve(parsed.positional[0]) },
          ...status === undefined ? {} : { status },
          limit: positiveInteger(parsed.values.get('limit'), 50, '--limit'),
        })
        io.out(JSON.stringify(records, null, 2))
        return 0
      }
      case 'accept':
      case 'reject': {
        if (parsed.positional.length !== 1) throw new Error(`${command} 需要一个 candidate-id。`)
        if (parsed.values.has('status') || parsed.values.has('limit') || parsed.values.has('max-chars')) {
          throw new Error(`${command} 只接受 --db。`)
        }
        const record = await engine.reviewCandidate(candidateId(parsed.positional[0]!), command)
        io.out(JSON.stringify(record, null, 2))
        return 0
      }
      case 'promote': {
        if (parsed.positional.length < 1 || parsed.positional.length > 2) {
          throw new Error('promote 需要 candidate-id，可选 project-root。')
        }
        if (parsed.values.has('status') || parsed.values.has('limit') || parsed.values.has('max-chars')) {
          throw new Error('promote 只接受 --db。')
        }
        const result = await engine.promoteCandidate(
          candidateId(parsed.positional[0]!),
          parsed.positional[1] === undefined ? undefined : resolve(parsed.positional[1]),
        )
        io.out(JSON.stringify(result, null, 2))
        return 0
      }
      case 'search': {
        if (parsed.positional.length < 1 || parsed.positional.length > 2) {
          throw new Error('search 需要 query，可选 project-root。')
        }
        if (parsed.values.has('status')) throw new Error('search 不接受 --status。')
        const hits = await engine.search({
          query: parsed.positional[0]!,
          projectRoot: resolve(parsed.positional[1] ?? process.cwd()),
          limit: positiveInteger(parsed.values.get('limit'), 8, '--limit'),
          maxChars: positiveInteger(parsed.values.get('max-chars'), 12_000, '--max-chars'),
          includeRestricted: parsed.flags.has('include-restricted'),
        })
        io.out(JSON.stringify(hits, null, 2))
        return 0
      }
      case 'trace': {
        if (parsed.positional.length < 1 || parsed.positional.length > 2) {
          throw new Error('trace 需要 id，可选 project-root。')
        }
        if (parsed.values.has('status') || parsed.values.has('limit') || parsed.values.has('max-chars')) {
          throw new Error('trace 只接受 --db。')
        }
        const trace = await engine.trace(parsed.positional[0]!, resolve(parsed.positional[1] ?? process.cwd()))
        if (trace === undefined) {
          io.error(`未找到记忆：${parsed.positional[0]}`)
          return 1
        }
        io.out(JSON.stringify(trace, null, 2))
        return 0
      }
      default:
        return assertNever(command)
    }
  } finally {
    await engine.close()
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled command: ${value}`)
}

/** Run one CLI request and return its process exit code. */
export async function runCli(args: readonly string[], io: CliIo = processIo): Promise<number> {
  const [command, ...rest] = args
  if (command === undefined || command === '--help' || command === '-h') {
    io.out(usage())
    return command === undefined ? 2 : 0
  }
  try {
    const parsed = parseArguments(rest)
    if (command === 'init' || command === 'validate' || command === 'check' || command === 'project'
      || command === 'inventory' || command === 'stale') {
      return await runCanonicalCommand(command, parsed, io)
    }
    if ((RUNTIME_COMMANDS as readonly string[]).includes(command)) {
      return await runRuntimeCommand(command as RuntimeCommand, parsed, io)
    }
    io.error(`未知命令：${command}`)
    io.out(usage())
    return 2
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
