// Linear Agents API, as much of it as lets needs and no more.
//
// Deliberately hand-rolled over `fetch` rather than @linear/sdk: this is six operations,
// and both APIs it touches are previews - Agents API is a Developer Preview and Agent Plans
// is a technology preview, so Linear says outright they may change. A thin file is a
// one-file repair when they do; a dependency pinned to a preview schema is not.
//
// Lets is an OUTBOUND agent (PLAN.md §9 Phase 5, "Tier 2"): it creates its own session
// with agentSessionCreateOnIssue and streams activities into it. There is no webhook, no
// public endpoint and no daemon. The cost is that `prompted` events do not reach us, so
// iteration happens in the terminal rather than by replying in Linear.

const ENDPOINT = "https://api.linear.app/graphql"

export type LinearCtx = { token: string; endpoint?: string }

export class LinearError extends Error {}

async function gql<T>(ctx: LinearCtx, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(ctx.endpoint ?? ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: ctx.token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  })
  // Read text first: an auth failure here returns a body that is not JSON, and calling
  // .json() on it reports a parser error for what is actually a bad token. Same trap the
  // engine hit against the opencode server.
  const raw = await r.text()
  if (r.status >= 300) throw new LinearError(`http ${r.status}: ${raw.slice(0, 200) || "(empty body)"}`)
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    throw new LinearError(`unparseable response: ${raw.slice(0, 200)}`)
  }
  if (body.errors?.length) throw new LinearError(body.errors.map((e: any) => e.message).join("; ").slice(0, 300))
  return body.data as T
}

/** `LIN-123` -> the issue, or null. Identifiers are what humans have; the API wants a uuid. */
export async function findIssue(ctx: LinearCtx, identifier: string) {
  const d = await gql<{ issue: { id: string; identifier: string; title: string; url: string } | null }>(
    ctx,
    `query($id: String!) { issue(id: $id) { id identifier title url } }`,
    { id: identifier },
  )
  return d.issue
}

export async function createSessionOnIssue(ctx: LinearCtx, issueId: string): Promise<string> {
  const d = await gql<{ agentSessionCreateOnIssue: { success: boolean; agentSession: { id: string } } }>(
    ctx,
    `mutation($input: AgentSessionCreateOnIssueInput!) {
       agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
     }`,
    { input: { issueId } },
  )
  const id = d.agentSessionCreateOnIssue?.agentSession?.id
  if (!id) throw new LinearError("session was not created")
  return id
}

export type Activity =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }

/**
 * `ephemeral` activities are replaced by the next one rather than accumulating. Progress
 * lines are exactly that: without it a twenty-minute run leaves a hundred entries on the
 * issue and buries the two that mattered.
 */
export async function createActivity(ctx: LinearCtx, sessionId: string, content: Activity, ephemeral = false) {
  await gql(
    ctx,
    `mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
    { input: { agentSessionId: sessionId, content, ...(ephemeral ? { ephemeral: true } : {}) } },
  )
}

export type PlanStep = { content: string; status: "pending" | "inProgress" | "completed" | "canceled" }

/** The whole plan, every time - Linear replaces the array rather than patching one entry. */
export async function updatePlan(ctx: LinearCtx, sessionId: string, plan: PlanStep[]) {
  await gql(
    ctx,
    `mutation($id: String!, $input: AgentSessionUpdateInput!) {
       agentSessionUpdate(id: $id, input: $input) { success }
     }`,
    { id: sessionId, input: { plan } },
  )
}

/** Adds without replacing, so a PR link cannot clobber a dashboard link. */
export async function addExternalUrl(ctx: LinearCtx, sessionId: string, label: string, url: string) {
  await gql(
    ctx,
    `mutation($id: String!, $input: AgentSessionUpdateInput!) {
       agentSessionUpdate(id: $id, input: $input) { success }
     }`,
    { id: sessionId, input: { addedExternalUrls: [{ label, url }] } },
  )
}

/** `LIN-123`, `ENG-7`. Used to decide whether a directive names an issue at all. */
export const ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/

export function issueIdentifierIn(text: string): string | null {
  const m = text.trim().match(ISSUE_IDENTIFIER)
  return m ? m[0] : null
}
