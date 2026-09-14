import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { SourceSymbolId, SOURCE_SYMBOL_ID_PATTERN, type SourceSymbolId as SourceSymbolIdType } from './ids.js'
import { PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'

/** Durable format version for deterministic cross-file symbol references. */
export const SOURCE_SYMBOL_GRAPH_VERSION = 2 as const

/** Bounds for one local TypeScript Program analysis. */
export interface SourceSymbolConfig {
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  maxReferences: number
  maxReferencesPerSymbol: number
  maxSymbolNameChars: number
  maxConfigFiles: number
  maxConfigTotalBytes: number
  maxConfigFileBytes: number
}

/** Default bounds for local symbol definition/reference analysis. */
export const DEFAULT_SOURCE_SYMBOL_CONFIG: SourceSymbolConfig = {
  maxFiles: 5_000,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxReferences: 100_000,
  maxReferencesPerSymbol: 512,
  maxSymbolNameChars: 240,
  maxConfigFiles: 32,
  maxConfigTotalBytes: 2 * 1024 * 1024,
  maxConfigFileBytes: 256 * 1024,
}

/** One current Source file eligible for bounded symbol analysis. */
export interface SourceSymbolFile {
  path: string
  contentHash: string
  size: number
  language?: string
}

/** Complete current-file request for cross-file symbol analysis. */
export interface SourceSymbolRequest {
  projectRoot: string
  files: SourceSymbolFile[]
  signal?: AbortSignal
}

/** Semantic context of one reference occurrence. */
export type SourceSymbolReferenceKind = 'import' | 'export' | 'type' | 'value'

/** One portable symbol definition referenced from another Source file. */
export interface SourceSymbolDefinition {
  id: SourceSymbolIdType
  name: string
  declaration: string
  path: string
  contentHash: string
  startLine: number
  endLine: number
}

/** One cross-file reference occurrence resolved to a current Source definition. */
export interface SourceSymbolReference {
  definitionId: SourceSymbolIdType
  fromPath: string
  fromContentHash: string
  kind: SourceSymbolReferenceKind
  startLine: number
  endLine: number
}

/** Bounded project configuration used for current Source symbol resolution. */
export interface SourceSymbolConfiguration {
  mode: 'default' | 'tsconfig'
  configPaths: string[]
  projectReferenceCount: number
  pathAliasCount: number
  diagnosticCount: number
  omittedConfigFileCount: number
}

/** Durable deterministic symbol graph for one complete Source inventory. */
export interface SourceSymbolGraph {
  version: typeof SOURCE_SYMBOL_GRAPH_VERSION
  provider: string
  providerKey: string
  outputHash: string
  analyzedFileCount: number
  omittedFileCount: number
  definitionCount: number
  referenceCount: number
  omittedReferenceCount: number
  configuration: SourceSymbolConfiguration
  definitions: SourceSymbolDefinition[]
  references: SourceSymbolReference[]
}

/** Replaceable analyzer for project-local cross-file symbol references. */
export interface SourceSymbolAnalyzer {
  /** Stable output identity included in Source checkpoint keys. */
  readonly cacheKey: string

  /** Build one bounded graph without retaining source bodies. */
  analyze(request: SourceSymbolRequest): Promise<SourceSymbolGraph>
}

/** Bounded source reader used by the TypeScript analyzer. */
export interface SourceSymbolFileReader {
  /** Read one portable path from the requested project root. */
  read(projectRoot: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** Node filesystem reader used by the standalone CLI. */
export class NodeSourceSymbolFileReader implements SourceSymbolFileReader {
  async read(projectRoot: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const root = await realpath(resolve(projectRoot))
    const requested = resolve(root, path)
    if (!containsPath(root, requested)) throw new Error('Source symbol path escapes the project')
    const pathInfo = await lstat(requested)
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error('Source symbol input must be an ordinary file')
    if (pathInfo.size > maxBytes) throw new Error('Source symbol input exceeds its declared bound')
    const actual = await realpath(requested)
    if (!containsPath(root, actual)) throw new Error('Source symbol path escapes the project')
    const bytes = await readFile(actual, signal === undefined ? undefined : { signal })
    if (bytes.byteLength > maxBytes) throw new Error('Source symbol input exceeds its declared bound')
    return bytes
  }
}

const SOURCE_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts', '.tsx', '.mts', '.cts', '.jsx', '.mjs', '.cjs', '.ts', '.js'] as const
const VIRTUAL_SOURCE_ROOT = '/__dsh_source__'

function supportedSource(path: string): boolean {
  const lower = path.toLowerCase()
  return SOURCE_EXTENSIONS.some(extension => lower.endsWith(extension))
}

function supportedConfig(path: string): boolean {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  return /^tsconfig(?:\.[a-z0-9_-]+)*\.json$/u.test(name)
}

function extension(path: string): ts.Extension {
  const lower = path.toLowerCase()
  if (lower.endsWith('.d.mts')) return ts.Extension.Dmts
  if (lower.endsWith('.d.cts')) return ts.Extension.Dcts
  if (lower.endsWith('.d.ts')) return ts.Extension.Dts
  if (lower.endsWith('.tsx')) return ts.Extension.Tsx
  if (lower.endsWith('.mts')) return ts.Extension.Mts
  if (lower.endsWith('.cts')) return ts.Extension.Cts
  if (lower.endsWith('.jsx')) return ts.Extension.Jsx
  if (lower.endsWith('.mjs')) return ts.Extension.Mjs
  if (lower.endsWith('.cjs')) return ts.Extension.Cjs
  if (lower.endsWith('.js')) return ts.Extension.Js
  return ts.Extension.Ts
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extension(path)) {
    case ts.Extension.Tsx: return ts.ScriptKind.TSX
    case ts.Extension.Jsx: return ts.ScriptKind.JSX
    case ts.Extension.Js:
    case ts.Extension.Mjs:
    case ts.Extension.Cjs: return ts.ScriptKind.JS
    default: return ts.ScriptKind.TS
  }
}

function assertConfig(config: SourceSymbolConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  }
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = node.getStart(sourceFile)
  const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1
  const endLine = sourceFile.getLineAndCharacterOfPosition(Math.max(start, node.getEnd() - 1)).line + 1
  return { startLine, endLine }
}

function referenceKind(node: ts.Identifier): SourceSymbolReferenceKind {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current) || ts.isImportSpecifier(current)) return 'import'
    if (ts.isExportDeclaration(current) || ts.isExportSpecifier(current)) return 'export'
    if (ts.isTypeNode(current)) return 'type'
    if (ts.isStatement(current)) break
  }
  return 'value'
}

function definitionId(definition: Omit<SourceSymbolDefinition, 'id'>): SourceSymbolIdType {
  return SourceSymbolId(`sym_${createHash('sha256').update(JSON.stringify([
    definition.path,
    definition.name,
    definition.declaration,
    definition.startLine,
    definition.endLine,
  ])).digest('hex')}`)
}

function compareDefinition(left: SourceSymbolDefinition, right: SourceSymbolDefinition): number {
  return compareText(left.path, right.path)
    || left.startLine - right.startLine
    || left.endLine - right.endLine
    || compareText(left.name, right.name)
    || compareText(String(left.id), String(right.id))
}

function compareReference(left: SourceSymbolReference, right: SourceSymbolReference): number {
  return compareText(String(left.definitionId), String(right.definitionId))
    || compareText(left.fromPath, right.fromPath)
    || left.startLine - right.startLine
    || left.endLine - right.endLine
    || compareText(left.kind, right.kind)
}

function finalizeGraph(
  provider: string,
  providerKey: string,
  analyzedFileCount: number,
  omittedFileCount: number,
  configuration: SourceSymbolConfiguration,
  definitions: readonly SourceSymbolDefinition[],
  references: readonly SourceSymbolReference[],
  omittedReferenceCount: number,
): SourceSymbolGraph {
  const normalizedConfiguration: SourceSymbolConfiguration = {
    ...structuredClone(configuration),
    configPaths: [...configuration.configPaths].sort(compareText),
  }
  const sortedDefinitions = [...structuredClone(definitions)].sort(compareDefinition)
  const sortedReferences = [...structuredClone(references)].sort(compareReference)
  const outputHash = sha256(JSON.stringify({
    version: SOURCE_SYMBOL_GRAPH_VERSION,
    provider,
    providerKey,
    analyzedFileCount,
    omittedFileCount,
    configuration: normalizedConfiguration,
    definitions: sortedDefinitions,
    references: sortedReferences,
    omittedReferenceCount,
  }))
  return {
    version: SOURCE_SYMBOL_GRAPH_VERSION,
    provider,
    providerKey,
    outputHash,
    analyzedFileCount,
    omittedFileCount,
    definitionCount: sortedDefinitions.length,
    referenceCount: sortedReferences.length,
    omittedReferenceCount,
    configuration: normalizedConfiguration,
    definitions: sortedDefinitions,
    references: sortedReferences,
  }
}

/** Create an explicit empty graph for callers that do not install a symbol Provider. */
export function emptySourceSymbolGraph(providerKey = 'source-symbols-disabled:1'): SourceSymbolGraph {
  return finalizeGraph('disabled-source-symbols', providerKey, 0, 0, {
    mode: 'default',
    configPaths: [],
    projectReferenceCount: 0,
    pathAliasCount: 0,
    diagnosticCount: 0,
    omittedConfigFileCount: 0,
  }, [], [], 0)
}

interface LoadedSource {
  file: SourceSymbolFile
  text: string
  virtualPath: string
}

interface LoadedConfig {
  file: SourceSymbolFile
  text: string
  virtualPath: string
}

interface ParsedConfig {
  path: string
  virtualPath: string
  directory: string
  options: ts.CompilerOptions
}

interface CandidateReference {
  definition: SourceSymbolDefinition
  reference: SourceSymbolReference
}

/** Deterministic TypeScript Program analyzer for current-project definitions and references. */
export class TypeScriptSourceSymbolAnalyzer implements SourceSymbolAnalyzer {
  readonly cacheKey: string

  constructor(
    private readonly reader: SourceSymbolFileReader = new NodeSourceSymbolFileReader(),
    private readonly config: SourceSymbolConfig = DEFAULT_SOURCE_SYMBOL_CONFIG,
  ) {
    assertConfig(config)
    this.cacheKey = [
      'typescript-source-symbols', SOURCE_SYMBOL_GRAPH_VERSION, ts.version,
      config.maxFiles, config.maxTotalBytes, config.maxFileBytes,
      config.maxReferences, config.maxReferencesPerSymbol, config.maxSymbolNameChars,
      config.maxConfigFiles, config.maxConfigTotalBytes, config.maxConfigFileBytes,
    ].join(':')
  }

  async analyze(request: SourceSymbolRequest): Promise<SourceSymbolGraph> {
    const pathPattern = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')
    const validateFile = (file: SourceSymbolFile): void => {
      if (!pathPattern.test(file.path) || !/^sha256:[0-9a-f]{64}$/u.test(file.contentHash)
        || !Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error('Source symbol file is invalid')
      }
    }
    const eligible = request.files
      .filter(file => supportedSource(file.path))
      .sort((left, right) => compareText(left.path, right.path))
    const selected: SourceSymbolFile[] = []
    let selectedBytes = 0
    for (const file of eligible) {
      validateFile(file)
      if (selected.length >= this.config.maxFiles || file.size > this.config.maxFileBytes
        || selectedBytes + file.size > this.config.maxTotalBytes) continue
      selected.push(file)
      selectedBytes += file.size
    }
    const eligibleConfigs = request.files
      .filter(file => supportedConfig(file.path))
      .sort((left, right) => (
        left.path.split('/').length - right.path.split('/').length
        || Number(!(left.path === 'tsconfig.json' || left.path.endsWith('/tsconfig.json')))
          - Number(!(right.path === 'tsconfig.json' || right.path.endsWith('/tsconfig.json')))
        || compareText(left.path, right.path)
      ))
    const selectedConfigs: SourceSymbolFile[] = []
    let selectedConfigBytes = 0
    for (const file of eligibleConfigs) {
      validateFile(file)
      if (selectedConfigs.length >= this.config.maxConfigFiles || file.size > this.config.maxConfigFileBytes
        || selectedConfigBytes + file.size > this.config.maxConfigTotalBytes) continue
      selectedConfigs.push(file)
      selectedConfigBytes += file.size
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const loaded: LoadedSource[] = []
    for (const file of selected) {
      request.signal?.throwIfAborted()
      const bytes = await this.reader.read(request.projectRoot, file.path, this.config.maxFileBytes, request.signal)
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.contentHash) {
        throw new Error(`Source symbol input changed after inventory: ${file.path}`)
      }
      loaded.push({ file, text: decoder.decode(bytes), virtualPath: `${VIRTUAL_SOURCE_ROOT}/${file.path}` })
    }
    const loadedConfigs: LoadedConfig[] = []
    for (const file of selectedConfigs) {
      request.signal?.throwIfAborted()
      const bytes = await this.reader.read(request.projectRoot, file.path, this.config.maxConfigFileBytes, request.signal)
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.contentHash) {
        throw new Error(`Source symbol config changed after inventory: ${file.path}`)
      }
      loadedConfigs.push({ file, text: decoder.decode(bytes), virtualPath: `${VIRTUAL_SOURCE_ROOT}/${file.path}` })
    }
    const byVirtual = new Map(loaded.map(item => [item.virtualPath, item]))
    const portableByVirtual = new Map(loaded.map(item => [item.virtualPath, item.file.path]))
    const options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noLib: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2024,
    }
    const configTextByVirtual = new Map(loadedConfigs.map(item => [item.virtualPath, item.text]))
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      fileExists: fileName => configTextByVirtual.has(fileName) || byVirtual.has(fileName),
      readFile: fileName => configTextByVirtual.get(fileName) ?? byVirtual.get(fileName)?.text,
      readDirectory: (rootDir, extensions) => [...byVirtual.keys()].filter(fileName => (
        containsPath(rootDir, fileName)
        && (extensions === undefined || extensions.some(extension => fileName.toLowerCase().endsWith(extension)))
      )),
    }
    const parsedConfigs: ParsedConfig[] = []
    let configDiagnosticCount = 0
    let projectReferenceCount = 0
    const pathAliases = new Set<string>()
    for (const config of loadedConfigs) {
      request.signal?.throwIfAborted()
      const parsedJson = ts.parseConfigFileTextToJson(config.virtualPath, config.text)
      if (parsedJson.error !== undefined) configDiagnosticCount += 1
      if (parsedJson.config === undefined) continue
      const parsed = ts.parseJsonConfigFileContent(
        parsedJson.config,
        parseHost,
        dirname(config.virtualPath),
        undefined,
        config.virtualPath,
      )
      configDiagnosticCount += parsed.errors.length
      projectReferenceCount += parsed.projectReferences?.length ?? 0
      for (const [pattern, targets] of Object.entries(parsed.options.paths ?? {})) {
        pathAliases.add(JSON.stringify([pattern, targets]))
      }
      parsedConfigs.push({
        path: config.file.path,
        virtualPath: config.virtualPath,
        directory: dirname(config.virtualPath),
        options: { ...options, ...parsed.options, noEmit: true, noLib: true },
      })
    }
    const loadedConfigPaths = new Set(loadedConfigs.map(item => item.virtualPath))
    for (const config of loadedConfigs) {
      const parsedJson = ts.parseConfigFileTextToJson(config.virtualPath, config.text)
      const references = parsedJson.config !== undefined && Array.isArray(parsedJson.config['references'])
        ? parsedJson.config['references'] as unknown[] : []
      for (const reference of references) {
        if (typeof reference !== 'object' || reference === null || Array.isArray(reference)
          || typeof (reference as Record<string, unknown>)['path'] !== 'string') continue
        const target = resolve(dirname(config.virtualPath), (reference as Record<string, string>)['path']!)
        const candidates = target.toLowerCase().endsWith('.json')
          ? [target]
          : [`${target}.json`, resolve(target, 'tsconfig.json')]
        if (!candidates.some(candidate => loadedConfigPaths.has(candidate))) configDiagnosticCount += 1
      }
    }
    const configuration: SourceSymbolConfiguration = {
      mode: loadedConfigs.length === 0 ? 'default' : 'tsconfig',
      configPaths: loadedConfigs.map(item => item.file.path),
      projectReferenceCount,
      pathAliasCount: pathAliases.size,
      diagnosticCount: configDiagnosticCount,
      omittedConfigFileCount: eligibleConfigs.length - loadedConfigs.length,
    }
    const configForFile = (fileName: string): ParsedConfig | undefined => [...parsedConfigs]
      .filter(config => containsPath(config.directory, fileName))
      .sort((left, right) => (
        right.directory.length - left.directory.length
        || Number(right.path.endsWith('/tsconfig.json') || right.path === 'tsconfig.json')
          - Number(left.path.endsWith('/tsconfig.json') || left.path === 'tsconfig.json')
        || compareText(left.path, right.path)
      ))[0]
    const moduleResolutionHost: ts.ModuleResolutionHost = {
      fileExists: fileName => byVirtual.has(fileName),
      readFile: fileName => byVirtual.get(fileName)?.text,
    }
    const host: ts.CompilerHost = {
      fileExists: fileName => byVirtual.has(fileName),
      getCanonicalFileName: fileName => fileName,
      getCurrentDirectory: () => VIRTUAL_SOURCE_ROOT,
      getDefaultLibFileName: () => `${VIRTUAL_SOURCE_ROOT}/lib.d.ts`,
      getNewLine: () => '\n',
      getSourceFile: (fileName, languageVersion) => {
        const item = byVirtual.get(fileName)
        return item === undefined
          ? undefined
          : ts.createSourceFile(fileName, item.text, languageVersion, true, scriptKind(item.file.path))
      },
      readFile: fileName => byVirtual.get(fileName)?.text,
      resolveModuleNames: (moduleNames, containingFile) => moduleNames.map(specifier => {
        const resolved = ts.resolveModuleName(
          specifier,
          containingFile,
          configForFile(containingFile)?.options ?? options,
          moduleResolutionHost,
        ).resolvedModule
        return resolved !== undefined && byVirtual.has(resolved.resolvedFileName)
          ? { ...resolved, isExternalLibraryImport: false }
          : undefined
      }),
      useCaseSensitiveFileNames: () => true,
      writeFile: () => {},
    }
    const program = ts.createProgram({ rootNames: loaded.map(item => item.virtualPath), options, host })
    const checker = program.getTypeChecker()
    const fileByPath = new Map(loaded.map(item => [item.file.path, item.file]))
    const candidates = new Map<string, CandidateReference>()
    const visit = (sourceFile: ts.SourceFile, node: ts.Node): void => {
      request.signal?.throwIfAborted()
      if (ts.isIdentifier(node)) {
        const sourcePath = portableByVirtual.get(sourceFile.fileName)
        const source = sourcePath === undefined ? undefined : fileByPath.get(sourcePath)
        let symbol = checker.getSymbolAtLocation(node)
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
          symbol = checker.getAliasedSymbol(symbol)
        }
        if (sourcePath !== undefined && source !== undefined && symbol !== undefined) {
          const name = checker.symbolToString(symbol)
          if (name.length > 0 && [...name].length <= this.config.maxSymbolNameChars) {
            for (const declaration of symbol.getDeclarations() ?? []) {
              const definitionPath = portableByVirtual.get(declaration.getSourceFile().fileName)
              if (definitionPath === undefined || definitionPath === sourcePath) continue
              const definitionFile = fileByPath.get(definitionPath)
              if (definitionFile === undefined) continue
              const definitionNode = ts.getNameOfDeclaration(declaration) ?? declaration
              const definitionRange = lineRange(declaration.getSourceFile(), definitionNode)
              const definitionWithoutId = {
                name,
                declaration: ts.SyntaxKind[declaration.kind] ?? String(declaration.kind),
                path: definitionPath,
                contentHash: definitionFile.contentHash,
                ...definitionRange,
              }
              const definition: SourceSymbolDefinition = {
                id: definitionId(definitionWithoutId),
                ...definitionWithoutId,
              }
              const reference: SourceSymbolReference = {
                definitionId: definition.id,
                fromPath: sourcePath,
                fromContentHash: source.contentHash,
                kind: referenceKind(node),
                ...lineRange(sourceFile, node),
              }
              candidates.set(JSON.stringify([
                definition.id, reference.fromPath, reference.startLine, reference.endLine, reference.kind,
              ]), { definition, reference })
            }
          }
        }
      }
      ts.forEachChild(node, child => { visit(sourceFile, child) })
    }
    for (const sourceFile of [...program.getSourceFiles()].sort((left, right) => compareText(left.fileName, right.fileName))) {
      if (portableByVirtual.has(sourceFile.fileName)) visit(sourceFile, sourceFile)
    }
    const ordered = [...candidates.values()].sort((left, right) => (
      compareDefinition(left.definition, right.definition) || compareReference(left.reference, right.reference)
    ))
    const perDefinition = new Map<string, number>()
    const bounded: CandidateReference[] = []
    let omittedReferenceCount = 0
    for (const candidate of ordered) {
      const key = String(candidate.definition.id)
      const count = perDefinition.get(key) ?? 0
      if (count >= this.config.maxReferencesPerSymbol || bounded.length >= this.config.maxReferences) {
        omittedReferenceCount += 1
        continue
      }
      perDefinition.set(key, count + 1)
      bounded.push(candidate)
    }
    const definitions = new Map<string, SourceSymbolDefinition>()
    for (const item of bounded) definitions.set(String(item.definition.id), item.definition)
    return finalizeGraph(
      'typescript-program-symbols',
      this.cacheKey,
      loaded.length,
      eligible.length - loaded.length,
      configuration,
      [...definitions.values()],
      bounded.map(item => item.reference),
      omittedReferenceCount,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate and reconstruct one durable Source symbol graph. */
export function parseSourceSymbolGraph(value: unknown): SourceSymbolGraph {
  if (!isRecord(value)
    || value['version'] !== SOURCE_SYMBOL_GRAPH_VERSION
    || typeof value['provider'] !== 'string' || value['provider'].length === 0
    || typeof value['providerKey'] !== 'string' || value['providerKey'].length === 0
    || !Number.isSafeInteger(value['analyzedFileCount']) || (value['analyzedFileCount'] as number) < 0
    || !Number.isSafeInteger(value['omittedFileCount']) || (value['omittedFileCount'] as number) < 0
    || !Number.isSafeInteger(value['omittedReferenceCount']) || (value['omittedReferenceCount'] as number) < 0
    || !isRecord(value['configuration'])
    || !Array.isArray(value['definitions']) || !Array.isArray(value['references'])) {
    throw new Error('Source symbol graph is invalid')
  }
  const pathPattern = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')
  const configurationValue = value['configuration']
  if ((configurationValue['mode'] !== 'default' && configurationValue['mode'] !== 'tsconfig')
    || !Array.isArray(configurationValue['configPaths'])
    || !configurationValue['configPaths'].every(path => typeof path === 'string' && pathPattern.test(path))
    || !Number.isSafeInteger(configurationValue['projectReferenceCount'])
    || (configurationValue['projectReferenceCount'] as number) < 0
    || !Number.isSafeInteger(configurationValue['pathAliasCount'])
    || (configurationValue['pathAliasCount'] as number) < 0
    || !Number.isSafeInteger(configurationValue['diagnosticCount'])
    || (configurationValue['diagnosticCount'] as number) < 0
    || !Number.isSafeInteger(configurationValue['omittedConfigFileCount'])
    || (configurationValue['omittedConfigFileCount'] as number) < 0) {
    throw new Error('Source symbol configuration is invalid')
  }
  const configPaths = configurationValue['configPaths'] as string[]
  if (new Set(configPaths).size !== configPaths.length) throw new Error('Source symbol config paths must be unique')
  if ((configurationValue['mode'] === 'tsconfig') !== (configPaths.length > 0)) {
    throw new Error('Source symbol configuration mode is inconsistent')
  }
  const configuration: SourceSymbolConfiguration = {
    mode: configurationValue['mode'],
    configPaths,
    projectReferenceCount: configurationValue['projectReferenceCount'] as number,
    pathAliasCount: configurationValue['pathAliasCount'] as number,
    diagnosticCount: configurationValue['diagnosticCount'] as number,
    omittedConfigFileCount: configurationValue['omittedConfigFileCount'] as number,
  }
  const definitions = value['definitions'].map((item): SourceSymbolDefinition => {
    if (!isRecord(item)
      || typeof item['id'] !== 'string' || !new RegExp(SOURCE_SYMBOL_ID_PATTERN, 'u').test(item['id'])
      || typeof item['name'] !== 'string' || item['name'].length === 0
      || typeof item['declaration'] !== 'string' || item['declaration'].length === 0
      || typeof item['path'] !== 'string' || !pathPattern.test(item['path'])
      || typeof item['contentHash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(item['contentHash'])
      || !Number.isSafeInteger(item['startLine']) || (item['startLine'] as number) < 1
      || !Number.isSafeInteger(item['endLine']) || (item['endLine'] as number) < (item['startLine'] as number)) {
      throw new Error('Source symbol definition is invalid')
    }
    return {
      id: SourceSymbolId(item['id']),
      name: item['name'],
      declaration: item['declaration'],
      path: item['path'],
      contentHash: item['contentHash'],
      startLine: item['startLine'] as number,
      endLine: item['endLine'] as number,
    }
  })
  const definitionIds = new Set(definitions.map(item => String(item.id)))
  if (definitionIds.size !== definitions.length) throw new Error('Source symbol definition ids must be unique')
  const kinds: SourceSymbolReferenceKind[] = ['import', 'export', 'type', 'value']
  const references = value['references'].map((item): SourceSymbolReference => {
    if (!isRecord(item)
      || typeof item['definitionId'] !== 'string' || !definitionIds.has(item['definitionId'])
      || typeof item['fromPath'] !== 'string' || !pathPattern.test(item['fromPath'])
      || typeof item['fromContentHash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(item['fromContentHash'])
      || typeof item['kind'] !== 'string' || !kinds.includes(item['kind'] as SourceSymbolReferenceKind)
      || !Number.isSafeInteger(item['startLine']) || (item['startLine'] as number) < 1
      || !Number.isSafeInteger(item['endLine']) || (item['endLine'] as number) < (item['startLine'] as number)) {
      throw new Error('Source symbol reference is invalid')
    }
    return {
      definitionId: SourceSymbolId(item['definitionId']),
      fromPath: item['fromPath'],
      fromContentHash: item['fromContentHash'],
      kind: item['kind'] as SourceSymbolReferenceKind,
      startLine: item['startLine'] as number,
      endLine: item['endLine'] as number,
    }
  })
  const rebuilt = finalizeGraph(
    value['provider'],
    value['providerKey'],
    value['analyzedFileCount'] as number,
    value['omittedFileCount'] as number,
    configuration,
    definitions,
    references,
    value['omittedReferenceCount'] as number,
  )
  if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error('Source symbol graph is inconsistent')
  return rebuilt
}
