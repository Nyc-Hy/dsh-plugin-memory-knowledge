import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_SOURCE_RELATION_CONFIG,
  DeterministicSourceRelationAnalyzer,
  type SourceRelationConfig,
  type SourceRelationGraph,
  type SourceRelationRequest,
} from './source-relations.js'
import { SourceRelations } from './source-relations-service.js'

/** Built-in module relation Provider configuration. */
export interface Config extends Partial<SourceRelationConfig> {}

/** Schemastery configuration for bounded cross-file module relations. */
export const Config: z<Config> = z.object({
  maxRelations: z.number().step(1).min(1).default(DEFAULT_SOURCE_RELATION_CONFIG.maxRelations),
})

/** Local deterministic Provider for syntax-level module relations. */
export class LocalSourceRelations extends SourceRelations {
  static Config = Config

  private readonly analyzer: DeterministicSourceRelationAnalyzer

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.analyzer = new DeterministicSourceRelationAnalyzer({ ...DEFAULT_SOURCE_RELATION_CONFIG, ...config })
  }

  override get cacheKey(): string {
    return this.analyzer.cacheKey
  }

  override analyze(request: SourceRelationRequest): SourceRelationGraph {
    return this.analyzer.analyze(request)
  }
}

export default LocalSourceRelations
