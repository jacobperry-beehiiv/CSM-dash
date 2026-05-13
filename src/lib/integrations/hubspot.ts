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
 * Setup:
 *   1. HubSpot Settings → Integrations → Private Apps → Create
 *   2. Scopes: crm.objects.companies.read + crm.schemas.companies.read
 *   3. Copy the pat-na1-… token into HUBSPOT_ACCESS_TOKEN (env)
 *
 * Rate limits: Private Apps are capped at 100 requests / 10 seconds per
 * portal. We batch up to 100 company IDs per call (the HubSpot batch
 * endpoint's own cap) and add a small inter-batch delay as a guardrail.
 */

const BATCH_ENDPOINT = "https://api.hubapi.com/crm/v3/objects/companies/batch/read";
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
      res = await fetch(BATCH_ENDPOINT, {
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
        `[hubspot] batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
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
