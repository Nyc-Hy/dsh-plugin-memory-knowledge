import { createHash } from 'node:crypto'
import type { CanonicalStore } from './canonical.js'
import { KnowledgeCardId, type KnowledgeSourceId } from './ids.js'
import type { KnowledgeSection, ProvenanceRef } from './model.js'
import type { ProjectKnowledgeStatus } from './inventory.js'
import type { KnowledgeCardCandidateSkip, SaveKnowledgeCardCandidateInput } from './runtime-model.js'
import type { WikiProjectCatalog } from './wiki-catalog.js'
import type { WikiCitation, WikiClaim, WikiPage, WikiRunSnapshot } from './wiki-model.js'

/** Stable rule version for verified Wiki Page to Knowledge Card candidates. */
export const WIKI_PAGE_CARD_CANDIDATE_VERSION = 2

/** A pure plan for candidates derived from one complete Wiki run. */
export interface WikiCardCandidatePlan {
  inputs: SaveKnowledgeCardCandidateInput[]
  skipped: KnowledgeCardCandidateSkip[]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function pageCardId(page: WikiPage, sourceId: KnowledgeSourceId): KnowledgeCardId {
  const hex = createHash('sha256')
    .update(`dsh-wiki-page-card:${sourceId}:${page.slug}`)
    .digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return KnowledgeCardId(`card_${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`)
}

function uniqueProvenance(values: readonly ProvenanceRef[]): ProvenanceRef[] {
  const seen = new Set<string>()
  const result: ProvenanceRef[] = []
  for (const value of values) {
    const key = JSON.stringify(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(structuredClone(value))
  }
  return result
}

function skip(page: WikiPage, kind: KnowledgeCardCandidateSkip['kind']): KnowledgeCardCandidateSkip {
  return { pageId: page.id, kind }
}

function citationCoverage(
  citation: WikiCitation,
  snapshot: WikiRunSnapshot,
): { sourceId: KnowledgeSourceId; commit: string } | undefined {
  const provenance = citation.provenance
  if (citation.role !== 'supports' || provenance.kind !== 'git-file') return undefined
  const coverage = snapshot.coverage.find(item => item.path === provenance.path
    && item.sourceId === provenance.sourceId)
  if (coverage === undefined || coverage.status !== 'analyzed'
    || coverage.analyzedContentHash !== provenance.contentHash
    || coverage.revision.kind !== 'git-object'
    || coverage.revision.commit !== provenance.commit) return undefined
  return {
    sourceId: provenance.sourceId,
    commit: provenance.commit,
  }
}

function claimProvenance(
  claim: WikiClaim,
  snapshot: WikiRunSnapshot,
): { sourceId: KnowledgeSourceId; commit: string; references: ProvenanceRef[] } | undefined {
  if (claim.kind !== 'assertion' || claim.status !== 'verified' || claim.citationIds.length === 0) return undefined
  const citations = claim.citationIds.map(id => snapshot.citations.find(value => value.id === id))
  if (citations.some(value => value === undefined)) return undefined
  const locations = citations.map(value => citationCoverage(value!, snapshot))
  if (locations.some(value => value === undefined)) return undefined
  const first = locations[0]!
  if (locations.some(value => value!.sourceId !== first.sourceId || value!.commit !== first.commit)) return undefined
  return {
    sourceId: first.sourceId,
    commit: first.commit,
    references: uniqueProvenance(citations.map(value => value!.provenance)),
  }
}

function generationKey(
  snapshot: WikiRunSnapshot,
  page: WikiPage,
  sourceId: KnowledgeSourceId,
  checkpointHash: string,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    generator: 'wiki-page',
    version: WIKI_PAGE_CARD_CANDIDATE_VERSION,
    runId: snapshot.run.id,
    snapshotHash: snapshot.snapshotHash,
    pageId: page.id,
    sourceId,
    checkpointHash,
    claimIds: page.claimIds,
  })).digest('hex')
  return `knowledge-card:wiki-page:${WIKI_PAGE_CARD_CANDIDATE_VERSION}:${digest}`
}

function sectionForClaim(
  claim: WikiClaim,
  ordinal: number,
  snapshot: WikiRunSnapshot,
): KnowledgeSection | undefined {
  const provenance = claimProvenance(claim, snapshot)
  if (provenance === undefined) return undefined
  const id = `claim-${createHash('sha256').update(String(claim.id)).digest('hex').slice(0, 16)}`
  return {
    id,
    title: `已验证声明 ${ordinal + 1}`,
    content: claim.statement,
    provenance: provenance.references,
  }
}

/** Plan auditable Knowledge Card candidates from verified, single-Git-source Wiki Pages. */
export function planWikiCardCandidates(
  snapshot: WikiRunSnapshot,
  store: CanonicalStore,
  status: ProjectKnowledgeStatus | WikiProjectCatalog,
): WikiCardCandidatePlan {
  if (snapshot.run.status !== 'complete' && snapshot.run.status !== 'needs-review') {
    return { inputs: [], skipped: snapshot.pages.map(page => skip(page, 'wiki-run-incomplete')) }
  }
  const inputs: SaveKnowledgeCardCandidateInput[] = []
  const skipped: KnowledgeCardCandidateSkip[] = []
  const pages = [...snapshot.pages].sort((left, right) => compareText(String(left.id), String(right.id)))
  for (const page of pages) {
    if (page.status !== 'verified' || page.claimIds.length === 0) {
      skipped.push(skip(page, 'wiki-page-not-verified'))
      continue
    }
    const claims = page.claimIds.map(id => snapshot.claims.find(value => value.id === id))
    if (claims.some(value => value === undefined)) {
      skipped.push(skip(page, 'wiki-page-unsupported-evidence'))
      continue
    }
    const claimDetails = claims.map(claim => claimProvenance(claim!, snapshot))
    if (claimDetails.some(value => value === undefined)) {
      skipped.push(skip(page, 'wiki-page-unsupported-evidence'))
      continue
    }
    const first = claimDetails[0]!
    if (claimDetails.some(value => value!.sourceId !== first.sourceId || value!.commit !== first.commit)) {
      skipped.push(skip(page, 'wiki-page-unsupported-evidence'))
      continue
    }
    let checkpoint: { kind: 'inventory' | 'catalog'; hash: string } | undefined
    if ('catalogHash' in status) {
      const source = status.sources.find(value => value.sourceId === first.sourceId)
      if (status.state === 'complete' && status.catalogHash === snapshot.run.catalogHash
        && source?.complete === true && source.commit === first.commit) {
        checkpoint = { kind: 'catalog', hash: status.catalogHash }
      }
    } else {
      const source = status.sources.find(value => value.sourceId === first.sourceId)
      if (source?.state === 'ready' && !source.dirty && source.commit === first.commit
        && source.inventoryHash !== undefined) {
        checkpoint = { kind: 'inventory', hash: source.inventoryHash }
      }
    }
    if (checkpoint === undefined) {
      skipped.push(skip(page, 'wiki-source-changed'))
      continue
    }
    if (!store.manifest.sources.some(value => value.id === first.sourceId)) {
      skipped.push(skip(page, 'wiki-page-unsupported-evidence'))
      continue
    }
    const sections = claims.map((claim, index) => sectionForClaim(claim!, index, snapshot))
    if (sections.some(value => value === undefined)) {
      skipped.push(skip(page, 'wiki-page-unsupported-evidence'))
      continue
    }
    const provenance: ProvenanceRef[] = [{ kind: 'git-commit', sourceId: first.sourceId, commit: first.commit }]
    const targetCardId = pageCardId(page, first.sourceId)
    const current = store.cards.find(card => card.id === targetCardId)
    if (current !== undefined && (current.scope.kind !== 'source' || current.scope.sourceId !== first.sourceId)) {
      skipped.push(skip(page, 'wiki-page-unsupported-evidence'))
      continue
    }
    const summary = `已验证 Wiki 页面“${page.title}”包含 ${claims.length} 条有 Git 文件证据的声明；候选来自运行 ${snapshot.run.id}。`
    inputs.push({
      target: 'knowledge-card',
      applicability: 'project',
      projectRoot: store.projectRoot,
      kind: 'module',
      title: page.title,
      content: [summary, ...sections.flatMap(section => [section!.title, section!.content])].join('\n\n'),
      tags: ['knowledge-card', 'wiki', 'wiki-page', page.slug],
      sensitivity: 'normal',
      suggestedBy: 'wiki',
      provenance,
      generation: {
        key: generationKey(snapshot, page, first.sourceId, checkpoint.hash),
        generator: 'wiki-page',
        version: WIKI_PAGE_CARD_CANDIDATE_VERSION,
        sourceId: first.sourceId,
        ...(checkpoint.kind === 'inventory'
          ? { inventoryHash: checkpoint.hash }
          : { catalogHash: checkpoint.hash }),
        inputHash: snapshot.snapshotHash,
      },
      card: {
        targetCardId,
        ...(current === undefined ? {} : { baseRevision: current.revision }),
        scope: { kind: 'source', sourceId: first.sourceId },
        kind: 'module',
        summary,
        sections: sections as KnowledgeSection[],
        provenance,
        sourceRevisions: [{
          sourceId: first.sourceId,
          kind: 'git',
          commit: first.commit,
          ...(checkpoint.kind === 'inventory'
            ? { inventoryHash: checkpoint.hash }
            : { catalogHash: checkpoint.hash }),
        }],
        evidenceClass: 'ai-suggested',
      },
    })
  }
  return { inputs, skipped }
}
