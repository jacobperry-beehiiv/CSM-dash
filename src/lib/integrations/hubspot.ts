/**
 * HubSpot Private-App-token CRM client. Used by scripts/sync.ts to enrich
 * each customer row with `last_activity_at` — the most-recent activity
 * across emails/calls/meetings/notes for ALL contacts at the company.
 *
 * Why this exists: q10600 surfaces HubSpot's narrow `notes_last_contacted`
 * property, which CSMs almost never set manually. The company-level
 * activity rollup (`notes_last_activity_date`) is dramatically more
 * populated and is what HubSpot itself uses for "last activity" in its
 * own UI.
 *
 * Two lookup paths:
 *   • fetchLastActivity(companyIds) — for snapshots that already have a
 *     hubspot_company_id column (faster: 1 batch call per ~100 ids)
 *   • fetchLastActivityByEmail(emails) — for snapshots that only carry
 *     contact emails (q10600 today). Walks contact → primary company →
 *     activity rollup. 2 batch calls per ~100 emails.
 *
 * Setup:
 *   1. HubSpot Settings → Integrations → Private Apps → Create
 *   2. Scopes:
 *        - crm.objects.companies.read
 *        - crm.schemas.companies.read
 *        - crm.objects.contacts.read    (only for the by-email lookup)
 *   3. Paste the token into HUBSPOT_ACCESS_TOKEN (env)
 *
 * Rate limits: Private Apps are capped at 100 requests / 10 seconds per
 * portal. We batch up to 100 IDs per call (the HubSpot batch endpoint's
 * own cap) and add a small inter-batch delay as a guardrail.
 */

const COMPANY_BATCH_ENDPOINT =
  "https://api.hubapi.com/crm/v3/objects/companies/batch/read";
const CONTACT_BATCH_ENDPOINT =
  "https://api.hubapi.com/crm/v3/objects/contacts/batch/read";
const BATCH_SIZE = 100;
const INTER_BATCH_DELAY_MS = 100;

const ACTIVITY_PROPS = [
  "notes_last_activity_date",
  "notes_last_contacted",
  "hs_last_sales_activity_timestamp",
] as const;

type ActivityProp = (typeof ACTIVITY_PROPS)[number];

interface BatchReadResponse {
  status: "COMPLETE" | "PENDING";
  results: Array<{
    id: string;
    properties: Partial<Record<ActivityProp, string | null>>;
  }>;
  numErrors?: number;
  errors?: Array<{ status: string; message: string }>;
}

export interface CompanyActivity {
  /** Most-recent of the three HubSpot activity properties, as ISO string. */
  last_activity_at: string | null;
  /** Which raw HubSpot property produced the winning value — used for the UI tooltip. */
  source: ActivityProp | null;
}

/**
 * Fetch the most-recent activity timestamp for each HubSpot company ID.
 * Returns a Map keyed by company ID — companies that don't exist or
 * 404 silently produce no entry rather than an error, since stale IDs
 * are a known reality in snapshot rows.
 */
export async function fetchLastActivity(
  companyIds: string[]
): Promise<Map<string, CompanyActivity>> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "HUBSPOT_ACCESS_TOKEN is not set — create a Private App in HubSpot " +
        "with crm.objects.companies.read scope and export the token."
    );
  }
  const result = new Map<string, CompanyActivity>();
  const unique = [...new Set(companyIds.filter(Boolean))];
  if (unique.length === 0) return result;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const slice = unique.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    let res: Response;
    try {
      res = await fetch(COMPANY_BATCH_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          properties: ACTIVITY_PROPS,
          inputs: slice.map((id) => ({ id })),
        }),
      });
    } catch (e) {
      console.error(
        `[hubspot] company batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] company batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      continue;
    }

    const json = (await res.json()) as BatchReadResponse;
    for (const company of json.results ?? []) {
      const winner = pickLatest(company.properties);
      if (winner) result.set(company.id, winner);
    }
  }

  return result;
}

interface ContactBatchResponse {
  status: "COMPLETE" | "PENDING";
  results: Array<{
    id: string;
    properties: { email?: string | null; associatedcompanyid?: string | null };
  }>;
  numErrors?: number;
  errors?: Array<{ id?: string; status: string; message: string }>;
}

/**
 * Resolve a list of contact emails → most-recent company activity for the
 * company each contact is primarily associated with.
 *
 * Returns a Map keyed by the lowercased input email. Used by sync.ts when
 * q10600 surfaces `owner_email` but no HubSpot company ID column —
 * traverses contact → primary company → activity rollup.
 */
export async function fetchLastActivityByEmail(
  emails: string[]
): Promise<Map<string, CompanyActivity>> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "HUBSPOT_ACCESS_TOKEN is not set — create a Private App in HubSpot " +
        "with crm.objects.companies.read + crm.objects.contacts.read scopes."
    );
  }

  const unique = [
    ...new Set(
      emails
        .filter((e): e is string => Boolean(e))
        .map((e) => e.toLowerCase().trim())
    ),
  ];
  const result = new Map<string, CompanyActivity>();
  if (unique.length === 0) return result;

  // Step 1: resolve emails → primary company ID via contacts batch read.
  // associatedcompanyid is HubSpot's built-in contact property that
  // points at the contact's primary associated company. Cheaper than the
  // separate /associations endpoint.
  const emailToCompany = new Map<string, string>();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const slice = unique.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    let res: Response;
    try {
      res = await fetch(CONTACT_BATCH_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idProperty: "email",
          properties: ["email", "associatedcompanyid"],
          inputs: slice.map((email) => ({ id: email })),
        }),
      });
    } catch (e) {
      console.error(
        `[hubspot] contact batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }

    if (!res.ok && res.status !== 207) {
      // 207 Multi-Status fires when SOME emails missed — partial results
      // still come back, so don't `continue` on it.
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] contact batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      continue;
    }

    const json = (await res.json()) as ContactBatchResponse;
    for (const contact of json.results ?? []) {
      const email = contact.properties?.email?.toLowerCase() ?? null;
      const companyId = contact.properties?.associatedcompanyid ?? null;
      if (email && companyId) emailToCompany.set(email, companyId);
    }
  }

  if (emailToCompany.size === 0) return result;

  // Step 2: fetch activity rollup for those companies. Reuses the same
  // batch endpoint as fetchLastActivity().
  const companyIds = [...new Set(emailToCompany.values())];
  const companyActivity = await fetchLastActivity(companyIds);

  // Step 3: re-key the result by email so the caller can match rows.
  for (const [email, companyId] of emailToCompany) {
    const hit = companyActivity.get(companyId);
    if (hit) result.set(email, hit);
  }
  return result;
}

function pickLatest(
  props: Partial<Record<ActivityProp, string | null>>
): CompanyActivity | null {
  let bestDate: number | null = null;
  let bestSource: ActivityProp | null = null;
  let bestValue: string | null = null;
  for (const key of ACTIVITY_PROPS) {
    const raw = props[key];
    if (!raw) continue;
    const ts = new Date(raw).getTime();
    if (!Number.isFinite(ts)) continue;
    if (bestDate === null || ts > bestDate) {
      bestDate = ts;
      bestSource = key;
      bestValue = raw;
    }
  }
  if (bestValue === null) return null;
  // Normalize to ISO so the snapshot is consistent regardless of how
  // HubSpot serialized the property (epoch ms vs ISO vs date-only).
  const iso = new Date(bestValue).toISOString();
  return { last_activity_at: iso, source: bestSource };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
