import { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanonicalStoreError } from '../src/canonical.js'
import { KnowledgeSelectionRevisionConflictError } from '../src/database.js'
import { MemoryKnowledgeGateway } from '../src/gateway.js'
import { MEMORY_UI_INVOCATIONS } from '../src/remote-contract.js'
import type { LocalMemoryEntry, MemoryCandidate, MemoryTrace, RecallableMemoryRecord } from '../src/runtime-model.js'
import type { WikiRun } from '../src/wiki-model.js'
import { WikiMaterialBudgetConflictError, type WikiMaterialBudgetPage, type WikiMaterialReadBudget } from '../src/wiki-material-budget.js'

const contexts: Context[] = []
const projectPath = '/private/projects/secret-repository'
const workspace = {
  id: 'workspace-one',
  path: projectPath,
  title: '示例项目',
} as unknown as Workspace

const candidate: MemoryCandidate = {
  id: 'cand_11111111-1111-4111-8111-111111111111' as never,
  revision: 3,
  target: 'memory',
  applicability: 'project',
  projectRoot: projectPath,
  kind: 'decision',
  title: '保留来源',
  content: '候选正文',
  tags: ['memory'],
  sensitivity: 'normal',
  status: 'pending',
  suggestedBy: 'model',
  provenance: [{
    kind: 'git-file',
    sourceId: 'src_11111111-1111-4111-8111-111111111111' as never,
    commit: '1234567890abcdef',
    path: 'src/example.ts',
    startLine: 8,
    contentHash: 'sha256:test',
  }],
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T01:00:00.000Z',
}

const localMemory: LocalMemoryEntry = {
  id: 'mem_22222222-2222-4222-8222-222222222222' as never,
  revision: 2,
  applicability: 'project',
  projectRoot: projectPath,
  kind: 'method',
  status: 'active',
  title: '发布流程',
  content: '发布前先运行聚焦验证。',
  conditions: ['修改插件时'],
  tags: ['release'],
  sensitivity: 'normal',
  provenance: [],
  supersedes: [],
  conflictsWith: [],
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-11T00:00:00.000Z',
}

const wikiRun: WikiRun = {
  schemaVersion: 8,
  id: 'wrun_11111111-1111-4111-8111-111111111111' as never,
  projectRoot: projectPath,
  status: 'planned',
  catalogHash: `sha256:${'a'.repeat(64)}`,
  catalogComplete: true,
  catalogOmittedItemCount: 0,
  coverage: {
    itemCount: 4,
    totalBytes: 4_096,
    pending: 3,
    analyzing: 0,
    analyzed: 0,
    deferred: 0,
    excluded: 1,
    blocked: 0,
    stale: 0,
  },
  materialRanges: {
    rangeCount: 0,
    totalBytes: 0,
    analyzedBytes: 0,
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  },
  tasks: {
    taskCount: 1,
    planned: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  },
  fileSynthesis: {
    rulesVersion: 2,
    status: 'unplanned',
    fileCount: 0,
    inputClaimCount: 0,
    taskCount: 0,
    levelCount: 0,
    completeFileCount: 0,
    incompleteFileCount: null,
    noReductionFileCount: 0,
    levelLimitFileCount: 0,
    limits: null,
  },
  consistency: {
    rulesVersion: 1,
    planned: false,
    candidatePairCount: 0,
    candidatePairsComplete: false,
    omittedCandidatePairCount: null,
  },
  pageGeneration: { rulesVersion: 1, planned: false, claimCount: 0, taskCount: 0 },
  rootPageIds: [],
  blockingReasons: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function mounted(options: { restrictedTrace?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const record: RecallableMemoryRecord = {
    id: 'mem_11111111-1111-4111-8111-111111111111' as never,
    recordType: 'project-memory',
    title: '项目记忆',
    content: '项目正文',
    tags: ['project'],
    evidenceClass: 'human-verified',
    sensitivity: 'normal',
    status: 'verified',
    projectRoot: projectPath,
    provenance: candidate.provenance,
    updatedAt: candidate.updatedAt,
  }
  const trace: MemoryTrace = {
    id: record.id,
    recordType: record.recordType,
    title: record.title,
    content: record.content,
    status: record.status,
    sensitivity: options.restrictedTrace === true ? 'restricted' : 'normal',
    projectRoot: projectPath,
    provenance: candidate.provenance,
    updatedAt: record.updatedAt,
  }
  const memoryKnowledge = {
    listCandidates: vi.fn(async () => [candidate]),
    listRecallable: vi.fn(async () => [record]),
    listLocalMemoryEntries: vi.fn(async (): Promise<LocalMemoryEntry[]> => []),
    getLocalMemoryEntry: vi.fn(async (): Promise<LocalMemoryEntry | undefined> => undefined),
    listLocalMemoryRevisions: vi.fn(async () => []),
    createLocalMemoryEntry: vi.fn(async input => ({
      id: 'mem_22222222-2222-4222-8222-222222222222',
      revision: 1,
      ...input,
      status: 'active',
      supersedes: [],
      conflictsWith: [],
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    })),
    updateLocalMemoryEntry: vi.fn(),
    setLocalMemoryEntryStatus: vi.fn(),
    search: vi.fn(async () => [{ ...record, score: 1, truncated: false }]),
    searchSourceEvidence: vi.fn(async request => ({
      retriever: 'source-evidence-fts' as const,
      version: 2 as const,
      query: request.query,
      totalMatches: 1,
      omittedHitCount: 0,
      truncationReasons: [],
      sourceRevisions: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef1234567890abcdef12345678',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
      }],
      hits: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef1234567890abcdef12345678',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        path: 'src/example.ts',
        contentHash: `sha256:${'3'.repeat(64)}`,
        area: 'src',
        artifactKind: 'code' as const,
        language: 'TypeScript',
        evidence: {
          kind: 'code-symbol' as const,
          declaration: 'function' as const,
          name: 'greeting',
          exported: true,
          startLine: 2,
          endLine: 4,
        },
      }],
    })),
    querySourceRelations: vi.fn(async request => ({
      retriever: 'source-relations-sql' as const,
      version: 1 as const,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.area === undefined ? {} : { area: request.area }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      totalMatches: 1,
      omittedEdgeCount: 0,
      truncationReasons: [],
      sourceRevisions: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef1234567890abcdef12345678',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        relationProvider: 'deterministic-module-relations',
        relationProviderKey: 'deterministic-module-relations:1:100000',
        relationOutputHash: `sha256:${'4'.repeat(64)}`,
        graphOmittedEdgeCount: 2,
      }],
      edges: [{
        edgeId: '5'.repeat(64),
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef1234567890abcdef12345678',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        fromPath: 'src/example.ts',
        fromContentHash: `sha256:${'3'.repeat(64)}`,
        specifier: '/private/projects/secret-repository/absolute.ts',
        kind: 'import' as const,
        resolution: 'unresolved' as const,
        startLine: 1,
        endLine: 1,
      }],
    })),
    querySourceSymbols: vi.fn(async request => ({
      retriever: 'source-symbols-sql' as const,
      version: 2 as const,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.definitionPath === undefined ? {} : { definitionPath: request.definitionPath }),
      ...(request.referencePath === undefined ? {} : { referencePath: request.referencePath }),
      ...(request.referenceKind === undefined ? {} : { referenceKind: request.referenceKind }),
      totalMatches: 1,
      omittedReferenceCount: 0,
      truncationReasons: [],
      sourceRevisions: [{
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef1234567890abcdef12345678',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        symbolProvider: 'typescript-program-symbols',
        symbolProviderKey: 'typescript-program-symbols:1:test',
        symbolOutputHash: `sha256:${'6'.repeat(64)}`,
        graphOmittedFileCount: 2,
        graphOmittedReferenceCount: 3,
        configMode: 'tsconfig' as const,
        configPaths: ['tsconfig.json'],
        projectReferenceCount: 1,
        pathAliasCount: 2,
        configDiagnosticCount: 0,
        omittedConfigFileCount: 0,
      }],
      edges: [{
        referenceId: '7'.repeat(64),
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef1234567890abcdef12345678',
        inventoryHash: `sha256:${'1'.repeat(64)}`,
        sourceRecordHash: `sha256:${'2'.repeat(64)}`,
        definitionId: `sym_${'8'.repeat(64)}`,
        symbolName: 'greeting',
        declaration: 'FunctionDeclaration',
        definitionPath: 'src/model.ts',
        definitionContentHash: `sha256:${'9'.repeat(64)}`,
        definitionStartLine: 2,
        definitionEndLine: 2,
        referencePath: 'src/example.ts',
        referenceContentHash: `sha256:${'3'.repeat(64)}`,
        referenceKind: 'value' as const,
        referenceStartLine: 4,
        referenceEndLine: 4,
      }],
    })),
    trace: vi.fn(async () => trace),
    reviewCandidate: vi.fn(async () => ({ ...candidate, revision: 4, status: 'accepted' as const })),
    generateKnowledgeCardCandidates: vi.fn(async () => ({
      candidates: [],
      skipped: [{ kind: 'already-current' as const }],
      understandings: [{
        version: 5 as const,
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        commit: '1234567890abcdef',
        inventoryHash: 'sha256:inventory',
        outputHash: `sha256:${'a'.repeat(64)}`,
        recordCount: 12,
        evidenceCount: 4,
        totalBytes: 4_096,
        areaCount: 3,
        relationCount: 7,
        internalRelationCount: 4,
        externalRelationCount: 2,
        unresolvedRelationCount: 1,
        omittedRelationCount: 3,
      }],
    })),
    listSourceUnderstandings: vi.fn(async () => [{
      version: 5 as const,
      sourceId: 'src_11111111-1111-4111-8111-111111111111',
      commit: '1234567890abcdef',
      inventoryHash: 'sha256:inventory',
      outputHash: `sha256:${'a'.repeat(64)}`,
      recordCount: 12,
      evidenceCount: 4,
      totalBytes: 4_096,
      areaCount: 3,
      relationCount: 7,
      internalRelationCount: 4,
      externalRelationCount: 2,
      unresolvedRelationCount: 1,
      omittedRelationCount: 3,
    }]),
    listSourceInventoryBaselines: vi.fn(async () => []),
    listWikiRuns: vi.fn(async () => [wikiRun]),
    getKnowledgeVersionState: vi.fn(async () => ({
      selection: {
        schemaVersion: 1 as const,
        projectRoot: projectPath,
        revision: 1,
        mode: 'automatic' as const,
        analysisGeneration: 1,
        currentRunId: wikiRun.id,
        updatedAt: wikiRun.updatedAt,
      },
    })),
    listKnowledgeHumanRevisions: vi.fn(async () => []),
    applyKnowledgeHumanRevision: vi.fn(),
    getWikiRunSnapshot: vi.fn(async () => undefined),
    listWikiMaterialReadBudgets: vi.fn(async (): Promise<WikiMaterialBudgetPage> => ({ items: [] })),
    increaseWikiMaterialReadBudget: vi.fn(async (): Promise<WikiMaterialReadBudget> => { throw new Error('未配置测试账本') }),
    planWikiProject: vi.fn(async () => ({ run: { run: wikiRun } } as never)),
    getCandidate: vi.fn(async () => candidate),
    promoteCandidate: vi.fn(),
  }
  ctx.provide('memoryKnowledge', memoryKnowledge as never)
  const knowledgeProject = {
    inspect: vi.fn(async () => ({
      sources: [{
        version: 3,
        sourceId: 'src_11111111-1111-4111-8111-111111111111',
        state: 'ready',
        commit: '1234567890abcdef',
        branch: 'main',
        dirty: true,
        reuseKey: `sha256:${'4'.repeat(64)}`,
        scanMode: 'full',
        reusedFileCount: 0,
        readFileCount: 12,
        inventoryHash: 'sha256:inventory',
        fileCount: 12,
        totalBytes: 4_096,
        files: [{ path: 'src/example.ts', size: 128, contentHash: 'sha256:file' }],
        issues: [],
      }],
      cards: [{
        cardId: 'card_11111111-1111-4111-8111-111111111111',
        title: '项目结构',
        canonicalStatus: 'verified',
        state: 'stale',
        reasons: [{ kind: 'file-changed', path: 'src/example.ts' }],
      }],
      staleCardCount: 1,
      degradedCardCount: 0,
    })),
  }
  ctx.provide('knowledgeProject', knowledgeProject as never)
  const wikiGeneration = {
    runNext: vi.fn(async () => ({ run: {
      ...wikiRun,
      status: 'verifying',
      tasks: { ...wikiRun.tasks, planned: 0, succeeded: 1 },
    } } as never)),
  }
  ctx.provide('wikiGeneration', wikiGeneration as never)
  ctx.provide('workspaceRegistry', {
    list: () => [workspace],
    get: (id: string) => id === workspace.id ? workspace : undefined,
  } as never)
  const register = vi.fn(() => async () => {})
  ctx.provide('typert', { register } as never)
  const gateway = new MemoryKnowledgeGateway(ctx)
  return { gateway, knowledgeProject, memoryKnowledge, register, wikiGeneration }
}

describe('memory knowledge UI gateway', () => {
  it('projects workspace names and portable evidence without local paths', async () => {
    const { gateway, memoryKnowledge, register } = mounted()
    const overview = await gateway.overview({ domain: 'memory', workspaceId: String(workspace.id) })
    expect(register).toHaveBeenCalledOnce()
    expect(overview).toMatchObject({
      workspaces: [{ id: String(workspace.id), title: '示例项目' }],
      candidates: [{ workspaceTitle: '示例项目', evidence: ['src/example.ts:8 · 12345678'] }],
      records: [{ workspaceTitle: '示例项目' }],
      projectStatus: {
        omittedSourceCount: 0,
        sources: [{
          branch: 'main',
          revision: '1234567890abcdef',
          fileCount: 12,
          issueCount: 0,
          understandingState: 'current',
          sourceRecordCount: 12,
          sourceEvidenceCount: 4,
          sourceAreaCount: 3,
          sourceRelationCount: 7,
          sourceInternalRelationCount: 4,
          sourceExternalRelationCount: 2,
          sourceUnresolvedRelationCount: 1,
          sourceOmittedRelationCount: 3,
          understandingHash: `sha256:${'a'.repeat(64)}`,
        }],
        cards: [{
          title: '项目结构',
          state: 'stale',
          reasons: [{ kind: 'file-changed', path: 'src/example.ts' }],
          omittedReasonCount: 0,
        }],
        omittedCardCount: 0,
      },
      knowledgeVersion: {
        status: 'draft',
        mode: 'automatic',
        selectionRevision: 1,
        analysisGeneration: 1,
        currentRunId: String(wikiRun.id),
        sourceRunId: String(wikiRun.id),
        humanRevisionCount: 0,
      },
      wikiRuns: [{
        id: String(wikiRun.id),
        status: 'planned',
        catalogComplete: true,
        coverage: { itemCount: 4, pending: 3, excluded: 1 },
        completion: {
          eligibleForActivation: false,
          checks: expect.arrayContaining([
            { id: 'coverage', state: 'fail', issueCount: 3 },
            { id: 'material-exposure', state: 'unsupported', issueCount: 1 },
          ]),
        },
        rootPageCount: 0,
      }],
      wikiRunHistoryTruncated: false,
    })
    expect(memoryKnowledge.listWikiRuns).toHaveBeenCalledWith(projectPath, 21)
    expect(memoryKnowledge.getKnowledgeVersionState).toHaveBeenCalledWith(projectPath)
    expect(memoryKnowledge.listRecallable).toHaveBeenCalledWith({
      projectRoot: projectPath,
      domain: 'memory',
      scopeMode: 'selected',
      limit: 120,
    })
    expect(JSON.stringify(overview)).not.toContain(projectPath)
  })

  it('passes the selected record domain and strict project scope to search', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const signal = new AbortController().signal

    await gateway.search({ domain: 'knowledge', query: '示例模块', workspaceId: String(workspace.id) }, signal)

    expect(memoryKnowledge.search).toHaveBeenCalledWith({
      query: '示例模块',
      projectRoot: projectPath,
      domain: 'knowledge',
      scopeMode: 'selected',
      limit: 30,
      maxChars: 60_000,
      signal,
    })
  })

  it('rejects project knowledge requests without a workspace at the Host boundary', async () => {
    const { gateway } = mounted()
    const signal = new AbortController().signal

    await expect(gateway.overview({ domain: 'knowledge' } as never))
      .rejects.toThrow('knowledge browsing requires a workspace')
    await expect(gateway.search({ domain: 'knowledge', query: '示例模块' } as never, signal))
      .rejects.toThrow('knowledge search requires a workspace')
  })

  it('treats a missing canonical store as project knowledge not yet initialized', async () => {
    const { gateway, knowledgeProject, memoryKnowledge } = mounted()
    knowledgeProject.inspect.mockRejectedValue(new CanonicalStoreError(
      'KNOWLEDGE_NOT_FOUND',
      join(projectPath, '.dsh'),
      'required knowledge directory is missing',
    ))

    const overview = await gateway.overview({ domain: 'knowledge', workspaceId: String(workspace.id) })

    expect(overview.projectStatus).toBeUndefined()
    expect(memoryKnowledge.listRecallable).toHaveBeenCalledWith({
      projectRoot: projectPath,
      domain: 'knowledge',
      scopeMode: 'selected',
      limit: 120,
    })
  })

  it('bounds project status collections and reports every omitted item', async () => {
    const { gateway, knowledgeProject } = mounted()
    const source = {
      version: 3,
      sourceId: 'src_11111111-1111-4111-8111-111111111111',
      state: 'ready',
      commit: '1234567890abcdef',
      branch: 'main',
      dirty: false,
      reuseKey: `sha256:${'4'.repeat(64)}`,
      scanMode: 'incremental',
      reusedFileCount: 1,
      readFileCount: 0,
      inventoryHash: 'sha256:inventory',
      fileCount: 1,
      totalBytes: 128,
      files: [],
      issues: [],
    }
    const reason = { kind: 'file-changed', path: 'src/example.ts' }
    const card = {
      cardId: 'card_11111111-1111-4111-8111-111111111111',
      title: '项目结构',
      canonicalStatus: 'verified',
      state: 'stale',
      reasons: Array.from({ length: 21 }, () => reason),
    }
    knowledgeProject.inspect.mockResolvedValue({
      sources: Array.from({ length: 121 }, () => source),
      cards: Array.from({ length: 121 }, () => card),
      staleCardCount: 121,
      degradedCardCount: 0,
    } as never)

    const overview = await gateway.overview({ domain: 'memory', workspaceId: String(workspace.id) })

    expect(overview.projectStatus).toMatchObject({
      omittedSourceCount: 1,
      omittedCardCount: 1,
      staleCardCount: 121,
    })
    expect(overview.projectStatus?.sources).toHaveLength(120)
    expect(overview.projectStatus?.cards).toHaveLength(120)
    expect(overview.projectStatus?.cards[0]?.reasons).toHaveLength(20)
    expect(overview.projectStatus?.cards[0]?.omittedReasonCount).toBe(1)
  })

  it('bounds Wiki run history and blocking reasons before browser projection', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const runs = Array.from({ length: 21 }, (_, index): WikiRun => ({
      ...wikiRun,
      id: `wrun_11111111-1111-4111-8111-${String(index).padStart(12, '0')}` as never,
      blockingReasons: Array.from({ length: 21 }, (__, reasonIndex) => `阻塞原因 ${reasonIndex}`),
    }))
    memoryKnowledge.listWikiRuns.mockResolvedValue(runs)

    const overview = await gateway.overview({ domain: 'memory', workspaceId: String(workspace.id) })

    expect(memoryKnowledge.listWikiRuns).toHaveBeenCalledWith(projectPath, 21)
    expect(overview.wikiRuns).toHaveLength(20)
    expect(overview.wikiRunHistoryTruncated).toBe(true)
    expect(overview.wikiRuns?.[0]?.blockingReasons).toHaveLength(20)
    expect(overview.wikiRuns?.[0]?.omittedBlockingReasonCount).toBe(1)
  })

  it('projects one active version pointer without exposing its project path', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const generatedVersionId = 'kgv_11111111-1111-4111-8111-111111111111'
    const effectiveVersionId = 'kev_22222222-2222-4222-8222-222222222222'
    memoryKnowledge.getKnowledgeVersionState.mockResolvedValue({
      selection: {
        schemaVersion: 1,
        projectRoot: projectPath,
        revision: 4,
        mode: 'automatic',
        analysisGeneration: 3,
        currentRunId: wikiRun.id,
        effectiveVersionId,
        updatedAt: wikiRun.updatedAt,
      },
      generatedVersion: { id: generatedVersionId },
      effectiveVersion: { id: effectiveVersionId, runId: wikiRun.id, humanRevisionIds: [] },
    } as never)

    const overview = await gateway.overview({ domain: 'knowledge', workspaceId: String(workspace.id) })

    expect(overview.knowledgeVersion).toEqual({
      status: 'active',
      mode: 'automatic',
      selectionRevision: 4,
      analysisGeneration: 3,
      currentRunId: String(wikiRun.id),
      sourceRunId: String(wikiRun.id),
      generatedVersionId,
      effectiveVersionId,
      humanRevisionCount: 0,
    })
    expect(JSON.stringify(overview.knowledgeVersion)).not.toContain(projectPath)
    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'overview')!
    if (descriptor.result.mode !== 'strict') throw new Error('overview result codec must be strict')
    expect(descriptor.result.schema.parse(overview)).toEqual(overview)
  })

  it('saves one human Wiki revision through the workspace-scoped strict RPC projection', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const requestId = 'khreq_11111111-1111-4111-8111-111111111111'
    const pageId = 'wpage_22222222-2222-4222-8222-222222222222'
    const generatedVersionId = 'kgv_33333333-3333-4333-8333-333333333333'
    const baseEffectiveVersionId = 'kev_44444444-4444-4444-8444-444444444444'
    const revisedEffectiveVersionId = 'kev_55555555-5555-4555-8555-555555555555'
    const revisionId = 'khr_66666666-6666-4666-8666-666666666666'
    memoryKnowledge.applyKnowledgeHumanRevision.mockResolvedValue({
      revision: {
        schemaVersion: 1,
        id: revisionId,
        requestId,
        requestFingerprint: `sha256:${'7'.repeat(64)}`,
        revision: 1,
        projectRoot: projectPath,
        generatedVersionId,
        baseEffectiveVersionId,
        effectiveVersionId: revisedEffectiveVersionId,
        pageId,
        kind: 'replace-page-body',
        title: '人工架构说明',
        content: '由操作者确认的架构入口。',
        affectedClaimIds: [],
        createdAt: wikiRun.updatedAt,
      },
      effectiveVersion: {
        schemaVersion: 1,
        id: revisedEffectiveVersionId,
        projectRoot: projectPath,
        generatedVersionId,
        runId: wikiRun.id,
        runSnapshotHash: `sha256:${'8'.repeat(64)}`,
        humanRevisionIds: [revisionId],
        createdAt: wikiRun.updatedAt,
      },
      selection: {
        schemaVersion: 1,
        projectRoot: projectPath,
        revision: 5,
        mode: 'fixed',
        analysisGeneration: 3,
        currentRunId: wikiRun.id,
        effectiveVersionId: revisedEffectiveVersionId,
        updatedAt: wikiRun.updatedAt,
      },
    } as never)

    const result = await gateway.saveKnowledgeRevision({
      workspaceId: String(workspace.id),
      requestId,
      expectedSelectionRevision: 4,
      baseEffectiveVersionId,
      pageId,
      kind: 'replace-page-body',
      title: '人工架构说明',
      content: '由操作者确认的架构入口。',
    })

    expect(memoryKnowledge.applyKnowledgeHumanRevision).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: projectPath,
      requestId,
      expectedSelectionRevision: 4,
      baseEffectiveVersionId,
      pageId,
      kind: 'replace-page-body',
    }))
    expect(result).toMatchObject({
      outcome: 'updated',
      revision: { id: revisionId, title: '人工架构说明' },
      knowledgeVersion: {
        status: 'active',
        mode: 'fixed',
        selectionRevision: 5,
        effectiveVersionId: revisedEffectiveVersionId,
        humanRevisionCount: 1,
      },
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)
    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'saveKnowledgeRevision')!
    if (descriptor.result.mode !== 'strict') throw new Error('knowledge revision result codec must be strict')
    expect(descriptor.result.schema.parse(result)).toEqual(result)
  })

  it('returns a conflict when a human Wiki revision was based on an obsolete selection', async () => {
    const { gateway, memoryKnowledge } = mounted()
    memoryKnowledge.applyKnowledgeHumanRevision.mockRejectedValue(
      new KnowledgeSelectionRevisionConflictError(projectPath, 2, 3),
    )
    await expect(gateway.saveKnowledgeRevision({
      workspaceId: String(workspace.id),
      requestId: 'khreq_77777777-7777-4777-8777-777777777777',
      expectedSelectionRevision: 2,
      baseEffectiveVersionId: 'kev_88888888-8888-4888-8888-888888888888',
      pageId: 'wpage_99999999-9999-4999-8999-999999999999',
      kind: 'append-page-note',
      content: '并发保存后的补充说明。',
    })).resolves.toEqual({ outcome: 'conflict' })
  })

  it('never returns restricted trace content to the browser', async () => {
    const { gateway } = mounted({ restrictedTrace: true })
    await expect(gateway.trace({ id: String(candidate.id), workspaceId: String(workspace.id) })).resolves.toBeNull()
  })

  it('does not return a project trace without its selected workspace', async () => {
    const { gateway } = mounted()
    await expect(gateway.trace({ id: 'mem_11111111-1111-4111-8111-111111111111' })).resolves.toBeNull()
  })

  it('creates, revises, and changes local-memory lifecycle through guarded Workspace RPCs', async () => {
    const { gateway, memoryKnowledge } = mounted()
    memoryKnowledge.createLocalMemoryEntry.mockResolvedValue(localMemory)
    memoryKnowledge.getLocalMemoryEntry.mockResolvedValue(localMemory)
    memoryKnowledge.updateLocalMemoryEntry.mockResolvedValue({ ...localMemory, revision: 3, title: '新发布流程' })
    memoryKnowledge.setLocalMemoryEntryStatus.mockResolvedValue({ ...localMemory, revision: 3, status: 'deprecated' })

    const created = await gateway.createMemory({
      workspaceId: String(workspace.id),
      kind: 'method',
      title: localMemory.title,
      content: localMemory.content,
      conditions: localMemory.conditions,
      tags: localMemory.tags,
    })
    expect(memoryKnowledge.createLocalMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({
      applicability: 'project',
      projectRoot: projectPath,
      kind: 'method',
      sensitivity: 'normal',
      provenance: [],
    }))
    expect(created).toMatchObject({ outcome: 'updated', record: { id: localMemory.id, editable: true, revision: 2 } })

    const updated = await gateway.updateMemory({
      id: String(localMemory.id),
      revision: 2,
      workspaceId: String(workspace.id),
      kind: 'method',
      title: '新发布流程',
      content: localMemory.content,
      conditions: localMemory.conditions,
      tags: localMemory.tags,
    })
    expect(memoryKnowledge.updateLocalMemoryEntry).toHaveBeenCalledWith(
      localMemory.id,
      expect.objectContaining({ title: '新发布流程', supersedes: [], conflictsWith: [] }),
      2,
      projectPath,
    )
    expect(updated).toMatchObject({ outcome: 'updated', record: { revision: 3, title: '新发布流程' } })

    const deprecated = await gateway.setMemoryStatus({
      id: String(localMemory.id), revision: 2, workspaceId: String(workspace.id), status: 'deprecated',
    })
    expect(memoryKnowledge.setLocalMemoryEntryStatus).toHaveBeenCalledWith(localMemory.id, 'deprecated', 2, projectPath)
    expect(deprecated).toMatchObject({ outcome: 'updated', record: { status: 'deprecated', revision: 3 } })

    for (const method of ['createMemory', 'updateMemory', 'setMemoryStatus'] as const) {
      const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === method)!
      if (descriptor.result.mode !== 'strict') throw new Error(`${method} result codec must be strict`)
      expect(descriptor.result.schema.parse(method === 'createMemory' ? created : method === 'updateMemory' ? updated : deprecated)).toBeTruthy()
    }
    expect(JSON.stringify([created, updated, deprecated])).not.toContain(projectPath)
  })

  it('generates candidates through a Workspace id without returning its local path', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const result = await gateway.generate({ workspaceId: String(workspace.id) })
    expect(result).toEqual({ candidateCount: 0, skippedCount: 1, sourceCount: 1, sourceRecordCount: 12 })
    expect(memoryKnowledge.generateKnowledgeCardCandidates).toHaveBeenCalledWith(projectPath)
    expect(JSON.stringify(result)).not.toContain(projectPath)
  })

  it('plans Wiki coverage through a Workspace id without returning catalog paths', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const signal = new AbortController().signal
    const result = await gateway.planWiki({ workspaceId: String(workspace.id) }, signal)

    expect(memoryKnowledge.planWikiProject).toHaveBeenCalledWith(projectPath, signal)
    expect(result).toMatchObject({
      run: {
        id: String(wikiRun.id),
        status: 'planned',
        catalogComplete: true,
        coverage: { itemCount: 4, pending: 3, excluded: 1 },
        fileSynthesis: { status: 'unplanned', fileCount: 0, inputClaimCount: 0, taskCount: 0 },
      },
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)
    expect(JSON.stringify(result)).not.toContain('src/example.ts')

    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'planWiki')!
    if (descriptor.result.mode !== 'strict') throw new Error('Wiki plan result codec must be strict')
    expect(descriptor.result.schema.parse(result)).toEqual(result)
  })

  it('runs one durable Wiki shard through a Workspace id without returning local paths', async () => {
    const { gateway, wikiGeneration } = mounted()
    const signal = new AbortController().signal
    const result = await gateway.runWikiTask({
      workspaceId: String(workspace.id),
      dataEgressConfirmed: true,
    }, signal)

    expect(wikiGeneration.runNext).toHaveBeenCalledWith(
      projectPath,
      { dataEgressConfirmed: true },
      signal,
    )
    expect(result).toMatchObject({
      run: {
        status: 'verifying',
        tasks: { taskCount: 1, planned: 0, succeeded: 1 },
      },
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)

    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'runWikiTask')!
    if (descriptor.result.mode !== 'strict') throw new Error('Wiki task result codec must be strict')
    expect(descriptor.result.schema.parse(result)).toEqual(result)
  })

  it('只按 Workspace 查询 20 条任务账本；确认扩额不启动模型', async () => {
    const { gateway, memoryKnowledge, wikiGeneration } = mounted()
    const budget: WikiMaterialReadBudget = {
      runId: wikiRun.id, taskId: `wtask_${'1'.repeat(64)}` as never,
      limitBytes: 100, reservedBytes: 60, reservationCount: 1, blockedReadBytes: 60,
      startedAt: '2026-09-03T00:00:00.000Z', startedAtAttempt: 1,
    }
    const hash = `sha256:${'a'.repeat(64)}`
    memoryKnowledge.listWikiMaterialReadBudgets.mockResolvedValue({ items: [{ budget, budgetHash: hash, kind: 'analysis', status: 'failed' }], nextAfterTaskId: budget.taskId })
    const request = { workspaceId: String(workspace.id), runId: wikiRun.id, onlyBlocked: true }
    const result = await gateway.wikiBudgets(request)
    expect(memoryKnowledge.listWikiMaterialReadBudgets).toHaveBeenCalledWith({ projectRoot: projectPath, runId: wikiRun.id, onlyBlocked: true, limit: 20 })
    expect(memoryKnowledge.getWikiRunSnapshot).not.toHaveBeenCalled()
    expect(result).toMatchObject({ runId: wikiRun.id, items: [{ taskId: budget.taskId, budgetHash: hash, reservedBytes: 60 }], nextAfterTaskId: budget.taskId })
    expect(JSON.stringify(result)).not.toContain(projectPath)
    expect(Object.keys(result.items[0]!).sort()).toEqual(['taskId', 'kind', 'status', 'limitBytes', 'reservedBytes', 'reservationCount', 'blockedReadBytes', 'startedAt', 'startedAtAttempt', 'budgetHash'].sort())
    const descriptor = MEMORY_UI_INVOCATIONS.find(value => value.method === 'wikiBudgets')!
    if (descriptor.result.mode !== 'strict') throw new Error('账本结果必须严格校验')
    expect(descriptor.result.schema.parse(result)).toEqual(result)
    expect(() => descriptor.result.mode === 'strict' && descriptor.result.schema.parse({ ...result, items: Array(21).fill(result.items[0]) })).toThrow()
    await expect(gateway.wikiBudgets({ ...request, workspaceId: 'missing' })).rejects.toThrow()
    const update = { workspaceId: request.workspaceId, runId: wikiRun.id, taskId: budget.taskId, limitBytes: 120, expectedBudgetHash: hash }
    memoryKnowledge.increaseWikiMaterialReadBudget.mockRejectedValueOnce(new WikiMaterialBudgetConflictError())
    expect(await gateway.increaseWikiBudget(update)).toEqual({ outcome: 'conflict' })
    memoryKnowledge.increaseWikiMaterialReadBudget.mockResolvedValueOnce({ ...budget, limitBytes: 120, blockedReadBytes: null })
    expect(await gateway.increaseWikiBudget(update)).toEqual({ outcome: 'updated' })
    expect(memoryKnowledge.increaseWikiMaterialReadBudget).toHaveBeenLastCalledWith({ runId: wikiRun.id, taskId: budget.taskId }, 120, { projectRoot: projectPath, expectedBudgetHash: hash })
    await expect(gateway.increaseWikiBudget({ ...update, workspaceId: 'missing' })).rejects.toThrow()
    memoryKnowledge.increaseWikiMaterialReadBudget.mockRejectedValueOnce(new Error('storage failure'))
    await expect(gateway.increaseWikiBudget(update)).rejects.toThrow('storage failure')
    expect(wikiGeneration.runNext).not.toHaveBeenCalled()
  })

  it('预算 RPC 拒绝无确认版本、非法额度、宿主路径和无界查询参数', () => {
    const query = MEMORY_UI_INVOCATIONS.find(value => value.method === 'wikiBudgets')!.parameters[0]!.codec
    const update = MEMORY_UI_INVOCATIONS.find(value => value.method === 'increaseWikiBudget')!.parameters[0]!.codec
    if (query.mode !== 'strict' || update.mode !== 'strict') throw new Error('账本请求必须严格校验')
    const request = { workspaceId: String(workspace.id), runId: wikiRun.id, onlyBlocked: false }
    expect(query.schema.parse(request)).toEqual(request)
    for (const extra of [{ projectRoot: projectPath }, { limit: 1000 }, { afterTaskId: 'bad-id' }]) {
      expect(() => query.schema.parse({ ...request, ...extra })).toThrow()
    }
    const grant = { workspaceId: String(workspace.id), runId: wikiRun.id, taskId: `wtask_${'1'.repeat(64)}`, limitBytes: 120, expectedBudgetHash: `sha256:${'a'.repeat(64)}` }
    expect(update.schema.parse(grant)).toEqual(grant)
    for (const extra of [{ expectedBudgetHash: undefined }, { expectedBudgetHash: 'bad' }, { limitBytes: 0 }, { limitBytes: 1.5 }, { limitBytes: Number.MAX_SAFE_INTEGER + 1 }, { projectRoot: projectPath }]) {
      expect(() => update.schema.parse({ ...grant, ...extra })).toThrow()
    }
  })

  it('projects a bounded Wiki Page tree with Claim states and portable sources', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const rootPageId = 'wpage_11111111-1111-4111-8111-111111111111'
    const childPageId = 'wpage_22222222-2222-4222-8222-222222222222'
    const claimId = 'wclaim_33333333-3333-4333-8333-333333333333'
    const citationId = 'wcite_44444444-4444-4444-8444-444444444444'
    const rangeId = `wrange_${'5'.repeat(64)}`
    memoryKnowledge.getWikiRunSnapshot.mockResolvedValue({
      run: { ...wikiRun, projectRoot: projectPath, rootPageIds: [rootPageId] },
      tasks: [{
        materialRanges: [{ id: rangeId, startByte: 256, endByte: 512 }],
      }],
      pages: [{
        id: rootPageId,
        title: 'Wiki',
        status: 'draft',
        claimIds: [],
        childPageIds: [childPageId],
      }, {
        id: childPageId,
        title: '存储',
        status: 'conflicted',
        claimIds: [claimId],
        childPageIds: [],
      }],
      claims: [{
        id: claimId,
        kind: 'assertion',
        status: 'conflicted',
        statement: `SQLite 来源冲突。${'长'.repeat(1_100)}`,
        citationIds: [citationId],
      }],
      citations: [{
        id: citationId,
        role: 'supports',
        rangeId,
        provenance: { kind: 'git-file', path: 'src/storage.ts', startLine: 8, endLine: 10 },
      }],
    } as never)

    const result = await gateway.wikiTree({ workspaceId: String(workspace.id), runId: String(wikiRun.id) })

    expect(result).toMatchObject({
      runId: String(wikiRun.id),
      pageCount: 2,
      omittedPageCount: 0,
      omittedClaimCount: 0,
      omittedSourceCount: 0,
      pages: [
        { id: rootPageId, depth: 0, title: 'Wiki', childCount: 1, claimCount: 0 },
        {
          id: childPageId,
          parentId: rootPageId,
          depth: 1,
          status: 'conflicted',
          claims: [{
            id: claimId,
            statementTruncated: true,
            sources: [{
              role: 'supports',
              path: 'src/storage.ts',
              startLine: 8,
              endLine: 10,
              startByte: 256,
              endByte: 512,
            }],
          }],
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)
    expect(JSON.stringify(result)).not.toContain('session-')
    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'wikiTree')!
    if (descriptor.result.mode !== 'strict') throw new Error('Wiki tree result codec must be strict')
    expect(descriptor.result.schema.parse(result)).toEqual(result)
  })

  it('projects a structured Source evidence pack without exposing the workspace path', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const result = await gateway.searchEvidence({ query: 'greeting', workspaceId: String(workspace.id) }, new AbortController().signal)

    expect(memoryKnowledge.searchSourceEvidence).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: projectPath,
      query: 'greeting',
      limit: 50,
    }))
    expect(result).toMatchObject({
      retriever: 'source-evidence-fts',
      totalMatches: 1,
      sourceRevisions: [{ sourceId: 'src_11111111-1111-4111-8111-111111111111' }],
      hits: [{
        path: 'src/example.ts',
        name: 'greeting',
        kind: 'code-symbol',
        detail: 'function',
        exported: true,
        startLine: 2,
      }],
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)

    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'searchEvidence')!
    if (descriptor.result.mode !== 'strict') throw new Error('evidence result codec must be strict')
    const resultSchema = descriptor.result.schema
    expect(resultSchema.parse(result)).toEqual(result)
    expect(() => resultSchema.parse({
      ...result,
      hits: [{ ...result.hits[0]!, path: projectPath }],
    })).toThrow()
  })

  it('projects a bounded relation graph and redacts absolute source specifiers', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const result = await gateway.queryRelations({
      workspaceId: String(workspace.id),
      query: 'example',
      area: 'src',
      resolution: 'unresolved',
      kind: 'import',
    }, new AbortController().signal)

    expect(memoryKnowledge.querySourceRelations).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: projectPath,
      query: 'example',
      area: 'src',
      resolution: 'unresolved',
      kind: 'import',
      limit: 120,
    }))
    expect(result).toMatchObject({
      retriever: 'source-relations-sql',
      version: 1,
      totalMatches: 1,
      sourceRevisions: [{ graphOmittedEdgeCount: 2 }],
      edges: [{
        fromPath: 'src/example.ts',
        specifier: '[absolute specifier]',
        resolution: 'unresolved',
        startLine: 1,
      }],
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)

    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'queryRelations')!
    if (descriptor.result.mode !== 'strict') throw new Error('relation result codec must be strict')
    const resultSchema = descriptor.result.schema
    expect(resultSchema.parse(result)).toEqual(result)
    expect(() => resultSchema.parse({
      ...result,
      edges: [{ ...result.edges[0]!, fromPath: projectPath }],
    })).toThrow()
  })

  it('projects a bounded portable symbol definition/reference graph', async () => {
    const { gateway, memoryKnowledge } = mounted()
    const result = await gateway.querySymbols({
      workspaceId: String(workspace.id),
      query: 'greeting',
      definitionPath: 'model.ts',
      referencePath: 'example.ts',
      referenceKind: 'value',
    }, new AbortController().signal)

    expect(memoryKnowledge.querySourceSymbols).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: projectPath,
      query: 'greeting',
      definitionPath: 'model.ts',
      referencePath: 'example.ts',
      referenceKind: 'value',
      limit: 120,
    }))
    expect(result).toMatchObject({
      retriever: 'source-symbols-sql',
      version: 2,
      totalMatches: 1,
      sourceRevisions: [{
        graphOmittedFileCount: 2,
        graphOmittedReferenceCount: 3,
        configMode: 'tsconfig',
        configPaths: ['tsconfig.json'],
        projectReferenceCount: 1,
        pathAliasCount: 2,
      }],
      edges: [{
        symbolName: 'greeting',
        definitionPath: 'src/model.ts',
        referencePath: 'src/example.ts',
        referenceKind: 'value',
      }],
    })
    expect(JSON.stringify(result)).not.toContain(projectPath)

    const descriptor = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'querySymbols')!
    if (descriptor.result.mode !== 'strict') throw new Error('symbol result codec must be strict')
    const resultSchema = descriptor.result.schema
    expect(resultSchema.parse(result)).toEqual(result)
    expect(() => resultSchema.parse({
      ...result,
      edges: [{ ...result.edges[0]!, definitionPath: projectPath }],
    })).toThrow()
  })

  it('publishes strict request schemas for every Remote method', () => {
    const overview = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'overview')!
    const overviewRequest = overview.parameters[0]!.codec
    if (overviewRequest.mode !== 'strict') throw new Error('overview request codec must be strict')
    expect(overviewRequest.schema.parse({ domain: 'memory', workspaceId: String(workspace.id) }))
      .toEqual({ domain: 'memory', workspaceId: String(workspace.id) })
    expect(overviewRequest.schema.parse({ domain: 'knowledge', workspaceId: String(workspace.id) }))
      .toEqual({ domain: 'knowledge', workspaceId: String(workspace.id) })
    expect(() => overviewRequest.schema.parse({ domain: 'knowledge' })).toThrow()
    expect(() => overviewRequest.schema.parse({})).toThrow()
    expect(() => overviewRequest.schema.parse({ domain: 'other' })).toThrow()
    expect(() => overviewRequest.schema.parse({ domain: 'memory', scopeMode: 'applicable' })).toThrow()
    expect(() => overviewRequest.schema.parse({ domain: 'memory', projectRoot: projectPath })).toThrow()

    const search = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'search')!
    const searchRequest = search.parameters[0]!.codec
    if (searchRequest.mode !== 'strict') throw new Error('search request codec must be strict')
    expect(searchRequest.schema.parse({ domain: 'knowledge', query: ' example ', workspaceId: String(workspace.id) }))
      .toEqual({ domain: 'knowledge', query: 'example', workspaceId: String(workspace.id) })
    expect(() => searchRequest.schema.parse({ domain: 'knowledge', query: 'example' })).toThrow()
    expect(() => searchRequest.schema.parse({ query: 'example' })).toThrow()
    expect(() => searchRequest.schema.parse({ domain: 'unknown', query: 'example' })).toThrow()
    expect(() => searchRequest.schema.parse({ domain: 'memory', query: 'example', projectRoot: projectPath })).toThrow()
    expect(() => searchRequest.schema.parse({ domain: 'memory', query: 'example', scopeMode: 'selected' })).toThrow()

    const review = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'review')!
    const request = review.parameters[0]!.codec
    if (request.mode !== 'strict') throw new Error('review request codec must be strict')
    expect(request.schema.parse({ id: String(candidate.id), revision: 3, decision: 'accept' }))
      .toEqual({ id: String(candidate.id), revision: 3, decision: 'accept' })
    expect(() => request.schema.parse({ id: String(candidate.id), revision: 3, decision: 'accept', projectRoot: projectPath }))
      .toThrow()
    const generate = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'generate')!
    const generateRequest = generate.parameters[0]!.codec
    if (generateRequest.mode !== 'strict') throw new Error('generate request codec must be strict')
    expect(generateRequest.schema.parse({ workspaceId: String(workspace.id) })).toEqual({ workspaceId: String(workspace.id) })
    expect(() => generateRequest.schema.parse({ workspaceId: String(workspace.id), projectRoot: projectPath })).toThrow()
    const planWiki = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'planWiki')!
    const planWikiRequest = planWiki.parameters[0]!.codec
    if (planWikiRequest.mode !== 'strict') throw new Error('Wiki plan request codec must be strict')
    expect(planWikiRequest.schema.parse({ workspaceId: String(workspace.id) }))
      .toEqual({ workspaceId: String(workspace.id) })
    expect(() => planWikiRequest.schema.parse({ workspaceId: String(workspace.id), projectRoot: projectPath })).toThrow()
    const runWikiTask = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'runWikiTask')!
    const runWikiTaskRequest = runWikiTask.parameters[0]!.codec
    if (runWikiTaskRequest.mode !== 'strict') throw new Error('Wiki task request codec must be strict')
    expect(runWikiTaskRequest.schema.parse({ workspaceId: String(workspace.id), dataEgressConfirmed: true }))
      .toEqual({ workspaceId: String(workspace.id), dataEgressConfirmed: true })
    expect(() => runWikiTaskRequest.schema.parse({ workspaceId: String(workspace.id) })).toThrow()
    expect(() => runWikiTaskRequest.schema.parse({ workspaceId: String(workspace.id), projectRoot: projectPath })).toThrow()
    const wikiTree = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'wikiTree')!
    const wikiTreeRequest = wikiTree.parameters[0]!.codec
    if (wikiTreeRequest.mode !== 'strict') throw new Error('Wiki tree request codec must be strict')
    expect(wikiTreeRequest.schema.parse({ workspaceId: String(workspace.id), runId: String(wikiRun.id) }))
      .toEqual({ workspaceId: String(workspace.id), runId: String(wikiRun.id) })
    expect(() => wikiTreeRequest.schema.parse({
      workspaceId: String(workspace.id),
      runId: String(wikiRun.id),
      projectRoot: projectPath,
    })).toThrow()
    const saveKnowledgeRevision = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'saveKnowledgeRevision')!
    const saveKnowledgeRevisionRequest = saveKnowledgeRevision.parameters[0]!.codec
    if (saveKnowledgeRevisionRequest.mode !== 'strict') throw new Error('knowledge revision request codec must be strict')
    const revisionRequestBase = {
      workspaceId: String(workspace.id),
      requestId: 'khreq_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedSelectionRevision: 1,
      baseEffectiveVersionId: 'kev_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pageId: 'wpage_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      content: '人工说明',
    }
    expect(saveKnowledgeRevisionRequest.schema.parse({
      ...revisionRequestBase,
      kind: 'replace-page-body',
      title: '人工标题',
    })).toMatchObject({ kind: 'replace-page-body', title: '人工标题' })
    expect(saveKnowledgeRevisionRequest.schema.parse({ ...revisionRequestBase, kind: 'append-page-note' }))
      .toMatchObject({ kind: 'append-page-note' })
    expect(() => saveKnowledgeRevisionRequest.schema.parse({ ...revisionRequestBase, kind: 'replace-page-body' })).toThrow()
    expect(() => saveKnowledgeRevisionRequest.schema.parse({ ...revisionRequestBase, kind: 'append-page-note', title: '不允许' })).toThrow()
    const evidence = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'searchEvidence')!
    const evidenceRequest = evidence.parameters[0]!.codec
    if (evidenceRequest.mode !== 'strict') throw new Error('evidence request codec must be strict')
    expect(evidenceRequest.schema.parse({ workspaceId: String(workspace.id), query: 'greeting' }))
      .toEqual({ workspaceId: String(workspace.id), query: 'greeting' })
    expect(() => evidenceRequest.schema.parse({ workspaceId: String(workspace.id), query: 'greeting', projectRoot: projectPath }))
      .toThrow()
    const relations = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'queryRelations')!
    const relationRequest = relations.parameters[0]!.codec
    if (relationRequest.mode !== 'strict') throw new Error('relation request codec must be strict')
    expect(relationRequest.schema.parse({
      workspaceId: String(workspace.id),
      query: ' example ',
      area: 'src',
      resolution: 'internal',
      kind: 'import',
    })).toEqual({
      workspaceId: String(workspace.id),
      query: 'example',
      area: 'src',
      resolution: 'internal',
      kind: 'import',
    })
    expect(() => relationRequest.schema.parse({ workspaceId: String(workspace.id), projectRoot: projectPath })).toThrow()
    const symbols = MEMORY_UI_INVOCATIONS.find(candidate => candidate.method === 'querySymbols')!
    const symbolRequest = symbols.parameters[0]!.codec
    if (symbolRequest.mode !== 'strict') throw new Error('symbol request codec must be strict')
    expect(symbolRequest.schema.parse({
      workspaceId: String(workspace.id),
      query: ' greeting ',
      definitionPath: 'src/model.ts',
      referencePath: 'src/main.ts',
      referenceKind: 'type',
    })).toEqual({
      workspaceId: String(workspace.id),
      query: 'greeting',
      definitionPath: 'src/model.ts',
      referencePath: 'src/main.ts',
      referenceKind: 'type',
    })
    expect(() => symbolRequest.schema.parse({ workspaceId: String(workspace.id), projectRoot: projectPath })).toThrow()
  })
})
