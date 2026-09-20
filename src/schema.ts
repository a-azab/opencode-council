// JSON Schemas passed to the runtime as `format: {type:"json_schema"}`.
//
// opencode implements structured output as a FORCED TOOL CALL, so this is real
// enforcement, not a prompt asking nicely: a model that cannot comply returns
// StructuredOutputError rather than prose that has to be parsed and guessed at. That is
// the whole reason aggregation can be arithmetic (PLAN §3).

export const CATEGORIES = [
  "security", "correctness", "architecture", "performance",
  "test", "docs", "quality", "ops",
] as const

export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["BLOCKER", "SUGGESTION", "NIT"] },
          category: { type: "string", enum: [...CATEGORIES] },
          file: { type: "string", description: "path exactly as it appears in the diff" },
          line: { type: "integer", description: "line number in the new file" },
          issue: { type: "string", description: "what is wrong, one sentence" },
          why: { type: "string", description: "the consequence if left unfixed" },
          fix: { type: "string", description: "the concrete change, not a suggestion to consider one" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reference: { type: "string", description: "OWASP ASVS / CWE id, for security findings" },
        },
        required: ["tier", "category", "file", "line", "issue", "why", "fix", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const

export const WORKITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "one line, imperative" },
          detail: { type: "string", description: "what to change and why" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "paths this item is expected to touch",
          },
          acceptance: {
            type: "string",
            description: "how a reviewer would know this item is genuinely done",
          },
        },
        required: ["title", "detail", "files", "acceptance"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const

/** One work item's implementation: whole files, never diffs. Same reasoning as PATCH_SCHEMA. */

export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "the approach in one or two sentences" },
    steps: {
      type: "array",
      items: { type: "string" },
      description: "ordered, concrete steps a developer could follow",
    },
    risks: { type: "array", items: { type: "string" } },
    tradeoff: { type: "string", description: "what this approach gives up" },
  },
  required: ["summary", "steps", "risks", "tradeoff"],
  additionalProperties: false,
} as const

/**
 * Scoring is per-criterion and integral so the tally is arithmetic. Free-form preference
 * would put the decision back inside a model, which is the thing D3 forbids.
 */
export const SCORE_SCHEMA = {
  type: "object",
  properties: {
    correctness: { type: "integer", minimum: 1, maximum: 5, description: "will it actually work?" },
    simplicity: { type: "integer", minimum: 1, maximum: 5, description: "least machinery for the result" },
    risk: { type: "integer", minimum: 1, maximum: 5, description: "5 = lowest risk" },
    completeness: { type: "integer", minimum: 1, maximum: 5, description: "does it cover the whole goal?" },
    reason: { type: "string", description: "one sentence, the deciding factor" },
  },
  required: ["correctness", "simplicity", "risk", "completeness", "reason"],
  additionalProperties: false,
} as const

/**
 * A task answer. `/council:task` asks for the answer itself, not a plan for producing one,
 * so this is deliberately not PROPOSAL_SCHEMA's summary/steps/risks/tradeoff shape.
 */
export const TASK_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "the actual answer to the task, not a description of one" },
    reasoning: { type: "string", description: "why this answer, briefly" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["answer", "reasoning", "confidence"],
  additionalProperties: false,
} as const

/**
 * SCORE_SCHEMA's four dimensions verbatim, because `tally()` sums exactly those four and
 * compares means against TIE_MARGIN, which is calibrated to their 4-20 scale. A scalar
 * `score: 1-10` here would make every term undefined and every mean NaN; NaN comparisons
 * are falsy, so tally()'s sort would fall through to alphabetical-by-slug and still name a
 * confident winner - a false consensus, the exact failure this command exists to prevent.
 *
 * `objection` is the one addition: `reason` is praise when the score is high, so dissent
 * needs a field of its own to be preserved verbatim rather than averaged away.
 */
export const TASK_SCORE_SCHEMA = {
  type: "object",
  properties: {
    correctness: { type: "integer", minimum: 1, maximum: 5, description: "does the answer actually answer it?" },
    simplicity: { type: "integer", minimum: 1, maximum: 5, description: "least machinery for the result" },
    risk: { type: "integer", minimum: 1, maximum: 5, description: "5 = lowest risk" },
    completeness: { type: "integer", minimum: 1, maximum: 5, description: "does it cover the whole task?" },
    reason: { type: "string", description: "one sentence, the deciding factor" },
    objection: {
      type: "string",
      description: "your specific objection to this answer, empty string if you have none",
    },
  },
  required: ["correctness", "simplicity", "risk", "completeness", "reason", "objection"],
  additionalProperties: false,
} as const

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    real: { type: "boolean", description: "is this a genuine problem in the code shown?" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string", description: "one sentence of evidence from the code" },
  },
  required: ["real", "confidence", "reason"],
  additionalProperties: false,
} as const

/**
 * A debate reply revises one judgement; it does not re-emit the finding. Keeping this
 * narrow is what stops a debate round from silently inventing new findings, which would
 * make convergence impossible to reach.
 */
export const DEBATE_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["BLOCKER", "SUGGESTION", "NIT", "WITHDRAW"] },
    reason: { type: "string", description: "what in the other positions moved you, or why it did not" },
    changed_mind: { type: "boolean" },
  },
  required: ["tier", "reason", "changed_mind"],
  additionalProperties: false,
} as const

/**
 * The fixer returns the FULL new file, not a diff.
 *
 * Measured: asking for a unified diff produced `corrupt patch at line 12` and `no valid
 * patches in input` on 2 of 5 attempts, because hand-computing `@@` hunk arithmetic is
 * something models are reliably bad at and there is no reason to make them try. We hold
 * the old content, so the diff is ours to compute - mechanically, and correctly every time.
 */
export const PATCH_SCHEMA = {
  type: "object",
  properties: {
    new_content: {
      type: "string",
      description:
        "the complete new content of the file, from first line to last, with the fix applied " +
        "and everything else byte-identical to what you were shown",
    },
    explanation: { type: "string" },
    confident: { type: "boolean", description: "false if you are guessing; the loop escalates instead of applying" },
  },
  required: ["new_content", "explanation", "confident"],
  additionalProperties: false,
} as const

/**
 * One round's handoff in a fresh-agent loop (`src/ralph.ts`).
 *
 * Every field is required and the object is closed, because the validation that makes
 * this contract worth having is CROSS-FIELD: `complete` must carry evidence and no next
 * steps, `continue` must carry next steps and no blocker. Optional fields would make
 * "absent" and "empty" two ways of saying the same thing, and the checks could not
 * distinguish a worker that finished from one that forgot to answer.
 *
 * Adapted from DeepSeek Harness's `tool-ralph` (packages/workflow/tool-ralph), whose
 * schema this mirrors deliberately: the shape is the part worth copying.
 */
export const ROUND_REPORT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["continue", "complete", "blocked"],
      description:
        "continue = useful work remains; complete = the objective is met and you can point at " +
        "what proves it; blocked = no further progress is possible without a human or an " +
        "external change",
    },
    summary: { type: "string", description: "what you did this round, in one or two sentences" },
    evidence: {
      type: "array",
      items: { type: "string" },
      description:
        "concrete proof the work landed - a file path you changed, a command you ran and its " +
        "result. Required to claim complete. Not a restatement of intent",
    },
    next_steps: {
      type: "array",
      items: { type: "string" },
      description: "what the next round should do. Required to continue, and must be empty to complete",
    },
    blocker: {
      type: "string",
      description: "what is stopping you, concretely. Empty unless status is blocked",
    },
  },
  required: ["status", "summary", "evidence", "next_steps", "blocker"],
  additionalProperties: false,
} as const
