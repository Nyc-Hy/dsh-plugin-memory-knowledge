import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findProjectRoot } from '../src/workspace.js'
import { makeTempProject } from './helpers.js'

describe('workspace project-root resolution', () => {
  it('selects the nearest ancestor marker and returns its real path', async () => {
    const project = await makeTempProject()
    const nested = join(project, 'packages', 'feature')
    await mkdir(nested, { recursive: true })
    expect(await findProjectRoot(nested)).toBe(await realpath(project))

    await mkdir(join(nested, '.git'))
    expect(await findProjectRoot(nested)).toBe(await realpath(nested))
  })

  it('returns the starting directory when no configured marker exists', async () => {
    const project = await makeTempProject()
    const nested = join(project, 'scratch')
    await mkdir(nested)
    expect(await findProjectRoot(nested, ['absent.marker'])).toBe(await realpath(nested))
  })
})
