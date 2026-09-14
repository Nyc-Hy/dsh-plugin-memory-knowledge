import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CanonicalStore } from './canonical.js'
import type { KnowledgeCard, MemoryEntry, ProvenanceRef, SharedKnowledgeScope } from './model.js'
import { schemaDocuments } from './schema.js'

/** Header marking Markdown that is owned by the deterministic projector. */
export const GENERATED_MARKDOWN_MARKER = '<!-- dsh-memory-knowledge:generated:v1; do not edit -->'

/** One complete set of project-relative generated files. */
export type ProjectionFiles = ReadonlyMap<string, string>

/** One difference between canonical data and files currently on disk. */
export interface ProjectionIssue {
  kind: 'missing' | 'changed' | 'unexpected'
  path: string
}

function markdownText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
}

function headingText(value: string): string {
  return markdownText(value).replaceAll('\n', ' ')
}

function inlineCode(value: string): string {
  const runs = value.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(1, ...runs.map(run => run.length + 1)))
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

function scopeLabel(scope: SharedKnowledgeScope): string {
  return scope.kind === 'space'
    ? `space ${scope.spaceId}`
    : `source ${scope.sourceId}`
}

function provenanceLabel(reference: ProvenanceRef): string {
  switch (reference.kind) {
    case 'git-file':
      return `${inlineCode(reference.path)} at ${inlineCode(reference.commit)}${reference.startLine === undefined ? '' : ` lines ${reference.startLine}${reference.endLine === undefined || reference.endLine === reference.startLine ? '' : `-${reference.endLine}`}`} (${inlineCode(reference.contentHash)})`
    case 'git-commit':
      return `commit ${inlineCode(reference.commit)} in ${inlineCode(reference.sourceId)}`
    case 'session':
      return `session ${inlineCode(reference.sessionId)} events ${reference.eventSeqs.join(', ')}${reference.portableEvidence === undefined ? '' : ` — ${markdownText(reference.portableEvidence)}`}`
    case 'document':
      return `${inlineCode(reference.path)} (${inlineCode(reference.contentHash)})`
    default:
      return assertNever(reference)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled projection value: ${JSON.stringify(value)}`)
}

function provenanceSection(provenance: readonly ProvenanceRef[]): string {
  return ['## 来源', '', ...provenance.map(reference => `- ${provenanceLabel(reference)}`)].join('\n')
}

/** Render one memory entry as deterministic Markdown. */
export function renderMemoryMarkdown(memory: MemoryEntry): string {
  return [
    GENERATED_MARKDOWN_MARKER,
    '',
    `# ${headingText(memory.title)}`,
    '',
    `- ID：${inlineCode(memory.id)}`,
    `- Revision：${memory.revision}`,
    `- Scope：${inlineCode(scopeLabel(memory.scope))}`,
    `- Kind：${inlineCode(memory.kind)}`,
    `- Status：${inlineCode(memory.status)}`,
    `- Evidence：${inlineCode(memory.evidenceClass)}`,
    `- Sensitivity：${inlineCode(memory.sensitivity)}`,
    `- Updated：${inlineCode(memory.updatedAt)}`,
    '',
    '## 内容',
    '',
    markdownText(memory.content),
    '',
    provenanceSection(memory.provenance),
    '',
    '## 关系',
    '',
    `- Tags：${memory.tags.length === 0 ? '无' : memory.tags.map(inlineCode).join('、')}`,
    `- Supersedes：${memory.supersedes.length === 0 ? '无' : memory.supersedes.map(inlineCode).join('、')}`,
    `- Conflicts：${memory.conflictsWith.length === 0 ? '无' : memory.conflictsWith.map(inlineCode).join('、')}`,
    '',
  ].join('\n')
}

/** Render one knowledge card as deterministic Markdown. */
export function renderCardMarkdown(card: KnowledgeCard): string {
  const sections = card.sections.flatMap(section => [
    `## ${headingText(section.title)}`,
    '',
    markdownText(section.content),
    '',
    '### 本节来源',
    '',
    ...section.provenance.map(reference => `- ${provenanceLabel(reference)}`),
    '',
  ])
  return [
    GENERATED_MARKDOWN_MARKER,
    '',
    `# ${headingText(card.title)}`,
    '',
    `- ID：${inlineCode(card.id)}`,
    `- Revision：${card.revision}`,
    `- Scope：${inlineCode(scopeLabel(card.scope))}`,
    `- Kind：${inlineCode(card.kind)}`,
    `- Status：${inlineCode(card.status)}`,
    `- Evidence：${inlineCode(card.evidenceClass)}`,
    `- Source revisions：${card.sourceRevisions.map(revision => `${inlineCode(revision.sourceId)}@${inlineCode(revision.commit)}`).join('、')}`,
    `- Updated：${inlineCode(card.updatedAt)}`,
    '',
    '## 摘要',
    '',
    markdownText(card.summary),
    '',
    ...sections,
    provenanceSection(card.provenance),
    '',
  ].join('\n')
}

function indexMarkdown(store: CanonicalStore): string {
  const memories = [...store.memories].sort(compareDocument)
  const cards = [...store.cards].sort(compareDocument)
  return [
    GENERATED_MARKDOWN_MARKER,
    '',
    '# 项目知识',
    '',
    `- Knowledge space：${inlineCode(store.manifest.spaceId)}`,
    `- Sources：${store.manifest.sources.length}`,
    `- Memories：${memories.length}`,
    `- Knowledge cards：${cards.length}`,
    '',
    '## 记忆',
    '',
    ...(memories.length === 0
      ? ['暂无已审核记忆。']
      : memories.map(memory => `- [${headingText(memory.title)}](memory/${memory.id}.md) — ${inlineCode(memory.status)}`)),
    '',
    '## Knowledge Cards',
    '',
    ...(cards.length === 0
      ? ['暂无 Knowledge Card。']
      : cards.map(card => `- [${headingText(card.title)}](cards/${card.id}.md) — ${inlineCode(card.status)}`)),
    '',
  ].join('\n')
}

function compareDocument(left: { title: string; id: string }, right: { title: string; id: string }): number {
  return compareText(left.title, right.title) || compareText(left.id, right.id)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Build every deterministic schema and Markdown projection for a canonical store. */
export function buildProjection(store: CanonicalStore): ProjectionFiles {
  const files = new Map<string, string>()
  files.set('wiki/index.md', indexMarkdown(store))
  for (const memory of [...store.memories].sort(compareDocument)) {
    files.set(`wiki/memory/${memory.id}.md`, renderMemoryMarkdown(memory))
  }
  for (const card of [...store.cards].sort(compareDocument)) {
    files.set(`wiki/cards/${card.id}.md`, renderCardMarkdown(card))
  }
  for (const [name, schema] of Object.entries(schemaDocuments)) {
    files.set(`schema/${name}`, `${JSON.stringify(schema, null, 2)}\n`)
  }
  return files
}

function toPortablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

async function listProjectionFiles(root: string, directory: string): Promise<string[]> {
  const absolute = join(root, directory)
  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(absolute, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`projection path must not be a symbolic link: ${path}`)
    if (entry.isDirectory()) {
      files.push(...await listProjectionFiles(root, toPortablePath(root, path)))
    } else if (entry.isFile()) {
      files.push(toPortablePath(root, path))
    } else {
      throw new Error(`projection path must be a file or directory: ${path}`)
    }
  }
  return files.sort(compareText)
}

async function readActualProjection(root: string): Promise<Map<string, string>> {
  const files = [
    ...await listProjectionFiles(root, 'wiki'),
    ...await listProjectionFiles(root, 'schema'),
  ]
  const actual = new Map<string, string>()
  for (const path of files) actual.set(path, await readFile(join(root, path), 'utf8'))
  return actual
}

/** Compare generated files on disk with the canonical projection. */
export async function checkProjection(store: CanonicalStore): Promise<ProjectionIssue[]> {
  const expected = buildProjection(store)
  const actual = await readActualProjection(store.knowledgeRoot)
  const issues: ProjectionIssue[] = []
  for (const [path, content] of expected) {
    const actualContent = actual.get(path)
    if (actualContent === undefined) issues.push({ kind: 'missing', path })
    else if (actualContent !== content) issues.push({ kind: 'changed', path })
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) issues.push({ kind: 'unexpected', path })
  }
  return issues.sort((left, right) => compareText(left.path, right.path) || compareText(left.kind, right.kind))
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content, { mode: 0o644, dirMode: 0o755 })
}

/** Write every expected projection file without deleting unexpected user files. */
export async function writeProjection(store: CanonicalStore): Promise<void> {
  const root = resolve(store.knowledgeRoot)
  for (const [path, content] of buildProjection(store)) {
    await writeAtomic(join(root, path), content)
  }
}
