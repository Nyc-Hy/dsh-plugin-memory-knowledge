import { Context, Service } from '@deepseek-ai/cordis'
import type { SourceRelationAnalyzer } from './source-relations.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sourceRelations: SourceRelations
  }
}

/** Service Definition for replaceable cross-file module relation analysis. */
export abstract class SourceRelations extends Service implements SourceRelationAnalyzer {
  constructor(ctx: Context) {
    super(ctx, 'sourceRelations')
  }

  /** Stable output identity included in Source checkpoints. */
  abstract readonly cacheKey: string

  /** Resolve a complete portable file set without reading source bodies. */
  abstract analyze(...parameters: Parameters<SourceRelationAnalyzer['analyze']>): ReturnType<SourceRelationAnalyzer['analyze']>
}
