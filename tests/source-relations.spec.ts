import { describe, expect, it } from 'vitest'
import {
  DeterministicSourceRelationAnalyzer,
  parseSourceRelationGraph,
  type SourceRelationFile,
} from '../src/source-relations.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

function files(): SourceRelationFile[] {
  return [
    {
      path: 'src/a.ts',
      contentHash: digest('a'),
      omittedModuleReferenceCount: 1,
      moduleReferences: [
        { kind: 'import', specifier: './b.js', startLine: 1, endLine: 1 },
        { kind: 'type-import', specifier: './types.js', startLine: 2, endLine: 2 },
        { kind: 'import', specifier: 'react', startLine: 3, endLine: 3 },
        { kind: 'dynamic-import', specifier: './missing.js', startLine: 4, endLine: 4 },
        { kind: 'import', specifier: '../../outside.js', startLine: 5, endLine: 5 },
        { kind: 'require', specifier: '/absolute/module.js', startLine: 6, endLine: 6 },
      ],
    },
    {
      path: 'src/b.ts',
      contentHash: digest('b'),
      omittedModuleReferenceCount: 0,
      moduleReferences: [{ kind: 're-export', specifier: './a.js', startLine: 1, endLine: 1 }],
    },
    { path: 'src/types.ts', contentHash: digest('c'), omittedModuleReferenceCount: 0, moduleReferences: [] },
  ]
}

describe('deterministic Source relations', () => {
  it('resolves internal relative modules and classifies external or unresolved specifiers', () => {
    const analyzer = new DeterministicSourceRelationAnalyzer({ maxRelations: 20 })
    const graph = analyzer.analyze({ files: files() })

    expect(graph).toMatchObject({
      relationCount: 7,
      internalRelationCount: 3,
      externalRelationCount: 1,
      unresolvedRelationCount: 3,
      omittedRelationCount: 1,
    })
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'src/a.ts', specifier: './b.js', resolution: 'internal', toPath: 'src/b.ts' }),
      expect.objectContaining({ fromPath: 'src/a.ts', specifier: './types.js', resolution: 'internal', toPath: 'src/types.ts' }),
      expect.objectContaining({ fromPath: 'src/a.ts', specifier: 'react', resolution: 'external' }),
      expect.objectContaining({ fromPath: 'src/a.ts', specifier: './missing.js', resolution: 'unresolved' }),
      expect.objectContaining({ fromPath: 'src/a.ts', specifier: '../../outside.js', resolution: 'unresolved' }),
      expect.objectContaining({ fromPath: 'src/a.ts', specifier: '/absolute/module.js', resolution: 'unresolved' }),
      expect.objectContaining({ fromPath: 'src/b.ts', specifier: './a.js', resolution: 'internal', toPath: 'src/a.ts' }),
    ]))
    expect(graph.areaRelations).toEqual([{ fromArea: 'src', toArea: 'src', relationCount: 3 }])
    expect(parseSourceRelationGraph(structuredClone(graph))).toEqual(graph)
  })

  it('is traversal-order independent and exposes bounded omissions', () => {
    const analyzer = new DeterministicSourceRelationAnalyzer({ maxRelations: 2 })
    const first = analyzer.analyze({ files: files() })
    const second = analyzer.analyze({ files: [...files()].reverse() })

    expect(second).toEqual(first)
    expect(first.relationCount).toBe(2)
    expect(first.omittedRelationCount).toBe(6)
  })

  it('re-resolves unchanged importer references against the current file set', () => {
    const analyzer = new DeterministicSourceRelationAnalyzer({ maxRelations: 20 })
    const current = files().map(file => file.path === 'src/b.ts' ? { ...file, path: 'src/renamed.ts' } : file)
    const edge = analyzer.analyze({ files: current }).edges.find(item => item.specifier === './b.js')

    expect(edge).toMatchObject({ fromPath: 'src/a.ts', resolution: 'unresolved' })
    expect(edge).not.toHaveProperty('toPath')
  })

  it('rejects durable graph tampering', () => {
    const graph = new DeterministicSourceRelationAnalyzer({ maxRelations: 20 }).analyze({ files: files() })
    const changed = structuredClone(graph)
    changed.internalRelationCount += 1
    expect(() => parseSourceRelationGraph(changed)).toThrow('inconsistent')
  })
})
