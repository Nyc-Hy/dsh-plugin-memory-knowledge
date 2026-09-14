import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_SOURCE_SYMBOL_CONFIG,
  TypeScriptSourceSymbolAnalyzer,
  type SourceSymbolConfig,
  type SourceSymbolFileReader,
  type SourceSymbolGraph,
  type SourceSymbolRequest,
} from './source-symbols.js'
import { SourceSymbols } from './source-symbols-service.js'

/** Built-in TypeScript symbol Provider configuration. */
export interface Config extends Partial<SourceSymbolConfig> {}

/** Schemastery configuration for bounded cross-file symbol analysis. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxFiles),
  maxTotalBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxTotalBytes),
  maxFileBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxFileBytes),
  maxReferences: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxReferences),
  maxReferencesPerSymbol: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxReferencesPerSymbol),
  maxSymbolNameChars: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxSymbolNameChars),
  maxConfigFiles: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxConfigFiles),
  maxConfigTotalBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxConfigTotalBytes),
  maxConfigFileBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_SYMBOL_CONFIG.maxConfigFileBytes),
})

class DshSourceSymbolFileReader implements SourceSymbolFileReader {
  constructor(private readonly fs: FileSystem) {}

  async read(projectRoot: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const root = await this.fs.resolve('.', { cwd: projectRoot, ...(signal === undefined ? {} : { signal }) })
    const rootPath = this.fs.processPath(root)
    const info = await this.fs.lstat(path, { cwd: rootPath }, signal)
    if (info?.type !== 'file') throw new Error('Source symbol input must be an ordinary file')
    if (info.size !== undefined && info.size > maxBytes) throw new Error('Source symbol input exceeds its declared bound')
    const target: FsTarget = await this.fs.resolve(path, { cwd: rootPath, ...(signal === undefined ? {} : { signal }) })
    if (!this.fs.contains(root, target)) throw new Error('Source symbol path escapes the project')
    return this.fs.readBytes(target, signal, maxBytes)
  }
}

/** Local TypeScript Program Provider for project symbol definitions and references. */
export class LocalSourceSymbols extends SourceSymbols {
  static inject = ['fs']
  static Config = Config

  private readonly analyzer: TypeScriptSourceSymbolAnalyzer

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.analyzer = new TypeScriptSourceSymbolAnalyzer(
      new DshSourceSymbolFileReader(ctx.fs),
      { ...DEFAULT_SOURCE_SYMBOL_CONFIG, ...config },
    )
  }

  override get cacheKey(): string {
    return this.analyzer.cacheKey
  }

  override analyze(request: SourceSymbolRequest): Promise<SourceSymbolGraph> {
    return this.analyzer.analyze(request)
  }
}

export default LocalSourceSymbols
