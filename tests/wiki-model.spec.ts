import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createWikiCitationId,
  createWikiClaimId,
  createWikiConflictId,
  KnowledgeSourceId,
} from '../src/ids.js'
import {
  assessWikiCompletion,
  createPlannedWikiRun,
  createUnassessedWikiFileSynthesisSummary,
  createWikiConsistencyTasks,
  createWikiFileSynthesisTasks,
  createWikiVerificationTasks,
  finalizeWikiRunSnapshot,
  MAX_WIKI_CLAIM_STATEMENT_CHARACTERS,
  parseWikiRunSnapshot,
  summarizeWikiCrossModuleFlows,
  summarizeWikiCoverage,
  WIKI_BUSINESS_QUESTION_DEFINITIONS,
  type WikiBusinessQuestionFinding,
  type WikiCatalogEntry,
  type WikiRunSnapshot,
} from '../src/wiki-model.js'
import {
  failWikiTask,
  startWikiTask,
  succeedWikiFileSynthesisTask,
  succeedWikiCrossModuleFlowTask,
  succeedWikiPageTask,
  succeedWikiTask,
  succeedWikiVerificationTask,
} from '../src/wiki-task.js'
import { testBusinessQuestionFindings } from './wiki-business-question-fixture.js'

const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
const contentHash = `sha256:${'1'.repeat(64)}`
const preparedContentHash = `sha256:${'3'.repeat(64)}`
const catalogHash = `sha256:${'2'.repeat(64)}`
const timestamp = '2026-08-27T00:00:00.000Z'

function catalogEntry(path: string, language?: string): WikiCatalogEntry {
  return {
    sourceId,
    path,
    byteSize: 42,
    revision: { kind: 'content-hash', contentHash },
    ...(language === undefined ? {} : { language }),
  }
}

function notApplicableBusinessQuestions(): WikiBusinessQuestionFinding[] {
  return WIKI_BUSINESS_QUESTION_DEFINITIONS.map(definition => ({
    key: definition.key,
    outcome: 'not-applicable',
    claimIds: [],
    reason: '本分片未包含该问题的可引用证据。',
  }))
}

function rangedCatalogEntry(): WikiCatalogEntry {
  return {
    sourceId,
    path: 'archive/huge.polyglot',
    byteSize: 100,
    revision: { kind: 'git-object', commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
    preparedMaterial: {
      contentHash: preparedContentHash,
      ranges: [{
        ordinal: 0,
        startByte: 0,
        endByte: 50,
        startLine: 1,
        endLine: 5,
        contentStartByte: 0,
        contentEndByte: 60,
        contentStartLine: 1,
        contentEndLine: 6,
        contentHash: `sha256:${'4'.repeat(64)}`,
      }, {
        ordinal: 1,
        startByte: 50,
        endByte: 100,
        startLine: 5,
        endLine: 10,
        contentStartByte: 40,
        contentEndByte: 100,
        contentStartLine: 4,
        contentEndLine: 10,
        contentHash: `sha256:${'5'.repeat(64)}`,
      }],
    },
  }
}

function withoutSnapshotHash(snapshot: WikiRunSnapshot): Omit<WikiRunSnapshot, 'snapshotHash'> {
  return {
    schemaVersion: snapshot.schemaVersion,
    run: structuredClone(snapshot.run),
    coverage: structuredClone(snapshot.coverage),
    tasks: structuredClone(snapshot.tasks),
    citations: structuredClone(snapshot.citations),
    claims: structuredClone(snapshot.claims),
    conflicts: structuredClone(snapshot.conflicts),
    pages: structuredClone(snapshot.pages),
  }
}

function withAnalyzedCoverage(snapshot: WikiRunSnapshot): Omit<WikiRunSnapshot, 'snapshotHash'> {
  const value = withoutSnapshotHash(snapshot)
  value.coverage = value.coverage.map(item => ({
    ...item,
    status: 'analyzed',
    attemptCount: 1,
    analyzedContentHash: item.revision.kind === 'content-hash' ? item.revision.contentHash : contentHash,
    analyzedAt: timestamp,
  }))
  value.run.coverage = summarizeWikiCoverage(value.coverage)
  return value
}

function completePageTasks(snapshot: WikiRunSnapshot): WikiRunSnapshot {
  let current = snapshot
  const tasks = snapshot.tasks.filter(task => task.kind === 'page')
  for (const [index, task] of tasks.entries()) {
    current = succeedWikiPageTask(startWikiTask(
      current,
      task.id,
      SessionId(`session-page-${index}`),
      `2026-08-27T02:${index.toString().padStart(2, '0')}:00.000Z`,
    ), task.id, {
      pages: [{ slug: 'claims', title: `项目知识 ${index + 1}`, claimIds: task.claimIds, childSlugs: [] }],
    }, `2026-08-27T02:${index.toString().padStart(2, '0')}:30.000Z`)
  }
  return current
}

describe('LLM Wiki runtime model', () => {
  it('rejects disappearance of an already planned cross-module flow task set', () => {
    expect(() => summarizeWikiCrossModuleFlows([], {
      rulesVersion: 1,
      state: 'running',
      candidateClaimCount: 2,
      taskCount: 1,
      completedTaskCount: 0,
      flowCount: 0,
      stepCount: 0,
      unresolvedClaimCount: 0,
    })).toThrow('running Wiki cross-module flow tasks cannot disappear')
  })

  it('requires every analysis task to durably settle the complete business-question set', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/questions',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('src/questions.unknown')],
      now: timestamp,
    })
    const task = planned.tasks[0]!
    const started = startWikiTask(planned, task.id, SessionId('session-questions'), '2026-08-27T00:01:00.000Z')
    const completed = succeedWikiTask(started, task.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [],
      claims: [],
      businessQuestions: notApplicableBusinessQuestions(),
    }, '2026-08-27T00:02:00.000Z')

    expect(completed.tasks[0]!.businessQuestions).toMatchObject({
      rulesVersion: 1,
      state: 'completed',
      findings: expect.arrayContaining([expect.objectContaining({ key: 'primary-flows' })]),
    })
    expect(completed.run.businessQuestions).toEqual({
      rulesVersion: 1,
      state: 'complete',
      requiredQuestionCount: 9,
      analysisTaskCount: 1,
      completedTaskCount: 1,
      evidenceFindingCount: 0,
      unknownFindingCount: 0,
      notApplicableFindingCount: 9,
    })
    expect(assessWikiCompletion(completed.run).checks.find(check => check.id === 'business-questions'))
      .toEqual({ id: 'business-questions', state: 'pass', issueCount: 0 })

    expect(() => succeedWikiTask(started, task.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [],
      claims: [],
      businessQuestions: notApplicableBusinessQuestions().slice(1),
    }, '2026-08-27T00:02:00.000Z')).toThrow('every required business question')

    expect(() => succeedWikiTask(started, task.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [],
      claims: [],
    } as never, '2026-08-27T00:02:00.000Z')).toThrow('must submit business-question findings')
  })

  it('synthesizes primary-flow Claims into an evidence-bound cross-module flow before Pages', () => {
    let current = createPlannedWikiRun({
      projectRoot: '/workspace/cross-module-flow',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('api/entry.ts'), catalogEntry('domain/order.ts')],
      now: timestamp,
    }, [], { maxItems: 1, maxBytes: 100 })
    const claimIds = [createWikiClaimId(), createWikiClaimId()]
    for (const [index, plannedTask] of current.tasks.filter(task => task.kind === 'analysis').entries()) {
      const task = current.tasks.find(value => value.id === plannedTask.id)!
      const coverage = current.coverage.find(item => item.id === task.coverageIds[0])!
      const citationId = createWikiCitationId()
      current = succeedWikiTask(startWikiTask(
        current, task.id, SessionId(`session-flow-analysis-${index}`), `2026-08-27T00:0${index + 1}:00.000Z`,
      ), task.id, {
        coverage: [{ coverageId: coverage.id, status: 'analyzed', contentHash }],
        citations: [{
          id: citationId,
          runId: current.run.id,
          role: 'supports',
          provenance: { kind: 'document', sourceId, path: coverage.path, contentHash },
        }],
        claims: [{
          id: claimIds[index]!,
          runId: current.run.id,
          kind: 'assertion',
          status: 'proposed',
          statement: index === 0 ? 'HTTP 入口接收订单请求。' : '领域层保存订单状态。',
          citationIds: [citationId],
          coverageIds: [coverage.id],
          sourceClaimIds: [],
        }],
        businessQuestions: testBusinessQuestionFindings([claimIds[index]!], 'primary-flows'),
      }, `2026-08-27T00:0${index + 1}:30.000Z`)
    }
    const verification = current.tasks.find(task => task.kind === 'verification')!
    current = succeedWikiVerificationTask(startWikiTask(
      current, verification.id, SessionId('session-flow-verification'), '2026-08-27T00:04:00.000Z',
    ), verification.id, {
      decisions: claimIds.map(claimId => ({ claimId, status: 'verified' as const })),
      citations: [],
      conflicts: [],
    }, '2026-08-27T00:05:00.000Z')

    const flowTask = current.tasks.find(task => task.kind === 'flow')!
    expect(current.run.crossModuleFlows).toMatchObject({ state: 'running', candidateClaimCount: 2, taskCount: 1 })
    current = succeedWikiCrossModuleFlowTask(startWikiTask(
      current, flowTask.id, SessionId('session-flow-synthesis'), '2026-08-27T00:06:00.000Z',
    ), flowTask.id, {
      flows: [{
        title: '订单创建',
        steps: [
          { title: '接收请求', claimIds: [claimIds[0]!] },
          { title: '保存状态', claimIds: [claimIds[1]!] },
        ],
      }],
      unresolvedClaimIds: [],
    }, '2026-08-27T00:07:00.000Z')

    expect(current.run.crossModuleFlows).toEqual({
      rulesVersion: 1,
      state: 'complete',
      candidateClaimCount: 2,
      taskCount: 1,
      completedTaskCount: 1,
      flowCount: 1,
      stepCount: 2,
      unresolvedClaimCount: 0,
    })
    expect(current.tasks.some(task => task.kind === 'page' && task.status === 'planned')).toBe(true)
    expect(assessWikiCompletion(current.run).checks.find(check => check.id === 'cross-module-flows'))
      .toEqual({ id: 'cross-module-flows', state: 'pass', issueCount: 0 })
  })

  it('plans every catalog file without treating language as a support gate', () => {
    const entries = [
      catalogEntry('cmd/main.go', 'Go'),
      catalogEntry('src/lib.rs', 'Rust'),
      catalogEntry('Services/App.cs', 'C#'),
      catalogEntry('scripts/build.py', 'Python'),
      catalogEntry('db/schema.sql', 'SQL'),
      catalogEntry('domain/model.unknown'),
    ]
    const snapshot = createPlannedWikiRun({
      projectRoot: '/workspace/polyglot',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries,
      now: timestamp,
    })

    expect(snapshot.run).toMatchObject({
      status: 'planned',
      catalogComplete: true,
      coverage: { itemCount: entries.length, pending: entries.length, excluded: 0, blocked: 0 },
    })
    expect(snapshot.coverage.map(item => [item.path, item.language]).sort()).toEqual([
      ['Services/App.cs', 'C#'],
      ['cmd/main.go', 'Go'],
      ['db/schema.sql', 'SQL'],
      ['domain/model.unknown', undefined],
      ['scripts/build.py', 'Python'],
      ['src/lib.rs', 'Rust'],
    ])
    expect(snapshot.coverage.every(item => item.status === 'pending')).toBe(true)
    expect(snapshot.tasks).toHaveLength(6)
    expect(snapshot.tasks.every(task => task.status === 'planned' && task.attemptCount === 0)).toBe(true)
    expect(parseWikiRunSnapshot(snapshot)).toEqual(snapshot)
  })

  it('reuses only verified leaf Claims when a new Run sees the same evidence', () => {
    const entry: WikiCatalogEntry = {
      sourceId,
      path: 'src/reused.unknown',
      byteSize: 42,
      revision: { kind: 'git-object', commit: 'a'.repeat(40), objectId: 'b'.repeat(40) },
    }
    const input = {
      projectRoot: '/workspace/cross-run-reuse',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [entry],
      now: timestamp,
    } as const
    const planned = createPlannedWikiRun(input)
    const analysis = planned.tasks[0]!
    const claimId = createWikiClaimId()
    const citationId = createWikiCitationId()
    const analyzed = succeedWikiTask(startWikiTask(
      planned,
      analysis.id,
      SessionId('session-cross-run-analysis'),
      '2026-08-27T00:01:00.000Z',
    ), analysis.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: {
          kind: 'git-file',
          sourceId,
          commit: entry.revision.kind === 'git-object' ? entry.revision.commit : '',
          path: entry.path,
          contentHash,
          startLine: 1,
          endLine: 1,
        },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: '复用测试文件包含稳定的项目事实。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T00:02:00.000Z')
    const verification = analyzed.tasks.find(task => task.kind === 'verification')!
    const previous = succeedWikiVerificationTask(startWikiTask(
      analyzed,
      verification.id,
      SessionId('session-cross-run-verification'),
      '2026-08-27T00:03:00.000Z',
    ), verification.id, {
      decisions: [{ claimId, status: 'verified' }],
      citations: [],
      conflicts: [],
    }, '2026-08-27T00:04:00.000Z')

    const nextInput = {
      ...input,
      catalogHash: `sha256:${'4'.repeat(64)}`,
      entries: [{
        ...entry,
        revision: { ...entry.revision, commit: 'c'.repeat(40) },
      }],
    } as const
    const next = createPlannedWikiRun(nextInput, previous.coverage, undefined, previous)
    expect(next.run.status).toBe('verifying')
    expect(next.tasks).toHaveLength(1)
    expect(next.tasks[0]).toMatchObject({ kind: 'verification', claimIds: [claimId], status: 'planned' })
    expect(next.coverage[0]).toMatchObject({ status: 'analyzed', analyzedContentHash: contentHash })
    expect(next.claims).toEqual([expect.objectContaining({ id: claimId, runId: next.run.id, status: 'verified' })])
    expect(next.citations).toEqual([expect.objectContaining({
      id: citationId,
      runId: next.run.id,
      provenance: expect.objectContaining({ kind: 'git-file', commit: 'c'.repeat(40) }),
    })])
    expect(next.tasks.some(task => task.kind === 'analysis')).toBe(false)
    expect(parseWikiRunSnapshot(next)).toEqual(next)
  })

  it('creates deterministic natural shards without blocking multi-gigabyte materials', () => {
    const entries: WikiCatalogEntry[] = [
      { ...catalogEntry('src/c.rs', 'Rust'), byteSize: 40 },
      { ...catalogEntry('docs/archive.unknown'), byteSize: 5 * 1_024 * 1_024 * 1_024 },
      { ...catalogEntry('src/a.go', 'Go'), byteSize: 40 },
      { ...catalogEntry('src/b.cs', 'C#'), byteSize: 40 },
    ]
    const input = {
      projectRoot: '/workspace/large-polyglot',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries,
      now: timestamp,
    } as const
    const first = createPlannedWikiRun(input, [], { maxItems: 2, maxBytes: 100 })
    const reversed = createPlannedWikiRun({ ...input, entries: [...entries].reverse() }, [], {
      maxItems: 2,
      maxBytes: 100,
    })
    const shardMap = (snapshot: WikiRunSnapshot): Record<string, string> => Object.fromEntries(
      snapshot.coverage.map(item => [item.path, item.shardKey]).sort(([left], [right]) => left!.localeCompare(right!)),
    )

    expect(first.run).toMatchObject({ status: 'planned', coverage: { itemCount: 4, pending: 4 } })
    expect(first.run.coverage.totalBytes).toBeGreaterThan(5_000_000_000)
    expect(shardMap(first)).toEqual(shardMap(reversed))
    expect(first.tasks.map(task => [task.shardKey, task.coverageIds])).toEqual(
      reversed.tasks.map(task => [task.shardKey, task.coverageIds]),
    )
    expect(first.coverage.find(item => item.path === 'src/a.go')?.shardKey)
      .toBe(first.coverage.find(item => item.path === 'src/b.cs')?.shardKey)
    expect(first.coverage.find(item => item.path === 'src/c.rs')?.shardKey)
      .not.toBe(first.coverage.find(item => item.path === 'src/a.go')?.shardKey)
    expect(first.coverage.find(item => item.path === 'docs/archive.unknown')?.status).toBe('pending')
  })

  it('plans prepared large files as exact independently resumable ranges', () => {
    const entry = rangedCatalogEntry()
    const snapshot = createPlannedWikiRun({
      projectRoot: '/workspace/ranged-material',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [entry],
      now: timestamp,
    })

    expect(snapshot.coverage[0]).toMatchObject({
      path: entry.path,
      status: 'pending',
      preparedContentHash,
    })
    expect(snapshot.tasks.map(task => task.materialRanges[0]?.ordinal)).toEqual([0, 1])
    expect(snapshot.tasks.every(task => task.coverageIds[0] === snapshot.coverage[0]?.id)).toBe(true)
    expect(snapshot.run.materialRanges).toEqual({
      rangeCount: 2,
      totalBytes: 100,
      analyzedBytes: 0,
      planned: 2,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    })
    expect(parseWikiRunSnapshot(snapshot)).toEqual(snapshot)

    const invalid = rangedCatalogEntry()
    invalid.preparedMaterial!.ranges[1]!.startByte = 51
    expect(() => createPlannedWikiRun({
      projectRoot: '/workspace/ranged-gap',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [invalid],
      now: timestamp,
    })).toThrow('material ranges do not exactly partition Coverage bytes')
  })

  it('keeps file synthesis bounded and reports cross-batch semantic blind spots', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/bounded-file-synthesis',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [rangedCatalogEntry()],
      now: timestamp,
    })
    const coverage = planned.coverage[0]!
    const citations = planned.tasks.map(task => ({
      id: createWikiCitationId(),
      runId: planned.run.id,
      role: 'supports' as const,
      rangeId: task.materialRanges[0]!.id,
      provenance: {
        kind: 'git-file' as const,
        sourceId,
        commit: 'a'.repeat(40),
        path: coverage.path,
        contentHash: preparedContentHash,
      },
    }))
    const claims = Array.from({ length: 4 }, (_, index) => ({
      id: createWikiClaimId(),
      runId: planned.run.id,
      kind: 'assertion' as const,
      status: 'proposed' as const,
      statement: `文件区间声明 ${index}`,
      citationIds: [citations[index % 2]!.id],
      coverageIds: [coverage.id],
      sourceClaimIds: [],
    }))
    const analysisTasks = planned.tasks.map((task, index) => ({
      ...task,
      status: 'succeeded' as const,
      attemptCount: 1,
      agentSessionId: SessionId(`session-bounded-file-${index}`),
      startedAt: timestamp,
      completedAt: timestamp,
    }))
    const result = createWikiFileSynthesisTasks(
      planned.run.id,
      planned.coverage,
      citations,
      claims,
      analysisTasks,
      timestamp,
      { maxClaimsPerTask: 2, maxStatementCharactersPerTask: MAX_WIKI_CLAIM_STATEMENT_CHARACTERS, maxLevels: 8 },
    )

    expect(result.summary).toMatchObject({
      rulesVersion: 2,
      status: 'running',
      fileCount: 1,
      inputClaimCount: 4,
      taskCount: 2,
      levelCount: 1,
      incompleteFileCount: 0,
    })
    expect(result.tasks.map(task => task.claimIds.length)).toEqual([2, 2])
    expect(new Set(result.tasks.flatMap(task => task.claimIds))).toEqual(new Set(claims.map(claim => claim.id)))
    expect(result.tasks.every(task => new Set(task.claimIds.flatMap(id => {
      const claim = claims.find(value => value.id === id)!
      return claim.citationIds.map(citationId => citations.findIndex(citation => citation.id === citationId))
    })).size === 2)).toBe(true)
  })

  it('marks a prepared file analyzed only after every range succeeds', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/ranged-lifecycle',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [rangedCatalogEntry()],
      now: timestamp,
    })
    const coverage = planned.coverage[0]!
    const firstTask = planned.tasks[0]!
    const firstRange = firstTask.materialRanges[0]!
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const first = succeedWikiTask(startWikiTask(
      planned,
      firstTask.id,
      SessionId('session-range-0'),
      '2026-08-27T00:01:00.000Z',
    ), firstTask.id, {
      coverage: [{
        coverageId: coverage.id,
        rangeId: firstRange.id,
        status: 'analyzed',
        contentHash: preparedContentHash,
      }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        rangeId: firstRange.id,
        provenance: {
          kind: 'git-file',
          sourceId,
          commit: 'a'.repeat(40),
          path: coverage.path,
          startLine: 2,
          endLine: 3,
          contentHash: preparedContentHash,
        },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: '第一个区间声明了一项可验证事实。',
        citationIds: [citationId],
        coverageIds: [coverage.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T00:02:00.000Z')

    expect(first.run).toMatchObject({
      status: 'analyzing',
      coverage: { pending: 0, analyzing: 1, analyzed: 0 },
      materialRanges: { analyzedBytes: 50, planned: 1, succeeded: 1 },
    })
    expect(first.coverage[0]).not.toHaveProperty('analyzedContentHash')
    const secondTask = first.tasks.find(task => task.kind === 'analysis' && task.status === 'planned')!
    const secondRange = secondTask.materialRanges[0]!
    const complete = succeedWikiTask(startWikiTask(
      first,
      secondTask.id,
      SessionId('session-range-1'),
      '2026-08-27T00:03:00.000Z',
    ), secondTask.id, {
      coverage: [{
        coverageId: coverage.id,
        rangeId: secondRange.id,
        status: 'analyzed',
        contentHash: preparedContentHash,
      }],
      citations: [],
      claims: [],
      businessQuestions: testBusinessQuestionFindings(),
    }, '2026-08-27T00:04:00.000Z')

    expect(complete.run).toMatchObject({
      status: 'verifying',
      coverage: { analyzing: 0, analyzed: 1 },
      materialRanges: { analyzedBytes: 100, planned: 0, succeeded: 2 },
    })
    expect(complete.coverage[0]).toMatchObject({
      status: 'analyzed',
      analyzedContentHash: preparedContentHash,
    })
    expect(complete.tasks.find(task => task.kind === 'verification')).toMatchObject({
      status: 'planned',
      claimIds: [claimId],
      materialRanges: [],
    })
  })

  it('synthesizes cross-range file Claims before verification without hiding source Claims', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/file-synthesis',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [rangedCatalogEntry()],
      now: timestamp,
    })
    const coverage = planned.coverage[0]!
    const sourceClaimIds = [createWikiClaimId(), createWikiClaimId()]
    const citationIds = [createWikiCitationId(), createWikiCitationId()]
    let current = planned
    for (const [index, initialTask] of planned.tasks.entries()) {
      const task = current.tasks.find(value => value.id === initialTask.id)!
      const range = task.materialRanges[0]!
      current = succeedWikiTask(startWikiTask(
        current,
        task.id,
        SessionId(`session-file-range-${index}`),
        `2026-08-27T00:1${index}:00.000Z`,
      ), task.id, {
        coverage: [{
          coverageId: coverage.id,
          rangeId: range.id,
          status: 'analyzed',
          contentHash: preparedContentHash,
        }],
        citations: [{
          id: citationIds[index]!,
          runId: planned.run.id,
          role: 'supports',
          rangeId: range.id,
          provenance: {
            kind: 'git-file',
            sourceId,
            commit: 'a'.repeat(40),
            path: coverage.path,
            startLine: range.startLine,
            endLine: range.endLine,
            contentHash: preparedContentHash,
          },
        }],
        claims: [{
          id: sourceClaimIds[index]!,
          runId: planned.run.id,
          kind: index === 0 ? 'assertion' : 'inference',
          status: 'proposed',
          statement: index === 0 ? '文件前段声明处理入口。' : '文件后段表明入口结果会进入持久化。',
          citationIds: [citationIds[index]!],
          coverageIds: [coverage.id],
          sourceClaimIds: [],
        }],
        businessQuestions: testBusinessQuestionFindings([sourceClaimIds[index]!]),
      }, `2026-08-27T00:2${index}:00.000Z`)
    }

    const synthesisTask = current.tasks.find(task => task.kind === 'file-synthesis')!
    expect(current.run).toMatchObject({
      status: 'analyzing',
      fileSynthesis: {
        status: 'running',
        fileCount: 1,
        inputClaimCount: 2,
        taskCount: 1,
        completeFileCount: 0,
        incompleteFileCount: 0,
      },
    })
    expect(current.tasks.some(task => task.kind === 'verification')).toBe(false)

    const derivedId = createWikiClaimId()
    const started = startWikiTask(
      current,
      synthesisTask.id,
      SessionId('session-file-synthesis'),
      '2026-08-27T00:30:00.000Z',
    )
    expect(() => succeedWikiFileSynthesisTask(started, synthesisTask.id, {
      retainedClaimIds: [],
      claims: [],
    })).toThrow('account for every input Claim exactly once')
    const synthesized = succeedWikiFileSynthesisTask(started, synthesisTask.id, {
      retainedClaimIds: [],
      claims: [{
        id: derivedId,
        runId: planned.run.id,
        kind: 'inference',
        status: 'proposed',
        statement: '该文件把入口处理结果交给持久化流程。',
        citationIds,
        coverageIds: [coverage.id],
        sourceClaimIds,
        sourceTaskId: synthesisTask.id,
      }],
    }, '2026-08-27T00:31:00.000Z')

    expect(synthesized.claims).toHaveLength(3)
    expect(synthesized.claims.find(claim => claim.id === derivedId)).toMatchObject({
      kind: 'inference',
      sourceClaimIds,
      citationIds,
    })
    expect(synthesized.tasks.find(task => task.kind === 'verification')).toMatchObject({
      claimIds: [derivedId],
      status: 'planned',
    })
    expect(synthesized.tasks.some(task => task.kind === 'verification'
      && task.claimIds.some(id => sourceClaimIds.includes(id)))).toBe(false)
  })

  it('mixes claims from different analysis shards into bounded verification batches', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/cross-shard',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('api/contract.md'), catalogEntry('runtime/implementation.md')],
      now: timestamp,
    })
    const firstClaim = createWikiClaimId()
    const secondClaim = createWikiClaimId()
    const tasks = createWikiVerificationTasks(planned.run.id, planned.coverage, [{
      id: firstClaim,
      runId: planned.run.id,
      kind: 'assertion',
      status: 'proposed',
      statement: '接口声明使用版本一。',
      citationIds: [],
      coverageIds: [planned.coverage.find(item => item.path.startsWith('api/'))!.id],
      sourceClaimIds: [],
    }, {
      id: secondClaim,
      runId: planned.run.id,
      kind: 'assertion',
      status: 'proposed',
      statement: '运行时实现使用版本二。',
      citationIds: [],
      coverageIds: [planned.coverage.find(item => item.path.startsWith('runtime/'))!.id],
      sourceClaimIds: [],
    }], timestamp, 2)

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      kind: 'verification',
      status: 'planned',
      claimIds: expect.arrayContaining([firstClaim, secondClaim]),
    })
    expect(new Set(tasks[0]!.coverageIds).size).toBe(2)
  })

  it('schedules bounded global consistency groups only after every Claim batch is verified', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/global-consistency',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('config/runtime.md'), catalogEntry('src/runtime.md')],
      now: timestamp,
    }, [], { maxItems: 1, maxBytes: 100 })
    const claimIds = [createWikiClaimId(), createWikiClaimId()]
    let current = planned
    for (const [index, task] of planned.tasks.entries()) {
      const coverage = planned.coverage.find(item => item.id === task.coverageIds[0])!
      const citationId = createWikiCitationId()
      current = succeedWikiTask(startWikiTask(
        current,
        task.id,
        SessionId(`session-global-analysis-${index}`),
        `2026-08-27T01:0${index}:00.000Z`,
      ), task.id, {
        coverage: [{ coverageId: coverage.id, status: 'analyzed', contentHash }],
        citations: [{
          id: citationId,
          runId: planned.run.id,
          role: 'supports',
          provenance: { kind: 'document', sourceId, path: coverage.path, contentHash },
        }],
        claims: [{
          id: claimIds[index]!,
          runId: planned.run.id,
          kind: 'assertion',
          status: 'proposed',
          statement: index === 0 ? '运行模式使用安全配置。' : '运行模式使用兼容配置。',
          citationIds: [citationId],
          coverageIds: [coverage.id],
          sourceClaimIds: [],
        }],
        businessQuestions: testBusinessQuestionFindings([claimIds[index]!]),
      }, `2026-08-27T01:1${index}:00.000Z`, 1)
    }
    const verificationTasks = current.tasks.filter(task => task.kind === 'verification')
    expect(verificationTasks).toHaveLength(2)
    expect(current.run.consistency).toMatchObject({ planned: false, candidatePairCount: 0 })

    for (const [index, task] of verificationTasks.entries()) {
      current = succeedWikiVerificationTask(startWikiTask(
        current,
        task.id,
        SessionId(`session-global-verification-${index}`),
        `2026-08-27T01:2${index}:00.000Z`,
      ), task.id, {
        decisions: [{ claimId: task.claimIds[0]!, status: 'verified' }],
        citations: [],
        conflicts: [],
      }, `2026-08-27T01:3${index}:00.000Z`)
      if (index === 0) expect(current.run.consistency.planned).toBe(false)
    }

    const consistencyTask = current.tasks.find(task => task.kind === 'consistency')!
    expect(current.run).toMatchObject({
      status: 'verifying',
      consistency: {
        planned: true,
        candidatePairCount: 1,
        candidatePairsComplete: true,
        omittedCandidatePairCount: 0,
      },
    })
    expect(consistencyTask).toMatchObject({
      claimIds: expect.arrayContaining(claimIds),
      candidatePairs: [{ claimIds: expect.arrayContaining(claimIds), reasons: ['statement-key'] }],
    })
    current = succeedWikiVerificationTask(startWikiTask(
      current,
      consistencyTask.id,
      SessionId('session-global-consistency'),
      '2026-08-27T01:40:00.000Z',
    ), consistencyTask.id, {
      decisions: claimIds.map(claimId => ({ claimId, status: 'verified' as const })),
      citations: [],
      conflicts: [],
    }, '2026-08-27T01:41:00.000Z')
    expect(current.run).toMatchObject({
      status: 'synthesizing',
      pageGeneration: { planned: true, claimCount: 2, taskCount: 2 },
    })
    current = completePageTasks(current)
    expect(current.run.status).toBe('needs-review')
    expect(current.pages).toHaveLength(3)
  })

  it('marks global recall incomplete when a bounded candidate group would exceed its Claim budget', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/global-consistency-bounds',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('a.md'), catalogEntry('b.md'), catalogEntry('c.md')],
      now: timestamp,
    }, [], { maxItems: 1, maxBytes: 100 })
    const claims = planned.coverage.map((coverage, index) => ({
      id: createWikiClaimId(),
      runId: planned.run.id,
      kind: 'assertion' as const,
      status: 'verified' as const,
      statement: `共享运行模式声明 ${index}`,
      citationIds: [],
      coverageIds: [coverage.id],
      sourceClaimIds: [],
    }))
    const verification = createWikiVerificationTasks(planned.run.id, planned.coverage, claims, timestamp, 1)
      .map(task => ({ ...task, status: 'succeeded' as const, attemptCount: 1, agentSessionId: SessionId(`session-${task.id}`), startedAt: timestamp, completedAt: timestamp }))
    const result = createWikiConsistencyTasks(
      planned.run.id,
      planned.coverage,
      [],
      claims,
      verification,
      timestamp,
      { maxClaimsPerTask: 2, maxCandidatePairs: 20, maxClaimsPerRecallKey: 20, maxRecallKeysPerClaim: 20 },
    )

    expect(result.summary).toMatchObject({
      planned: true,
      candidatePairsComplete: false,
      omittedCandidatePairCount: null,
    })
    expect(result.tasks.every(task => task.claimIds.length <= 2)).toBe(true)
  })

  it('refuses global consistency recall before every verification task succeeds', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/premature-consistency',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('a.md'), catalogEntry('b.md')],
      now: timestamp,
    }, [], { maxItems: 1, maxBytes: 100 })
    const claims = planned.coverage.map(coverage => ({
      id: createWikiClaimId(),
      runId: planned.run.id,
      kind: 'assertion' as const,
      status: 'verified' as const,
      statement: '共享运行模式声明',
      citationIds: [],
      coverageIds: [coverage.id],
      sourceClaimIds: [],
    }))
    const verification = createWikiVerificationTasks(planned.run.id, planned.coverage, claims, timestamp, 1)
    verification[0] = {
      ...verification[0]!,
      status: 'succeeded',
      attemptCount: 1,
      agentSessionId: SessionId('session-finished'),
      startedAt: timestamp,
      completedAt: timestamp,
    }

    expect(() => createWikiConsistencyTasks(
      planned.run.id,
      planned.coverage,
      [],
      claims,
      verification,
      timestamp,
    )).toThrow('requires every verification task to succeed')
  })

  it('rejects unbounded Wiki Claim statements before global recall', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/claim-budget',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md')],
      now: timestamp,
    })
    const input = withAnalyzedCoverage(planned)

    expect(() => finalizeWikiRunSnapshot({
      ...input,
      claims: [{
        id: createWikiClaimId(),
        runId: planned.run.id,
        kind: 'unknown',
        status: 'uncertain',
        statement: 'x'.repeat(MAX_WIKI_CLAIM_STATEMENT_CHARACTERS + 1),
        citationIds: [],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
    })).toThrow(`Wiki claim statement exceeds ${MAX_WIKI_CLAIM_STATEMENT_CHARACTERS} characters`)
  })

  it('blocks generation when the catalog admits any omitted files', () => {
    const snapshot = createPlannedWikiRun({
      projectRoot: '/workspace/incomplete',
      catalogHash,
      catalogComplete: false,
      catalogOmittedItemCount: 3,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })

    expect(snapshot.run).toMatchObject({
      status: 'blocked',
      catalogComplete: false,
      catalogOmittedItemCount: 3,
      blockingReasons: ['项目目录清单遗漏 3 项，禁止生成 Wiki'],
    })
    expect(snapshot.tasks).toEqual([])
  })

  it('persists retryable task start and failure state independently of Coverage identity', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/task-failure',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('src/main.go', 'Go')],
      now: timestamp,
    })
    const task = planned.tasks[0]!
    const startedAt = '2026-08-27T00:01:00.000Z'
    const started = startWikiTask(planned, task.id, SessionId('session-wiki-task-1'), startedAt)

    expect(started.run).toMatchObject({ status: 'analyzing', coverage: { analyzing: 1 } })
    expect(started.tasks[0]).toMatchObject({
      status: 'running',
      attemptCount: 1,
      agentSessionId: 'session-wiki-task-1',
      startedAt,
    })
    const failedAt = '2026-08-27T00:02:00.000Z'
    const failed = failWikiTask(started, task.id, '模型回合未提交结果', failedAt)
    expect(failed.run).toMatchObject({ status: 'failed', coverage: { pending: 1 }, failure: '模型回合未提交结果' })
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', completedAt: failedAt })
    expect(startWikiTask(failed, task.id, SessionId('session-wiki-task-2'), failedAt).tasks[0])
      .toMatchObject({ status: 'running', attemptCount: 2, agentSessionId: 'session-wiki-task-2' })
  })

  it('accepts one shard only when every Coverage item is analyzed or explicitly deferred', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/task-success',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })
    const task = planned.tasks[0]!
    const started = startWikiTask(
      planned,
      task.id,
      SessionId('session-wiki-task-success'),
      '2026-08-27T00:03:00.000Z',
    )
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const completed = succeedWikiTask(started, task.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: { kind: 'document', sourceId, path: 'README.md', contentHash },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: 'README 是当前分片的项目材料。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T00:04:00.000Z')

    expect(completed.run).toMatchObject({ status: 'verifying', coverage: { analyzed: 1 } })
    expect(completed.tasks).toEqual([
      expect.objectContaining({ kind: 'analysis', status: 'succeeded' }),
      expect.objectContaining({ kind: 'verification', status: 'planned', claimIds: [claimId] }),
    ])
    expect(completed.claims).toEqual([expect.objectContaining({ id: claimId, status: 'proposed' })])
    const verificationTask = completed.tasks[1]!
    const verificationStarted = startWikiTask(
      completed,
      verificationTask.id,
      SessionId('session-wiki-verification-success'),
      '2026-08-27T00:05:00.000Z',
    )
    expect(verificationStarted.run).toMatchObject({ status: 'verifying', coverage: { analyzed: 1, analyzing: 0 } })
    const verified = succeedWikiVerificationTask(verificationStarted, verificationTask.id, {
      decisions: [{ claimId, status: 'verified' }],
      citations: [],
      conflicts: [],
    }, '2026-08-27T00:06:00.000Z')
    expect(verified.run.status).toBe('synthesizing')
    expect(verified.claims[0]?.status).toBe('verified')
    expect(verified.tasks.find(task => task.kind === 'verification')).toMatchObject({ status: 'succeeded' })
    expect(() => succeedWikiTask(started, task.id, {
      coverage: [],
      citations: [],
      claims: [],
      businessQuestions: testBusinessQuestionFindings(),
    })).toThrow('settle every assigned Coverage item exactly once')
  })

  it('keeps an uncountable catalog blind spot explicit', () => {
    const snapshot = createPlannedWikiRun({
      projectRoot: '/workspace/unknown-omissions',
      catalogHash,
      catalogComplete: false,
      catalogOmittedItemCount: null,
      entries: [],
      now: timestamp,
    })

    expect(snapshot.run).toMatchObject({
      status: 'blocked',
      catalogOmittedItemCount: null,
      blockingReasons: ['项目目录清单不完整，遗漏数量未知，禁止生成 Wiki'],
    })
  })

  it('keeps deferred coverage and legacy synthesis outside project knowledge activation', () => {
    const deferred = createPlannedWikiRun({
      projectRoot: '/workspace/deferred-completion',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        ...catalogEntry('docs/deferred.md'),
        disposition: { status: 'deferred', reason: '材料尚未获准读取' },
      }],
      now: timestamp,
    })
    const deferredReport = assessWikiCompletion(deferred.run)
    const legacyReport = assessWikiCompletion({
      ...deferred.run,
      fileSynthesis: createUnassessedWikiFileSynthesisSummary(),
    })

    expect(deferredReport.eligibleForActivation).toBe(false)
    expect(deferredReport.checks).toContainEqual({ id: 'coverage', state: 'fail', issueCount: 1 })
    expect(legacyReport.checks).toContainEqual({ id: 'file-synthesis', state: 'unsupported', issueCount: 1 })
  })

  it('keeps unknown Claims visible as draft Pages without inventing verification work', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/page-unknown',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md')],
      now: timestamp,
    })
    const unknownId = createWikiClaimId()
    const synthesizing = succeedWikiTask(startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-unknown-analysis'),
      '2026-08-27T00:07:00.000Z',
    ), planned.tasks[0]!.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [],
      claims: [{
        id: unknownId,
        runId: planned.run.id,
        kind: 'unknown',
        status: 'uncertain',
        statement: '材料没有说明数据保留期限。',
        citationIds: [],
        coverageIds: [],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings(),
    }, '2026-08-27T00:08:00.000Z')

    expect(synthesizing.run).toMatchObject({
      status: 'synthesizing',
      consistency: { planned: true, candidatePairCount: 0 },
      pageGeneration: { planned: true, claimCount: 1, taskCount: 1 },
    })
    expect(synthesizing.tasks.filter(task => task.kind === 'verification' || task.kind === 'consistency')).toEqual([])
    const paged = completePageTasks(synthesizing)
    expect(paged.run.status).toBe('needs-review')
    expect(paged.pages.filter(page => page.legacy !== true).every(page => page.status === 'draft')).toBe(true)
    expect(paged.pages.find(page => page.sourceTaskId !== undefined)?.claimIds).toEqual([unknownId])
    expect(assessWikiCompletion(paged.run)).toEqual({
      eligibleForActivation: false,
      checks: [
        { id: 'catalog', state: 'pass', issueCount: 0 },
        { id: 'coverage', state: 'pass', issueCount: 0 },
        { id: 'analysis', state: 'pass', issueCount: 0 },
        { id: 'file-synthesis', state: 'pass', issueCount: 0 },
        { id: 'verification', state: 'pass', issueCount: 0 },
        { id: 'consistency', state: 'pass', issueCount: 0 },
        { id: 'pages', state: 'pass', issueCount: 0 },
        { id: 'material-exposure', state: 'fail', issueCount: 1 },
        { id: 'business-questions', state: 'pass', issueCount: 0 },
        { id: 'cross-module-flows', state: 'pass', issueCount: 0 },
      ],
    })
  })

  it('retains both cross-shard claims and contradictory evidence as an open conflict', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/verification-conflict',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('config/runtime.md'), catalogEntry('src/runtime.md')],
      now: timestamp,
    }, [], { maxItems: 1, maxBytes: 100 })
    const claimIds = [createWikiClaimId(), createWikiClaimId()]
    const supportIds = [createWikiCitationId(), createWikiCitationId()]
    let current = planned
    for (const [index, task] of planned.tasks.entries()) {
      const coverage = planned.coverage.find(item => item.id === task.coverageIds[0])!
      const started = startWikiTask(
        current,
        task.id,
        SessionId(`session-wiki-conflict-analysis-${index}`),
        `2026-08-27T00:1${index}:00.000Z`,
      )
      current = succeedWikiTask(started, task.id, {
        coverage: [{ coverageId: coverage.id, status: 'analyzed', contentHash }],
        citations: [{
          id: supportIds[index]!,
          runId: planned.run.id,
          role: 'supports',
          provenance: { kind: 'document', sourceId, path: coverage.path, contentHash },
        }],
        claims: [{
          id: claimIds[index]!,
          runId: planned.run.id,
          kind: 'assertion',
          status: 'proposed',
          statement: index === 0 ? '运行时模式固定为安全模式。' : '运行时模式固定为兼容模式。',
          citationIds: [supportIds[index]!],
          coverageIds: [coverage.id],
          sourceClaimIds: [],
        }],
        businessQuestions: testBusinessQuestionFindings([claimIds[index]!]),
      }, `2026-08-27T00:2${index}:00.000Z`, 2)
    }
    const verificationTask = current.tasks.find(task => task.kind === 'verification')!
    const verificationStarted = startWikiTask(
      current,
      verificationTask.id,
      SessionId('session-wiki-conflict-verification'),
      '2026-08-27T00:30:00.000Z',
    )
    const contradictsId = createWikiCitationId()
    const conflictId = createWikiConflictId()
    const conflicted = succeedWikiVerificationTask(verificationStarted, verificationTask.id, {
      decisions: claimIds.map(claimId => ({ claimId, status: 'conflicted' as const })),
      citations: [{
        id: contradictsId,
        runId: planned.run.id,
        role: 'contradicts',
        provenance: {
          kind: 'document',
          sourceId,
          path: planned.coverage[1]!.path,
          contentHash,
        },
      }],
      conflicts: [{
        id: conflictId,
        runId: planned.run.id,
        status: 'open',
        summary: '配置与实现声明了不同的固定运行模式。',
        claimIds,
        citationIds: [...supportIds, contradictsId],
      }],
    }, '2026-08-27T00:31:00.000Z')

    expect(conflicted.run.status).toBe('synthesizing')
    expect(conflicted.claims.map(claim => claim.status)).toEqual(['conflicted', 'conflicted'])
    expect(conflicted.conflicts).toEqual([expect.objectContaining({ id: conflictId, status: 'open' })])
    const paged = completePageTasks(conflicted)
    expect(paged.run.status).toBe('needs-review')
    expect(paged.pages.filter(page => page.legacy !== true).every(page => page.status === 'conflicted')).toBe(true)
  })

  it('records explicit exclusions without treating them as catalog omissions', () => {
    const snapshot = createPlannedWikiRun({
      projectRoot: '/workspace/exclusions',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [{
        ...catalogEntry('dist/app.js', 'JavaScript'),
        disposition: { status: 'excluded', reason: '生成产物不进入 Wiki 语料' },
      }],
      now: timestamp,
    })

    expect(snapshot.run).toMatchObject({ status: 'planned', coverage: { excluded: 1, pending: 0 } })
    expect(snapshot.coverage[0]).toMatchObject({ status: 'excluded', reason: '生成产物不进入 Wiki 语料' })
  })

  it('rejects assertions that have no supporting source evidence', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/no-hallucinations',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })
    const claimId = createWikiClaimId()

    expect(() => finalizeWikiRunSnapshot({
      ...withAnalyzedCoverage(planned),
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: '项目使用事件溯源。',
        citationIds: [],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
    })).toThrow('assertion or inference requires catalog-backed supporting evidence')
  })

  it('retains an evidence gap as unknown instead of converting it into a fact', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/unknowns',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })
    const unknown = finalizeWikiRunSnapshot({
      ...withoutSnapshotHash(planned),
      claims: [{
        id: createWikiClaimId(),
        runId: planned.run.id,
        kind: 'unknown',
        status: 'uncertain',
        statement: '未知：无法从当前项目材料确认生产部署拓扑。',
        citationIds: [],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
    })

    expect(unknown.claims[0]).toMatchObject({ kind: 'unknown', status: 'uncertain' })
  })

  it('requires verified facts to cite direct project material', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/direct-evidence',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })
    const citationId = createWikiCitationId()

    expect(() => finalizeWikiRunSnapshot({
      ...withAnalyzedCoverage(planned),
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: { kind: 'session', sessionId: 'session-wiki-test' as never, eventSeqs: [1] },
      }],
      claims: [{
        id: createWikiClaimId(),
        runId: planned.run.id,
        kind: 'assertion',
        status: 'verified',
        statement: '项目使用 SQLite。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
    })).toThrow('assertion or inference requires catalog-backed supporting evidence')
  })

  it('derives a verified Page tree only from Claims assigned to completed Page tasks', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/verified',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const analyzed = succeedWikiTask(startWikiTask(
      planned,
      planned.tasks[0]!.id,
      SessionId('session-page-analysis'),
      '2026-08-27T03:00:00.000Z',
    ), planned.tasks[0]!.id, {
      coverage: [{ coverageId: planned.coverage[0]!.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId,
        runId: planned.run.id,
        role: 'supports',
        provenance: {
          kind: 'document',
          sourceId,
          path: 'README.md',
          contentHash,
        },
      }],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'proposed',
        statement: 'README 明确说明项目使用 SQLite。',
        citationIds: [citationId],
        coverageIds: [planned.coverage[0]!.id],
        sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, '2026-08-27T03:01:00.000Z')
    const verificationTask = analyzed.tasks.find(task => task.kind === 'verification')!
    const synthesizing = succeedWikiVerificationTask(startWikiTask(
      analyzed,
      verificationTask.id,
      SessionId('session-page-verification'),
      '2026-08-27T03:02:00.000Z',
    ), verificationTask.id, {
      decisions: [{ claimId, status: 'verified' }],
      citations: [],
      conflicts: [],
    }, '2026-08-27T03:03:00.000Z')
    const pageTask = synthesizing.tasks.find(task => task.kind === 'page')!
    expect(() => succeedWikiPageTask(startWikiTask(
      synthesizing,
      pageTask.id,
      SessionId('session-page-invalid'),
      '2026-08-27T03:04:00.000Z',
    ), pageTask.id, {
      pages: [{ slug: 'overview', title: '项目概览', claimIds: [], childSlugs: [] }],
    })).toThrow('empty Page')
    const verified = completePageTasks(synthesizing)

    expect(verified.run).toMatchObject({
      status: 'needs-review',
      rootPageIds: [verified.pages.find(page => page.title === 'Wiki')!.id],
    })
    expect(verified.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'verified', sourceTaskId: pageTask.id, claimIds: [claimId] }),
      expect.objectContaining({ status: 'verified', title: 'Wiki', claimIds: [] }),
    ]))
  })

  it('retains both catalog-backed sides of an open contradiction', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/conflict',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown'), catalogEntry('config/runtime.yml', 'YAML')],
      now: timestamp,
    })
    const supportsId = createWikiCitationId()
    const contradictsId = createWikiCitationId()
    const claimId = createWikiClaimId()
    const input = withAnalyzedCoverage(planned)
    const coverageByPath = new Map(input.coverage.map(item => [item.path, item]))

    const conflicted = finalizeWikiRunSnapshot({
      ...input,
      citations: [
        {
          id: supportsId,
          runId: planned.run.id,
          role: 'supports',
          provenance: { kind: 'document', sourceId, path: 'README.md', contentHash },
        },
        {
          id: contradictsId,
          runId: planned.run.id,
          role: 'contradicts',
          provenance: { kind: 'document', sourceId, path: 'config/runtime.yml', contentHash },
        },
      ],
      claims: [{
        id: claimId,
        runId: planned.run.id,
        kind: 'assertion',
        status: 'conflicted',
        statement: '项目默认启用缓存。',
        citationIds: [supportsId, contradictsId],
        coverageIds: [coverageByPath.get('README.md')!.id, coverageByPath.get('config/runtime.yml')!.id],
        sourceClaimIds: [],
      }],
      conflicts: [{
        id: createWikiConflictId(),
        runId: planned.run.id,
        status: 'open',
        summary: 'README 与运行配置对默认缓存状态的描述相反。',
        claimIds: [claimId],
        citationIds: [supportsId, contradictsId],
      }],
    })

    expect(conflicted.claims[0]).toMatchObject({ status: 'conflicted' })
    expect(conflicted.conflicts[0]).toMatchObject({ status: 'open' })
  })

  it('detects durable payload tampering through the snapshot hash', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/tampered',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [catalogEntry('README.md', 'Markdown')],
      now: timestamp,
    })
    const tampered = structuredClone(planned)
    tampered.coverage[0]!.byteSize += 1

    expect(() => parseWikiRunSnapshot(tampered)).toThrow('coverage summary is inconsistent')
  })

  it('rejects a model input audit that borrows another task material range', () => {
    const planned = createPlannedWikiRun({
      projectRoot: '/workspace/cross-task-model-input-audit',
      catalogHash,
      catalogComplete: true,
      catalogOmittedItemCount: 0,
      entries: [rangedCatalogEntry()],
      now: timestamp,
    })
    let completed = planned
    for (const [index, plannedTask] of planned.tasks.entries()) {
      const task = completed.tasks.find(value => value.id === plannedTask.id)!
      const range = task.materialRanges[0]!
      completed = succeedWikiTask(startWikiTask(
        completed,
        task.id,
        SessionId(`session-cross-task-audit-${index}`),
        `2026-08-27T03:0${index}:00.000Z`,
      ), task.id, {
        coverage: [{
          coverageId: completed.coverage[0]!.id,
          rangeId: range.id,
          status: 'analyzed',
          contentHash: preparedContentHash,
        }],
        citations: [],
        claims: [],
        businessQuestions: testBusinessQuestionFindings(),
      }, `2026-08-27T03:0${index}:30.000Z`)
    }
    const tampered = withoutSnapshotHash(completed)
    const firstTask = tampered.tasks[0]!
    const secondRange = tampered.tasks[1]!.materialRanges[0]!
    firstTask.modelInputAudit = {
      rulesVersion: 1,
      state: 'verified',
      provider: 'test-provider',
      model: 'test-model',
      submissionCallId: 'call-cross-task-audit',
      requestMessageCount: 2,
      requestLastMessageId: 'message-cross-task-audit',
      requestMessagesHash: `sha256:${'6'.repeat(64)}`,
      material: [{
        coverageId: completed.coverage[0]!.id,
        contentHash: preparedContentHash,
        rangeId: secondRange.id,
        rangeHash: secondRange.contentHash,
      }],
      recordedAt: '2026-08-27T03:02:00.000Z',
    }
    tampered.run.materialExposure = {
      rulesVersion: 1,
      requiredTaskCount: 2,
      verifiedTaskCount: 1,
      pendingTaskCount: 1,
      unsupportedTaskCount: 0,
    }

    expect(() => finalizeWikiRunSnapshot(tampered)).toThrow('stale material range')
  })
})
