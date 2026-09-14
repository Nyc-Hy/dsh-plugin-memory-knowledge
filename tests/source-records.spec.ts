import { describe, expect, it } from 'vitest'
import type { SourceInventory } from '../src/inventory.js'
import {
  buildSourceUnderstanding,
  parseSourceUnderstanding,
  summarizeSourceUnderstanding,
} from '../src/source-records.js'

const sourceId = 'src_22222222-2222-4222-8222-222222222222' as never
const commit = 'a'.repeat(40)
const digest = (character: string): string => `sha256:${character.repeat(64)}`

function inventory(overrides: Partial<SourceInventory> = {}): SourceInventory {
  return {
    version: 3,
    sourceId,
    state: 'ready',
    commit,
    branch: 'main',
    dirty: false,
    reuseKey: digest('e'),
    scanMode: 'full',
    reusedFileCount: 0,
    readFileCount: 5,
    inventoryHash: digest('f'),
    fileCount: 5,
    totalBytes: 150,
    files: [
      {
        path: 'src/main.ts',
        size: 50,
        contentHash: digest('1'),
        language: 'TypeScript',
        analysis: {
          provider: 'deterministic-source-evidence',
          version: 3,
          evidence: [{ kind: 'code-symbol', name: 'main', declaration: 'function', exported: true, startLine: 3, endLine: 3 }],
          omittedEvidenceCount: 0,
          moduleReferences: [{ kind: 'import', specifier: '../tests/main.spec.js', startLine: 1, endLine: 1 }],
          omittedModuleReferenceCount: 0,
        },
      },
      { path: 'tests/main.spec.ts', size: 40, contentHash: digest('2'), language: 'TypeScript' },
      { path: 'README.md', size: 30, contentHash: digest('3'), language: 'Markdown' },
      { path: 'config/app.yaml', size: 20, contentHash: digest('4'), language: 'YAML' },
      { path: 'public/logo.svg', size: 10, contentHash: digest('5') },
    ],
    issues: [],
    ...overrides,
  }
}

describe('deterministic Source records', () => {
  it('builds the same bounded checkpoint regardless of inventory traversal order', () => {
    const config = { maxRepresentativeFilesPerArea: 1 }
    const first = buildSourceUnderstanding(inventory(), config)
    const reordered = inventory({ files: [...inventory().files].reverse() })
    const second = buildSourceUnderstanding(reordered, config)

    expect(second).toEqual(first)
    expect(first.records.map(record => record.path)).toEqual([
      'README.md',
      'config/app.yaml',
      'public/logo.svg',
      'src/main.ts',
      'tests/main.spec.ts',
    ])
    expect(first.records.find(record => record.path === 'tests/main.spec.ts')).toMatchObject({ artifactKind: 'test' })
    expect(first.records.find(record => record.path === 'README.md')).toMatchObject({ artifactKind: 'documentation' })
    expect(first.records.find(record => record.path === 'config/app.yaml')).toMatchObject({ artifactKind: 'configuration' })
    expect(first.records.find(record => record.path === 'public/logo.svg')).toMatchObject({ artifactKind: 'asset' })
    expect(first.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(first.checkpointKey).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(first.relations).toMatchObject({
      relationCount: 1,
      internalRelationCount: 1,
      areaRelations: [{ fromArea: 'src', toArea: 'tests', relationCount: 1 }],
    })
  })

  it('round-trips a strict durable payload and rejects inconsistent derived fields', () => {
    const value = buildSourceUnderstanding(inventory(), { maxRepresentativeFilesPerArea: 2 })
    expect(parseSourceUnderstanding(structuredClone(value))).toEqual(value)

    const changed = structuredClone(value) as unknown as Record<string, unknown>
    const records = changed['records'] as Array<Record<string, unknown>>
    records[0]!['artifactKind'] = 'code'
    expect(() => parseSourceUnderstanding(changed)).toThrow('inconsistent')
  })

  it('rejects duplicate durable record paths before indexing', () => {
    const value = structuredClone(buildSourceUnderstanding(inventory(), { maxRepresentativeFilesPerArea: 2 }))
    value.records.push(structuredClone(value.records[0]!))
    expect(() => parseSourceUnderstanding(value)).toThrow('record paths must be unique')
  })

  it('returns a browser-safe summary without file paths or record groups', () => {
    const value = buildSourceUnderstanding(inventory(), { maxRepresentativeFilesPerArea: 2 })
    const summary = summarizeSourceUnderstanding(value)

    expect(summary).toMatchObject({
      sourceId,
      recordCount: 5,
      evidenceCount: 1,
      totalBytes: 150,
      areaCount: 5,
      relationCount: 1,
      internalRelationCount: 1,
      symbolDefinitionCount: 0,
      symbolReferenceCount: 0,
      omittedSymbolFileCount: 0,
      omittedSymbolReferenceCount: 0,
      symbolConfigMode: 'default',
      symbolConfigFileCount: 0,
      symbolProjectReferenceCount: 0,
      symbolPathAliasCount: 0,
      symbolConfigDiagnosticCount: 0,
      omittedSymbolConfigFileCount: 0,
    })
    expect(JSON.stringify(summary)).not.toContain('src/main.ts')
    expect(summary).not.toHaveProperty('records')
    expect(summary).not.toHaveProperty('areas')
  })

  it('refuses dirty or incomplete inventories', () => {
    const config = { maxRepresentativeFilesPerArea: 2 }
    const degraded = inventory({ state: 'degraded' })
    delete degraded.commit
    expect(() => buildSourceUnderstanding(inventory({ dirty: true }), config)).toThrow('clean, complete')
    expect(() => buildSourceUnderstanding(degraded, config))
      .toThrow('clean, complete')
  })
})
