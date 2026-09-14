import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_SOURCE_ANALYSIS_CONFIG,
  DeterministicSourceAnalyzer,
  type SourceAnalysisConfig,
  type SourceAnalysisRequest,
  type SourceFileAnalysis,
} from './source-analysis.js'
import { SourceAnalysis } from './source-analysis-service.js'

/** Built-in deterministic Source analysis Provider configuration. */
export interface Config extends Partial<SourceAnalysisConfig> {}

/** Schemastery configuration for bounded Source evidence extraction. */
export const Config: z<Config> = z.object({
  maxEvidencePerFile: z.number().step(1).min(1).default(DEFAULT_SOURCE_ANALYSIS_CONFIG.maxEvidencePerFile),
  maxEvidenceNameChars: z.number().step(1).min(1).default(DEFAULT_SOURCE_ANALYSIS_CONFIG.maxEvidenceNameChars),
  maxModuleReferencesPerFile: z.number().step(1).min(1)
    .default(DEFAULT_SOURCE_ANALYSIS_CONFIG.maxModuleReferencesPerFile),
  maxModuleSpecifierChars: z.number().step(1).min(1).default(DEFAULT_SOURCE_ANALYSIS_CONFIG.maxModuleSpecifierChars),
})

/** Local deterministic Provider for TypeScript-AST symbols and Markdown headings. */
export class LocalSourceAnalysis extends SourceAnalysis {
  static Config = Config

  private readonly analyzer: DeterministicSourceAnalyzer

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.analyzer = new DeterministicSourceAnalyzer({ ...DEFAULT_SOURCE_ANALYSIS_CONFIG, ...config })
  }

  override get cacheKey(): string {
    return this.analyzer.cacheKey
  }

  override analyze(request: SourceAnalysisRequest): SourceFileAnalysis | undefined {
    return this.analyzer.analyze(request)
  }
}

export default LocalSourceAnalysis
