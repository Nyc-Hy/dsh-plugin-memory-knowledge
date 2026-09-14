import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOURCE_SYMBOL_CONFIG,
  parseSourceSymbolGraph,
  TypeScriptSourceSymbolAnalyzer,
  type SourceSymbolFile,
  type SourceSymbolFileReader,
} from '../src/source-symbols.js'

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function fixture(files: Record<string, string>): {
  reader: SourceSymbolFileReader
  inventory: SourceSymbolFile[]
} {
  const encoded = new Map(Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]))
  return {
    reader: {
      read: async (_projectRoot, path) => {
        const bytes = encoded.get(path)
        if (bytes === undefined) throw new Error(`missing fixture ${path}`)
        return bytes
      },
    },
    inventory: [...encoded].map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      contentHash: sha256(bytes),
      language: 'TypeScript',
    })),
  }
}

describe('TypeScript Source symbols', () => {
  it('resolves bounded cross-file definitions and import, type, and value references', async () => {
    const input = fixture({
      'src/model.ts': 'export interface User { name: string }\nexport function greet(user: User): string { return user.name }\n',
      'src/main.ts': "import { greet, type User } from './model.js'\nexport const result = greet({ name: 'Ada' } satisfies User)\n",
    })
    const analyzer = new TypeScriptSourceSymbolAnalyzer(input.reader)
    const graph = await analyzer.analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.provider).toBe('typescript-program-symbols')
    expect(graph.analyzedFileCount).toBe(2)
    expect(graph.omittedFileCount).toBe(0)
    expect(graph.definitions.map(definition => definition.name)).toEqual(expect.arrayContaining(['User', 'greet']))
    expect(graph.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'src/main.ts', kind: 'import', startLine: 1 }),
      expect.objectContaining({ fromPath: 'src/main.ts', kind: 'value', startLine: 2 }),
      expect.objectContaining({ fromPath: 'src/main.ts', kind: 'type', startLine: 2 }),
    ]))
    expect(parseSourceSymbolGraph(structuredClone(graph))).toEqual(graph)
  })

  it('resolves baseUrl and paths aliases from a bounded root tsconfig', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@model/*': ['src/model/*'] } },
      }),
      'src/model/user.ts': 'export interface User { name: string }\n',
      'src/main.ts': "import type { User } from '@model/user.js'\nexport const user: User = { name: 'Ada' }\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toEqual({
      mode: 'tsconfig',
      configPaths: ['tsconfig.json'],
      projectReferenceCount: 0,
      pathAliasCount: 1,
      diagnosticCount: 0,
      omittedConfigFileCount: 0,
    })
    expect(graph.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'User', path: 'src/model/user.ts' }),
    ]))
    expect(graph.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'src/main.ts', kind: 'import' }),
      expect.objectContaining({ fromPath: 'src/main.ts', kind: 'type' }),
    ]))
  })

  it('uses the nearest root-contained referenced project config', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({ references: [{ path: './packages/core' }] }),
      'packages/core/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#/*': ['src/*'] } },
      }),
      'packages/core/src/value.ts': 'export const value = 1\n',
      'packages/core/src/main.ts': "import { value } from '#/value.js'\nexport const result = value\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({
      mode: 'tsconfig',
      configPaths: ['packages/core/tsconfig.json', 'tsconfig.json'],
      projectReferenceCount: 1,
      pathAliasCount: 1,
      diagnosticCount: 0,
    })
    expect(graph.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'packages/core/src/main.ts', kind: 'value' }),
    ]))
  })

  it('counts an inherited alias once when parent and child configs resolve it identically', async () => {
    const input = fixture({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#/*': ['src/*'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      'src/value.ts': 'export const value = 1\n',
      'src/main.ts': "import { value } from '#/value.js'\nexport const result = value\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({ pathAliasCount: 1, diagnosticCount: 0 })
    expect(graph.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'src/main.ts', kind: 'value' }),
    ]))
  })

  it('reports missing referenced configs and never guesses an unconfigured alias', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({ references: [{ path: './packages/missing' }] }),
      'src/value.ts': 'export const value = 1\n',
      'src/main.ts': "import { value } from '@/value.js'\nexport const result = value\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({ projectReferenceCount: 1, diagnosticCount: 1 })
    expect(graph.referenceCount).toBe(0)
  })

  it('reports a relative extends target that is absent from the bounded inventory', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({ extends: './configs/base.json' }),
      'src/main.ts': 'export const value = 1\n',
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({ mode: 'tsconfig', diagnosticCount: 1 })
  })

  it('does not resolve a configured alias whose target is absent from the bounded inventory', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@missing/*': ['generated/*'] } },
      }),
      'src/main.ts': "import { value } from '@missing/value.js'\nexport const result = value\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({ pathAliasCount: 1, diagnosticCount: 0 })
    expect(graph.referenceCount).toBe(0)
  })

  it('reports a project reference that resolves outside the Source root', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({ references: [{ path: '../shared' }] }),
      'src/main.ts': 'export const value = 1\n',
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({ projectReferenceCount: 1, diagnosticCount: 1 })
  })

  it('bounds configuration reads independently from source files', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({ references: [{ path: './packages/core' }] }),
      'packages/core/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#/*': ['src/*'] } },
      }),
      'packages/core/src/value.ts': 'export const value = 1\n',
      'packages/core/src/main.ts': "import { value } from '#/value.js'\nexport const result = value\n",
    })
    const analyzer = new TypeScriptSourceSymbolAnalyzer(input.reader, {
      ...DEFAULT_SOURCE_SYMBOL_CONFIG,
      maxConfigFiles: 1,
    })
    const graph = await analyzer.analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.configuration).toMatchObject({ omittedConfigFileCount: 1 })
    expect(graph.referenceCount).toBe(0)
  })

  it('reports deterministic reference and file budget omissions', async () => {
    const input = fixture({
      'a.ts': 'export const shared = 1\n',
      'b.ts': "import { shared } from './a.js'\nexport const one = shared + shared\n",
      'c.ts': "import { shared } from './a.js'\nexport const two = shared\n",
    })
    const analyzer = new TypeScriptSourceSymbolAnalyzer(input.reader, {
      ...DEFAULT_SOURCE_SYMBOL_CONFIG,
      maxFiles: 2,
      maxReferences: 1,
      maxReferencesPerSymbol: 1,
    })
    const graph = await analyzer.analyze({ projectRoot: '/project', files: input.inventory })

    expect(graph.analyzedFileCount).toBe(2)
    expect(graph.omittedFileCount).toBe(1)
    expect(graph.referenceCount).toBe(1)
    expect(graph.omittedReferenceCount).toBeGreaterThan(0)
  })

  it('rejects source content that changed after inventory', async () => {
    const input = fixture({ 'a.ts': 'export const value = 1\n' })
    const analyzer = new TypeScriptSourceSymbolAnalyzer(input.reader)
    const files = input.inventory.map(file => ({ ...file, contentHash: `sha256:${'0'.repeat(64)}` }))
    await expect(analyzer.analyze({ projectRoot: '/project', files })).rejects
      .toThrow('Source symbol input changed after inventory')
  })

  it('rejects tsconfig content that changed after inventory', async () => {
    const input = fixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'src/main.ts': 'export const value = 1\n',
    })
    const files = input.inventory.map(file => file.path === 'tsconfig.json'
      ? { ...file, contentHash: `sha256:${'0'.repeat(64)}` }
      : file)
    await expect(new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files })).rejects
      .toThrow('Source symbol config changed after inventory')
  })

  it('rejects a durable graph whose definition no longer matches its hash', async () => {
    const input = fixture({
      'a.ts': 'export const value = 1\n',
      'b.ts': "import { value } from './a.js'\nexport const result = value\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })
    const tampered = structuredClone(graph)
    tampered.definitions[0]!.contentHash = `sha256:${'0'.repeat(64)}`
    expect(() => parseSourceSymbolGraph(tampered)).toThrow('inconsistent')
  })

  it('rejects duplicate durable symbol definition ids before indexing', async () => {
    const input = fixture({
      'a.ts': 'export const value = 1\n',
      'b.ts': "import { value } from './a.js'\nexport const result = value\n",
    })
    const graph = await new TypeScriptSourceSymbolAnalyzer(input.reader)
      .analyze({ projectRoot: '/project', files: input.inventory })
    const tampered = structuredClone(graph)
    tampered.definitions.push(structuredClone(tampered.definitions[0]!))
    expect(() => parseSourceSymbolGraph(tampered)).toThrow('definition ids must be unique')
  })
})
