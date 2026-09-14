import { describe, expect, it } from 'vitest'
import {
  extractExplicitMemory,
  type ConversationExtractionResult,
} from '../src/conversation-extraction.js'

function candidate(input: string): Extract<ConversationExtractionResult, { kind: 'candidate' }>['value'] {
  const result = extractExplicitMemory(input)
  expect(result.kind).toBe('candidate')
  if (result.kind !== 'candidate') throw new Error(`expected candidate, got ${result.reason}`)
  return result.value
}

describe('explicit conversation memory extraction', () => {
  it('extracts one explicit Chinese project constraint', () => {
    expect(candidate('请记住：这个项目统一使用 pnpm。')).toMatchObject({
      applicability: 'project',
      kind: 'constraint',
      content: '这个项目统一使用 pnpm',
      sensitivity: 'normal',
      ruleId: 'explicit-remember-zh',
    })
  })

  it('extracts Chinese and English personal preferences as global candidates', () => {
    expect(candidate('以后请用中文回答我。')).toMatchObject({ applicability: 'global', kind: 'preference' })
    expect(candidate('I prefer concise answers.')).toMatchObject({
      applicability: 'global',
      kind: 'preference',
      content: 'I prefer concise answers',
    })
  })

  it('extracts an explicit English repository fact', () => {
    expect(candidate('Remember that this repo uses pnpm.')).toMatchObject({
      applicability: 'project',
      kind: 'fact',
      content: 'this repo uses pnpm',
      ruleId: 'explicit-remember-en',
    })
    expect(candidate('Remember that this repo uses Node.js.')).toMatchObject({
      applicability: 'project',
      content: 'this repo uses Node.js',
    })
  })

  it.each([
    ['你能记住这个项目使用 pnpm 吗？', 'question'],
    ['不要记住：这个项目使用 npm。', 'negative'],
    ['如果项目改用 pnpm，请记住它。', 'conditional'],
    ['请记住：如果项目改用 pnpm 就更新文档。', 'conditional'],
    ['> 请记住：项目使用 pnpm。', 'quoted-or-code'],
    ['请记住：“项目使用 pnpm”。', 'quoted-or-code'],
    ['请记住：项目使用 pnpm。团队使用中文。', 'multiple-statements'],
    ['请记住：这个。', 'ambiguous-reference'],
    ['项目里有很多 TypeScript 文件。', 'not-explicit'],
    ['请记住：API key 是 sk-example-secret。', 'unsafe-content'],
  ])('skips %s without creating a candidate', (input, reason) => {
    expect(extractExplicitMemory(input)).toEqual({ kind: 'skipped', reason })
  })

  it('enforces code-point bounds on candidate content and titles', () => {
    expect(extractExplicitMemory('请记住：这个项目统一使用 pnpm。', {
      maxInputChars: 100,
      maxContentChars: 5,
      maxTitleChars: 8,
    })).toEqual({ kind: 'skipped', reason: 'content-limit' })
    expect([...candidate('请记住：这个项目统一使用 pnpm。').title].length).toBeLessThanOrEqual(80)
  })
})
