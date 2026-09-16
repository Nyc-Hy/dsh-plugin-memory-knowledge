import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  createWikiPageId,
  type WikiClaimId,
  type WikiCoverageId,
  type WikiMaterialRangeId,
  type WikiTaskId,
} from './ids.js'
import {
  activeWikiClaims,
  advanceWikiFileSynthesisTasks,
  createWikiConsistencyTasks,
  createWikiCrossModuleFlowTasks,
  createWikiFileSynthesisTasks,
  createWikiPageTasks,
  createWikiVerificationTasks,
  DEFAULT_WIKI_CONSISTENCY_CONFIG,
  DEFAULT_WIKI_CROSS_MODULE_FLOW_CONFIG,
  DEFAULT_WIKI_FILE_SYNTHESIS_CONFIG,
  DEFAULT_WIKI_PAGE_CONFIG,
  DEFAULT_WIKI_VERIFICATION_BATCH_CLAIMS,
  finalizeWikiRunSnapshot,
  MAX_WIKI_PAGE_SLUG_CHARACTERS,
  MAX_WIKI_PAGE_TITLE_CHARACTERS,
  WIKI_BUSINESS_QUESTION_DEFINITIONS,
  WIKI_BUSINESS_QUESTION_RULES_VERSION,
  createPendingWikiModelInputAudit,
  createPendingWikiBusinessQuestions,
  createUnsupportedWikiBusinessQuestions,
  summarizeWikiBusinessQuestions,
  summarizeWikiCrossModuleFlows,
  summarizeWikiCoverage,
  summarizeWikiMaterialExposure,
  summarizeWikiMaterialRanges,
  summarizeWikiTasks,
  type WikiCitation,
  type WikiBusinessQuestionFinding,
  type WikiBusinessQuestionTaskState,
  type WikiClaim,
  type WikiConflict,
  type WikiConsistencyConfig,
  type WikiCrossModuleFlow,
  type WikiCrossModuleFlowConfig,
  type WikiCoverageItem,
  type WikiFileSynthesisConfig,
  type WikiModelInputAudit,
  type WikiPage,
  type WikiPageConfig,
  type WikiRunSnapshot,
  type WikiShardTask,
} from './wiki-model.js'

/** Terminal analysis result for one Coverage item in a shard task. */
export type WikiTaskCoverageResult =
  | { coverageId: WikiCoverageId; rangeId?: WikiMaterialRangeId; status: 'analyzed'; contentHash: string }
  | { coverageId: WikiCoverageId; status: 'deferred'; reason: string }

/** Evidence-constrained data accepted when one shard Agent finishes. */
export interface WikiTaskSubmission {
  coverage: WikiTaskCoverageResult[]
  citations: WikiCitation[]
  claims: WikiClaim[]
  businessQuestions: WikiBusinessQuestionFinding[]
}

/** File-level Claims and explicitly retained inputs accepted from one synthesis task. */
export interface WikiFileSynthesisSubmission {
  retainedClaimIds: WikiClaimId[]
  claims: WikiClaim[]
}

/** One verifier conclusion for an assigned Claim. */
export interface WikiVerificationDecision {
  claimId: WikiClaimId
  status: 'verified' | 'uncertain' | 'rejected' | 'conflicted'
}

/** Evidence-constrained result of one bounded cross-shard verification task. */
export interface WikiVerificationSubmission {
  decisions: WikiVerificationDecision[]
  citations: WikiCitation[]
  conflicts: WikiConflict[]
}

/** One task-local Page node; Host owns ids, status, and the global root. */
export interface WikiPageDraft {
  slug: string
  title: string
  claimIds: WikiClaimId[]
  childSlugs: string[]
}

/** Complete organizational tree submitted for one bounded Page task. */
export interface WikiPageSubmission {
  pages: WikiPageDraft[]
}

/** Evidence-bound flows plus Claims whose ordering could not be established. */
export interface WikiCrossModuleFlowSubmission {
  flows: WikiCrossModuleFlow[]
  unresolvedClaimIds: WikiClaimId[]
}

function taskById(snapshot: WikiRunSnapshot, id: WikiTaskId): WikiShardTask {
  const task = snapshot.tasks.find(value => value.id === id)
  if (task === undefined) throw new Error(`memory-knowledge: Wiki task ${id} does not exist`)
  return task
}

function canonicalTimestamp(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error('memory-knowledge: Wiki task timestamp must be canonical ISO')
  }
  return value
}

function synchronizeRangedCoverage(
  coverage: readonly WikiCoverageItem[],
  tasks: readonly WikiShardTask[],
  timestamp: string,
): WikiCoverageItem[] {
  const rangeTasksByCoverage = Map.groupBy(
    tasks.filter(task => task.kind === 'analysis' && task.materialRanges.length === 1),
    task => String(task.coverageIds[0]),
  )
  return coverage.map((item): WikiCoverageItem => {
    const rangeTasks = rangeTasksByCoverage.get(String(item.id))
    if (rangeTasks === undefined) return structuredClone(item)
    if (item.preparedContentHash === undefined) {
      throw new Error('memory-knowledge: ranged Wiki Coverage is missing its prepared content hash')
    }
    const next = structuredClone(item)
    if (rangeTasks.every(task => task.status === 'succeeded')) {
      next.status = 'analyzed'
      next.analyzedContentHash = item.preparedContentHash
      next.analyzedAt = timestamp
      delete next.reason
      return next
    }
    next.status = rangeTasks.some(task => task.status === 'running' || task.status === 'succeeded')
      ? 'analyzing'
      : 'pending'
    delete next.reason
    delete next.analyzedContentHash
    delete next.analyzedAt
    return next
  })
}

function planPageGeneration(
  run: WikiRunSnapshot['run'],
  tasks: WikiShardTask[],
  coverage: readonly WikiCoverageItem[],
  claims: readonly WikiClaim[],
  timestamp: string,
  config: WikiPageConfig,
): WikiShardTask[] {
  const plan = createWikiPageTasks(run.id, coverage, activeWikiClaims(claims), timestamp, config)
  run.pageGeneration = plan.summary
  run.rootPageIds = []
  run.status = plan.tasks.length === 0 ? 'needs-review' : 'synthesizing'
  return [...tasks, ...plan.tasks]
}

function planCrossModuleFlows(
  run: WikiRunSnapshot['run'],
  tasks: WikiShardTask[],
  coverage: readonly WikiCoverageItem[],
  claims: readonly WikiClaim[],
  timestamp: string,
  flowConfig: WikiCrossModuleFlowConfig,
  pageConfig: WikiPageConfig,
): WikiShardTask[] {
  const plan = createWikiCrossModuleFlowTasks(run.id, coverage, claims, tasks, timestamp, flowConfig)
  run.crossModuleFlows = plan.summary
  const nextTasks = [...tasks, ...plan.tasks]
  if (plan.tasks.length === 0) return planPageGeneration(run, nextTasks, coverage, claims, timestamp, pageConfig)
  run.status = 'synthesizing'
  return nextTasks
}

function planVerification(
  run: WikiRunSnapshot['run'],
  tasks: WikiShardTask[],
  coverage: readonly WikiCoverageItem[],
  citations: readonly WikiCitation[],
  claims: readonly WikiClaim[],
  timestamp: string,
  verificationBatchClaims: number,
  consistencyConfig: WikiConsistencyConfig,
  flowConfig: WikiCrossModuleFlowConfig,
  pageConfig: WikiPageConfig,
): WikiShardTask[] {
  const activeClaims = activeWikiClaims(claims)
  const verificationTasks = createWikiVerificationTasks(
    run.id,
    coverage,
    activeClaims,
    timestamp,
    verificationBatchClaims,
  )
  let nextTasks = [...tasks, ...verificationTasks]
  if (verificationTasks.length > 0) {
    run.status = 'verifying'
    return nextTasks
  }
  const plan = createWikiConsistencyTasks(
    run.id,
    coverage,
    citations,
    activeClaims,
    nextTasks,
    timestamp,
    consistencyConfig,
  )
  nextTasks = [...nextTasks, ...plan.tasks]
  run.consistency = plan.summary
  if (plan.tasks.length === 0) {
    return planCrossModuleFlows(run, nextTasks, coverage, activeClaims, timestamp, flowConfig, pageConfig)
  }
  run.status = 'verifying'
  return nextTasks
}

/** Start or retry one planned shard under a newly allocated durable Session. */
export function startWikiTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  agentSessionId: SessionId,
  now = new Date().toISOString(),
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const current = taskById(snapshot, id)
  if (!['planned', 'failed', 'cancelled'].includes(current.status)) {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot start from ${current.status}`)
  }
  if (snapshot.run.status === 'blocked' || snapshot.run.status === 'complete') {
    throw new Error(`memory-knowledge: Wiki run cannot start work from ${snapshot.run.status}`)
  }
  const taskCoverage = new Set(current.coverageIds.map(String))
  let coverage = snapshot.coverage.map((item): WikiCoverageItem => {
    if (current.kind !== 'analysis' || !taskCoverage.has(String(item.id)) || item.status === 'analyzed') {
      return structuredClone(item)
    }
    if (item.status !== 'pending' && item.status !== 'analyzing') {
      throw new Error(`memory-knowledge: Wiki task coverage cannot start from ${item.status}`)
    }
    const next = structuredClone(item)
    next.status = 'analyzing'
    next.attemptCount += 1
    delete next.reason
    delete next.analyzedContentHash
    delete next.analyzedAt
    return next
  })
  const tasks = snapshot.tasks.map((task): WikiShardTask => {
    if (task.id !== id) return structuredClone(task)
    const next = structuredClone(task)
    next.status = 'running'
    next.attemptCount += 1
    next.agentSessionId = agentSessionId
    next.startedAt = timestamp
    next.updatedAt = timestamp
    next.modelInputAudit = createPendingWikiModelInputAudit()
    if (next.kind === 'analysis') next.businessQuestions = createPendingWikiBusinessQuestions()
    delete next.completedAt
    delete next.failure
    return next
  })
  coverage = synchronizeRangedCoverage(coverage, tasks, timestamp)
  const run = structuredClone(snapshot.run)
  run.status = current.kind === 'analysis' || current.kind === 'file-synthesis'
    ? 'analyzing'
    : current.kind === 'page' || current.kind === 'flow'
      ? 'synthesizing'
      : 'verifying'
  run.coverage = summarizeWikiCoverage(coverage)
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.businessQuestions = summarizeWikiBusinessQuestions(tasks)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  delete run.completedAt
  delete run.failure
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage,
    tasks,
    citations: structuredClone(snapshot.citations),
    claims: structuredClone(snapshot.claims),
    conflicts: structuredClone(snapshot.conflicts),
    pages: structuredClone(snapshot.pages),
  })
}

/** Mark one running shard failed while keeping its Coverage retryable. */
export function failWikiTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  failure: string,
  now = new Date().toISOString(),
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const normalizedFailure = failure.trim()
  if (normalizedFailure.length === 0) throw new Error('memory-knowledge: Wiki task failure must not be empty')
  const current = taskById(snapshot, id)
  if (current.status !== 'running') {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot fail from ${current.status}`)
  }
  const taskCoverage = new Set(current.coverageIds.map(String))
  let coverage = snapshot.coverage.map((item): WikiCoverageItem => {
    if (current.kind !== 'analysis' || !taskCoverage.has(String(item.id)) || item.status !== 'analyzing') {
      return structuredClone(item)
    }
    return { ...structuredClone(item), status: 'pending' }
  })
  const tasks = snapshot.tasks.map((task): WikiShardTask => task.id !== id
    ? structuredClone(task)
    : {
        ...structuredClone(task),
        status: 'failed',
        updatedAt: timestamp,
        completedAt: timestamp,
        failure: normalizedFailure,
      })
  coverage = synchronizeRangedCoverage(coverage, tasks, timestamp)
  const run = structuredClone(snapshot.run)
  run.status = current.kind === 'analysis'
    ? 'failed'
    : current.kind === 'file-synthesis'
      ? 'analyzing'
      : current.kind === 'page' || current.kind === 'flow'
        ? 'synthesizing'
        : 'verifying'
  run.coverage = summarizeWikiCoverage(coverage)
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.businessQuestions = summarizeWikiBusinessQuestions(tasks)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  run.failure = normalizedFailure
  delete run.completedAt
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage,
    tasks,
    citations: structuredClone(snapshot.citations),
    claims: structuredClone(snapshot.claims),
    conflicts: structuredClone(snapshot.conflicts),
    pages: structuredClone(snapshot.pages),
  })
}

/** Commit one running shard's analyzed/deferred Coverage and proposed Claims. */
export function succeedWikiTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  submission: WikiTaskSubmission,
  now = new Date().toISOString(),
  verificationBatchClaims = DEFAULT_WIKI_VERIFICATION_BATCH_CLAIMS,
  consistencyConfig: WikiConsistencyConfig = DEFAULT_WIKI_CONSISTENCY_CONFIG,
  pageConfig: WikiPageConfig = DEFAULT_WIKI_PAGE_CONFIG,
  fileSynthesisConfig: WikiFileSynthesisConfig = DEFAULT_WIKI_FILE_SYNTHESIS_CONFIG,
  flowConfig: WikiCrossModuleFlowConfig = DEFAULT_WIKI_CROSS_MODULE_FLOW_CONFIG,
  modelInputAudit?: WikiModelInputAudit,
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const current = taskById(snapshot, id)
  if (current.status !== 'running') {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot succeed from ${current.status}`)
  }
  if (current.kind !== 'analysis') throw new Error('memory-knowledge: evidence-checking tasks require a verification submission')
  const expectedIds = new Set(current.coverageIds.map(String))
  const results = new Map(submission.coverage.map(result => [String(result.coverageId), result]))
  if (results.size !== submission.coverage.length || results.size !== expectedIds.size
    || [...results.keys()].some(value => !expectedIds.has(value))) {
    throw new Error('memory-knowledge: Wiki task submission must settle every assigned Coverage item exactly once')
  }
  const expectedRange = current.materialRanges[0]
  if (expectedRange !== undefined) {
    const result = submission.coverage[0]
    if (result?.status !== 'analyzed' || result.rangeId !== expectedRange.id) {
      throw new Error('memory-knowledge: ranged Wiki task must settle its exact assigned material range')
    }
    const item = snapshot.coverage.find(value => value.id === result.coverageId)
    if (item?.preparedContentHash !== result.contentHash) {
      throw new Error('memory-knowledge: ranged Wiki task content hash does not match prepared material')
    }
  }
  const submittedClaims = new Map(submission.claims.map(claim => [String(claim.id), claim]))
  if (submittedClaims.size !== submission.claims.length) {
    throw new Error('memory-knowledge: Wiki analysis submission Claim ids must be unique')
  }
  if (!Array.isArray(submission.businessQuestions)) {
    throw new Error('memory-knowledge: Wiki analysis must submit business-question findings')
  }
  let businessQuestions: WikiBusinessQuestionTaskState = createUnsupportedWikiBusinessQuestions()
  if (current.businessQuestions?.state === 'pending') {
    const findingByKey = new Map(submission.businessQuestions.map(finding => [finding.key, finding]))
    if (findingByKey.size !== submission.businessQuestions.length
      || findingByKey.size !== WIKI_BUSINESS_QUESTION_DEFINITIONS.length
      || WIKI_BUSINESS_QUESTION_DEFINITIONS.some(definition => !findingByKey.has(definition.key))) {
      throw new Error('memory-knowledge: Wiki analysis must settle every required business question exactly once')
    }
    const referencedClaimIds = new Set<string>()
    for (const finding of submission.businessQuestions) {
      const findingClaims = finding.claimIds.map(claimId => submittedClaims.get(String(claimId)))
      if (findingClaims.some(claim => claim === undefined)) {
        throw new Error('memory-knowledge: Wiki question findings may reference only Claims from the same submission')
      }
      if (finding.outcome === 'evidence' && (findingClaims.length === 0
        || findingClaims.some(claim => claim!.kind === 'unknown'))) {
        throw new Error('memory-knowledge: evidence-backed Wiki questions require non-unknown Claims')
      }
      if (finding.outcome === 'unknown' && findingClaims.some(claim => claim!.kind !== 'unknown')) {
        throw new Error('memory-knowledge: unknown Wiki questions may only reference unknown Claims')
      }
      if (finding.outcome !== 'evidence' && finding.reason?.trim().length === 0) {
        throw new Error('memory-knowledge: unknown or not-applicable Wiki questions require a reason')
      }
      for (const claimId of finding.claimIds) referencedClaimIds.add(String(claimId))
    }
    if (submission.claims.some(claim => claim.kind !== 'unknown' && !referencedClaimIds.has(String(claim.id)))) {
      throw new Error('memory-knowledge: every non-unknown analysis Claim must support at least one business question')
    }
    businessQuestions = {
      rulesVersion: WIKI_BUSINESS_QUESTION_RULES_VERSION,
      state: 'completed',
      findings: WIKI_BUSINESS_QUESTION_DEFINITIONS.map(definition => structuredClone(findingByKey.get(definition.key)!)),
    }
  } else if (submission.businessQuestions.length !== 0) {
    throw new Error('memory-knowledge: legacy Wiki analysis cannot acquire invented business-question answers')
  }
  let coverage = snapshot.coverage.map((item): WikiCoverageItem => {
    const result = results.get(String(item.id))
    if (result === undefined) return structuredClone(item)
    const next = structuredClone(item)
    if (expectedRange !== undefined) return next
    if (result.status === 'analyzed') {
      next.status = 'analyzed'
      next.analyzedContentHash = result.contentHash
      next.analyzedAt = timestamp
      delete next.reason
    } else {
      const reason = result.reason.trim()
      if (reason.length === 0) throw new Error('memory-knowledge: deferred Wiki coverage requires a reason')
      next.status = 'deferred'
      next.reason = reason
      delete next.analyzedContentHash
      delete next.analyzedAt
    }
    return next
  })
  let tasks = snapshot.tasks.map((task): WikiShardTask => task.id !== id
    ? structuredClone(task)
    : {
        ...structuredClone(task),
        status: 'succeeded',
        modelInputAudit: structuredClone(modelInputAudit ?? current.modelInputAudit),
        businessQuestions,
        updatedAt: timestamp,
        completedAt: timestamp,
      })
  coverage = synchronizeRangedCoverage(coverage, tasks, timestamp)
  const citations = [...snapshot.citations.map(value => structuredClone(value)), ...structuredClone(submission.citations)]
  const claims = [...snapshot.claims.map(value => structuredClone(value)), ...structuredClone(submission.claims)]
  const analysisComplete = tasks.filter(task => task.kind === 'analysis')
    .every(task => task.status === 'succeeded')
  const run = structuredClone(snapshot.run)
  run.status = 'analyzing'
  if (analysisComplete) {
    const synthesisPlan = createWikiFileSynthesisTasks(
      run.id,
      coverage,
      citations,
      claims,
      tasks,
      timestamp,
      fileSynthesisConfig,
    )
    tasks = [...tasks, ...synthesisPlan.tasks]
    run.fileSynthesis = synthesisPlan.summary
    if (synthesisPlan.tasks.length === 0) {
      tasks = planVerification(
        run,
        tasks,
        coverage,
        citations,
        claims,
        timestamp,
        verificationBatchClaims,
        consistencyConfig,
        flowConfig,
        pageConfig,
      )
    }
  }
  run.coverage = summarizeWikiCoverage(coverage)
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.businessQuestions = summarizeWikiBusinessQuestions(tasks)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  delete run.failure
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage,
    tasks,
    citations,
    claims,
    conflicts: structuredClone(snapshot.conflicts),
    pages: structuredClone(snapshot.pages),
  })
}

/** Commit one file-level synthesis task without hiding or duplicating any input Claim. */
export function succeedWikiFileSynthesisTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  submission: WikiFileSynthesisSubmission,
  now = new Date().toISOString(),
  verificationBatchClaims = DEFAULT_WIKI_VERIFICATION_BATCH_CLAIMS,
  consistencyConfig: WikiConsistencyConfig = DEFAULT_WIKI_CONSISTENCY_CONFIG,
  pageConfig: WikiPageConfig = DEFAULT_WIKI_PAGE_CONFIG,
  flowConfig: WikiCrossModuleFlowConfig = DEFAULT_WIKI_CROSS_MODULE_FLOW_CONFIG,
  modelInputAudit?: WikiModelInputAudit,
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const current = taskById(snapshot, id)
  if (current.status !== 'running') {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot succeed from ${current.status}`)
  }
  if (current.kind !== 'file-synthesis') {
    throw new Error('memory-knowledge: this task does not accept a file synthesis submission')
  }
  const expectedIds = new Set(current.claimIds.map(String))
  const retainedIds = new Set(submission.retainedClaimIds.map(String))
  if (retainedIds.size !== submission.retainedClaimIds.length
    || [...retainedIds].some(value => !expectedIds.has(value))) {
    throw new Error('memory-knowledge: retained file synthesis Claims must be unique task inputs')
  }
  const existingClaimIds = new Set(snapshot.claims.map(claim => String(claim.id)))
  const outputClaimIds = new Set<string>()
  const consumedIds = new Set<string>()
  for (const claim of submission.claims) {
    const claimId = String(claim.id)
    if (existingClaimIds.has(claimId) || outputClaimIds.has(claimId) || claim.runId !== snapshot.run.id
      || claim.status !== 'proposed' || claim.kind === 'unknown' || claim.sourceClaimIds.length < 2
      || claim.sourceTaskId !== current.id
      || claim.coverageIds.length !== 1 || claim.coverageIds[0] !== current.coverageIds[0]) {
      throw new Error('memory-knowledge: synthesized Wiki Claim identity, status, sources, or Coverage is invalid')
    }
    outputClaimIds.add(claimId)
    for (const sourceId of claim.sourceClaimIds) {
      const key = String(sourceId)
      if (!expectedIds.has(key) || retainedIds.has(key) || consumedIds.has(key)) {
        throw new Error('memory-knowledge: each file synthesis input Claim must be retained or consumed exactly once')
      }
      consumedIds.add(key)
    }
  }
  if (retainedIds.size + consumedIds.size !== expectedIds.size
    || [...expectedIds].some(value => !retainedIds.has(value) && !consumedIds.has(value))) {
    throw new Error('memory-knowledge: file synthesis must account for every input Claim exactly once')
  }
  let tasks = snapshot.tasks.map((task): WikiShardTask => task.id !== id
    ? structuredClone(task)
    : {
        ...structuredClone(task),
        status: 'succeeded',
        modelInputAudit: structuredClone(modelInputAudit ?? current.modelInputAudit),
        updatedAt: timestamp,
        completedAt: timestamp,
      })
  const claims = [...snapshot.claims.map(value => structuredClone(value)), ...structuredClone(submission.claims)]
  const run = structuredClone(snapshot.run)
  run.status = 'analyzing'
  const advanced = advanceWikiFileSynthesisTasks(tasks, claims, run.fileSynthesis, timestamp)
  tasks = advanced.tasks
  run.fileSynthesis = advanced.summary
  if (tasks.filter(task => task.kind === 'file-synthesis').every(task => task.status === 'succeeded')) {
    tasks = planVerification(
      run,
      tasks,
      snapshot.coverage,
      snapshot.citations,
      claims,
      timestamp,
      verificationBatchClaims,
      consistencyConfig,
      flowConfig,
      pageConfig,
    )
  }
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.businessQuestions = summarizeWikiBusinessQuestions(tasks)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  delete run.completedAt
  delete run.failure
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage: structuredClone(snapshot.coverage),
    tasks,
    citations: structuredClone(snapshot.citations),
    claims,
    conflicts: structuredClone(snapshot.conflicts),
    pages: structuredClone(snapshot.pages),
  })
}

/** Commit one running verifier's Claim decisions and explicit conflicts. */
export function succeedWikiVerificationTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  submission: WikiVerificationSubmission,
  now = new Date().toISOString(),
  consistencyConfig: WikiConsistencyConfig = DEFAULT_WIKI_CONSISTENCY_CONFIG,
  pageConfig: WikiPageConfig = DEFAULT_WIKI_PAGE_CONFIG,
  flowConfig: WikiCrossModuleFlowConfig = DEFAULT_WIKI_CROSS_MODULE_FLOW_CONFIG,
  modelInputAudit?: WikiModelInputAudit,
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const current = taskById(snapshot, id)
  if (current.status !== 'running') {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot succeed from ${current.status}`)
  }
  if (current.kind !== 'verification' && current.kind !== 'consistency') {
    throw new Error('memory-knowledge: this task does not accept a verification submission')
  }
  const expectedIds = new Set(current.claimIds.map(String))
  const decisions = new Map(submission.decisions.map(value => [String(value.claimId), value]))
  if (decisions.size !== submission.decisions.length || decisions.size !== expectedIds.size
    || [...decisions.keys()].some(value => !expectedIds.has(value))) {
    throw new Error('memory-knowledge: Wiki verification must decide every assigned Claim exactly once')
  }
  const conflictClaimIds = new Set(submission.conflicts
    .filter(conflict => conflict.status === 'open')
    .flatMap(conflict => conflict.claimIds.map(String)))
  if (submission.conflicts.some(conflict => conflict.claimIds.some(claimId => !expectedIds.has(String(claimId))))) {
    throw new Error('memory-knowledge: Wiki verification Conflict cannot modify Claims from another task')
  }
  if (current.kind === 'consistency') {
    const candidatePairs = new Set(current.candidatePairs.map(pair => pair.claimIds.map(String).sort().join('\0')))
    for (const conflict of submission.conflicts) {
      const ids = new Set(conflict.claimIds.map(String))
      const recalled = [...candidatePairs].some(pair => pair.split('\0').every(id => ids.has(id)))
      if (!recalled) throw new Error('memory-knowledge: Wiki consistency Conflict requires a recalled candidate pair')
    }
  }
  for (const [claimId, decision] of decisions) {
    if ((decision.status === 'conflicted') !== conflictClaimIds.has(claimId)) {
      throw new Error('memory-knowledge: conflicted verification decisions require an open submitted Conflict')
    }
  }
  const claims = snapshot.claims.map((claim): WikiClaim => {
    const decision = decisions.get(String(claim.id))
    return decision === undefined ? structuredClone(claim) : { ...structuredClone(claim), status: decision.status }
  })
  let tasks = snapshot.tasks.map((task): WikiShardTask => task.id !== id
    ? structuredClone(task)
    : {
        ...structuredClone(task),
        status: 'succeeded',
        modelInputAudit: structuredClone(modelInputAudit ?? current.modelInputAudit),
        updatedAt: timestamp,
        completedAt: timestamp,
      })
  const run = structuredClone(snapshot.run)
  if (current.kind === 'verification'
    && tasks.filter(task => task.kind === 'verification').every(task => task.status === 'succeeded')) {
    const plan = createWikiConsistencyTasks(
      snapshot.run.id,
      snapshot.coverage,
      [...snapshot.citations, ...submission.citations],
      claims,
      tasks,
      timestamp,
      consistencyConfig,
    )
    tasks = [...tasks, ...plan.tasks]
    run.consistency = plan.summary
    if (plan.tasks.length === 0) {
      tasks = planCrossModuleFlows(run, tasks, snapshot.coverage, claims, timestamp, flowConfig, pageConfig)
    } else {
      run.status = 'verifying'
    }
  } else if (current.kind === 'consistency'
    && tasks.filter(task => task.kind === 'consistency').every(task => task.status === 'succeeded')) {
    tasks = planCrossModuleFlows(run, tasks, snapshot.coverage, claims, timestamp, flowConfig, pageConfig)
  } else {
    run.status = 'verifying'
  }
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.businessQuestions = summarizeWikiBusinessQuestions(tasks)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  delete run.completedAt
  delete run.failure
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage: structuredClone(snapshot.coverage),
    tasks,
    citations: [...snapshot.citations.map(value => structuredClone(value)), ...structuredClone(submission.citations)],
    claims,
    conflicts: [...snapshot.conflicts.map(value => structuredClone(value)), ...structuredClone(submission.conflicts)],
    pages: structuredClone(snapshot.pages),
  })
}

/** Commit one flow task after every candidate Claim was either placed in evidence or left explicit. */
export function succeedWikiCrossModuleFlowTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  submission: WikiCrossModuleFlowSubmission,
  now = new Date().toISOString(),
  pageConfig: WikiPageConfig = DEFAULT_WIKI_PAGE_CONFIG,
  modelInputAudit?: WikiModelInputAudit,
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const current = taskById(snapshot, id)
  if (current.status !== 'running') {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot succeed from ${current.status}`)
  }
  if (current.kind !== 'flow') throw new Error('memory-knowledge: this task does not accept a flow submission')
  const assigned = new Set(current.claimIds.map(String))
  const accounted = new Set(submission.unresolvedClaimIds.map(String))
  if (accounted.size !== submission.unresolvedClaimIds.length
    || [...accounted].some(value => !assigned.has(value))) {
    throw new Error('memory-knowledge: unresolved flow Claims must be unique task inputs')
  }
  const claimById = new Map(snapshot.claims.map(claim => [String(claim.id), claim]))
  const flows = submission.flows.map((flow): WikiCrossModuleFlow => {
    const title = flow.title.trim()
    if (title.length === 0 || title.length > MAX_WIKI_PAGE_TITLE_CHARACTERS || flow.steps.length < 2) {
      throw new Error('memory-knowledge: a Wiki flow requires a bounded title and at least two steps')
    }
    const flowCoverage = new Set<string>()
    const steps = flow.steps.map(step => {
      const stepTitle = step.title.trim()
      if (stepTitle.length === 0 || stepTitle.length > MAX_WIKI_PAGE_TITLE_CHARACTERS
        || step.claimIds.length === 0 || new Set(step.claimIds.map(String)).size !== step.claimIds.length) {
        throw new Error('memory-knowledge: a Wiki flow step requires a bounded title and unique Claims')
      }
      for (const claimIdValue of step.claimIds) {
        const key = String(claimIdValue)
        if (!assigned.has(key) || accounted.has(key)) {
          throw new Error('memory-knowledge: each flow Claim must be used or unresolved exactly once')
        }
        accounted.add(key)
        for (const coverageIdValue of claimById.get(key)!.coverageIds) flowCoverage.add(String(coverageIdValue))
      }
      return { title: stepTitle, claimIds: [...step.claimIds] }
    })
    if (flowCoverage.size < 2) {
      throw new Error('memory-knowledge: a cross-module Wiki flow requires at least two Coverage items')
    }
    return { title, steps }
  })
  if (accounted.size !== assigned.size) {
    throw new Error('memory-knowledge: Wiki flow synthesis must account for every assigned Claim')
  }
  let tasks = snapshot.tasks.map((task): WikiShardTask => task.id !== id
    ? structuredClone(task)
    : {
        ...structuredClone(task),
        status: 'succeeded',
        modelInputAudit: structuredClone(modelInputAudit ?? current.modelInputAudit),
        crossModuleFlow: {
          rulesVersion: 1,
          state: 'completed',
          flows,
          unresolvedClaimIds: [...submission.unresolvedClaimIds],
        },
        updatedAt: timestamp,
        completedAt: timestamp,
      })
  const run = structuredClone(snapshot.run)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  if (tasks.filter(task => task.kind === 'flow').every(task => task.status === 'succeeded')) {
    tasks = planPageGeneration(run, tasks, snapshot.coverage, snapshot.claims, timestamp, pageConfig)
  } else {
    run.status = 'synthesizing'
  }
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.businessQuestions = summarizeWikiBusinessQuestions(tasks)
  run.crossModuleFlows = summarizeWikiCrossModuleFlows(tasks, run.crossModuleFlows)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  delete run.completedAt
  delete run.failure
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage: structuredClone(snapshot.coverage),
    tasks,
    citations: structuredClone(snapshot.citations),
    claims: structuredClone(snapshot.claims),
    conflicts: structuredClone(snapshot.conflicts),
    pages: structuredClone(snapshot.pages),
  })
}

/** Commit one running Page task's complete Claim organization tree. */
export function succeedWikiPageTask(
  snapshot: WikiRunSnapshot,
  id: WikiTaskId,
  submission: WikiPageSubmission,
  now = new Date().toISOString(),
): WikiRunSnapshot {
  const timestamp = canonicalTimestamp(now)
  const current = taskById(snapshot, id)
  if (current.status !== 'running') {
    throw new Error(`memory-knowledge: Wiki task ${id} cannot succeed from ${current.status}`)
  }
  if (current.kind !== 'page') throw new Error('memory-knowledge: this task does not accept a Page submission')
  if (submission.pages.length === 0 || submission.pages.length > current.claimIds.length + 1) {
    throw new Error('memory-knowledge: Page submission must contain a bounded non-empty tree')
  }

  const drafts = submission.pages.map((value): WikiPageDraft => {
    const slug = value.slug.trim()
    const title = value.title.trim()
    if (slug.length > MAX_WIKI_PAGE_SLUG_CHARACTERS || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      throw new Error('memory-knowledge: Page slug must be bounded lowercase kebab-case')
    }
    if (title.length === 0 || title.length > MAX_WIKI_PAGE_TITLE_CHARACTERS) {
      throw new Error('memory-knowledge: Page title is empty or too long')
    }
    if (new Set(value.claimIds).size !== value.claimIds.length
      || new Set(value.childSlugs).size !== value.childSlugs.length) {
      throw new Error('memory-knowledge: Page Claim ids and child slugs must be unique')
    }
    return { slug, title, claimIds: [...value.claimIds], childSlugs: value.childSlugs.map(child => child.trim()) }
  })
  const draftBySlug = new Map(drafts.map(value => [value.slug, value]))
  if (draftBySlug.size !== drafts.length) throw new Error('memory-knowledge: Page slugs must be unique within one task')
  const assignedClaims = new Set(current.claimIds.map(String))
  const submittedClaims = new Set<string>()
  const parents = new Map<string, string>()
  for (const draft of drafts) {
    if (draft.claimIds.length === 0 && draft.childSlugs.length === 0) {
      throw new Error('memory-knowledge: an empty Page must organize at least one child Page')
    }
    for (const claimIdValue of draft.claimIds) {
      const key = String(claimIdValue)
      if (!assignedClaims.has(key) || submittedClaims.has(key)) {
        throw new Error('memory-knowledge: Page submission must use each assigned Claim exactly once')
      }
      submittedClaims.add(key)
    }
    for (const childSlug of draft.childSlugs) {
      if (!draftBySlug.has(childSlug) || childSlug === draft.slug || parents.has(childSlug)) {
        throw new Error('memory-knowledge: Page children must be local, distinct, and singly owned')
      }
      parents.set(childSlug, draft.slug)
    }
  }
  if (submittedClaims.size !== assignedClaims.size) {
    throw new Error('memory-knowledge: Page submission must organize every assigned Claim exactly once')
  }
  const roots = drafts.filter(value => !parents.has(value.slug))
  if (roots.length !== 1) throw new Error('memory-knowledge: a Page task must submit exactly one root')

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (slug: string): void => {
    if (visiting.has(slug)) throw new Error('memory-knowledge: Page submission contains a cycle')
    if (visited.has(slug)) return
    visiting.add(slug)
    for (const child of draftBySlug.get(slug)!.childSlugs) visit(child)
    visiting.delete(slug)
    visited.add(slug)
  }
  visit(roots[0]!.slug)
  if (visited.size !== drafts.length) throw new Error('memory-knowledge: Page submission contains an orphan')

  const prefix = current.shardKey.replaceAll('_', '-')
  const idBySlug = new Map(drafts.map(value => [value.slug, createWikiPageId()]))
  const claimById = new Map(snapshot.claims.map(claim => [String(claim.id), claim]))
  const statusBySlug = new Map<string, WikiPage['status']>()
  const statusFor = (slug: string): WikiPage['status'] => {
    const cached = statusBySlug.get(slug)
    if (cached !== undefined) return cached
    const draft = draftBySlug.get(slug)!
    const statuses = [
      ...draft.claimIds.map(claimIdValue => claimById.get(String(claimIdValue))!.status),
      ...draft.childSlugs.map(statusFor),
    ]
    const status: WikiPage['status'] = statuses.includes('conflicted')
      ? 'conflicted'
      : statuses.includes('stale')
        ? 'stale'
        : statuses.length > 0 && statuses.every(value => value === 'verified')
          ? 'verified'
          : 'draft'
    statusBySlug.set(slug, status)
    return status
  }
  const submittedPages = drafts.map((draft): WikiPage => ({
    id: idBySlug.get(draft.slug)!,
    runId: snapshot.run.id,
    slug: `${prefix}-${draft.slug}`,
    title: draft.title,
    status: statusFor(draft.slug),
    sourceTaskId: current.id,
    claimIds: [...draft.claimIds],
    childPageIds: draft.childSlugs.map(slug => idBySlug.get(slug)!),
  }))
  let pages = [...snapshot.pages.map(value => structuredClone(value)), ...submittedPages]
  const tasks = snapshot.tasks.map((task): WikiShardTask => task.id !== id
    ? structuredClone(task)
    : {
        ...structuredClone(task),
        status: 'succeeded',
        updatedAt: timestamp,
        completedAt: timestamp,
      })
  const taskRoots = tasks.filter(task => task.kind === 'page' && task.status === 'succeeded')
    .sort((left, right) => left.shardKey.localeCompare(right.shardKey, 'und'))
    .map(task => {
      const taskPages = pages.filter(page => page.sourceTaskId === task.id)
      const childIds = new Set(taskPages.flatMap(page => page.childPageIds.map(String)))
      const rootsForTask = taskPages.filter(page => !childIds.has(String(page.id)))
      if (rootsForTask.length !== 1) throw new Error('memory-knowledge: completed Page task root is inconsistent')
      return rootsForTask[0]!
    })
  const allPageTasksComplete = tasks.filter(task => task.kind === 'page')
    .every(task => task.status === 'succeeded')
  const run = structuredClone(snapshot.run)
  if (allPageTasksComplete) {
    const overviewStatus: WikiPage['status'] = taskRoots.some(page => page.status === 'conflicted')
      ? 'conflicted'
      : taskRoots.some(page => page.status === 'stale')
        ? 'stale'
        : taskRoots.length > 0 && taskRoots.every(page => page.status === 'verified')
          ? 'verified'
          : 'draft'
    const overview: WikiPage = {
      id: createWikiPageId(),
      runId: snapshot.run.id,
      slug: `overview-${String(snapshot.run.id).slice(5)}`,
      title: 'Wiki',
      status: overviewStatus,
      claimIds: [],
      childPageIds: taskRoots.map(page => page.id),
    }
    pages = [...pages, overview]
    run.rootPageIds = [overview.id]
    run.status = 'needs-review'
  } else {
    run.rootPageIds = taskRoots.map(page => page.id)
    run.status = 'synthesizing'
  }
  run.materialRanges = summarizeWikiMaterialRanges(tasks)
  run.materialExposure = summarizeWikiMaterialExposure(tasks)
  run.tasks = summarizeWikiTasks(tasks)
  run.updatedAt = timestamp
  delete run.completedAt
  delete run.failure
  return finalizeWikiRunSnapshot({
    schemaVersion: snapshot.schemaVersion,
    run,
    coverage: structuredClone(snapshot.coverage),
    tasks,
    citations: structuredClone(snapshot.citations),
    claims: structuredClone(snapshot.claims),
    conflicts: structuredClone(snapshot.conflicts),
    pages,
  })
}
