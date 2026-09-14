import { Context, Service } from '@deepseek-ai/cordis'
import type { WikiRunSnapshot } from './wiki-model.js'

/** Whether remote-model Wiki work is blocked, confirmed per call, or pre-authorized. */
export type WikiDataEgressMode = 'deny' | 'ask' | 'allow'

/** Explicit authorization attached to one bounded Wiki task execution. */
export interface WikiRunAuthorization {
  dataEgressConfirmed?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    wikiGeneration: WikiGeneration
  }
}

/** Service Definition for durable, one-task-at-a-time LLM Wiki analysis, verification, and Page generation. */
export abstract class WikiGeneration extends Service {
  constructor(ctx: Context) {
    super(ctx, 'wikiGeneration')
  }

  /** Plan or resume one project Wiki run and execute at most one bounded analysis, verification, or Page task. */
  abstract runNext(
    projectRoot: string,
    authorization?: WikiRunAuthorization,
    signal?: AbortSignal,
  ): Promise<WikiRunSnapshot>
}
