/**
 * HubSpot CRM client. Used by scripts/sync.ts to enrich each customer
 * row with `last_activity_at` — the most-recent activity across
 * emails/calls/meetings/notes for ALL contacts at the company.
 *
 * Why this exists: q10600 surfaces HubSpot's narrow `notes_last_contacted`
 * property, which CSMs almost never set manually. The company-level
 * activity rollup (`notes_last_activity_date`) is dramatically more
 * populated and is what HubSpot itself uses for "last activity" in its
 * own UI.
 *
 * Auth: supports two credential paths, checked in order:
 *
 *   1. **Private App access token** — paste `pat-na1-…` into
 *      HUBSPOT_ACCESS_TOKEN. Simplest, never expires.
 *
 *   2. **OAuth client_credentials grant** — set HUBSPOT_CLIENT_ID +
 *      HUBSPOT_CLIENT_SECRET. The integration calls HubSpot's
 *      /oauth/v1/token endpoint to mint a short-lived bearer token
 *      (~30 min lifetime), caches it in-process until ~30s before
 *      expiry, then re-mints. No user redirect, no refresh tokens.
 *      Used when the HubSpot integration was provisioned as an OAuth
 *      app instead of a Private App.
 *
 * Lookup paths:
 *   • fetchLastActivity(companyIds) — for snapshots that already have a
 *     hubspot_company_id column (faster: 1 batch call per ~100 ids)
 *   • fetchLastActivityByEmail(emails) — for snapshots that only carry
 *     contact emails (q10600 today). Walks contact → primary company →
 *     activity rollup. 2 batch calls per ~100 emails.
 *
 * Required scopes:
 *   - crm.objects.companies.read
 *   - crm.schemas.companies.read
 *   - crm.objects.contacts.read    (only for the by-email lookup)
 *
 * Rate limits: 100 requests / 10 seconds per portal. We batch up to
 * 100 IDs per call and add a small inter-batch delay as a guardrail.
 */

const COMPANY_BATCH_ENDPOINT =
  "https://api.hubapi.com/crm/v3/objects/companies/batch/read";
const CONTACT_BATCH_ENDPOINT =
  "https://api.hubapi.com/crm/v3/objects/contacts/batch/read";
/** v4 associations endpoint — the v3 batch read silently drops the `associations`
 * field, so we read company → contact links separately here. typeId 2 =
 * "Contact with Primary Company", which is the label we surface to CSMs. */
const COMPANY_TO_CONTACTS_ASSOC_ENDPOINT =
  "https://api.hubapi.com/crm/v4/associations/companies/contacts/batch/read";
const OAUTH_TOKEN_ENDPOINT = "https://api.hubapi.com/oauth/v1/token";
/** HubSpot association typeId for "Contact with Primary Company". */
const PRIMARY_COMPANY_ASSOC_TYPE_ID = 2;
const BATCH_SIZE = 100;
const INTER_BATCH_DELAY_MS = 100;
/** Refresh the OAuth token this many ms before its declared expiry. */
const OAUTH_REFRESH_SLACK_MS = 30_000;

let cachedOauthToken: { token: string; expiresAt: number } | null = null;

/**
 * Resolve a bearer token for the HubSpot REST API. Tries the Private
 * App static token first, then falls back to minting one via OAuth
 * client_credentials. Throws a clear error if neither path is configured.
 */
async function getAccessToken(): Promise<string> {
  // Path A: static Private App token
  const staticToken = process.env.HUBSPOT_ACCESS_TOKEN;
  if (staticToken) return staticToken;

  // Path B: OAuth client_credentials
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "HubSpot auth is not configured. Set either HUBSPOT_ACCESS_TOKEN " +
        "(Private App `pat-na1-…`) or HUBSPOT_CLIENT_ID + " +
        "HUBSPOT_CLIENT_SECRET (OAuth client_credentials)."
    );
  }

  const now = Date.now();
  if (cachedOauthToken && cachedOauthToken.expiresAt > now + OAUTH_REFRESH_SLACK_MS) {
    return cachedOauthToken.token;
  }

  // HubSpot's client_credentials grant requires explicit scope. Pass the
  // exact list the integration needs; the OAuth app in HubSpot must have
  // these scopes enabled or the token request fails with BAD_SCOPES.
  const scope = [
    "crm.objects.companies.read",
    "crm.schemas.companies.read",
    "crm.objects.contacts.read",
  ].join(" ");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HubSpot OAuth token exchange failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type?: string;
  };
  cachedOauthToken = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 1800) * 1000,
  };
  return json.access_token;
}

const ACTIVITY_PROPS = [
  "notes_last_activity_date",
  "notes_last_contacted",
  "hs_last_sales_activity_timestamp",
] as const;

type ActivityProp = (typeof ACTIVITY_PROPS)[number];

const CONTACT_PROPS = [
  "email",
  "firstname",
  "lastname",
  "jobtitle",
  "notes_last_activity_date",
  "associatedcompanyid",
] as const;

type ContactProp = (typeof CONTACT_PROPS)[number];

interface CompanyBatchReadResponse {
  status: "COMPLETE" | "PENDING";
  results: Array<{
    id: string;
    properties: Partial<Record<ActivityProp, string | null>>;
  }>;
  numErrors?: number;
  errors?: Array<{ status: string; message: string }>;
}

interface AssociationBatchReadResponse {
  status: "COMPLETE" | "PENDING";
  results: Array<{
    from: { id: string };
    to: Array<{
      toObjectId: number;
      associationTypes: Array<{
        category: string;
        typeId: number;
        label: string | null;
      }>;
    }>;
  }>;
}

export interface HubSpotContact {
  id: string;
  email: string | null;
  name: string | null;
  job_title: string | null;
  last_activity_at: string | null;
  is_primary: boolean;
}

export interface CompanyActivity {
  /** Most-recent of the three HubSpot activity properties, as ISO string. */
  last_activity_at: string | null;
  /** Which raw HubSpot property produced the winning value — used for the UI tooltip. */
  source: ActivityProp | null;
  /**
   * Contacts whose primary associated company is this one. First entry,
   * if any, is the company's primary contact (`is_primary: true`); rest
   * are alphabetical by name. Populated by fetchLastActivity when the
   * HubSpot Private App has crm.objects.contacts.read scope.
   */
  contacts?: HubSpotContact[];
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
  const token = await getAccessToken();
  const result = new Map<string, CompanyActivity>();
  const unique = [...new Set(companyIds.filter(Boolean))];
  if (unique.length === 0) return result;

  // Pass 1: pull company activity rollup properties. The v3 batch endpoint
  // silently drops the `associations` field, so contact associations are
  // fetched separately in Pass 2 via the v4 associations API.
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
          properties: [...ACTIVITY_PROPS],
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

    const json = (await res.json()) as CompanyBatchReadResponse;
    for (const company of json.results ?? []) {
      const winner = pickLatest(company.properties);
      result.set(company.id, {
        last_activity_at: winner?.last_activity_at ?? null,
        source: winner?.source ?? null,
      });
    }
  }

  // Pass 2: fetch contacts whose primary associated company is one of these.
  // Uses the v4 associations batch endpoint, filtered to typeId 2 ("Contact
  // with Primary Company") so we surface only contacts that HubSpot considers
  // primarily attached to this company (not random associations).
  const companyToContactIds = new Map<string, string[]>();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const slice = unique.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    let res: Response;
    try {
      res = await fetch(COMPANY_TO_CONTACTS_ASSOC_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: slice.map((id) => ({ id })) }),
      });
    } catch (e) {
      console.error(
        `[hubspot] associations batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] associations batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      continue;
    }
    const json = (await res.json()) as AssociationBatchReadResponse;
    for (const row of json.results ?? []) {
      const ids = row.to
        .filter((t) =>
          t.associationTypes.some(
            (a) => a.typeId === PRIMARY_COMPANY_ASSOC_TYPE_ID
          )
        )
        .map((t) => String(t.toObjectId));
      if (ids.length > 0) companyToContactIds.set(row.from.id, ids);
    }
  }

  // Pass 3: batch-fetch contact details for every associated contact.
  // Dedupe across companies to minimise calls when contacts overlap.
  const allContactIds = [
    ...new Set([...companyToContactIds.values()].flat()),
  ];
  if (allContactIds.length > 0) {
    const contactById = await fetchContactsBatch(token, allContactIds);
    for (const [companyId, ids] of companyToContactIds) {
      let slot = result.get(companyId);
      if (!slot) {
        slot = { last_activity_at: null, source: null };
        result.set(companyId, slot);
      }
      const contacts: HubSpotContact[] = ids
        .map((id) => contactById.get(id))
        .filter((c): c is HubSpotContact => Boolean(c));
      // Sort: most-recently-active first, falling back to alphabetical.
      contacts.sort((a, b) => {
        const at = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
        const bt = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
        if (at !== bt) return bt - at;
        return (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "");
      });
      if (contacts.length > 0) slot.contacts = contacts;
    }
  }

  return result;
}

interface RawContactReadResponse {
  status: "COMPLETE" | "PENDING";
  results: Array<{
    id: string;
    properties: Partial<Record<ContactProp, string | null>>;
  }>;
  errors?: Array<{ status: string; message: string }>;
}

async function fetchContactsBatch(
  token: string,
  ids: string[]
): Promise<Map<string, HubSpotContact>> {
  const out = new Map<string, HubSpotContact>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const slice = ids.slice(i, i + BATCH_SIZE);
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
          properties: CONTACT_PROPS,
          inputs: slice.map((id) => ({ id })),
        }),
      });
    } catch (e) {
      console.error(
        `[hubspot] contact details batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }
    if (!res.ok && res.status !== 207) {
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] contact details batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      continue;
    }
    const json = (await res.json()) as RawContactReadResponse;
    for (const c of json.results ?? []) {
      const p = c.properties ?? {};
      const first = p.firstname ?? "";
      const last = p.lastname ?? "";
      const name = (first + " " + last).trim() || null;
      out.set(c.id, {
        id: c.id,
        email: p.email ?? null,
        name,
        job_title: p.jobtitle ?? null,
        last_activity_at: p.notes_last_activity_date ?? null,
        // We don't have a reliable "is primary contact for company" flag
        // from this endpoint; the company side carries hs_primary_contact_id
        // but it's not always populated. Leaving false for now — the UI
        // sorts by recency anyway.
        is_primary: false,
      });
    }
  }
  return out;
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
  const token = await getAccessToken();

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

// ─── Company owner lookup (manual CSM-refresh path) ─────────────────────
//
// The dashboard's `customer_success_manager` field lives in Metabase
// q10600 and is therefore stale for 24-48h after a HubSpot reassignment.
// To shortcut that, `/api/customer-overrides/refresh-csm` calls
// fetchHubspotCompanyOwner() for a single company on demand and writes
// the override into KV. See:
//   - src/lib/data/customer-overrides.ts (override shape)
//   - src/app/api/customer-overrides/refresh-csm/route.ts (caller)

/**
 * HubSpot owner record. Returned by /crm/v3/owners/{id}. We surface only
 * the fields the override needs — the dashboard's CSM identifier is the
 * email's local-part (snake-cased) and the email itself is shown
 * inline.
 */
export interface HubspotOwner {
  owner_id: string;
  owner_email: string;
  owner_name: string | null;
}

const OWNER_CACHE_TTL_MS = 10 * 60 * 1000;
const ownerCache = new Map<string, { expires: number; data: HubspotOwner | null }>();

/** Fetch the HubSpot company's `hubspot_owner_id` property, then
 *  resolve that owner via /crm/v3/owners/{id}. Owner objects rarely
 *  change so we cache results for 10 minutes; the override write path
 *  is human-driven (button click) so cache freshness isn't critical.
 *
 *  Returns null when the company has no owner assigned in HubSpot or
 *  the owner can't be resolved. Throws on auth / 5xx errors so the
 *  endpoint caller can surface "HubSpot fetch failed: …" instead of
 *  silently writing a no-op override. */
export async function fetchHubspotCompanyOwner(
  companyId: string
): Promise<HubspotOwner | null> {
  const token = await getAccessToken();

  // Step 1 — read hubspot_owner_id off the company.
  const cmpRes = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=hubspot_owner_id`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (cmpRes.status === 404) return null;
  if (!cmpRes.ok) {
    const body = await cmpRes.text().catch(() => "");
    throw new Error(
      `HubSpot company ${companyId} fetch failed (${cmpRes.status}): ${body.slice(0, 200)}`
    );
  }
  const cmp = (await cmpRes.json()) as {
    properties?: { hubspot_owner_id?: string | null };
  };
  const ownerId = cmp.properties?.hubspot_owner_id?.trim() || null;
  if (!ownerId) return null;

  // Step 2 — resolve owner_id → email + name (cache-hit-friendly).
  const cached = ownerCache.get(ownerId);
  if (cached && cached.expires > Date.now()) return cached.data;

  const ownerRes = await fetch(
    `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(ownerId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (ownerRes.status === 404) {
    ownerCache.set(ownerId, {
      expires: Date.now() + OWNER_CACHE_TTL_MS,
      data: null,
    });
    return null;
  }
  if (!ownerRes.ok) {
    const body = await ownerRes.text().catch(() => "");
    throw new Error(
      `HubSpot owner ${ownerId} fetch failed (${ownerRes.status}): ${body.slice(0, 200)}`
    );
  }
  const o = (await ownerRes.json()) as {
    id?: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  if (!o.email) {
    ownerCache.set(ownerId, {
      expires: Date.now() + OWNER_CACHE_TTL_MS,
      data: null,
    });
    return null;
  }
  const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
  const data: HubspotOwner = {
    owner_id: ownerId,
    owner_email: o.email.toLowerCase(),
    owner_name: name || null,
  };
  ownerCache.set(ownerId, {
    expires: Date.now() + OWNER_CACHE_TTL_MS,
    data,
  });
  return data;
}
