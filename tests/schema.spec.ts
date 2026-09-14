import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertMemoryEntry, isPortableRelativePath, KnowledgeSchemaError, schemaDocuments } from '../src/schema.js'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'repository',
  '.dsh',
  'knowledge',
  'entries',
  'mem_33333333-3333-4333-8333-333333333333.json',
)

describe('canonical schemas', () => {
  it('rejects unknown durable fields', async () => {
    const entry = JSON.parse(await readFile(fixtureEntry, 'utf8')) as Record<string, unknown>
    entry.unexpected = true
    expect(() => { assertMemoryEntry(entry) }).toThrow(KnowledgeSchemaError)
  })

  it.each([
    '/absolute/path',
    'C:/absolute/path',
    '../parent/path',
    'source/../parent',
    'windows\\path',
    'windows:invalid',
  ])('rejects non-portable path %s', path => {
    expect(isPortableRelativePath(path)).toBe(false)
  })

  it.each(['src/example.ts', '.github/workflows/check.yml'])('accepts portable path %s', path => {
    expect(isPortableRelativePath(path)).toBe(true)
  })

  it.each(Object.entries(schemaDocuments))('keeps generated %s fresh', async (name, schema) => {
    const actual = await readFile(join(repositoryRoot, 'schemas', name), 'utf8')
    expect(actual).toBe(`${JSON.stringify(schema, null, 2)}\n`)
  })
})
