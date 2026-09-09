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
  project: { id: string; name: string } | null;
  completedAt: string | null;
  customerNeeds: { nodes: LinearCustomerNeed[] };
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
 *  come back, so we don't have to filter on the client side. */
const ISSUES_WITH_NEEDS_QUERY = /* GraphQL */ `
  query IssuesWithNeeds($after: String, $first: Int!) {
    issues(
      first: $first
      after: $after
      filter: { customerNeeds: { some: { id: { neq: null } } } }
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
        }
        completedAt
        customerNeeds {
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
 *  the Slack-intake sweep to resolve tickets that were posted to
 *  #enterprise-bugs-and-feature-requests but never got a customer_need
 *  attached in Linear — those don't show up in
 *  `fetchAllIssuesWithCustomerNeeds`, so we look them up
 *  individually. Returns null on any 404-shape response (unknown
 *  identifier, or the ticket lives in a team the API key can't
 *  see). Uses the same `issues.filter` shape, keyed on the
 *  `identifier` field. */
export async function fetchIssueByIdentifier(
  identifier: string
): Promise<LinearIssue | null> {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const query = /* GraphQL */ `
    query IssueByIdentifier($identifier: String!) {
      issues(first: 1, filter: { identifier: { eq: $identifier } }) {
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
          }
          completedAt
          customerNeeds {
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
  const res = await callLinear<IssuesPageResponse>(query, {
    identifier: trimmed,
  });
  return res.data?.issues?.nodes?.[0] ?? null;
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
