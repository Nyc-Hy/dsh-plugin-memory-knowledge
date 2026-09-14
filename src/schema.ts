import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import {
  KNOWLEDGE_CARD_ID_PATTERN,
  KNOWLEDGE_SOURCE_ID_PATTERN,
  KNOWLEDGE_SPACE_ID_PATTERN,
  MEMORY_ID_PATTERN,
} from './ids.js'
import type { KnowledgeCard, KnowledgeManifest, MemoryEntry, ProvenanceRef } from './model.js'

const schemaHeader = {
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const

const portablePathSegmentPattern = '(?!\\.{1,2}(?:/|$))[^/\\\\<>:"|?*\\u0000-\\u001F]+'
const portablePathBodyPattern = `(?![A-Za-z]:)${portablePathSegmentPattern}(?:/${portablePathSegmentPattern})*`

/** JSON Schema pattern for a cross-platform project-relative file path. */
export const PORTABLE_RELATIVE_PATH_PATTERN = `^${portablePathBodyPattern}$`

/** JSON Schema pattern for a cross-platform source root, including the project root. */
export const PORTABLE_RELATIVE_ROOT_PATTERN = `^(?:\\.|${portablePathBodyPattern})$`

const scopeSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'sourceId'],
      properties: {
        kind: { const: 'source' },
        sourceId: { type: 'string', pattern: KNOWLEDGE_SOURCE_ID_PATTERN },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'spaceId'],
      properties: {
        kind: { const: 'space' },
        spaceId: { type: 'string', pattern: KNOWLEDGE_SPACE_ID_PATTERN },
      },
    },
  ],
} as const

const provenanceSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'sourceId', 'commit', 'path', 'contentHash'],
      properties: {
        kind: { const: 'git-file' },
        sourceId: { type: 'string', pattern: KNOWLEDGE_SOURCE_ID_PATTERN },
        commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
        path: { type: 'string', pattern: PORTABLE_RELATIVE_PATH_PATTERN },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        contentHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'sourceId', 'commit'],
      properties: {
        kind: { const: 'git-commit' },
        sourceId: { type: 'string', pattern: KNOWLEDGE_SOURCE_ID_PATTERN },
        commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'sessionId', 'eventSeqs'],
      properties: {
        kind: { const: 'session' },
        sessionId: { type: 'string', minLength: 1 },
        eventSeqs: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1 },
        },
        portableEvidence: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'sourceId', 'path', 'contentHash'],
      properties: {
        kind: { const: 'document' },
        sourceId: { type: 'string', pattern: KNOWLEDGE_SOURCE_ID_PATTERN },
        path: { type: 'string', pattern: PORTABLE_RELATIVE_PATH_PATTERN },
        contentHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      },
    },
  ],
} as const

/** JSON Schema for the committed knowledge-root manifest. */
export const knowledgeManifestSchema = {
  ...schemaHeader,
  $id: 'https://deepseek-harness.local/schemas/memory-knowledge/manifest-v1.json',
  title: 'DSH Knowledge Manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'spaceId', 'sources', 'projection'],
  properties: {
    schemaVersion: { const: 1 },
    spaceId: { type: 'string', pattern: KNOWLEDGE_SPACE_ID_PATTERN },
    sources: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'relativeRoot'],
        properties: {
          id: { type: 'string', pattern: KNOWLEDGE_SOURCE_ID_PATTERN },
          kind: { const: 'git' },
          relativeRoot: { type: 'string', pattern: PORTABLE_RELATIVE_ROOT_PATTERN },
        },
      },
    },
    projection: {
      type: 'object',
      additionalProperties: false,
      required: ['generator', 'version'],
      properties: {
        generator: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
      },
    },
  },
} as const

/** JSON Schema for one reviewed long-term memory entry. */
export const memoryEntrySchema = {
  ...schemaHeader,
  $id: 'https://deepseek-harness.local/schemas/memory-knowledge/memory-entry-v1.json',
  title: 'DSH Memory Entry v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'revision', 'scope', 'kind', 'status', 'title', 'content',
    'evidenceClass', 'provenance', 'tags', 'supersedes', 'conflictsWith', 'sensitivity',
    'createdAt', 'updatedAt',
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: MEMORY_ID_PATTERN },
    revision: { type: 'integer', minimum: 1 },
    scope: scopeSchema,
    kind: { enum: ['fact', 'decision', 'lesson', 'method', 'preference', 'constraint'] },
    status: { enum: ['verified', 'conflicted', 'deprecated', 'deleted'] },
    title: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    evidenceClass: { enum: ['deterministic', 'human-verified', 'ai-suggested'] },
    provenance: { type: 'array', minItems: 1, items: provenanceSchema },
    tags: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    supersedes: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: MEMORY_ID_PATTERN } },
    conflictsWith: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: MEMORY_ID_PATTERN } },
    sensitivity: { enum: ['normal', 'restricted'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

/** JSON Schema for one structured knowledge card. */
export const knowledgeCardSchema = {
  ...schemaHeader,
  $id: 'https://deepseek-harness.local/schemas/memory-knowledge/knowledge-card-v1.json',
  title: 'DSH Knowledge Card v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'revision', 'scope', 'kind', 'title', 'summary', 'sections',
    'provenance', 'sourceRevisions', 'status', 'evidenceClass', 'createdAt', 'updatedAt',
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: KNOWLEDGE_CARD_ID_PATTERN },
    revision: { type: 'integer', minimum: 1 },
    scope: scopeSchema,
    kind: { enum: ['overview', 'architecture', 'module', 'flow', 'decision', 'stack'] },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    sections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'content', 'provenance'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
          title: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
          provenance: { type: 'array', minItems: 1, items: provenanceSchema },
        },
      },
    },
    provenance: { type: 'array', minItems: 1, items: provenanceSchema },
    sourceRevisions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceId', 'kind', 'commit'],
        properties: {
          sourceId: { type: 'string', pattern: KNOWLEDGE_SOURCE_ID_PATTERN },
          kind: { const: 'git' },
          commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
          inventoryHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          catalogHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        },
      },
    },
    status: { enum: ['verified', 'needs-review', 'stale', 'deprecated'] },
    evidenceClass: { enum: ['deterministic', 'human-verified', 'ai-suggested'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

/** Generated schema files and their canonical in-process definitions. */
export const schemaDocuments = {
  'manifest.schema.json': knowledgeManifestSchema,
  'memory-entry.schema.json': memoryEntrySchema,
  'knowledge-card.schema.json': knowledgeCardSchema,
} as const

/** One field-level JSON Schema validation issue. */
export interface SchemaIssue {
  path: string
  message: string
}

/** Error raised when a durable JSON document violates its declared schema. */
export class KnowledgeSchemaError extends Error {
  readonly issues: readonly SchemaIssue[]

  constructor(documentKind: string, errors: readonly ErrorObject[] | null | undefined) {
    const issues = (errors ?? []).map(error => ({
      path: error.instancePath || '/',
      message: error.message ?? error.keyword,
    }))
    super(`${documentKind} schema validation failed: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
    this.name = 'KnowledgeSchemaError'
    this.issues = issues
  }
}

/** Whether a path is a portable relative path without parent traversal. */
export function isPortableRelativePath(value: string, allowCurrentDirectory = false): boolean {
  const pattern = allowCurrentDirectory ? PORTABLE_RELATIVE_ROOT_PATTERN : PORTABLE_RELATIVE_PATH_PATTERN
  return new RegExp(pattern, 'u').test(value)
}

const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)

const validateManifest = ajv.compile<KnowledgeManifest>(knowledgeManifestSchema)
const validateMemoryEntry = ajv.compile<MemoryEntry>(memoryEntrySchema)
const validateKnowledgeCard = ajv.compile<KnowledgeCard>(knowledgeCardSchema)
const validateProvenanceRefs = ajv.compile<ProvenanceRef[]>({
  type: 'array',
  minItems: 1,
  items: provenanceSchema,
})

function assertValid<T>(
  value: unknown,
  validator: ValidateFunction<T>,
  documentKind: string,
): asserts value is T {
  if (!validator(value)) throw new KnowledgeSchemaError(documentKind, validator.errors)
}

/** Validate and narrow an external manifest document. */
export function assertKnowledgeManifest(value: unknown): asserts value is KnowledgeManifest {
  assertValid(value, validateManifest, 'knowledge manifest')
}

/** Validate and narrow an external memory-entry document. */
export function assertMemoryEntry(value: unknown): asserts value is MemoryEntry {
  assertValid(value, validateMemoryEntry, 'memory entry')
}

/** Validate and narrow an external knowledge-card document. */
export function assertKnowledgeCard(value: unknown): asserts value is KnowledgeCard {
  assertValid(value, validateKnowledgeCard, 'knowledge card')
}

/** Validate and narrow a non-empty durable provenance list. */
export function assertProvenanceRefs(value: unknown): asserts value is ProvenanceRef[] {
  assertValid(value, validateProvenanceRefs, 'provenance')
  for (const reference of value) {
    if (reference.kind === 'git-file' && reference.endLine !== undefined
      && (reference.startLine === undefined || reference.endLine < reference.startLine)) {
      throw new Error('provenance git-file endLine requires an earlier or equal startLine')
    }
  }
}
