import ts from 'typescript'

/** Stable version of the built-in deterministic code/document analyzer. */
export const DETERMINISTIC_SOURCE_ANALYZER_VERSION = 3 as const

/** Syntax-level declaration categories emitted by the TypeScript AST analyzer. */
export type SourceCodeSymbolDeclaration =
  | 'class'
  | 'function'
  | 'interface'
  | 'type'
  | 'enum'
  | 'enum-member'
  | 'namespace'
  | 'variable'
  | 'method'
  | 'property'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'default'
  | 're-export'

/** One bounded, line-addressable fact extracted from a source file. */
export type SourceEvidence =
  | {
      kind: 'code-symbol'
      name: string
      declaration: SourceCodeSymbolDeclaration
      exported: boolean
      containerName?: string
      startLine: number
      endLine: number
    }
  | {
      kind: 'document-heading'
      name: string
      level: number
      startLine: number
      endLine: number
    }

/** Syntax-level module reference categories retained for cross-file resolution. */
export type SourceModuleReferenceKind =
  | 'import'
  | 'type-import'
  | 're-export'
  | 'type-re-export'
  | 'dynamic-import'
  | 'require'
  | 'import-equals'

/** One bounded static module specifier observed in a code file. */
export interface SourceModuleReference {
  kind: SourceModuleReferenceKind
  specifier: string
  startLine: number
  endLine: number
}

/** Input limits that make source evidence extraction safe and reproducible. */
export interface SourceAnalysisConfig {
  maxEvidencePerFile: number
  maxEvidenceNameChars: number
  maxModuleReferencesPerFile: number
  maxModuleSpecifierChars: number
}

/** Default source-analysis limits for local profiles and the standalone CLI. */
export const DEFAULT_SOURCE_ANALYSIS_CONFIG: SourceAnalysisConfig = {
  maxEvidencePerFile: 64,
  maxEvidenceNameChars: 240,
  maxModuleReferencesPerFile: 64,
  maxModuleSpecifierChars: 512,
}

/** Deterministic analysis retained with one Source record. */
export interface SourceFileAnalysis {
  provider: 'deterministic-source-evidence'
  version: typeof DETERMINISTIC_SOURCE_ANALYZER_VERSION
  evidence: SourceEvidence[]
  omittedEvidenceCount: number
  moduleReferences: SourceModuleReference[]
  omittedModuleReferenceCount: number
}

/** Portable file input accepted by a Source analysis Provider. */
export interface SourceAnalysisRequest {
  path: string
  language?: string
  bytes: Uint8Array
}

/** Replaceable local parser used by the Source inventory Consumer. */
export interface SourceAnalyzer {
  /** Stable identity for reusing prior per-file analysis results. */
  readonly cacheKey: string

  /** Analyze one complete, bounded file without retaining its body. */
  analyze(request: SourceAnalysisRequest): SourceFileAnalysis | undefined
}

function assertConfig(config: SourceAnalysisConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  }
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function boundedEvidence(
  candidates: readonly SourceEvidence[],
  invalidNameCount: number,
  config: SourceAnalysisConfig,
): Pick<SourceFileAnalysis, 'evidence' | 'omittedEvidenceCount'> {
  const valid = candidates.filter(item => (
    item.name.length > 0
    && item.name.length <= config.maxEvidenceNameChars
    && (item.kind !== 'code-symbol'
      || item.containerName === undefined
      || item.containerName.length <= config.maxEvidenceNameChars)
  ))
  return {
    evidence: valid.slice(0, config.maxEvidencePerFile),
    omittedEvidenceCount: invalidNameCount + (candidates.length - valid.length) + Math.max(0, valid.length - config.maxEvidencePerFile),
  }
}

function markdownEvidence(text: string, config: SourceAnalysisConfig): Pick<SourceFileAnalysis, 'evidence' | 'omittedEvidenceCount'> {
  const evidence: SourceEvidence[] = []
  let invalidNameCount = 0
  let fence: { marker: '`' | '~'; length: number } | undefined
  const lines = text.split(/\r\n|\n|\r/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]![0] as '`' | '~'
      if (fence === undefined) fence = { marker, length: fenceMatch[1]!.length }
      else if (fence.marker === marker && fenceMatch[1]!.length >= fence.length && fenceMatch[2]!.trim() === '') {
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) continue
    const match = /^(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(line)
    if (match === null) continue
    const name = match[2]!.trim()
    if (name.length === 0) {
      invalidNameCount += 1
      continue
    }
    evidence.push({
      kind: 'document-heading',
      name,
      level: match[1]!.length,
      startLine: index + 1,
      endLine: index + 1,
    })
  }
  return boundedEvidence(evidence, invalidNameCount, config)
}

const CODE_LANGUAGES = new Set(['JavaScript', 'JavaScript JSX', 'TypeScript', 'TypeScript JSX'])
type CodeSymbolEvidence = Extract<SourceEvidence, { kind: 'code-symbol' }>

function scriptKind(language: string): ts.ScriptKind {
  switch (language) {
    case 'JavaScript': return ts.ScriptKind.JS
    case 'JavaScript JSX': return ts.ScriptKind.JSX
    case 'TypeScript': return ts.ScriptKind.TS
    case 'TypeScript JSX': return ts.ScriptKind.TSX
    default: throw new Error(`unsupported code language: ${language}`)
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function exported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)
}

function declarationName(name: ts.DeclarationName | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
    || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

function symbolRange(sourceFile: ts.SourceFile, node: ts.Node): Pick<CodeSymbolEvidence, 'startLine' | 'endLine'> {
  const start = node.getStart(sourceFile, false)
  const end = Math.max(start, node.getEnd() - 1)
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
  }
}

function codeEvidence(
  sourceFile: ts.SourceFile,
  config: SourceAnalysisConfig,
): Pick<SourceFileAnalysis, 'evidence' | 'omittedEvidenceCount'> {
  const evidence: SourceEvidence[] = []
  let invalidNameCount = 0

  const add = (
    node: ts.Node,
    name: string | undefined,
    declaration: SourceCodeSymbolDeclaration,
    isExported: boolean,
    containerName?: string,
  ): void => {
    if (name === undefined) {
      invalidNameCount += 1
      return
    }
    evidence.push({
      kind: 'code-symbol',
      name,
      declaration,
      exported: isExported,
      ...(containerName === undefined ? {} : { containerName }),
      ...symbolRange(sourceFile, node),
    })
  }

  const visitMembers = (members: ts.NodeArray<ts.TypeElement | ts.ClassElement>, containerName: string): void => {
    for (const member of members) {
      if (ts.isConstructorDeclaration(member)) {
        add(member, 'constructor', 'constructor', false, containerName)
      } else if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        add(member, declarationName(member.name), 'method', false, containerName)
      } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        add(member, declarationName(member.name), 'property', false, containerName)
      } else if (ts.isGetAccessorDeclaration(member)) {
        add(member, declarationName(member.name), 'getter', false, containerName)
      } else if (ts.isSetAccessorDeclaration(member)) {
        add(member, declarationName(member.name), 'setter', false, containerName)
      }
    }
  }

  const visitModule = (node: ts.ModuleDeclaration, parentName: string | undefined): void => {
    const ownName = declarationName(node.name)
    const containerName = parentName === undefined ? ownName : ownName === undefined ? parentName : `${parentName}.${ownName}`
    add(node, ownName, 'namespace', exported(node), parentName)
    if (node.body === undefined) return
    if (ts.isModuleBlock(node.body)) visitStatements(node.body.statements, containerName)
    else if (ts.isModuleDeclaration(node.body)) visitModule(node.body, containerName)
  }

  const visitStatements = (statements: ts.NodeArray<ts.Statement>, containerName: string | undefined): void => {
    for (const statement of statements) {
      if (ts.isClassDeclaration(statement)) {
        const name = declarationName(statement.name) ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined)
        add(statement, name, 'class', exported(statement), containerName)
        if (name !== undefined) visitMembers(statement.members, containerName === undefined ? name : `${containerName}.${name}`)
      } else if (ts.isFunctionDeclaration(statement)) {
        const name = declarationName(statement.name) ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined)
        add(statement, name, 'function', exported(statement), containerName)
      } else if (ts.isInterfaceDeclaration(statement)) {
        add(statement, statement.name.text, 'interface', exported(statement), containerName)
        visitMembers(statement.members, containerName === undefined ? statement.name.text : `${containerName}.${statement.name.text}`)
      } else if (ts.isTypeAliasDeclaration(statement)) {
        add(statement, statement.name.text, 'type', exported(statement), containerName)
        if (ts.isTypeLiteralNode(statement.type)) {
          visitMembers(statement.type.members, containerName === undefined ? statement.name.text : `${containerName}.${statement.name.text}`)
        }
      } else if (ts.isEnumDeclaration(statement)) {
        add(statement, statement.name.text, 'enum', exported(statement), containerName)
        const enumContainer = containerName === undefined ? statement.name.text : `${containerName}.${statement.name.text}`
        for (const member of statement.members) add(member, declarationName(member.name), 'enum-member', false, enumContainer)
      } else if (ts.isModuleDeclaration(statement)) {
        visitModule(statement, containerName)
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(declaration.name)) add(declaration, name.text, 'variable', exported(statement), containerName)
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause === undefined) {
          add(statement, '*', 're-export', true, containerName)
        } else if (ts.isNamespaceExport(statement.exportClause)) {
          add(statement.exportClause, statement.exportClause.name.text, 're-export', true, containerName)
        } else {
          for (const element of statement.exportClause.elements) add(element, element.name.text, 're-export', true, containerName)
        }
      } else if (ts.isExportAssignment(statement)) {
        add(statement, 'default', 'default', true, containerName)
      } else if (ts.isNamespaceExportDeclaration(statement)) {
        add(statement, statement.name.text, 're-export', true, containerName)
      }
    }
  }

  visitStatements(sourceFile.statements, undefined)
  return boundedEvidence(evidence, invalidNameCount, config)
}

function moduleReferences(
  sourceFile: ts.SourceFile,
  config: SourceAnalysisConfig,
): Pick<SourceFileAnalysis, 'moduleReferences' | 'omittedModuleReferenceCount'> {
  const candidates: SourceModuleReference[] = []
  let invalidReferenceCount = 0

  const add = (node: ts.Node, specifier: string | undefined, kind: SourceModuleReferenceKind): void => {
    if (specifier === undefined || specifier.length === 0) {
      invalidReferenceCount += 1
      return
    }
    candidates.push({ kind, specifier, ...symbolRange(sourceFile, node) })
  }

  const literalSpecifier = (node: ts.Expression | undefined): string | undefined => (
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined
  )

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, literalSpecifier(node.moduleSpecifier), node.importClause?.isTypeOnly === true ? 'type-import' : 'import')
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier, literalSpecifier(node.moduleSpecifier), node.isTypeOnly ? 'type-re-export' : 're-export')
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference, literalSpecifier(node.moduleReference.expression), 'import-equals')
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node, literalSpecifier(node.arguments[0]), 'dynamic-import')
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node, literalSpecifier(node.arguments[0]), 'require')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const valid = candidates.filter(reference => reference.specifier.length <= config.maxModuleSpecifierChars)
  return {
    moduleReferences: valid.slice(0, config.maxModuleReferencesPerFile),
    omittedModuleReferenceCount: invalidReferenceCount
      + (candidates.length - valid.length)
      + Math.max(0, valid.length - config.maxModuleReferencesPerFile),
  }
}

/** Built-in TypeScript AST and Markdown parser for bounded line-addressable source symbols. */
export class DeterministicSourceAnalyzer implements SourceAnalyzer {
  constructor(private readonly config: SourceAnalysisConfig = DEFAULT_SOURCE_ANALYSIS_CONFIG) {
    assertConfig(config)
  }

  get cacheKey(): string {
    return [
      'deterministic-source-evidence',
      DETERMINISTIC_SOURCE_ANALYZER_VERSION,
      this.config.maxEvidencePerFile,
      this.config.maxEvidenceNameChars,
      this.config.maxModuleReferencesPerFile,
      this.config.maxModuleSpecifierChars,
    ].join(':')
  }

  analyze(request: SourceAnalysisRequest): SourceFileAnalysis | undefined {
    const text = decodeText(request.bytes)
    if (text === undefined) return undefined
    const sourceFile = request.language !== undefined && CODE_LANGUAGES.has(request.language)
      ? ts.createSourceFile(request.path, text, ts.ScriptTarget.Latest, true, scriptKind(request.language))
      : undefined
    const extracted = request.language === 'Markdown'
      ? { ...markdownEvidence(text, this.config), moduleReferences: [], omittedModuleReferenceCount: 0 }
      : sourceFile === undefined
        ? undefined
        : {
            ...codeEvidence(sourceFile, this.config),
            ...moduleReferences(sourceFile, this.config),
          }
    if (extracted === undefined) return undefined
    return {
      provider: 'deterministic-source-evidence',
      version: DETERMINISTIC_SOURCE_ANALYZER_VERSION,
      evidence: extracted.evidence,
      omittedEvidenceCount: extracted.omittedEvidenceCount,
      moduleReferences: extracted.moduleReferences,
      omittedModuleReferenceCount: extracted.omittedModuleReferenceCount,
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one durable Source analysis payload before it is reconstructed. */
export function parseSourceFileAnalysis(value: unknown): SourceFileAnalysis {
  if (!isRecord(value)
    || value['provider'] !== 'deterministic-source-evidence'
    || value['version'] !== DETERMINISTIC_SOURCE_ANALYZER_VERSION
    || !Array.isArray(value['evidence'])
    || !Array.isArray(value['moduleReferences'])
    || !Number.isSafeInteger(value['omittedEvidenceCount'])
    || (value['omittedEvidenceCount'] as number) < 0
    || !Number.isSafeInteger(value['omittedModuleReferenceCount'])
    || (value['omittedModuleReferenceCount'] as number) < 0) {
    throw new Error('Source file analysis is invalid')
  }
  const evidence = value['evidence'].map((item): SourceEvidence => {
    if (!isRecord(item)
      || typeof item['name'] !== 'string' || item['name'].length === 0
      || !Number.isSafeInteger(item['startLine']) || (item['startLine'] as number) < 1
      || !Number.isSafeInteger(item['endLine']) || (item['endLine'] as number) < (item['startLine'] as number)) {
      throw new Error('Source evidence is invalid')
    }
    if (item['kind'] === 'document-heading') {
      if (!Number.isSafeInteger(item['level']) || (item['level'] as number) < 1 || (item['level'] as number) > 6) {
        throw new Error('Source document heading evidence is invalid')
      }
      return {
        kind: item['kind'],
        name: item['name'],
        level: item['level'] as number,
        startLine: item['startLine'] as number,
        endLine: item['endLine'] as number,
      }
    }
    const declarationKinds: SourceCodeSymbolDeclaration[] = [
      'class', 'function', 'interface', 'type', 'enum', 'enum-member', 'namespace', 'variable', 'method',
      'property', 'constructor', 'getter', 'setter', 'default', 're-export',
    ]
    if (item['kind'] !== 'code-symbol'
      || typeof item['declaration'] !== 'string'
      || !declarationKinds.includes(item['declaration'] as SourceCodeSymbolDeclaration)
      || typeof item['exported'] !== 'boolean'
      || (item['containerName'] !== undefined
        && (typeof item['containerName'] !== 'string' || item['containerName'].length === 0))) {
      throw new Error('Source code symbol evidence is invalid')
    }
    return {
      kind: item['kind'],
      name: item['name'],
      declaration: item['declaration'] as SourceCodeSymbolDeclaration,
      exported: item['exported'],
      ...(item['containerName'] === undefined ? {} : { containerName: item['containerName'] as string }),
      startLine: item['startLine'] as number,
      endLine: item['endLine'] as number,
    }
  })
  const referenceKinds: SourceModuleReferenceKind[] = [
    'import', 'type-import', 're-export', 'type-re-export', 'dynamic-import', 'require', 'import-equals',
  ]
  const moduleReferences = value['moduleReferences'].map((item): SourceModuleReference => {
    if (!isRecord(item)
      || typeof item['kind'] !== 'string'
      || !referenceKinds.includes(item['kind'] as SourceModuleReferenceKind)
      || typeof item['specifier'] !== 'string' || item['specifier'].length === 0
      || !Number.isSafeInteger(item['startLine']) || (item['startLine'] as number) < 1
      || !Number.isSafeInteger(item['endLine']) || (item['endLine'] as number) < (item['startLine'] as number)) {
      throw new Error('Source module reference is invalid')
    }
    return {
      kind: item['kind'] as SourceModuleReferenceKind,
      specifier: item['specifier'],
      startLine: item['startLine'] as number,
      endLine: item['endLine'] as number,
    }
  })
  const parsed: SourceFileAnalysis = {
    provider: value['provider'],
    version: value['version'],
    evidence,
    omittedEvidenceCount: value['omittedEvidenceCount'] as number,
    moduleReferences,
    omittedModuleReferenceCount: value['omittedModuleReferenceCount'] as number,
  }
  if (JSON.stringify(parsed) !== JSON.stringify(value)) throw new Error('Source file analysis has unknown or inconsistent fields')
  return parsed
}
