import { describe, expect, it } from 'vitest'
import {
  DeterministicSourceAnalyzer,
  parseSourceFileAnalysis,
} from '../src/source-analysis.js'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('deterministic Source analysis', () => {
  it('changes its cache identity when output-affecting bounds change', () => {
    const baseline = new DeterministicSourceAnalyzer()
    const same = new DeterministicSourceAnalyzer()
    const bounded = new DeterministicSourceAnalyzer({
      maxEvidencePerFile: 2,
      maxEvidenceNameChars: 240,
      maxModuleReferencesPerFile: 64,
      maxModuleSpecifierChars: 512,
    })

    expect(same.cacheKey).toBe(baseline.cacheKey)
    expect(bounded.cacheKey).not.toBe(baseline.cacheKey)
  })

  it('extracts bounded JavaScript and TypeScript AST symbols with stable 1-based ranges', () => {
    const analyzer = new DeterministicSourceAnalyzer({
      maxEvidencePerFile: 4,
      maxEvidenceNameChars: 40,
      maxModuleReferencesPerFile: 4,
      maxModuleSpecifierChars: 80,
    })
    const result = analyzer.analyze({
      path: 'src/example.ts',
      language: 'TypeScript',
      bytes: bytes([
        '// export const ignored = true',
        'export interface Request {}',
        'const template = `',
        'export const alsoIgnored = true',
        '`',
        'export const ready = true',
        "export { ready as publicReady } from './other.js'",
        'export default function run() {}',
      ].join('\r\n')),
    })

    expect(result).toMatchObject({
      provider: 'deterministic-source-evidence',
      version: 3,
      omittedEvidenceCount: 1,
      evidence: [
        { kind: 'code-symbol', declaration: 'interface', name: 'Request', exported: true, startLine: 2, endLine: 2 },
        { kind: 'code-symbol', declaration: 'variable', name: 'template', exported: false, startLine: 3, endLine: 5 },
        { kind: 'code-symbol', declaration: 'variable', name: 'ready', exported: true, startLine: 6, endLine: 6 },
        { kind: 'code-symbol', declaration: 're-export', name: 'publicReady', exported: true, startLine: 7, endLine: 7 },
      ],
    })
  })

  it('indexes declarations, members, destructured variables, anonymous defaults, and wildcard exports', () => {
    const analyzer = new DeterministicSourceAnalyzer({
      maxEvidencePerFile: 40,
      maxEvidenceNameChars: 80,
      maxModuleReferencesPerFile: 40,
      maxModuleSpecifierChars: 80,
    })
    const result = analyzer.analyze({
      path: 'src/symbols.ts',
      language: 'TypeScript',
      bytes: bytes([
        'export class Service {',
        '  constructor() {}',
        '  get value(): string { return "" }',
        '  set value(next: string) {}',
        '  async run(',
        '    input: string,',
        '  ): Promise<void> {}',
        '}',
        'interface Internal { field: string; execute(): void }',
        'type Config = { enabled: boolean }',
        'enum Mode { Fast, Safe }',
        'const { alpha, nested: { beta } } = source',
        'export default class { execute() {} }',
        "export * from './other.js'",
      ].join('\n')),
    })

    expect(result?.evidence).toEqual(expect.arrayContaining([
      { kind: 'code-symbol', declaration: 'class', name: 'Service', exported: true, startLine: 1, endLine: 8 },
      { kind: 'code-symbol', declaration: 'constructor', name: 'constructor', exported: false, containerName: 'Service', startLine: 2, endLine: 2 },
      { kind: 'code-symbol', declaration: 'getter', name: 'value', exported: false, containerName: 'Service', startLine: 3, endLine: 3 },
      { kind: 'code-symbol', declaration: 'setter', name: 'value', exported: false, containerName: 'Service', startLine: 4, endLine: 4 },
      { kind: 'code-symbol', declaration: 'method', name: 'run', exported: false, containerName: 'Service', startLine: 5, endLine: 7 },
      { kind: 'code-symbol', declaration: 'property', name: 'field', exported: false, containerName: 'Internal', startLine: 9, endLine: 9 },
      { kind: 'code-symbol', declaration: 'property', name: 'enabled', exported: false, containerName: 'Config', startLine: 10, endLine: 10 },
      { kind: 'code-symbol', declaration: 'enum-member', name: 'Fast', exported: false, containerName: 'Mode', startLine: 11, endLine: 11 },
      { kind: 'code-symbol', declaration: 'variable', name: 'alpha', exported: false, startLine: 12, endLine: 12 },
      { kind: 'code-symbol', declaration: 'variable', name: 'beta', exported: false, startLine: 12, endLine: 12 },
      { kind: 'code-symbol', declaration: 'class', name: 'default', exported: true, startLine: 13, endLine: 13 },
      { kind: 'code-symbol', declaration: 're-export', name: '*', exported: true, startLine: 14, endLine: 14 },
    ]))
  })

  it('extracts bounded static module specifiers without resolving cross-file targets', () => {
    const analyzer = new DeterministicSourceAnalyzer({
      maxEvidencePerFile: 20,
      maxEvidenceNameChars: 80,
      maxModuleReferencesPerFile: 7,
      maxModuleSpecifierChars: 80,
    })
    const result = analyzer.analyze({
      path: 'src/consumer.ts',
      language: 'TypeScript',
      bytes: bytes([
        "import value from './value.js'",
        "import type { Config } from './types.js'",
        "export { helper } from './helper.js'",
        "export type { Shape } from './shape.js'",
        "import legacy = require('./legacy.cjs')",
        "const lazy = import('./lazy.js')",
        "const common = require('common-package')",
        'const unknown = import(target)',
      ].join('\n')),
    })

    expect(result?.moduleReferences).toEqual([
      { kind: 'import', specifier: './value.js', startLine: 1, endLine: 1 },
      { kind: 'type-import', specifier: './types.js', startLine: 2, endLine: 2 },
      { kind: 're-export', specifier: './helper.js', startLine: 3, endLine: 3 },
      { kind: 'type-re-export', specifier: './shape.js', startLine: 4, endLine: 4 },
      { kind: 'import-equals', specifier: './legacy.cjs', startLine: 5, endLine: 5 },
      { kind: 'dynamic-import', specifier: './lazy.js', startLine: 6, endLine: 6 },
      { kind: 'require', specifier: 'common-package', startLine: 7, endLine: 7 },
    ])
    expect(result?.omittedModuleReferenceCount).toBe(1)
  })

  it('extracts Markdown ATX headings outside fenced code and reports its budget', () => {
    const analyzer = new DeterministicSourceAnalyzer({
      maxEvidencePerFile: 2,
      maxEvidenceNameChars: 20,
      maxModuleReferencesPerFile: 2,
      maxModuleSpecifierChars: 80,
    })
    const result = analyzer.analyze({
      path: 'README.md',
      language: 'Markdown',
      bytes: bytes('# 项目\n```ts\n## 假标题\n```\n## 设计 ##\n### 超过名称长度的标题不会进入证据列表'),
    })

    expect(result).toMatchObject({
      evidence: [
        { kind: 'document-heading', name: '项目', level: 1, startLine: 1, endLine: 1 },
        { kind: 'document-heading', name: '设计', level: 2, startLine: 5, endLine: 5 },
      ],
      omittedEvidenceCount: 1,
    })
  })

  it('requires a Markdown closing fence to be at least as long as its opening fence', () => {
    const analyzer = new DeterministicSourceAnalyzer()
    const result = analyzer.analyze({
      path: 'README.md',
      language: 'Markdown',
      bytes: bytes('````ts\n## fenced one\n```\n## fenced two\n````\n## visible'),
    })

    expect(result?.evidence).toEqual([
      { kind: 'document-heading', name: 'visible', level: 2, startLine: 6, endLine: 6 },
    ])
  })

  it('rejects binary, invalid UTF-8, unsupported languages, and unknown durable fields', () => {
    const analyzer = new DeterministicSourceAnalyzer()
    expect(analyzer.analyze({ path: 'image.md', language: 'Markdown', bytes: new Uint8Array([0]) })).toBeUndefined()
    expect(analyzer.analyze({ path: 'bad.md', language: 'Markdown', bytes: new Uint8Array([0xc3, 0x28]) })).toBeUndefined()
    expect(analyzer.analyze({ path: 'config.json', language: 'JSON', bytes: bytes('{"ok":true}') })).toBeUndefined()

    const valid = analyzer.analyze({ path: 'README.md', language: 'Markdown', bytes: bytes('# Valid') })!
    expect(parseSourceFileAnalysis(structuredClone(valid))).toEqual(valid)
    expect(() => parseSourceFileAnalysis({ ...valid, body: 'must not persist' })).toThrow('unknown')
    expect(() => parseSourceFileAnalysis({ ...valid, version: 1 })).toThrow('invalid')
  })
})
