import { SessionId } from '@deepseek-ai/dsh-session'
import { createWikiCitationId, createWikiClaimId, KnowledgeSourceId } from '../src/ids.js'
import { createPlannedWikiRun, type WikiFileSynthesisConfig, type WikiRunSnapshot, type WikiShardTask } from '../src/wiki-model.js'
import { startWikiTask, succeedWikiFileSynthesisTask, succeedWikiTask, type WikiFileSynthesisSubmission } from '../src/wiki-task.js'
import { testBusinessQuestionFindings } from './wiki-business-question-fixture.js'

export const synthesisTime = '2026-09-03T00:00:00.000Z'

/** 纯状态机材料，每个区间产出一条声明；不读取真实文件。 */
export function synthesisFixture(
  config: WikiFileSynthesisConfig = { maxClaimsPerTask: 2, maxStatementCharactersPerTask: 20_000, maxLevels: 8 },
  rangeCount = 4,
  projectRoot = '/workspace/recursive-wiki',
): WikiRunSnapshot {
  const sourceId = KnowledgeSourceId('src_11111111-1111-4111-8111-111111111111')
  const contentHash = `sha256:${'a'.repeat(64)}`
  let current = createPlannedWikiRun({
    projectRoot, catalogHash: contentHash, catalogComplete: true, catalogOmittedItemCount: 0, now: synthesisTime,
    entries: [{
      sourceId, path: 'large.unknown', byteSize: 100 * rangeCount,
      revision: { kind: 'git-object', commit: 'b'.repeat(40), objectId: 'c'.repeat(40) },
      preparedMaterial: {
        contentHash,
        ranges: Array.from({ length: rangeCount }, (_, ordinal) => ({
          ordinal, startByte: ordinal * 100, endByte: (ordinal + 1) * 100,
          startLine: ordinal + 1, endLine: ordinal + 1,
          contentStartByte: ordinal * 100, contentEndByte: (ordinal + 1) * 100,
          contentStartLine: ordinal + 1, contentEndLine: ordinal + 1, contentHash,
        })),
      },
    }],
  })
  for (const task of [...current.tasks]) {
    const range = task.materialRanges[0]!
    const citationId = createWikiCitationId()
    const claimId = createWikiClaimId()
    current = succeedWikiTask(startSynthesisTask(current, task), task.id, {
      coverage: [{ coverageId: task.coverageIds[0]!, rangeId: range.id, status: 'analyzed', contentHash }],
      citations: [{
        id: citationId, runId: current.run.id, role: 'supports', rangeId: range.id,
        provenance: { kind: 'git-file', sourceId, path: 'large.unknown', commit: 'b'.repeat(40), contentHash,
          startLine: range.startLine, endLine: range.endLine },
      }],
      claims: [{
        id: claimId, runId: current.run.id, kind: 'assertion', status: 'proposed',
        statement: `区间 ${range.ordinal} 明确记录处理步骤。`, citationIds: [citationId],
        coverageIds: [...task.coverageIds], sourceClaimIds: [],
      }],
      businessQuestions: testBusinessQuestionFindings([claimId]),
    }, synthesisTime, undefined, undefined, undefined, config)
  }
  return current
}

export function startSynthesisTask(snapshot: WikiRunSnapshot, task: WikiShardTask): WikiRunSnapshot {
  return startWikiTask(snapshot, task.id, SessionId(`session-${task.id}-${task.attemptCount}`), synthesisTime)
}

export function synthesisSubmission(snapshot: WikiRunSnapshot, task: WikiShardTask): WikiFileSynthesisSubmission {
  const sources = snapshot.claims.filter(claim => task.claimIds.includes(claim.id))
  return {
    retainedClaimIds: [],
    claims: [{
      id: createWikiClaimId(), runId: snapshot.run.id, kind: 'assertion', status: 'proposed',
      statement: '这些区间描述同一处理流程的相关步骤。',
      sourceClaimIds: [...task.claimIds], sourceTaskId: task.id, coverageIds: [...task.coverageIds],
      citationIds: [...new Set(sources.flatMap(claim => claim.citationIds))],
    }],
  }
}

export function completeSynthesisLayer(snapshot: WikiRunSnapshot): WikiRunSnapshot {
  let current = snapshot
  for (const task of snapshot.tasks.filter(task => task.kind === 'file-synthesis' && task.status === 'planned')) {
    current = succeedWikiFileSynthesisTask(startSynthesisTask(current, task), task.id,
      synthesisSubmission(current, task), synthesisTime)
  }
  return current
}
