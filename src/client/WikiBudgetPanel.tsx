import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MemoryUiWikiBudget, MemoryUiWikiBudgetIncreaseRequest, MemoryUiWikiBudgetIncreaseResult,
  MemoryUiWikiBudgetsRequest, MemoryUiWikiBudgetsResult,
} from '../ui-contract.js'
import type { MemoryKnowledgeLocaleKey } from './locales.js'

/** 浏览器只按需查询任务账本；扩额必须包含用户核对过的账本哈希。 */
export interface WikiBudgetPanelOperations {
  wikiBudgets: (request: MemoryUiWikiBudgetsRequest) => Promise<MemoryUiWikiBudgetsResult>
  increaseWikiBudget: (request: MemoryUiWikiBudgetIncreaseRequest) => Promise<MemoryUiWikiBudgetIncreaseResult>
}

interface PanelProps {
  workspaceId: string
  runId: string
  refreshKey: string
  disabled: boolean
  operations: WikiBudgetPanelOperations
  t: PropsLocale<'memoryKnowledge'>['t']
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: MemoryUiWikiBudgetsResult }
type EditState = { taskId: string; input: string; confirmedLimit?: number }

const KIND_KEYS = {
  analysis: 'wikiBudgetAnalysis', 'file-synthesis': 'wikiBudgetFileSynthesis',
  verification: 'wikiBudgetVerification', consistency: 'wikiBudgetConsistency', page: 'wikiBudgetPage',
} as const satisfies Record<MemoryUiWikiBudget['kind'], MemoryKnowledgeLocaleKey>
const STATUS_KEYS = {
  planned: 'wikiRunPlanned', running: 'wikiBudgetRunning', succeeded: 'wikiRunComplete',
  failed: 'wikiRunFailed', cancelled: 'wikiRunCancelled',
} as const satisfies Record<MemoryUiWikiBudget['status'], MemoryKnowledgeLocaleKey>

function validLimit(input: string, budget: MemoryUiWikiBudget): number | undefined {
  const value = Number(input)
  return /^\d+$/.test(input) && Number.isSafeInteger(value) && value > budget.limitBytes
    && value - budget.reservedBytes >= (budget.blockedReadBytes ?? 0) ? value : undefined
}

function BudgetPanelState({ workspaceId, runId, refreshKey, disabled, operations, t }: PanelProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [onlyBlocked, setOnlyBlocked] = useState(false)
  const [cursor, setCursor] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<MemoryKnowledgeLocaleKey | null>(null)
  const mounted = useRef(false)
  const mutationInFlight = useRef(false)
  const { wikiBudgets, increaseWikiBudget } = operations

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!open) return
    let current = true
    setState({ status: 'loading' })
    setEdit(null)
    void wikiBudgets({ workspaceId, runId, onlyBlocked, ...(cursor === undefined ? {} : { afterTaskId: cursor }) })
      .then(value => { if (current) setState({ status: 'ready', value }) })
      .catch(() => { if (current) setState({ status: 'error' }) })
    return () => { current = false }
  }, [open, workspaceId, runId, onlyBlocked, cursor, refresh, refreshKey, wikiBudgets])

  const confirm = async (budget: MemoryUiWikiBudget, limitBytes: number): Promise<void> => {
    if (mutationInFlight.current || disabled) return
    mutationInFlight.current = true
    setSaving(true)
    setNotice(null)
    try {
      const result = await increaseWikiBudget({ workspaceId, runId, taskId: budget.taskId, limitBytes, expectedBudgetHash: budget.budgetHash })
      if (mounted.current) setNotice(result.outcome === 'updated' ? 'wikiBudgetUpdated' : 'wikiBudgetConflict')
    } catch {
      if (mounted.current) setNotice('wikiBudgetMutationError')
    } finally {
      mutationInFlight.current = false
      if (mounted.current) {
        setSaving(false)
        setEdit(null)
        setRefresh(value => value + 1)
      }
    }
  }

  const locked = disabled || saving
  return <section className="mk-budget">
    <button type="button" className="mk-budget-toggle" aria-expanded={open} disabled={saving}
      onClick={() => setOpen(value => !value)}>{t(open ? 'wikiBudgetHide' : 'wikiBudgetShow')}</button>
    {!open ? null : <div className="mk-budget-body">
      <p className="mk-status">{t('wikiBudgetDescription')}</p>
      <div className="mk-actions">
        <label className="mk-budget-filter"><input type="checkbox" checked={onlyBlocked} disabled={locked}
          onChange={event => { setOnlyBlocked(event.target.checked); setCursor(undefined); setNotice(null) }} />{t('wikiBudgetOnlyBlocked')}</label>
        <Button size="sm" variant="outline" disabled={locked} onClick={() => setRefresh(value => value + 1)}>{t('wikiBudgetRefresh')}</Button>
      </div>
      {notice === null ? null : <p role="status" className="mk-warning">{t(notice)}</p>}
      {state.status === 'loading' ? <p role="status" className="mk-status">{t('wikiBudgetLoading')}</p>
        : state.status === 'error' ? <p role="alert" className="mk-failure">{t('wikiBudgetError')}</p>
          : <>
            {state.value.items.length === 0 ? <p className="mk-status">{t('wikiBudgetEmpty')}</p> : null}
            <ul className="mk-list">{state.value.items.map(budget => {
              const activeEdit = edit?.taskId === budget.taskId ? edit : null
              const limit = activeEdit === null ? undefined : validLimit(activeEdit.input, budget)
              const canIncrease = budget.kind !== 'page' && ['running', 'failed', 'cancelled'].includes(budget.status)
              return <li className="mk-budget-task" key={budget.taskId}>
                <div className="mk-meta"><strong>{t(KIND_KEYS[budget.kind])}</strong><span>{t(STATUS_KEYS[budget.status])}</span></div>
                <code className="mk-budget-id">{budget.taskId}</code>
                <span>{t('wikiBudgetUsage', { used: budget.reservedBytes, limit: budget.limitBytes })}</span>
                <progress aria-label={t('wikiBudgetUsage', { used: budget.reservedBytes, limit: budget.limitBytes })} max={budget.limitBytes} value={budget.reservedBytes} />
                <span className="mk-meta">{t('wikiBudgetAccounting', { count: budget.reservationCount, attempt: budget.startedAtAttempt, time: budget.startedAt })}</span>
                {budget.blockedReadBytes === null ? null : <p className="mk-warning">{t('wikiBudgetBlocked', { bytes: budget.blockedReadBytes, remaining: budget.limitBytes - budget.reservedBytes })}</p>}
                {!canIncrease ? null : activeEdit === null ? <div className="mk-actions">
                  <Button size="sm" variant="outline" disabled={locked} onClick={() => { setEdit({ taskId: budget.taskId, input: '' }); setNotice(null) }}>{t('wikiBudgetIncrease')}</Button>
                </div> : <div className="mk-budget-edit">
                  {activeEdit.confirmedLimit === undefined ? <>
                    <label className="mk-budget-input">{t('wikiBudgetNewLimit')}
                      <input type="text" inputMode="numeric" value={activeEdit.input} disabled={locked}
                        onChange={event => setEdit({ taskId: budget.taskId, input: event.target.value })} />
                    </label>
                    <p className="mk-status">{t('wikiBudgetLimitHint', { limit: budget.limitBytes, minimum: (BigInt(budget.reservedBytes) + BigInt(budget.blockedReadBytes ?? 0)).toString() })}</p>
                    {activeEdit.input === '' || limit !== undefined ? null : <p role="alert" className="mk-warning">{t('wikiBudgetInvalid')}</p>}
                    <div className="mk-actions"><Button size="sm" variant="primary" disabled={locked || limit === undefined}
                      onClick={() => { if (limit !== undefined) setEdit({ ...activeEdit, confirmedLimit: limit }) }}>{t('wikiBudgetReview')}</Button>
                      <Button size="sm" variant="outline" disabled={locked} onClick={() => setEdit(null)}>{t('wikiBudgetCancel')}</Button></div>
                  </> : <>
                    <p className="mk-status">{t('wikiBudgetConfirmDescription', { old: budget.limitBytes, next: activeEdit.confirmedLimit, used: budget.reservedBytes })}</p>
                    <div className="mk-actions"><Button size="sm" variant="primary" disabled={locked}
                      onClick={() => { void confirm(budget, activeEdit.confirmedLimit!) }}>{t(saving ? 'wikiBudgetSaving' : 'wikiBudgetConfirm')}</Button>
                      <Button size="sm" variant="outline" disabled={locked} onClick={() => setEdit(null)}>{t('wikiBudgetCancel')}</Button></div>
                  </>}
                </div>}
              </li>
            })}</ul>
            {cursor === undefined && state.value.nextAfterTaskId === undefined ? null : <div className="mk-actions">
              <Button size="sm" variant="outline" disabled={locked || cursor === undefined} onClick={() => setCursor(undefined)}>{t('wikiBudgetFirstPage')}</Button>
              <Button size="sm" variant="outline" disabled={locked || state.value.nextAfterTaskId === undefined}
                onClick={() => { if (state.status === 'ready') setCursor(state.value.nextAfterTaskId) }}>{t('wikiBudgetNextPage')}</Button>
            </div>}
          </>}
    </div>}
  </section>
}

/** 项目或 Run 切换会销毁旧确认与请求状态。
 * @param props 当前项目、Run 和本地化操作。
 * @returns 按需加载的材料预算面板。
 */
export function WikiBudgetPanel(props: PanelProps): ReactNode {
  return <BudgetPanelState key={`${props.workspaceId}:${props.runId}`} {...props} />
}
