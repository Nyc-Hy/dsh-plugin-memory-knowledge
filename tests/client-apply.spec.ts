import { describe, expect, it, vi } from 'vitest'
import { apply, inject as clientInject } from '../src/client/index.js'
import { MEMORY_UI_REMOTE_CONTRIBUTION } from '../src/remote-contract.js'

describe('memory knowledge client assembly', () => {
  it('mounts the Remote contribution before injecting its dynamic namespace', async () => {
    const dispose = vi.fn(async () => {})
    let finishMount!: (value: () => Promise<void>) => void
    const mount = vi.fn(() => new Promise<() => Promise<void>>(resolve => { finishMount = resolve }))
    const inject = vi.fn()
    const context = { remote: { $mount: mount }, inject }

    const applying = apply(context as never)
    await Promise.resolve()

    expect(mount).toHaveBeenCalledWith(MEMORY_UI_REMOTE_CONTRIBUTION)
    expect(inject).not.toHaveBeenCalled()

    finishMount(dispose)
    await expect(applying).resolves.toBe(dispose)
    expect(inject).toHaveBeenCalledWith(
      ['slots', 'locale', 'remote', 'remote.memoryKnowledgeUi'],
      expect.any(Function),
    )
    expect(clientInject).toEqual(['slots', 'locale', 'remote'])
  })
})
