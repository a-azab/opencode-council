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
