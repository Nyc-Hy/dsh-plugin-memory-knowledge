import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeSourceInventoryBackend } from '../src/inventory.js'
import { DEFAULT_SOURCE_INVENTORY_CONFIG, KnowledgeProjectInspector } from '../src/inventory-provider.js'
import { DEFAULT_WIKI_PROJECT_CATALOG_CONFIG, wikiPlanInputFromCatalog } from '../src/wiki-catalog.js'
import type { WikiMaterialStreamItem } from '../src/wiki-material.js'
import { createPlannedWikiRun } from '../src/wiki-model.js'
import { initializeGitProject, makeTempDirectory, makeTempProject } from './helpers.js'

async function collect(stream: AsyncIterable<WikiMaterialStreamItem>): Promise<WikiMaterialStreamItem[]> {
  const values: WikiMaterialStreamItem[] = []
  for await (const value of stream) values.push(value)
  return values
}

describe('Wiki material streaming', () => {
  it('reads the cataloged Git object in bounded chunks instead of the changed worktree file', async () => {
    const project = await makeTempProject()
    const original = Buffer.from('一个语言无关的 Wiki 材料\n'.repeat(20))
    const path = join(project, 'src', 'model.unknown')
    await writeFile(path, original)
    await initializeGitProject(project)
    const inspector = new KnowledgeProjectInspector(
      new NodeSourceInventoryBackend(),
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      undefined,
      undefined,
      DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
      {
        chunkBytes: 17,
        maxMaterialBytes: 1_024 * 1_024,
        rangeTargetBytes: 512 * 1_024,
        rangeContextBytes: 1,
        stderrMaxBytes: 8_192,
        processGraceMs: 1_000,
      },
    )
    const catalog = await inspector.catalog(project)
    const planned = createPlannedWikiRun(wikiPlanInputFromCatalog(catalog))
    const coverage = planned.coverage.find(item => item.path === 'src/model.unknown')!
    await writeFile(path, '工作树已经变了，不应该被读取。\n')

    const values = await collect(inspector.readWikiMaterial(project, coverage))
    const chunks = values.filter(value => value.kind === 'chunk')
    const complete = values.at(-1)
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.bytes)))

    expect(bytes).toEqual(original)
    expect(chunks.every(chunk => chunk.bytes.byteLength <= 17)).toBe(true)
    expect(chunks.map(chunk => chunk.startByte)).toEqual(chunks.map((_, index) => index * 17))
    expect(complete).toEqual({
      kind: 'complete',
      byteSize: original.byteLength,
      contentHash: `sha256:${createHash('sha256').update(original).digest('hex')}`,
      chunkCount: chunks.length,
      objectByteSize: original.byteLength,
      objectContentHash: `sha256:${createHash('sha256').update(original).digest('hex')}`,
      startByte: 0,
      endByte: original.byteLength,
    })
  })

  it('prepares exact UTF-8 ranges and rebuilds a corrupt cache from the immutable Git object', async () => {
    const project = await makeTempProject()
    const cacheRoot = await makeTempDirectory()
    const original = Buffer.from([
      '第一段：语言无关的材料🙂。',
      'second paragraph keeps evidence portable.',
      '第三段没有依赖任何语言解析器。',
      '尾段用于验证相邻区间不会遗漏字节。',
    ].join('\n').repeat(8))
    const path = join(project, 'src', 'huge.polyglot')
    await writeFile(path, original)
    await initializeGitProject(project)
    const config = {
      chunkBytes: 13,
      maxMaterialBytes: 4_096,
      rangeTargetBytes: 96,
      rangeContextBytes: 11,
      stderrMaxBytes: 8_192,
      processGraceMs: 1_000,
    }
    const inspector = new KnowledgeProjectInspector(
      new NodeSourceInventoryBackend(),
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      undefined,
      undefined,
      DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
      config,
      cacheRoot,
    )
    const catalog = await inspector.catalog(project)
    const entry = catalog.entries.find(item => item.path === 'src/huge.polyglot')!
    expect(inspector.needsWikiMaterialPreparation(entry)).toBe(true)
    const preparation = await inspector.prepareWikiMaterial(project, entry)
    if (preparation.kind !== 'ranges') throw new Error('expected oversized text ranges')

    expect(preparation.ranges.length).toBeGreaterThan(2)
    expect(preparation.ranges[0]?.startByte).toBe(0)
    expect(preparation.ranges.at(-1)?.endByte).toBe(original.byteLength)
    for (const [index, range] of preparation.ranges.entries()) {
      expect(range.ordinal).toBe(index)
      expect(range.endByte - range.startByte).toBeLessThanOrEqual(config.rangeTargetBytes)
      expect(range.contentStartByte).toBeLessThanOrEqual(range.startByte)
      expect(range.contentEndByte).toBeGreaterThanOrEqual(range.endByte)
      if (index > 0) expect(preparation.ranges[index - 1]?.endByte).toBe(range.startByte)
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(
        original.subarray(range.contentStartByte, range.contentEndByte),
      )).not.toThrow()
    }

    const input = wikiPlanInputFromCatalog(catalog)
    input.entries = input.entries.map(candidate => candidate.path !== entry.path ? candidate : {
      ...candidate,
      preparedMaterial: { contentHash: preparation.contentHash, ranges: preparation.ranges },
    })
    const planned = createPlannedWikiRun(input)
    const coverage = planned.coverage.find(item => item.path === entry.path)!
    const task = planned.tasks.find(candidate => candidate.materialRanges[0]?.ordinal === 1
      && candidate.coverageIds[0] === coverage.id)!
    const range = task.materialRanges[0]!
    if (entry.revision.kind !== 'git-object') throw new Error('expected Git catalog material')

    await writeFile(path, '工作树内容已经改变。\n')
    await writeFile(join(cacheRoot, `${entry.revision.objectId}.blob`), Buffer.alloc(original.byteLength, 0x78))
    const values = await collect(inspector.readWikiMaterialRange(project, coverage, range))
    const chunks = values.filter(value => value.kind === 'chunk')
    const complete = values.at(-1)
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.bytes)))
    const expected = original.subarray(range.contentStartByte, range.contentEndByte)

    expect(bytes).toEqual(expected)
    expect(chunks.every(chunk => chunk.bytes.byteLength <= config.chunkBytes)).toBe(true)
    expect(chunks[0]?.startByte).toBe(range.contentStartByte)
    expect(complete).toEqual({
      kind: 'complete',
      byteSize: expected.byteLength,
      contentHash: range.contentHash,
      chunkCount: chunks.length,
      objectByteSize: original.byteLength,
      objectContentHash: preparation.contentHash,
      startByte: range.contentStartByte,
      endByte: range.contentEndByte,
    })
  })

  it('fails loud for excluded, non-Git, oversized, or size-mismatched material', async () => {
    const project = await makeTempProject()
    await writeFile(join(project, 'src', 'main.go'), 'package main\n')
    await initializeGitProject(project)
    const inspector = new KnowledgeProjectInspector(
      new NodeSourceInventoryBackend(),
      DEFAULT_SOURCE_INVENTORY_CONFIG,
      undefined,
      undefined,
      DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
      {
        chunkBytes: 8,
        maxMaterialBytes: 64,
        rangeTargetBytes: 32,
        rangeContextBytes: 1,
        stderrMaxBytes: 8_192,
        processGraceMs: 1_000,
      },
    )
    const planned = createPlannedWikiRun(wikiPlanInputFromCatalog(await inspector.catalog(project)))
    const ordinary = planned.coverage.find(item => item.path === 'src/main.go')!
    const excluded = planned.coverage.find(item => item.status === 'excluded')!

    await expect(collect(inspector.readWikiMaterial(project, excluded))).rejects.toThrow('excluded Wiki coverage')
    await expect(collect(inspector.readWikiMaterial(project, {
      ...ordinary,
      revision: { kind: 'content-hash', contentHash: `sha256:${'1'.repeat(64)}` },
    }))).rejects.toThrow('requires a worktree reader provider')
    await expect(collect(inspector.readWikiMaterial(project, { ...ordinary, byteSize: 65 })))
      .rejects.toThrow('configured streaming bound')
    await expect(collect(inspector.readWikiMaterial(project, { ...ordinary, byteSize: ordinary.byteSize + 1 })))
      .rejects.toThrow('does not match its declared byte size')
  })
})
