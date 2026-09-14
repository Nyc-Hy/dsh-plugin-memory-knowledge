import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  exports: Record<string, string | { types?: string; default?: string; import?: string }>
}

describe('package export conditions', () => {
  it.each([
    '.',
    './schema',
    './canonical',
    './projection',
    './initialize',
    './service',
    './provider',
    './evidence-pack',
    './inventory',
    './candidate-generation',
    './source-records',
    './source-analysis',
    './source-analysis-service',
    './source-analysis-provider',
    './source-relations',
    './source-relation-query',
    './source-relations-service',
    './source-relations-provider',
    './source-symbols',
    './source-symbol-query',
    './source-symbols-service',
    './source-symbols-provider',
    './wiki-model',
    './wiki-task',
    './wiki-agent-service',
    './wiki-agent-provider',
    './wiki-catalog',
    './wiki-material',
    './conversation-extraction',
    './conversation-extraction-consumer',
    './inventory-provider',
    './recall',
    './tools',
    './ui-contract',
    './remote',
    './gateway',
  ])(
    'exposes %s through the default condition used by the packaged Loader',
    (subpath) => {
      const entry = manifest.exports[subpath]
      expect(entry).toMatchObject({ default: expect.stringMatching(/^\.\/lib\/.+\.mjs$/u) })
      expect(entry).not.toHaveProperty('import')
    },
  )

})
