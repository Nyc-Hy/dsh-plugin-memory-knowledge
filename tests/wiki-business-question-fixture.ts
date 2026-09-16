import type { WikiClaimId } from '../src/ids.js'
import {
  WIKI_BUSINESS_QUESTION_DEFINITIONS,
  type WikiBusinessQuestionFinding,
  type WikiBusinessQuestionKey,
} from '../src/wiki-model.js'

/** Build structurally complete question findings for state-machine fixtures. */
export function testBusinessQuestionFindings(
  evidenceClaimIds: readonly WikiClaimId[] = [],
  evidenceKey: WikiBusinessQuestionKey = 'purpose-and-terms',
): WikiBusinessQuestionFinding[] {
  return WIKI_BUSINESS_QUESTION_DEFINITIONS.map(definition => evidenceClaimIds.length > 0 && definition.key === evidenceKey
    ? { key: definition.key, outcome: 'evidence', claimIds: [...evidenceClaimIds] }
    : {
        key: definition.key,
        outcome: 'not-applicable',
        claimIds: [],
        reason: '当前测试材料不覆盖该项目问题。',
      })
}
