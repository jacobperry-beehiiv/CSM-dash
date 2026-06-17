const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const METABASE_SESSION_TOKEN = process.env.METABASE_SESSION_TOKEN;
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;

/**
 * Auth strategy (checked in order):
 *   1. METABASE_API_KEY — preferred. Works for any user including Google SSO.
 *      Requires admin access to create (Admin → Authentication → API Keys).
 *   2. METABASE_SESSION_TOKEN — copy the `metabase.SESSION` cookie value from
 *      your logged-in browser. Works for SSO accounts without admin rights,
 *      but expires every ~14 days and must be refreshed manually.
 *   3. METABASE_USERNAME + METABASE_PASSWORD — legacy fallback. Doesn't work
 *      for SSO-only accounts (no password exists).
 */

let sessionToken: string | null = null;
let sessionExpiresAt = 0;

function baseUrl(): string {
  if (!METABASE_URL) {
    throw new Error("Missing METABASE_URL — set it in .env.local");
  }
  return METABASE_URL;
}

async function getSession(): Promise<string> {
  if (sessionToken && Date.now() < sessionExpiresAt) return sessionToken;
  if (!METABASE_USERNAME || !METABASE_PASSWORD) {
    throw new Error(
      "Missing credentials — set METABASE_API_KEY, METABASE_SESSION_TOKEN, or METABASE_USERNAME + METABASE_PASSWORD"
    );
  }

  const res = await fetch(`${baseUrl()}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: METABASE_USERNAME,
      password: METABASE_PASSWORD,
    }),
  });
  if (!res.ok) {
    throw new Error(`Metabase auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  sessionToken = data.id;
  sessionExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
  return sessionToken!;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (METABASE_API_KEY) {
    return { "X-API-Key": METABASE_API_KEY };
  }
  if (METABASE_SESSION_TOKEN) {
    return { "X-Metabase-Session": METABASE_SESSION_TOKEN };
  }
  return { "X-Metabase-Session": await getSession() };
}

async function metabaseFetch(path: string, options: RequestInit = {}) {
  const doFetch = async () => {
    const auth = await authHeaders();
    return fetch(`${baseUrl()}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        ...auth,
        "Content-Type": "application/json",
      },
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    if (METABASE_API_KEY) {
      throw new Error("Metabase API key rejected (401) — verify the key is still active.");
    }
    if (METABASE_SESSION_TOKEN) {
      throw new Error(
        "Metabase session token rejected (401) — it has likely expired. Copy a fresh `metabase.SESSION` cookie value into METABASE_SESSION_TOKEN."
      );
    }
    // Username/password flow — clear cache and retry once
    sessionToken = null;
    sessionExpiresAt = 0;
    res = await doFetch();
  }
  if (!res.ok) {
    throw new Error(`Metabase request failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function runSavedQuestion(
  questionId: number,
  params?: Record<string, string | number>
): Promise<Record<string, unknown>[]> {
  // If embedding secret is configured, prefer that path — no user auth needed.
  if (process.env.METABASE_EMBEDDING_SECRET_KEY) {
    const { runEmbeddedQuestion } = await import("./metabase-embed");
    return runEmbeddedQuestion(questionId, params);
  }

  const body: Record<string, unknown> = {};
  if (params && Object.keys(params).length > 0) {
    body.parameters = Object.entries(params).map(([k, v]) => ({
      type: "category",
      target: ["variable", ["template-tag", k]],
      value: v,
    }));
  }
  const res = await metabaseFetch(`/api/card/${questionId}/query/json`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function runNativeQuery(
  databaseId: number,
  query: string
): Promise<Record<string, unknown>[]> {
  const res = await metabaseFetch("/api/dataset", {
    method: "POST",
    body: JSON.stringify({
      database: databaseId,
      type: "native",
      native: { query },
    }),
  });
  const data = await res.json();
  if (data?.status === "failed") {
    throw new Error(`Metabase query failed: ${data.error ?? "unknown"}`);
  }
  const cols: string[] = data.data.cols.map((c: { name: string }) => c.name);
  return data.data.rows.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

// ─── Database IDs ─────────────────────────────────────────────────────────
// 2   = Swarm Production Replica (Postgres) — use for org/pub/ad_network/subs
// 100 = Swarm Main ClickHouse — DO NOT use for fact_sendables joins (timeout)
// 199 = ClickHouse Ad Hoc — use for deliverability split queries
export const DB = {
  POSTGRES: 2,
  CLICKHOUSE_MAIN: 100,
  CLICKHOUSE_ADHOC: 199,
} as const;

// ─── QBR Charts helpers ───────────────────────────────────────────────────
//
// Three small helpers used by /api/qbr-charts:
//   • runCard()         — generic question runner with parameter
//                         introspection (maps our standard inputs
//                         like organizationId to whichever slug the
//                         question declares).
//   • describeCard()    — fetch a question's parameter schema so the
//                         UI can render ExtraParams when a question
//                         needs values outside the standard map.
//   • searchQuestions() — fuzzy search across saved questions for
//                         the "Find more charts" panel.
//   • MissingParamsError — thrown by runCard when a question
//                         requires a parameter we don't have a
//                         value for. The route catches it and
//                         surfaces missingParams to the UI.
//
// All three use the same auth path (authHeaders + metabaseFetch) as
// runSavedQuestion — no new auth wiring.

/** Standard input → which Metabase parameter slug we'll try (in order
 *  per name; case-insensitive matching against the question's
 *  declared slugs). */
const STANDARD_PARAM_ALIASES: Record<string, string[]> = {
  organizationId: ["organization_id", "org_id", "workspace_id"],
  publicationId: ["publication_id", "pub_id"],
  startMonth: ["start_month_filter", "start_date", "since", "from"],
  endMonth: ["stop_month_filter", "end_date", "until", "to"],
};

export interface MetabaseColumnRaw {
  name: string;
  display_name?: string;
  base_type?: string;
  effective_type?: string;
  semantic_type?: string;
}

export interface MetabaseParameter {
  slug: string;
  name?: string;
  type?: string;
  required?: boolean;
  /** Some questions declare default values; if set, the param is
   *  effectively optional even when `required` is true. */
  default?: unknown;
}

export interface RunCardOutput {
  questionId: number;
  questionName: string;
  columns: MetabaseColumnRaw[];
  rows: Record<string, unknown>[];
}

export class MissingParamsError extends Error {
  missingParams: Array<{ slug: string; name?: string; type?: string }>;
  constructor(
    missing: Array<{ slug: string; name?: string; type?: string }>
  ) {
    super(
      `Missing required parameters: ${missing.map((m) => m.slug).join(", ")}`
    );
    this.name = "MissingParamsError";
    this.missingParams = missing;
  }
}

/**
 * Fetch a card's metadata + parameter schema. Used by the UI to know
 * what extra inputs to render when a question needs values outside
 * the standard map.
 *
 * In-process cache: card schemas rarely change (a question's
 * parameter list only changes when an admin edits the question in
 * Metabase). Caching for the lifetime of the serverless isolate
 * means a CSM clicking through 5 charts in a row only pays the
 * describe round-trip once instead of 5x. TTL is set conservatively
 * — 5 min — so a Metabase edit picks up within minutes without a
 * deploy.
 */
interface CachedCard {
  id: number;
  name: string;
  parameters: MetabaseParameter[];
  expires_at: number;
}
const CARD_CACHE = new Map<number, CachedCard>();
const CARD_CACHE_TTL_MS = 5 * 60 * 1000;

export async function describeCard(questionId: number): Promise<{
  id: number;
  name: string;
  parameters: MetabaseParameter[];
}> {
  const cached = CARD_CACHE.get(questionId);
  if (cached && cached.expires_at > Date.now()) {
    return {
      id: cached.id,
      name: cached.name,
      parameters: cached.parameters,
    };
  }
  const res = await metabaseFetch(`/api/card/${questionId}`);
  const json = (await res.json()) as {
    id: number;
    name: string;
    parameters?: MetabaseParameter[];
  };
  const result = {
    id: json.id,
    name: json.name,
    parameters: json.parameters ?? [],
  };
  CARD_CACHE.set(questionId, {
    ...result,
    expires_at: Date.now() + CARD_CACHE_TTL_MS,
  });
  return result;
}

/**
 * Search saved questions by free-text query. Powers the "Find more
 * charts" panel (PR C). Returns id + name + description.
 */
export async function searchQuestions(
  q: string
): Promise<Array<{ id: number; name: string; description?: string }>> {
  const params = new URLSearchParams({ q, models: "card" });
  const res = await metabaseFetch(`/api/search?${params.toString()}`);
  const json = (await res.json()) as {
    data?: Array<{ id: number; name: string; description?: string; model?: string }>;
  };
  return (json.data ?? [])
    .filter((d) => d.model === "card")
    .map((d) => ({ id: d.id, name: d.name, description: d.description }));
}

/**
 * Generic question runner. Introspects the question's parameter
 * schema, maps our standard inputs (organizationId, publicationId,
 * startMonth, endMonth) to whichever slugs the question declares,
 * plus any user-supplied `extras` for non-standard params. Throws
 * MissingParamsError when a required slug has no value we can fill.
 */
export async function runCard(
  questionId: number,
  ctx: {
    organizationId?: string;
    publicationId?: string;
    startMonth?: string;
    endMonth?: string;
    extras?: Record<string, string>;
  }
): Promise<RunCardOutput> {
  const card = await describeCard(questionId);
  const declaredSlugs = new Set(card.parameters.map((p) => p.slug));

  // Build the slug → value mapping. For each standard input we have
  // a value for, walk the alias list and use whichever one the
  // question actually declares.
  const provided: Record<string, string> = {};
  const standardCtx: Record<string, string | undefined> = {
    organizationId: ctx.organizationId,
    publicationId: ctx.publicationId,
    startMonth: ctx.startMonth,
    endMonth: ctx.endMonth,
  };
  for (const [stdKey, aliases] of Object.entries(STANDARD_PARAM_ALIASES)) {
    const value = standardCtx[stdKey];
    if (!value) continue;
    for (const slug of aliases) {
      if (declaredSlugs.has(slug)) {
        provided[slug] = value;
        break;
      }
    }
  }
  // Layer in user-supplied extras for non-standard params. Only
  // honor extras the question actually declares — silently dropping
  // unknown slugs keeps the UI tolerant of typos.
  for (const [slug, value] of Object.entries(ctx.extras ?? {})) {
    if (declaredSlugs.has(slug) && value) provided[slug] = value;
  }

  // Look for required params we haven't filled and don't have a
  // default for. If any, throw with the list so the route can
  // surface a 422.
  const missing = card.parameters
    .filter((p) => p.required && p.default === undefined && !(p.slug in provided))
    .map((p) => ({ slug: p.slug, name: p.name, type: p.type }));
  if (missing.length > 0) throw new MissingParamsError(missing);

  // POST /api/card/:id/query (NOT /query/json — we want the raw
  // shape with cols metadata so the heuristic can read base_type).
  //
  // Metabase's per-card cache is configured on the Card model itself
  // (admin → question → caching), not as a per-request body field.
  // Sending cache_ttl here is silently ignored. Card-level caching
  // for the heaviest QBR questions should be set in Metabase admin;
  // app-side caching is layered above this in describeCard().
  const params: Record<string, unknown> = {};
  if (Object.keys(provided).length > 0) {
    params.parameters = Object.entries(provided).map(([slug, value]) => ({
      type: "category",
      target: ["variable", ["template-tag", slug]],
      value,
    }));
  }
  const res = await metabaseFetch(`/api/card/${questionId}/query`, {
    method: "POST",
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as {
    status?: string;
    error?: string;
    data?: {
      cols?: MetabaseColumnRaw[];
      rows?: unknown[][];
    };
  };
  if (json.status === "failed") {
    throw new Error(`Metabase query failed: ${json.error ?? "unknown"}`);
  }
  const cols: MetabaseColumnRaw[] = json.data?.cols ?? [];
  const rawRows: unknown[][] = json.data?.rows ?? [];
  const rows: Record<string, unknown>[] = rawRows.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      obj[c.name] = row[i];
    });
    return obj;
  });
  return {
    questionId,
    questionName: card.name,
    columns: cols,
    rows,
  };
}
