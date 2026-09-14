// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WikiBudgetPanel, type WikiBudgetPanelOperations } from '../src/client/WikiBudgetPanel.js'
import { zh, type MemoryKnowledgeLocaleKey } from '../src/client/locales.js'
import type { MemoryUiWikiBudget, MemoryUiWikiBudgetIncreaseResult, MemoryUiWikiBudgetsResult } from '../src/ui-contract.js'

afterEach(cleanup)
const budget: MemoryUiWikiBudget = {
  taskId: `wtask_${'1'.repeat(64)}`, kind: 'analysis', status: 'failed',
  limitBytes: 100, reservedBytes: 60, reservationCount: 1, blockedReadBytes: 60,
  startedAt: '2026-09-03T00:00:00.000Z', startedAtAttempt: 2, budgetHash: `sha256:${'a'.repeat(64)}`,
}
const runId = 'wrun_11111111-1111-4111-8111-111111111111'
const page: MemoryUiWikiBudgetsResult = { runId, items: [budget] }
const t = ((key: MemoryKnowledgeLocaleKey, params?: Record<string, unknown>): string => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}) as PropsLocale<'memoryKnowledge'>['t']

function setup() {
  const operations = {
    wikiBudgets: vi.fn<WikiBudgetPanelOperations['wikiBudgets']>(async () => page),
    increaseWikiBudget: vi.fn<WikiBudgetPanelOperations['increaseWikiBudget']>(async () => ({ outcome: 'updated' })),
  }
  const props = { workspaceId: 'one', runId, refreshKey: '1', disabled: false, operations, t }
  return { operations, props }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
async function openAndReview() {
  fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetShow }))
  fireEvent.click(await screen.findByRole('button', { name: zh.wikiBudgetIncrease }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.wikiBudgetNewLimit }), { target: { value: '120' } })
  fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetReview }))
}

describe('Wiki 预算人工确认面板', () => {
  it('默认不查询；展示预扣、拒绝原因，取消核对不写账本', async () => {
    const test = setup()
    render(<WikiBudgetPanel {...test.props} />)
    expect(test.operations.wikiBudgets).not.toHaveBeenCalled()
    await openAndReview()
    expect(test.operations.wikiBudgets).toHaveBeenCalledWith({ workspaceId: 'one', runId, onlyBlocked: false })
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('60')
    expect(screen.getByText('本次读取需要 60 字节，剩余 40 字节；已阻止读取，需人工扩额后再继续。')).toBeTruthy()
    expect(screen.getByText(/任务总额度：100 → 120 字节/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetCancel }))
    expect(test.operations.increaseWikiBudget).not.toHaveBeenCalled()
  })

  it('新总额度必须为安全整数且覆盖拒绝读取；只在二次确认后提交一次', async () => {
    const test = setup()
    const update = deferred<MemoryUiWikiBudgetIncreaseResult>()
    test.operations.increaseWikiBudget.mockReturnValue(update.promise)
    render(<WikiBudgetPanel {...test.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetShow }))
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiBudgetIncrease }))
    const input = screen.getByRole('textbox', { name: zh.wikiBudgetNewLimit })
    for (const value of ['100', '110', '-120', '120.5', '1e3', '9007199254740992']) {
      fireEvent.change(input, { target: { value } })
      expect(screen.getByRole('button', { name: zh.wikiBudgetReview }).hasAttribute('disabled')).toBe(true)
    }
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetReview }))
    expect(test.operations.increaseWikiBudget).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: zh.wikiBudgetConfirm })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(test.operations.increaseWikiBudget).toHaveBeenCalledTimes(1)
    expect(test.operations.increaseWikiBudget).toHaveBeenCalledWith({
      workspaceId: 'one', runId, taskId: budget.taskId, limitBytes: 120, expectedBudgetHash: budget.budgetHash,
    })
    test.operations.wikiBudgets.mockResolvedValue({ runId, items: [{ ...budget, limitBytes: 120, blockedReadBytes: null }] })
    await act(async () => { update.resolve({ outcome: 'updated' }); await update.promise })
    expect(await screen.findByText(zh.wikiBudgetUpdated)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('max')).toBe('120'))
  })

  it.each(['conflict', 'error'] as const)('扩额结果为 %s 时重新查询，不自动重复扩额', async outcome => {
    const test = setup()
    if (outcome === 'error') test.operations.increaseWikiBudget.mockRejectedValue(new Error('/private/host/path'))
    else test.operations.increaseWikiBudget.mockResolvedValue({ outcome })
    const rendered = render(<WikiBudgetPanel {...test.props} />)
    await openAndReview()
    test.operations.wikiBudgets.mockResolvedValue({ runId, items: [{ ...budget, limitBytes: 200, blockedReadBytes: null }] })
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetConfirm }))
    expect(await screen.findByText(zh[outcome === 'conflict' ? 'wikiBudgetConflict' : 'wikiBudgetMutationError'])).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('max')).toBe('200'))
    expect(test.operations.increaseWikiBudget).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: zh.wikiBudgetConfirm })).toBeNull()
    expect(rendered.container.textContent).not.toContain('/private/host/path')
  })

  it('筛选与分页使用游标；刷新失败可重试', async () => {
    const test = setup()
    test.operations.wikiBudgets.mockResolvedValueOnce({ ...page, nextAfterTaskId: budget.taskId })
    render(<WikiBudgetPanel {...test.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetShow }))
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiBudgetNextPage }))
    await waitFor(() => expect(test.operations.wikiBudgets).toHaveBeenLastCalledWith({ workspaceId: 'one', runId, onlyBlocked: false, afterTaskId: budget.taskId }))
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiBudgetFirstPage }))
    await waitFor(() => expect(test.operations.wikiBudgets).toHaveBeenLastCalledWith({ workspaceId: 'one', runId, onlyBlocked: false }))
    test.operations.wikiBudgets.mockRejectedValueOnce(new Error('read failed'))
    fireEvent.click(screen.getByRole('checkbox', { name: zh.wikiBudgetOnlyBlocked }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.wikiBudgetError)
    test.operations.wikiBudgets.mockResolvedValue({ runId, items: [] })
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetRefresh }))
    expect(await screen.findByText(zh.wikiBudgetEmpty)).toBeTruthy()
    expect(test.operations.wikiBudgets).toHaveBeenLastCalledWith({ workspaceId: 'one', runId, onlyBlocked: true })
  })

  it('旧查询和旧扩额响应都不能污染切换后的项目', async () => {
    const test = setup()
    const old = deferred<MemoryUiWikiBudgetsResult>()
    test.operations.wikiBudgets.mockReturnValueOnce(old.promise)
    const rendered = render(<WikiBudgetPanel {...test.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetShow }))
    rendered.rerender(<WikiBudgetPanel {...test.props} workspaceId="two" />)
    await act(async () => { old.resolve(page); await old.promise })
    expect(screen.queryByRole('progressbar')).toBeNull()
    await openAndReview()
    const update = deferred<MemoryUiWikiBudgetIncreaseResult>()
    test.operations.increaseWikiBudget.mockReturnValueOnce(update.promise)
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetConfirm }))
    expect(test.operations.increaseWikiBudget.mock.calls[0]![0].workspaceId).toBe('two')
    rendered.rerender(<WikiBudgetPanel {...test.props} workspaceId="three" />)
    await act(async () => { update.resolve({ outcome: 'updated' }); await update.promise })
    expect(screen.queryByText(zh.wikiBudgetUpdated)).toBeNull()
    expect(test.operations.wikiBudgets).toHaveBeenCalledTimes(2)
  })

  it('重新查询会丢弃旧查询结果和旧确认；已完成任务不提供扩额', async () => {
    const test = setup()
    const old = deferred<MemoryUiWikiBudgetsResult>()
    test.operations.wikiBudgets.mockReturnValueOnce(old.promise)
    const rendered = render(<WikiBudgetPanel {...test.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetShow }))
    fireEvent.click(screen.getByRole('button', { name: zh.wikiBudgetRefresh }))
    fireEvent.click(await screen.findByRole('button', { name: zh.wikiBudgetIncrease }))
    await act(async () => { old.resolve({ runId, items: [] }); await old.promise })
    expect(screen.getByRole('textbox')).toBeTruthy()
    test.operations.wikiBudgets.mockResolvedValue({ runId, items: [{ ...budget, status: 'succeeded' }] })
    rendered.rerender(<WikiBudgetPanel {...test.props} refreshKey="2" />)
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    expect(await screen.findByText(zh.wikiRunComplete)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.wikiBudgetIncrease })).toBeNull()
  })
})
