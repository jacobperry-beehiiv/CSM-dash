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
