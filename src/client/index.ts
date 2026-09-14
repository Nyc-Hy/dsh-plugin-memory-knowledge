import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { MEMORY_UI_REMOTE_CONTRIBUTION } from '../remote-contract.js'
import type { MemoryKnowledgeSectionInjected } from './MemoryKnowledgeSection.js'
import { MemoryKnowledgeSection } from './MemoryKnowledgeSection.js'
import { en, zh, type MemoryKnowledgeLocaleKey } from './locales.js'
import { MEMORY_KNOWLEDGE_STYLES } from './styles.js'

export type { MemoryKnowledgeSectionInjected, MemoryKnowledgeSectionProps } from './MemoryKnowledgeSection.js'
export type { MemoryKnowledgeLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Local memory browser copy. */
    memoryKnowledge: MemoryKnowledgeLocaleKey
  }
}

export const NS = 'memoryKnowledge'
export const inject = ['slots', 'locale', 'remote']

function remoteValue<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`memoryKnowledgeUi failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Mount the strict Remote contribution and register the Settings section. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(MEMORY_UI_REMOTE_CONTRIBUTION)
  ctx.inject(['slots', 'locale', 'remote', 'remote.memoryKnowledgeUi'], (scope: ClientContext) => {
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'memory-knowledge-ui: dictionaries')
    scope.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-memory-knowledge'
      style.textContent = MEMORY_KNOWLEDGE_STYLES
      document.head.appendChild(style)
      return () => { style.remove() }
    }, 'memory-knowledge-ui: styles')

    const injected = (): MemoryKnowledgeSectionInjected => ({
      overview: async request => remoteValue(await scope.remote.memoryKnowledgeUi.overview(request)),
      planWiki: async request => remoteValue(await scope.remote.memoryKnowledgeUi.planWiki(request)),
      runWikiTask: async request => remoteValue(await scope.remote.memoryKnowledgeUi.runWikiTask(request)),
      wikiTree: async request => remoteValue(await scope.remote.memoryKnowledgeUi.wikiTree(request)),
      saveKnowledgeRevision: async request => remoteValue(await scope.remote.memoryKnowledgeUi.saveKnowledgeRevision(request)),
      wikiBudgets: async request => remoteValue(await scope.remote.memoryKnowledgeUi.wikiBudgets(request)),
      increaseWikiBudget: async request => remoteValue(await scope.remote.memoryKnowledgeUi.increaseWikiBudget(request)),
      search: async request => remoteValue(await scope.remote.memoryKnowledgeUi.search(request)),
      searchEvidence: async request => remoteValue(await scope.remote.memoryKnowledgeUi.searchEvidence(request)),
      queryRelations: async request => remoteValue(await scope.remote.memoryKnowledgeUi.queryRelations(request)),
      querySymbols: async request => remoteValue(await scope.remote.memoryKnowledgeUi.querySymbols(request)),
      trace: async request => remoteValue(await scope.remote.memoryKnowledgeUi.trace(request)),
      createMemory: async request => remoteValue(await scope.remote.memoryKnowledgeUi.createMemory(request)),
      updateMemory: async request => remoteValue(await scope.remote.memoryKnowledgeUi.updateMemory(request)),
      setMemoryStatus: async request => remoteValue(await scope.remote.memoryKnowledgeUi.setMemoryStatus(request)),
      review: async request => remoteValue(await scope.remote.memoryKnowledgeUi.review(request)),
      promote: async request => remoteValue(await scope.remote.memoryKnowledgeUi.promote(request)),
      generate: async request => remoteValue(await scope.remote.memoryKnowledgeUi.generate(request)),
    })
    const t = scope.locale.bind(NS)
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section',
      id: 'memory-knowledge',
      order: 12,
      label: () => t('nav'),
      locale: NS,
      inject: injected,
    }, MemoryKnowledgeSection))
  })

  return disposeRemote
}
