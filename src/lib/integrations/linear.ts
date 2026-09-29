/**
 * Linear GraphQL client — read-only, scoped to the Enterprise Request
 * Loop's needs.
 *
 * Authentication:
 * - `LINEAR_API_KEY` env var. Linear personal-access-tokens start with
 *   `lin_api_…`. Pass RAW (no `Bearer` prefix — that's a common
 *   gotcha; Linear's docs say `Authorization: lin_api_...`).
 *
 * What we pull:
 * - Every Linear issue that has ≥1 `customerNeeds`, regardless of
 *   which team it's on. Requests routinely get moved from REQ →
 *   BEE / WEB / POD / COM when engineering picks them up, so team-
 *   scoped queries would silently drop delivered work. See the PDF's
 *   Part 2, Piece 1 "Resolve real state" bullet.
 * - Per issue: id, identifier, title, url, state (name + type),
 *   labels (Type of Work, Customer Impact, Resurfaced), estimate,
 *   project, completedAt, and every attached customer_need with its
 *   customer record (externalIds, domains, revenue).
 *
 * Pagination:
 * - Linear's GraphQL uses relay-style cursors. Each `issues(first,
 *   after)` page carries `pageInfo.hasNextPage` + `endCursor`. We
 *   page at 100 issues per round-trip.
 *
 * Fail posture:
 * - Any HTTP 429 or 5xx retries once after a 2s backoff. Anything else
 *   throws. The engine catches and reports on the sweep summary — a
 *   single failed pull shouldn't wipe the snapshot.
 */

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
/** Linear caps page size at 250; we go 100 to keep each round-trip
 *  under a few hundred KB and leave headroom for the wide join. */
const PAGE_SIZE = 100;

export interface LinearCustomer {
  id: string;
  name: string;
  /** Append-only array of external identifiers written by the intake
   *  skill. Ours carries beehiiv workspace_id (a UUID) + the owner
   *  email. Matched against the customer book in the sync engine. */
  externalIds: string[];
  /** Domains attached to the Linear customer. Some come from the
   *  intake skill, others get added later. Matched against the
   *  customer's owner_email + hubspot_contacts domains as a fallback
   *  when externalIds miss. */
  domains: string[];
  /** Linear's native annual revenue field on the customer. Skill
   *  writes ARR here (not MRR). Nullable because older customers
   *  never had the field set — the sync engine falls back to 0 when
   *  the aggregate math needs it. */
  revenue: number | null;
}

export interface LinearCustomerNeed {
  id: string;
  body: string | null;
  createdAt: string;
  creator: { email: string | null } | null;
  customer: LinearCustomer | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  estimate: number | null;
  /** Linear project the issue is under. Includes the status so the
   *  ER Loop shipped-sweep can gate "Live" promotion on the project
   *  being `completed` — a single ticket shipping doesn't mean the
   *  wider project is customer-facing yet (typical case: BEE-24713
   *  under the "Workspace Library" project). `status.type` is one
   *  of `backlog` / `planned` / `started` / `paused` / `completed`
   *  / `canceled`; only `completed` unblocks promotion. */
  project: {
    id: string;
    name: string;
    url: string;
    status: { name: string; type: string } | null;
  } | null;
  completedAt: string | null;
  /** Renamed by Linear: the field on Issue is `needs` (typed as
   *  `CustomerNeedConnection`). We keep the local TS field name in
   *  sync with the GraphQL wire shape so `issue.needs.nodes` walks
   *  the connection directly. Linear's error message for the old
   *  name (`customerNeeds`) even suggests `formerNeeds` — that's
   *  a different, archived relation and NOT what we want. */
  needs: { nodes: LinearCustomerNeed[] };
}

interface IssuesPageResponse {
  data?: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearIssue[];
    };
  };
  errors?: Array<{ message: string }>;
}

/** The one query the Enterprise Request Loop sync uses. Kept as a
 *  single fetch of one page — the sync engine loops until
 *  `hasNextPage` is false. Only issues WITH at least one customerNeed
 *  come back, so we don't have to filter on the client side.
 *
 *  Filter uses `customerCount: { gt: 0 }` — Linear's IssueFilter
 *  doesn't expose a `customerNeeds` relation filter (schema returns
 *  `Field "customerNeeds" is not defined by type "IssueFilter". Did
 *  you mean "customerCount"?`). `customerCount` is a scalar count
 *  of attached customer_needs, so `> 0` is the equivalent of "has
 *  at least one." Confirmed against the Linear GraphQL API on
 *  2026-09-14. */
const ISSUES_WITH_NEEDS_QUERY = /* GraphQL */ `
  query IssuesWithNeeds($after: String, $first: Int!) {
    issues(
      first: $first
      after: $after
      filter: { customerCount: { gt: 0 } }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        url
        state {
          name
          type
        }
        labels {
          nodes {
            name
          }
        }
        estimate
        project {
          id
          name
          url
          status {
            name
            type
          }
        }
        completedAt
        needs {
          nodes {
            id
            body
            createdAt
            creator {
              email
            }
            customer {
              id
              name
              externalIds
              domains
              revenue
            }
          }
        }
      }
    }
  }
`;

async function callLinear<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new Error(
      "LINEAR_API_KEY not set. Add a personal-access-token from linear.app/beehiiv/settings/api."
    );
  }

  const doFetch = () =>
    fetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: {
        // No `Bearer` prefix — Linear expects the raw key.
        Authorization: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

  let res = await doFetch();
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    // One retry after a 2s backoff. Linear's rate limit is generous
    // (1500 req/hour for personal keys); a 429 usually means we're
    // sharing the key with the intake skill's burst window, and a
    // short pause clears it.
    await new Promise((r) => setTimeout(r, 2000));
    res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Linear GraphQL HTTP ${res.status}: ${body.slice(0, 300)}`
    );
  }
  const json = (await res.json()) as { errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `Linear GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }
  return json as T;
}

export interface FetchIssuesPage {
  issues: LinearIssue[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Fetch one page of issues that have ≥1 customer_need attached.
 *  Caller iterates by passing the returned `endCursor` back as
 *  `after` until `hasNextPage` is false. */
export async function fetchIssuesWithCustomerNeedsPage(
  after: string | null = null
): Promise<FetchIssuesPage> {
  const res = await callLinear<IssuesPageResponse>(ISSUES_WITH_NEEDS_QUERY, {
    after,
    first: PAGE_SIZE,
  });
  const issues = res.data?.issues?.nodes ?? [];
  const pageInfo = res.data?.issues?.pageInfo;
  return {
    issues,
    endCursor: pageInfo?.endCursor ?? null,
    hasNextPage: !!pageInfo?.hasNextPage,
  };
}

/** Fetch a single issue by its identifier (e.g. "REQ-2207"). Used by
 *  the Slack-intake + Linear-comment scans to resolve tickets that
 *  are referenced but not yet attached as a customer_need. Uses
 *  Linear's singular `issue(id:)` root query — accepts either a UUID
 *  or an identifier like `REQ-2207`, so we skip the fragile
 *  `IssueFilter` schema shape. Returns null when the identifier is
 *  unknown or the ticket lives in a team the API key can't see. */
interface IssueByIdResponse {
  data?: { issue: LinearIssue | null };
  errors?: Array<{ message: string }>;
}
export async function fetchIssueByIdentifier(
  identifier: string
): Promise<LinearIssue | null> {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const query = /* GraphQL */ `
    query IssueById($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        url
        state {
          name
          type
        }
        labels {
          nodes {
            name
          }
        }
        estimate
        project {
          id
          name
          url
          status {
            name
            type
          }
        }
        completedAt
        needs {
          nodes {
            id
            body
            createdAt
            creator {
              email
            }
            customer {
              id
              name
              externalIds
              domains
              revenue
            }
          }
        }
      }
    }
  `;
  try {
    const res = await callLinear<IssueByIdResponse>(query, { id: trimmed });
    return res.data?.issue ?? null;
  } catch (e) {
    // Linear returns a GraphQL error (not a 404) for unknown
    // identifiers. Treat any error here as a soft-miss so a single
    // bad REQ-<KEY> in a Slack post doesn't wedge the whole sweep.
    console.warn(`[linear] fetchIssueByIdentifier(${trimmed}):`, e);
    return null;
  }
}

/** Walk every page of issues-with-needs and return the concatenated
 *  list. Consumer typically calls this once per sync run. Guards
 *  against a pathological Linear pagination bug by capping at 200
 *  pages (== 20k issues) — no realistic REQ team book approaches
 *  that. */
export async function fetchAllIssuesWithCustomerNeeds(): Promise<
  LinearIssue[]
> {
  const all: LinearIssue[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const {
      issues,
      endCursor,
      hasNextPage,
    }: FetchIssuesPage = await fetchIssuesWithCustomerNeedsPage(cursor);
    all.push(...issues);
    if (!hasNextPage) return all;
    cursor = endCursor;
    if (!cursor) return all;
  }
  // If we somehow hit the 200-page ceiling, return what we have —
  // the sweep report will show the number and we can debug from
  // there rather than looping forever.
  console.warn("[linear] fetchAllIssuesWithCustomerNeeds hit 200-page cap");
  return all;
}

// ─── Comment scan (open issues → comments) ──────────────────────────

/** Comment shape returned by the comment-scan query. `url` is a
 *  jump-to-Slack-style permalink (`.../issue/<key>#comment-<id>`). */
export interface LinearComment {
  id: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  user: { email: string | null; name: string | null } | null;
}

/** Trimmed issue payload for the comment-scan pass. We only pull the
 *  metadata the engine needs to build a snapshot row + reach each
 *  comment. Dedupe against issues already covered by the main sync
 *  is done via the snapshot's `rows[workspaceId][issue.id]` key, so
 *  we don't need to know the customer-need count up-front. (An
 *  earlier draft selected `customerCount` here — it's a filter
 *  field on IssueFilter, NOT a scalar on Issue. Linear returns
 *  `Cannot query field "customerCount" on type "Issue". Did you
 *  mean "customerTicketCount"?` — customerTicketCount is
 *  Zendesk-attachment-only and unrelated.) */
export interface LinearIssueWithComments {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  estimate: number | null;
  /** Linear project the issue is under. Includes the status so the
   *  ER Loop shipped-sweep can gate "Live" promotion on the project
   *  being `completed` — a single ticket shipping doesn't mean the
   *  wider project is customer-facing yet (typical case: BEE-24713
   *  under the "Workspace Library" project). `status.type` is one
   *  of `backlog` / `planned` / `started` / `paused` / `completed`
   *  / `canceled`; only `completed` unblocks promotion. */
  project: {
    id: string;
    name: string;
    url: string;
    status: { name: string; type: string } | null;
  } | null;
  completedAt: string | null;
  /** Issue body. Juliet's feature-request-creator skill sometimes
   *  writes the structured `Publication ID` / `User Email` block here
   *  rather than in a comment — BEE-24879 shipped for Daily Drop that
   *  way and never reached the tracker, because nothing parsed it. */
  description: string | null;
  createdAt: string;
  updatedAt: string;
  creator: { email: string | null; name: string | null } | null;
  comments: { nodes: LinearComment[]; pageInfo: { hasNextPage: boolean } };
}

interface OpenIssuesResponse {
  data?: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearIssueWithComments[];
    };
  };
  errors?: Array<{ message: string }>;
}

/** Pull one page of open issues (statusType NOT completed/canceled)
 *  with their first 20 comments inlined. Comments beyond the 20th
 *  are extremely rare on request tickets — if we see hasNextPage in
 *  the wild, the engine can fall back to a per-issue comment fetch,
 *  but we don't need that yet. Filter uses `state: { type }` which
 *  is on IssueFilter (validated in the Linear GraphQL playground). */
/** Field selections shared by both filter variants. Kept as one
 *  string so the two queries can't drift — a field added for the
 *  description path must exist on whichever query actually runs. */
const OPEN_ISSUES_SELECTION = `
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        url
        state {
          name
          type
        }
        labels {
          nodes {
            name
          }
        }
        estimate
        project {
          id
          name
          url
          status {
            name
            type
          }
        }
        completedAt
        description
        createdAt
        updatedAt
        creator {
          email
          name
        }
        comments(first: 20) {
          nodes {
            id
            body
            url
            createdAt
            updatedAt
            user {
              email
              name
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
`;

/** Preferred query: open issues PLUS anything completed since
 *  `$completedSince`. See COMPLETED_TAIL_DAYS for why the tail
 *  matters. */
const OPEN_ISSUES_WITH_TAIL_QUERY = `
  query OpenIssuesWithComments(
    $after: String
    $first: Int!
    $completedSince: DateTimeOrDuration!
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        or: [
          { state: { type: { nin: ["completed", "canceled"] } } }
          { completedAt: { gte: $completedSince } }
        ]
      }
      orderBy: updatedAt
    ) {
${OPEN_ISSUES_SELECTION}
    }
  }
`;

/** Fallback: the original open-only filter, no date variable.
 *
 *  The tail query's `completedAt: { gte: ... }` comparator shape
 *  couldn't be validated against Linear's live schema from here (no
 *  API key in local dev, and the published docs don't carry the
 *  GraphQL reference). Rather than gamble the whole sweep on it, a
 *  validation error downgrades to this query for the rest of the
 *  process — the scan then behaves exactly as it did before the
 *  completed-tail change, and the description-parsing half of the
 *  fix still works. */
const OPEN_ISSUES_ONLY_QUERY = `
  query OpenIssuesWithComments($after: String, $first: Int!) {
    issues(
      first: $first
      after: $after
      filter: {
        state: {
          type: { nin: ["completed", "canceled"] }
        }
      }
      orderBy: updatedAt
    ) {
${OPEN_ISSUES_SELECTION}
    }
  }
`;

/** Tri-state: null = not yet attempted, true = tail filter accepted,
 *  false = schema rejected it, use the open-only query. Module-level
 *  so one rejection isn't re-learned on every page of a run. */
let completedTailSupported: boolean | null = null;

/** A GraphQL validation failure — wrong field, wrong scalar, unknown
 *  argument. Distinguished from auth/rate-limit/network failures,
 *  which must keep propagating rather than silently narrowing the
 *  scan. */
function isSchemaRejection(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/Linear GraphQL errors/.test(msg)) return false;
  return /completedSince|completedAt|DateTimeOrDuration|Unknown argument|Cannot query|expected type|Variable/i.test(
    msg
  );
}

export interface FetchOpenIssuesPage {
  issues: LinearIssueWithComments[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** How far back to include ALREADY-COMPLETED issues.
 *
 *  The scan originally walked open issues only, which is the cheaper
 *  read but misses the case that matters most: a request that shipped
 *  before anyone attached a customer need. BEE-24879 went from filed
 *  to Done in eight days — the entire window in which an open-only
 *  scan could have caught it. Since close-the-loop value is
 *  concentrated exactly in shipped tickets, a recently-completed tail
 *  is worth the extra pages.
 *
 *  Canceled issues stay excluded: "we're not building this" isn't a
 *  ship to tell a customer about, and the main sync already handles
 *  canceled → Not planned for issues that do have needs. */
export const COMPLETED_TAIL_DAYS = 30;

export async function fetchOpenIssuesWithCommentsPage(
  after: string | null = null,
  first: number = 50,
  completedSinceIso?: string
): Promise<FetchOpenIssuesPage> {
  const completedSince =
    completedSinceIso ??
    new Date(
      Date.now() - COMPLETED_TAIL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

  const unpack = (res: OpenIssuesResponse): FetchOpenIssuesPage => ({
    issues: res.data?.issues?.nodes ?? [],
    endCursor: res.data?.issues?.pageInfo?.endCursor ?? null,
    hasNextPage: !!res.data?.issues?.pageInfo?.hasNextPage,
  });

  if (completedTailSupported !== false) {
    try {
      const res = await callLinear<OpenIssuesResponse>(
        OPEN_ISSUES_WITH_TAIL_QUERY,
        { after, first, completedSince }
      );
      completedTailSupported = true;
      return unpack(res);
    } catch (e) {
      if (!isSchemaRejection(e)) throw e;
      completedTailSupported = false;
      console.warn(
        "[linear] completed-tail filter rejected by the schema — " +
          "falling back to open-issues-only for this process. Recently " +
          "shipped tickets will not be scanned; fix the filter shape in " +
          "OPEN_ISSUES_WITH_TAIL_QUERY. Error: " +
          (e instanceof Error ? e.message : String(e))
      );
    }
  }

  const res = await callLinear<OpenIssuesResponse>(OPEN_ISSUES_ONLY_QUERY, {
    after,
    first,
  });
  return unpack(res);
}

/** Whether the last fetch used the completed tail. Surfaced on the
 *  scan result so a run says plainly which query shape it ran —
 *  otherwise a silent downgrade looks identical to "nothing shipped
 *  recently". */
export function completedTailActive(): boolean {
  return completedTailSupported === true;
}
