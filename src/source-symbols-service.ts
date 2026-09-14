import { Context, Service } from '@deepseek-ai/cordis'
import type { SourceSymbolAnalyzer } from './source-symbols.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sourceSymbols: SourceSymbols
  }
}

/** Service Definition for replaceable cross-file symbol analysis. */
export abstract class SourceSymbols extends Service implements SourceSymbolAnalyzer {
  constructor(ctx: Context) {
    super(ctx, 'sourceSymbols')
  }

  /** Stable output identity included in Source checkpoints. */
  abstract readonly cacheKey: string

  /** Build one bounded graph without retaining source bodies. */
  abstract analyze(...parameters: Parameters<SourceSymbolAnalyzer['analyze']>): ReturnType<SourceSymbolAnalyzer['analyze']>
}
