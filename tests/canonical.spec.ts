import { rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCanonicalStore } from '../src/canonical.js'
import { makeTempProject, readJson, writeJson } from './helpers.js'

const memoryId = 'mem_33333333-3333-4333-8333-333333333333'

describe('canonical store', () => {
  it('reads one detached, validated project store', async () => {
    const project = await makeTempProject()
    const store = await readCanonicalStore(project)
    expect(store.manifest.sources).toHaveLength(1)
    expect(store.memories.map(memory => memory.id)).toEqual([memoryId])
    expect(store.cards).toHaveLength(1)
  })

  it('rejects a filename that disagrees with the durable id', async () => {
    const project = await makeTempProject()
    const directory = join(project, '.dsh', 'knowledge', 'entries')
    await rename(join(directory, `${memoryId}.json`), join(directory, 'mem_55555555-5555-4555-8555-555555555555.json'))
    await expect(readCanonicalStore(project)).rejects.toMatchObject({
      code: 'KNOWLEDGE_INVARIANT',
    })
  })

  it('rejects a scope outside the manifest source universe', async () => {
    const project = await makeTempProject()
    const path = join(project, '.dsh', 'knowledge', 'entries', `${memoryId}.json`)
    const entry = await readJson(path)
    entry.scope = { kind: 'source', sourceId: 'src_66666666-6666-4666-8666-666666666666' }
    await writeJson(path, entry)
    await expect(readCanonicalStore(project)).rejects.toMatchObject({
      code: 'KNOWLEDGE_INVARIANT',
    })
  })

  it('requires portable evidence or human verification for session-only provenance', async () => {
    const project = await makeTempProject()
    const path = join(project, '.dsh', 'knowledge', 'entries', `${memoryId}.json`)
    const entry = await readJson(path)
    entry.evidenceClass = 'ai-suggested'
    entry.provenance = [{ kind: 'session', sessionId: 'session-1', eventSeqs: [1] }]
    await writeJson(path, entry)
    await expect(readCanonicalStore(project)).rejects.toMatchObject({
      code: 'KNOWLEDGE_INVARIANT',
    })
  })

  it('rejects a symlinked canonical collection', async () => {
    const project = await makeTempProject()
    const knowledgeRoot = join(project, '.dsh', 'knowledge')
    const entries = join(knowledgeRoot, 'entries')
    const target = join(knowledgeRoot, 'entries-target')
    await rename(entries, target)
    await symlink(target, entries, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readCanonicalStore(project)).rejects.toMatchObject({
      code: 'KNOWLEDGE_INVARIANT',
    })
  })
})
