import { Context, Service } from '@deepseek-ai/cordis'
import type { SourceAnalyzer } from './source-analysis.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sourceAnalysis: SourceAnalysis
  }
}

/** Service Definition for replaceable local code and documentation parsing. */
export abstract class SourceAnalysis extends Service implements SourceAnalyzer {
  constructor(ctx: Context) {
    super(ctx, 'sourceAnalysis')
  }

  /** Stable identity for reusing prior per-file analysis results. */
  abstract readonly cacheKey: string

  /** Analyze one complete, bounded file without retaining its body. */
  abstract analyze(...parameters: Parameters<SourceAnalyzer['analyze']>): ReturnType<SourceAnalyzer['analyze']>
}
