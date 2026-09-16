import type { WikiClaimId } from '../src/ids.js'
import {
  WIKI_BUSINESS_QUESTION_DEFINITIONS,
  type WikiBusinessQuestionFinding,
} from '../src/wiki-model.js'

/** Build structurally complete question findings for state-machine fixtures. */
export function testBusinessQuestionFindings(
  evidenceClaimIds: readonly WikiClaimId[] = [],
): WikiBusinessQuestionFinding[] {
  return WIKI_BUSINESS_QUESTION_DEFINITIONS.map((definition, index) => evidenceClaimIds.length > 0 && index === 0
    ? { key: definition.key, outcome: 'evidence', claimIds: [...evidenceClaimIds] }
    : {
        key: definition.key,
        outcome: 'not-applicable',
        claimIds: [],
        reason: '当前测试材料不覆盖该项目问题。',
      })
}
