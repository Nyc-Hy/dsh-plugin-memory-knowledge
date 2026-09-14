import { describe, expect, it } from 'vitest'
import { activeWikiClaims, finalizeWikiRunSnapshot, parseWikiRunSnapshot, type WikiRunSnapshot } from '../src/wiki-model.js'
import { failWikiTask, succeedWikiFileSynthesisTask, succeedWikiPageTask, succeedWikiVerificationTask } from '../src/wiki-task.js'
import { completeSynthesisLayer, startSynthesisTask, synthesisFixture, synthesisSubmission, synthesisTime } from './wiki-synthesis-fixture.js'

function refinalize(snapshot: WikiRunSnapshot): WikiRunSnapshot {
  const { snapshotHash: _hash, ...payload } = snapshot
  return finalizeWikiRunSnapshot(payload)
}

describe('递归文件综合', () => {
  it.each(['assertion', 'inference'] as const)('两层来源链在恢复后进入核验和 Page：%s', kind => {
    let current = completeSynthesisLayer(synthesisFixture())
    expect(current.run.fileSynthesis).toMatchObject({ status: 'running', levelCount: 2, taskCount: 3, inputClaimCount: 4 })
    expect(current.tasks.some(task => task.kind === 'verification')).toBe(false)
    current = parseWikiRunSnapshot(JSON.parse(JSON.stringify(current)))
    const task = current.tasks.find(task => task.kind === 'file-synthesis' && task.status === 'planned')!
    expect(task.fileSynthesis).toEqual({ level: 1, batchIndex: 0, batchCount: 1 })
    const submission = synthesisSubmission(current, task)
    submission.claims[0]!.kind = kind
    current = succeedWikiFileSynthesisTask(startSynthesisTask(current, task), task.id, submission, synthesisTime)
    expect(current.run.fileSynthesis).toMatchObject({ status: 'complete', completeFileCount: 1, incompleteFileCount: 0 })
    expect(current.claims).toHaveLength(7)
    const active = activeWikiClaims(current.claims)
    expect(active).toEqual(submission.claims)
    const verifier = current.tasks.find(task => task.kind === 'verification')!
    expect(verifier.claimIds).toEqual(active.map(claim => claim.id))
    current = succeedWikiVerificationTask(startSynthesisTask(current, verifier), verifier.id, {
      decisions: [{ claimId: active[0]!.id, status: kind === 'assertion' ? 'verified' : 'uncertain' }], citations: [], conflicts: [],
    }, synthesisTime)
    const page = current.tasks.find(task => task.kind === 'page')!
    current = succeedWikiPageTask(startSynthesisTask(current, page), page.id, {
      pages: [{ slug: 'flow', title: '文件流程', claimIds: [...page.claimIds], childSlugs: [] }],
    }, synthesisTime)
    expect(current.run.status).toBe('needs-review')
    expect(current.pages.flatMap(page => page.claimIds)).toEqual(active.map(claim => claim.id))
  })

  it.each([
    { maxLevels: 8, reason: 'no-reduction' },
    { maxLevels: 1, reason: 'level-limit' },
  ] as const)('显式保留全部输入并以 $reason 停止，不创建循环任务', ({ maxLevels, reason }) => {
    let current = synthesisFixture({ maxClaimsPerTask: 2, maxStatementCharactersPerTask: 20_000, maxLevels })
    for (const task of current.tasks.filter(task => task.kind === 'file-synthesis')) {
      current = succeedWikiFileSynthesisTask(startSynthesisTask(current, task), task.id,
        { retainedClaimIds: [...task.claimIds], claims: [] }, synthesisTime)
    }
    expect(current.run.fileSynthesis).toMatchObject({
      status: 'incomplete', levelCount: 1, taskCount: 2, incompleteFileCount: 1,
      noReductionFileCount: reason === 'no-reduction' ? 1 : 0,
      levelLimitFileCount: reason === 'level-limit' ? 1 : 0,
    })
    expect(current.tasks.filter(task => task.fileSynthesis?.outcome === reason)).toHaveLength(1)
    expect(activeWikiClaims(current.claims)).toHaveLength(4)
    expect(current.run.status).toBe('verifying')
  })

  it('保留项和综合结果一起进入下一层，最终单批无需强行归并', () => {
    let current = synthesisFixture({ maxClaimsPerTask: 3, maxStatementCharactersPerTask: 20_000, maxLevels: 8 }, 6)
    const tasks = current.tasks.filter(task => task.kind === 'file-synthesis')
    for (const [index, task] of tasks.entries()) {
      const submission = synthesisSubmission(current, task)
      if (index === 1) {
        const retained = submission.claims[0]!.sourceClaimIds.pop()!
        submission.retainedClaimIds.push(retained)
        submission.claims[0]!.citationIds = current.claims.filter(claim => submission.claims[0]!.sourceClaimIds.includes(claim.id))
          .flatMap(claim => claim.citationIds)
      }
      current = succeedWikiFileSynthesisTask(startSynthesisTask(current, task), task.id, submission, synthesisTime)
    }
    const final = current.tasks.find(task => task.kind === 'file-synthesis' && task.status === 'planned')!
    expect(final.claimIds).toHaveLength(3)
    expect(new Set(final.claimIds)).toEqual(new Set(activeWikiClaims(current.claims).map(claim => claim.id)))
    current = succeedWikiFileSynthesisTask(startSynthesisTask(current, final), final.id,
      { retainedClaimIds: [...final.claimIds], claims: [] }, synthesisTime)
    expect(current.run.fileSynthesis.status).toBe('complete')
    expect(activeWikiClaims(current.claims)).toHaveLength(3)
  })

  it('第二层失败重试保留已完成层和来源，不重复生成结果', () => {
    let current = completeSynthesisLayer(synthesisFixture())
    let task = current.tasks.find(task => task.kind === 'file-synthesis' && task.status === 'planned')!
    const before = structuredClone(current.claims)
    current = failWikiTask(startSynthesisTask(current, task), task.id, '模拟模型中断', synthesisTime)
    current = parseWikiRunSnapshot(JSON.parse(JSON.stringify(current)))
    expect(current.claims).toEqual(before)
    task = current.tasks.find(value => value.id === task.id)!
    current = succeedWikiFileSynthesisTask(startSynthesisTask(current, task), task.id,
      synthesisSubmission(current, task), synthesisTime)
    expect(current.tasks.find(value => value.id === task.id)?.attemptCount).toBe(2)
    expect(current.claims).toHaveLength(7)
  })

  it('不允许递归时丢弃上一层的底层支持证据', () => {
    const current = completeSynthesisLayer(synthesisFixture())
    const task = current.tasks.find(task => task.fileSynthesis?.level === 1)!
    const submission = synthesisSubmission(current, task)
    expect(submission.claims[0]!.citationIds).toHaveLength(4)
    submission.claims[0]!.citationIds.pop()
    expect(() => succeedWikiFileSynthesisTask(startSynthesisTask(current, task), task.id, submission, synthesisTime))
      .toThrow('递归综合必须继承来源综合声明的全部支持引用')
  })

  it('拒绝缺失输入、跳层、伪造停止原因和循环来源', () => {
    const current = completeSynthesisLayer(synthesisFixture())
    const missing = structuredClone(current)
    missing.tasks.find(task => task.fileSynthesis?.level === 1)!.claimIds.pop()
    expect(() => refinalize(missing)).toThrow(/综合下一层/)
    const skipped = structuredClone(current)
    skipped.tasks.find(task => task.fileSynthesis?.level === 1)!.fileSynthesis!.level = 2
    expect(() => refinalize(skipped)).toThrow(/summary is inconsistent|综合层/)
    const stopped = structuredClone(current)
    stopped.tasks.filter(task => task.fileSynthesis?.level === 0).at(-1)!.fileSynthesis!.outcome = 'level-limit'
    expect(() => refinalize(stopped)).toThrow(/summary is inconsistent|停止原因/)
    const final = completeSynthesisLayer(current)
    const cyclic = structuredClone(final)
    const root = activeWikiClaims(cyclic.claims)[0]!
    cyclic.claims.find(claim => claim.id === root.sourceClaimIds[0])!.sourceClaimIds[0] = root.id
    expect(() => refinalize(cyclic)).toThrow(/综合下一层|source|来源/)
    const wrongOwner = structuredClone(final)
    activeWikiClaims(wrongOwner.claims)[0]!.sourceTaskId = wrongOwner.tasks[0]!.id
    expect(() => refinalize(wrongOwner)).toThrow(/综合下一层|synthesis task/)
  })
})
