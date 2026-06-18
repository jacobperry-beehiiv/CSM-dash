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

import { isDemoMode } from "../demo/mode";

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
 * Look up HubSpot company records by their Stripe customer ID custom
 * property. This is the *primary* HubSpot join key used by sync.ts —
 * Stripe IDs are stable across HubSpot company merges / record drift
 * in a way that the q10600-sourced `hubspot_company_id` column isn't.
 *
 * Uses POST /crm/v3/objects/companies/search filtering on the
 * STRIPE_PROPERTY constant below. HubSpot caps `IN` filter values at
 * 100 per request, so we chunk the same way the existing batch reads
 * do (BATCH_SIZE = 100, with INTER_BATCH_DELAY_MS pacing).
 *
 * Returns Map<stripeId, HubspotCompanySummary> with each company's
 * HubSpot record ID, name, owner ID, and activity props pre-fetched
 * — folding the work that would otherwise need a follow-up
 * fetchLastActivity() call.
 *
 * Required scopes:
 *   - crm.objects.companies.read
 *   - crm.schemas.companies.read  (specifically for filtering by a
 *     custom property; the read-only paths above don't need this)
 */

/**
 * The HubSpot company-object property that stores the Stripe customer
 * ID. The *internal* name (not the display label) — admins see this
 * as "Stripe Customer ID (SaaS)" in the property editor; HubSpot's
 * API expects the snake-cased / underscore-suffixed slug.
 *
 * To confirm the current value, GET
 * /api/hubspot/check-stripe-property — it lists every company
 * property whose name or label contains "stripe". If this string
 * ever drifts (e.g., admin renames the property), the search returns
 * HTTP 400 "There was a problem with the request" and the resolver
 * stops working until the constant is updated to match.
 */
const STRIPE_PROPERTY = "stripe_customer_id__saas_";

export interface HubspotCompanySummary {
  companyId: string;
  name: string | null;
  ownerId: string | null;
  stripeCustomerId: string;
  activity: CompanyActivity | null;
}

const COMPANY_SEARCH_ENDPOINT =
  "https://api.hubapi.com/crm/v3/objects/companies/search";

interface CompanySearchResponse {
  total: number;
  results: Array<{
    id: string;
    // Loosely typed because the property keys are admin-configurable
    // — STRIPE_PROPERTY can change. Reading by index instead of by a
    // hard-coded key keeps the type honest.
    properties: Record<string, string | null | undefined>;
  }>;
  paging?: { next?: { after?: string } };
}

export async function searchCompaniesByStripeIds(
  stripeIds: string[],
  opts: {
    /**
     * When true, throw on the FIRST batch that errors at the
     * HubSpot API level (non-2xx, non-JSON, etc.). When false
     * (default), log + continue so a single bad batch doesn't kill
     * an entire sync pass.
     *
     * The single-row /resolve-by-stripe endpoint passes true so the
     * UI sees "property not searchable" / "invalid scope" verbatim
     * instead of a vague "no HubSpot company has this Stripe ID."
     * scripts/sync.ts passes false so partial results still land.
     */
    throwOnApiError?: boolean;
  } = {}
): Promise<Map<string, HubspotCompanySummary>> {
  const result = new Map<string, HubspotCompanySummary>();
  const unique = [...new Set(stripeIds.filter(Boolean))];
  if (unique.length === 0) return result;

  const token = await getAccessToken();
  // Properties returned per match. We pull the activity props here
  // too so a sync pass that wants `last_activity_at` doesn't have to
  // call fetchLastActivity() afterward against the same companies.
  const requestedProperties = [
    "name",
    "hubspot_owner_id",
    STRIPE_PROPERTY,
    ...ACTIVITY_PROPS,
  ];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const slice = unique.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    // Use EQ when querying a single Stripe ID — HubSpot accepts IN
    // with a one-element array but EQ is the more natural shape and
    // sidesteps any edge cases in their IN-filter validation. Keep IN
    // for multi-ID batches (sync.ts path).
    const filter =
      slice.length === 1
        ? {
            propertyName: STRIPE_PROPERTY,
            operator: "EQ",
            value: slice[0],
          }
        : {
            propertyName: STRIPE_PROPERTY,
            operator: "IN",
            values: slice,
          };
    const body = {
      filterGroups: [{ filters: [filter] }],
      properties: requestedProperties,
      limit: BATCH_SIZE,
    };

    let res: Response;
    try {
      res = await fetch(COMPANY_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[hubspot] stripe-id search batch ${i / BATCH_SIZE} network error:`,
        msg
      );
      if (opts.throwOnApiError) {
        throw new Error(`HubSpot search network error: ${msg}`);
      }
      continue;
    }

    if (!res.ok) {
      const respBody = await res.text().catch(() => "");
      // 1500-char window for both the thrown message and the log so
      // the full HubSpot error body fits — generic 400s come back
      // without an actionable hint until you can see the request
      // shape, and scope-error 403s list the required scopes after
      // the leading "One or more of the following scopes are
      // required" string that the prior 300-char truncation cut off.
      const msg = `HubSpot search HTTP ${res.status}: ${respBody.slice(0, 1500)}`;
      console.error(
        `[hubspot] stripe-id search batch ${i / BATCH_SIZE} HTTP ${res.status}: ${respBody.slice(0, 1500)}`,
        // Log the request body alongside the response so a 400
        // ("There was a problem with the request") is debuggable
        // without instrumenting the helper a second time. The Stripe
        // IDs aren't secret in this context.
        { request_body: body }
      );
      if (opts.throwOnApiError) throw new Error(msg);
      continue;
    }

    let json: CompanySearchResponse;
    try {
      json = (await res.json()) as CompanySearchResponse;
    } catch (e) {
      const msg = `HubSpot search returned non-JSON body: ${
        e instanceof Error ? e.message : "unknown"
      }`;
      console.error(`[hubspot] stripe-id search batch ${i / BATCH_SIZE}: ${msg}`);
      if (opts.throwOnApiError) throw new Error(msg);
      continue;
    }

    for (const company of json.results ?? []) {
      // Defensive: HubSpot occasionally returns search results with
      // no `properties` object when a property is restricted by
      // user-level visibility settings. Skip those rather than
      // throwing — they couldn't satisfy the Stripe-ID filter
      // anyway, but the response shape isn't guaranteed.
      const properties = company.properties ?? {};
      const stripeId = properties[STRIPE_PROPERTY];
      if (!stripeId) continue;
      const winner = pickLatest(
        properties as Partial<Record<ActivityProp, string | null>>
      );
      result.set(stripeId, {
        companyId: company.id,
        name: properties.name ?? null,
        ownerId: properties.hubspot_owner_id ?? null,
        stripeCustomerId: stripeId,
        activity: winner
          ? {
              last_activity_at: winner.last_activity_at,
              source: winner.source,
            }
          : null,
      });
    }
    // Note: HubSpot's search endpoint paginates at 100. We're
    // chunking input to ≤100 IDs per request so the `IN` filter
    // returns at most 100 matches — pagination doesn't kick in.
    // If the IN-cap rises in the future, walk paging.next.after.
  }

  return result;
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

/**
 * Batch counterpart to fetchHubspotCompanyOwner. Reads
 * `hubspot_owner_id` for every company in `companyIds` via the v3
 * batch endpoint, dedupes the owner IDs that come back, and resolves
 * each owner_id → email via single-owner lookups (HubSpot doesn't
 * expose a batch owners endpoint). Results are merged into one
 * `Map<companyId, HubspotOwner | null>` so the caller can compare
 * each row's HubSpot owner to its current dashboard CSM in one pass.
 *
 * Used by `/api/customer-overrides/refresh-all-csms` to sweep the
 * entire customer book without changing the nightly Metabase
 * snapshot pipeline. Cache reuse with fetchHubspotCompanyOwner: any
 * owner_id already in the per-owner cache is served from there.
 *
 * Skipped: companies HubSpot 404s on, companies with no
 * hubspot_owner_id set, and owners whose lookup fails individually —
 * each lands as `null` in the result map (or absent), letting the
 * caller distinguish "no change" from "no HubSpot data".
 */
export async function fetchHubspotCompanyOwners(
  companyIds: string[]
): Promise<Map<string, HubspotOwner | null>> {
  const result = new Map<string, HubspotOwner | null>();
  const unique = [...new Set(companyIds.filter(Boolean))];
  if (unique.length === 0) return result;
  const token = await getAccessToken();

  // Pass 1: batch-read hubspot_owner_id for every company.
  const companyToOwnerId = new Map<string, string>();
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
          properties: ["hubspot_owner_id"],
          inputs: slice.map((id) => ({ id })),
        }),
      });
    } catch (e) {
      console.error(
        `[hubspot] owner batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] owner batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      continue;
    }
    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        properties?: { hubspot_owner_id?: string | null };
      }>;
    };
    for (const company of json.results ?? []) {
      const ownerId = company.properties?.hubspot_owner_id?.trim() || null;
      if (ownerId) {
        companyToOwnerId.set(company.id, ownerId);
      } else {
        // Explicit null in the result — distinguishes "unassigned" from
        // "wasn't queried". Callers can leave the dashboard's snapshot
        // value alone in this case.
        result.set(company.id, null);
      }
    }
  }

  // Pass 2: resolve each unique owner_id → email + name. Pure
  // sequential calls because HubSpot has no batch owners read; the
  // per-owner cache hides repeat reads when many companies share the
  // same owner (which is exactly the beehiiv CSM rollup shape).
  const uniqueOwnerIds = [...new Set(companyToOwnerId.values())];
  const ownerById = new Map<string, HubspotOwner | null>();
  for (const ownerId of uniqueOwnerIds) {
    const cached = ownerCache.get(ownerId);
    if (cached && cached.expires > Date.now()) {
      ownerById.set(ownerId, cached.data);
      continue;
    }
    try {
      const ownerRes = await fetch(
        `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(ownerId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (ownerRes.status === 404) {
        ownerById.set(ownerId, null);
        ownerCache.set(ownerId, {
          expires: Date.now() + OWNER_CACHE_TTL_MS,
          data: null,
        });
        continue;
      }
      if (!ownerRes.ok) {
        // Treat as transient — don't poison the cache so the next
        // sweep can retry.
        ownerById.set(ownerId, null);
        continue;
      }
      const o = (await ownerRes.json()) as {
        email?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      };
      if (!o.email) {
        ownerById.set(ownerId, null);
        ownerCache.set(ownerId, {
          expires: Date.now() + OWNER_CACHE_TTL_MS,
          data: null,
        });
        continue;
      }
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
      const data: HubspotOwner = {
        owner_id: ownerId,
        owner_email: o.email.toLowerCase(),
        owner_name: name || null,
      };
      ownerById.set(ownerId, data);
      ownerCache.set(ownerId, {
        expires: Date.now() + OWNER_CACHE_TTL_MS,
        data,
      });
    } catch (e) {
      console.error(
        `[hubspot] owner ${ownerId} fetch error:`,
        e instanceof Error ? e.message : e
      );
      ownerById.set(ownerId, null);
    }
    // Light pacing — owners are typically <50 records, so we don't
    // need the full BATCH_SIZE machinery, but a brief breather keeps
    // us well under HubSpot's 100-req-per-10s quota when run alongside
    // other integrations on the same portal.
    await sleep(20);
  }

  // Stitch: for every company that had an owner_id, fold the resolved
  // owner object back into the result map by companyId.
  for (const [companyId, ownerId] of companyToOwnerId) {
    result.set(companyId, ownerById.get(ownerId) ?? null);
  }
  return result;
}

/**
 * Batch counterpart to fetchHubspotCompanyCsm. Reads the
 * `customer_success_manager` custom property (NOT the standard
 * hubspot_owner_id) on every company in `companyIds`, then resolves
 * each unique CSM owner_id → email + name. Identical pacing /
 * batching as fetchHubspotCompanyOwners.
 *
 * Used by /api/customer-overrides/refresh-all-csms. The "all CSMs"
 * sweep historically called fetchHubspotCompanyOwners and wrote the
 * standard Owner as the dashboard's CSM — which silently re-filed
 * accounts under whoever held the HubSpot Owner field (the AE on
 * many Enterprise deals) instead of the actual CSM. This fixes that
 * at the source: now the sweep reads the CSM-specific property.
 */
export async function fetchHubspotCompanyCsms(
  companyIds: string[]
): Promise<Map<string, HubspotOwner | null>> {
  const result = new Map<string, HubspotOwner | null>();
  const unique = [...new Set(companyIds.filter(Boolean))];
  if (unique.length === 0) return result;
  const token = await getAccessToken();

  // Pass 1: batch-read customer_success_manager (owner_id enum) +
  // owner_email__csm_ (string) for every company.
  const companyToCsmOwnerId = new Map<string, string>();
  const companyToCsmEmail = new Map<string, string>();
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
          properties: ["customer_success_manager", "owner_email__csm_"],
          inputs: slice.map((id) => ({ id })),
        }),
      });
    } catch (e) {
      console.error(
        `[hubspot] csm batch ${i / BATCH_SIZE} network error:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[hubspot] csm batch ${i / BATCH_SIZE} HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      continue;
    }
    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        properties?: {
          customer_success_manager?: string | null;
          owner_email__csm_?: string | null;
        };
      }>;
    };
    for (const company of json.results ?? []) {
      const csmOwnerId =
        company.properties?.customer_success_manager?.trim() || null;
      const csmEmail =
        company.properties?.owner_email__csm_?.trim().toLowerCase() || null;
      if (csmOwnerId) {
        companyToCsmOwnerId.set(company.id, csmOwnerId);
        if (csmEmail) companyToCsmEmail.set(company.id, csmEmail);
      } else {
        result.set(company.id, null);
      }
    }
  }

  // Pass 2: resolve each unique CSM owner_id → email + name. Same
  // sequential lookup + cache as fetchHubspotCompanyOwners (no
  // batch-owners endpoint on HubSpot's side).
  const uniqueOwnerIds = [...new Set(companyToCsmOwnerId.values())];
  const ownerById = new Map<string, HubspotOwner | null>();
  for (const ownerId of uniqueOwnerIds) {
    const cached = ownerCache.get(ownerId);
    if (cached && cached.expires > Date.now()) {
      ownerById.set(ownerId, cached.data);
      continue;
    }
    try {
      const ownerRes = await fetch(
        `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(ownerId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (ownerRes.status === 404) {
        ownerById.set(ownerId, null);
        ownerCache.set(ownerId, {
          expires: Date.now() + OWNER_CACHE_TTL_MS,
          data: null,
        });
        continue;
      }
      if (!ownerRes.ok) {
        ownerById.set(ownerId, null);
        continue;
      }
      const o = (await ownerRes.json()) as {
        email?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      };
      if (!o.email) {
        ownerById.set(ownerId, null);
        ownerCache.set(ownerId, {
          expires: Date.now() + OWNER_CACHE_TTL_MS,
          data: null,
        });
        continue;
      }
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
      const data: HubspotOwner = {
        owner_id: ownerId,
        owner_email: o.email.toLowerCase(),
        owner_name: name || null,
      };
      ownerById.set(ownerId, data);
      ownerCache.set(ownerId, {
        expires: Date.now() + OWNER_CACHE_TTL_MS,
        data,
      });
    } catch (e) {
      console.error(
        `[hubspot] csm owner ${ownerId} fetch error:`,
        e instanceof Error ? e.message : e
      );
      ownerById.set(ownerId, null);
    }
    await sleep(20);
  }

  // Stitch: per-company → resolved CSM. Prefer the company's
  // owner_email__csm_ string property when set (canonical CSM email);
  // fall back to the owner record's primary email.
  for (const [companyId, ownerId] of companyToCsmOwnerId) {
    const base = ownerById.get(ownerId);
    if (!base) {
      result.set(companyId, null);
      continue;
    }
    const csmEmail = companyToCsmEmail.get(companyId) ?? base.owner_email;
    result.set(companyId, {
      owner_id: base.owner_id,
      owner_email: csmEmail,
      owner_name: base.owner_name,
    });
  }
  return result;
}

// ─── Write helpers ────────────────────────────────────────────────────
//
// Used by the Slack-driven `/update-csm` slash command (and any future
// "edit HubSpot from Slack" flows). All write paths require additional
// HubSpot scopes beyond the read-only set the snapshot pipeline uses:
//
//   - crm.objects.companies.write  (for patchHubspotCompanyProperties)
//   - crm.objects.owners.read       (for listHubspotOwners — read-only,
//                                   already required by the existing
//                                   fetchHubspotCompanyOwner code path)

/**
 * List every active HubSpot owner. Paged via the v3 owners endpoint
 * with `limit=100`, walking `paging.next.after` until exhausted.
 * Cached for 10 minutes — owner lists rarely change minute-to-minute
 * and the Slack modal opens are bursty (one CSM clicks a slash command,
 * the modal needs the full list once). Returns the full list sorted by
 * name + email for stable rendering in dropdowns.
 */
let ownerListCache: { expires: number; data: HubspotOwner[] } | null = null;
const OWNER_LIST_TTL_MS = 10 * 60 * 1000;

export async function listHubspotOwners(): Promise<HubspotOwner[]> {
  if (ownerListCache && ownerListCache.expires > Date.now()) {
    return ownerListCache.data;
  }
  const token = await getAccessToken();
  const collected: HubspotOwner[] = [];
  let after: string | undefined;
  // Cap pagination defensively — beehiiv has <100 owners; if HubSpot
  // returns absurd amounts something's wrong and we'd rather bail
  // than loop forever.
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/owners?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HubSpot owners list failed (${res.status}): ${body.slice(0, 200)}`
      );
    }
    const json = (await res.json()) as {
      results?: Array<{
        id?: string;
        email?: string | null;
        firstName?: string | null;
        lastName?: string | null;
        archived?: boolean;
      }>;
      paging?: { next?: { after?: string } };
    };
    for (const o of json.results ?? []) {
      if (o.archived) continue;
      if (!o.id || !o.email) continue;
      const name = [o.firstName, o.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      collected.push({
        owner_id: o.id,
        owner_email: o.email.toLowerCase(),
        owner_name: name || null,
      });
    }
    after = json.paging?.next?.after;
    if (!after) break;
  }
  collected.sort((a, b) => {
    const an = a.owner_name ?? a.owner_email;
    const bn = b.owner_name ?? b.owner_email;
    return an.localeCompare(bn);
  });
  ownerListCache = {
    expires: Date.now() + OWNER_LIST_TTL_MS,
    data: collected,
  };
  return collected;
}

/**
 * PATCH arbitrary properties on a HubSpot company. Used by the Slack
 * `/update-csm` flow (sets `hubspot_owner_id`) and any future "edit
 * HubSpot from Slack" flows that drop in via the views.ts dispatcher.
 *
 * Throws on non-2xx so the caller can surface a specific failure
 * message back to Slack (response_action="errors" lights up the
 * field-level error inline in the modal).
 */
/**
 * Resolve a HubSpot deal to its associated company IDs via the
 * v3 associations endpoint:
 *   GET /crm/v3/objects/deals/{dealId}/associations/companies
 * → { results: [{ id, type }, ...] }
 *
 * Returns the array of associated company IDs in association order
 * (HubSpot's own order, typically primary first). Empty array when
 * the deal exists but has no company associations. Null on 404 so
 * the caller can surface "no such deal" cleanly.
 */
export async function fetchDealAssociatedCompanyIds(
  dealId: string
): Promise<string[] | null> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/companies`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HubSpot deal ${dealId} associations fetch failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    results?: Array<{ id?: string }>;
  };
  return (json.results ?? [])
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Lightweight company GET — returns `{ id, name }` + any extra
 * properties the caller passes in `properties[]`. Used by the
 * Slack @bot assign flow to confirm a pasted company URL/ID before
 * issuing the PATCH (and to grab the company name for the Drive
 * folder + confirmation message). Returns null on 404 so the caller
 * can surface a "no such company" error inline rather than a stack
 * trace.
 */
/**
 * Read the CSM-team custom property on a HubSpot company. This is a
 * SEPARATE field from `hubspot_owner_id` (HubSpot's standard
 * "Company owner"). Historically the dashboard's "Refresh CSM"
 * button called `fetchHubspotCompanyOwner` which read the standard
 * owner — but those two fields routinely diverge for Enterprise
 * accounts (Owner = AE/Sales for renewal reasons, CSM = the assigned
 * customer-success person). Sourcing CSM from the standard owner
 * silently mis-files accounts under the wrong person in the
 * dashboard.
 *
 * Reads two properties:
 *   • customer_success_manager   — enumeration of owner_ids; the
 *     value is one of the HubSpot owner IDs. Resolved to {email, name}
 *     by looking up the owner record.
 *   • owner_email__csm_          — string property carrying the
 *     CSM's email directly (q10600 aliases this as
 *     `customer_success_manager_email`).
 *
 * Returns null when the company isn't found OR when neither property
 * is populated (no CSM is assigned). 404 → null; other errors throw
 * so the caller can surface a clear message.
 */
export async function fetchHubspotCompanyCsm(
  companyId: string
): Promise<HubspotOwner | null> {
  const token = await getAccessToken();
  const cmpRes = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=customer_success_manager,owner_email__csm_`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (cmpRes.status === 404) return null;
  if (!cmpRes.ok) {
    const body = await cmpRes.text().catch(() => "");
    throw new Error(
      `HubSpot company ${companyId} CSM fetch failed (${cmpRes.status}): ${body.slice(0, 200)}`
    );
  }
  const cmp = (await cmpRes.json()) as {
    properties?: {
      customer_success_manager?: string | null;
      owner_email__csm_?: string | null;
    };
  };
  const csmOwnerId = cmp.properties?.customer_success_manager?.trim() || null;
  const csmEmailFromProp =
    cmp.properties?.owner_email__csm_?.trim().toLowerCase() || null;
  if (!csmOwnerId) return null;

  // Resolve owner_id → name via the same cache fetchHubspotCompanyOwner
  // uses. Both CSM and standard-owner reads share the owners table.
  const cached = ownerCache.get(csmOwnerId);
  if (cached && cached.expires > Date.now()) {
    const c = cached.data;
    return c
      ? {
          owner_id: c.owner_id,
          // Prefer the dedicated CSM email property when set; fall
          // back to the owner record's primary email. Both should
          // match in practice but the property is the canonical
          // CSM-side identifier.
          owner_email: csmEmailFromProp ?? c.owner_email,
          owner_name: c.owner_name,
        }
      : null;
  }

  const ownerRes = await fetch(
    `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(csmOwnerId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (ownerRes.status === 404) {
    ownerCache.set(csmOwnerId, {
      expires: Date.now() + OWNER_CACHE_TTL_MS,
      data: null,
    });
    return null;
  }
  if (!ownerRes.ok) {
    const body = await ownerRes.text().catch(() => "");
    throw new Error(
      `HubSpot owner ${csmOwnerId} fetch failed (${ownerRes.status}): ${body.slice(0, 200)}`
    );
  }
  const o = (await ownerRes.json()) as {
    id?: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  const baseEmail = o.email?.toLowerCase() ?? null;
  if (!baseEmail && !csmEmailFromProp) {
    ownerCache.set(csmOwnerId, {
      expires: Date.now() + OWNER_CACHE_TTL_MS,
      data: null,
    });
    return null;
  }
  const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
  const data: HubspotOwner = {
    owner_id: csmOwnerId,
    owner_email: csmEmailFromProp ?? baseEmail!,
    owner_name: name || null,
  };
  ownerCache.set(csmOwnerId, {
    expires: Date.now() + OWNER_CACHE_TTL_MS,
    data,
  });
  return data;
}

export async function fetchHubspotCompany(
  companyId: string,
  properties: string[] = ["name"]
): Promise<{ id: string; name: string | null; properties: Record<string, string | null> } | null> {
  const token = await getAccessToken();
  const url = new URL(
    `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}`
  );
  url.searchParams.set("properties", properties.join(","));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HubSpot company ${companyId} fetch failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    id: string;
    properties?: Record<string, string | null>;
  };
  const props = json.properties ?? {};
  return {
    id: json.id,
    name: props.name ?? null,
    properties: props,
  };
}

export async function patchHubspotCompanyProperties(
  companyId: string,
  properties: Record<string, string | number | boolean | null>
): Promise<void> {
  // Demo-mode write guard — never touch real HubSpot from a screenshot
  // session. Log the attempted patch for debugging visibility.
  if (isDemoMode()) {
    console.log(
      `[demo-mode] suppressed HubSpot PATCH on company ${companyId}:`,
      properties
    );
    return;
  }
  const token = await getAccessToken();
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HubSpot company ${companyId} PATCH failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  // Cache busting note: `ownerCache` is keyed by ownerId, not companyId,
  // so a PATCH that changes a company's owner_id doesn't strand stale
  // data — the next fetchHubspotCompanyOwner() call re-reads the
  // company row and looks up the new owner (whose cached profile is
  // still valid). No bust needed.
}

/**
 * Create a HubSpot Note engagement associated with a company. Used by
 * the dashboard's CompanyNotes section to mirror a note into HubSpot
 * so the timeline on the company record stays in sync with the
 * dashboard scratchpad.
 *
 *   POST /crm/v3/objects/notes
 *
 * Body: {
 *   properties: {
 *     hs_note_body:   <html-or-text body>,
 *     hs_timestamp:   <epoch ms or ISO — when the note "happened">,
 *     hubspot_owner_id?: <owner_id, when we want the note attributed>
 *   },
 *   associations: [{ to: { id }, types: [{...note-to-company}] }]
 * }
 *
 * Returns the new note's HubSpot id. Throws on non-2xx so the caller
 * can surface a specific message to the user.
 *
 * Required HubSpot Private App scope: `crm.objects.notes.write`. The
 * existing read scopes (`crm.objects.companies.read`,
 * `crm.objects.notes.read`) aren't sufficient for this; the dashboard
 * settings page checklist calls this out.
 */
export async function createHubspotCompanyNote(
  companyId: string,
  body: string,
  opts?: { timestamp?: string; hubspotOwnerId?: string }
): Promise<{ id: string }> {
  const token = await getAccessToken();
  // hs_timestamp accepts either epoch ms (number) or ISO string. ISO
  // is friendlier to read in logs; HubSpot parses both.
  const ts = opts?.timestamp ?? new Date().toISOString();
  // typeId 190 = note-to-company association (HubSpot v4 association
  // category id). We hardcode this rather than calling the schema
  // endpoint every time — note→company doesn't change shape.
  const associationTypeId = 190;
  const payload = {
    properties: {
      hs_note_body: body,
      hs_timestamp: ts,
      ...(opts?.hubspotOwnerId
        ? { hubspot_owner_id: opts.hubspotOwnerId }
        : {}),
    },
    associations: [
      {
        to: { id: companyId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId,
          },
        ],
      },
    ],
  };
  const res = await fetch(
    "https://api.hubapi.com/crm/v3/objects/notes",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HubSpot note create failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const j = (await res.json()) as { id?: string };
  if (!j.id) {
    throw new Error("HubSpot note create returned no id");
  }
  return { id: j.id };
}
