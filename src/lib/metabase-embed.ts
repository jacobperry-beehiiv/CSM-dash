import jwt from "jsonwebtoken";

/**
 * Metabase Signed Embedding client
 * ---------------------------------
 * For use when an API key isn't available. Requires:
 *   1. METABASE_URL
 *   2. METABASE_EMBEDDING_SECRET_KEY — shared signing key from a Metabase
 *      admin (Admin → Settings → Embedding → Embedding secret key).
 *   3. The target question or dashboard is flagged as "Embeddable" in its
 *      settings page inside Metabase, and any parameters we pass are
 *      declared as Embedding Parameters.
 *   4. This app's deployed origin is added to "Allowed origins" in the
 *      same Embedding settings page.
 *
 * Unlike API keys, signed embeds DO NOT support arbitrary native SQL —
 * only saved questions/dashboards that an admin has enabled. For engines
 * that run native queries (deliverability / ad-gap) we need those queries
 * to live in Metabase as saved questions with template-tag parameters.
 */

const METABASE_URL = process.env.METABASE_URL;
const EMBED_SECRET = process.env.METABASE_EMBEDDING_SECRET_KEY;

function requireConfig(): { url: string; secret: string } {
  if (!METABASE_URL) throw new Error("Missing METABASE_URL");
  if (!EMBED_SECRET) {
    throw new Error(
      "Missing METABASE_EMBEDDING_SECRET_KEY — ask a Metabase admin for the Embedding secret key (Admin → Settings → Embedding)."
    );
  }
  return { url: METABASE_URL, secret: EMBED_SECRET };
}

export type EmbedResource =
  | { question: number }
  | { dashboard: number };

export interface EmbedTokenOptions {
  /** Parameters to pass to the embedded question. Only parameters the admin
   *  has marked as "locked" or "enabled" in the question's Embedding tab
   *  will be accepted. */
  params?: Record<string, string | number | boolean | null>;
  /** Token expiry in seconds from now. Default 600 (10 min). */
  ttlSeconds?: number;
}

export function signEmbedToken(
  resource: EmbedResource,
  opts: EmbedTokenOptions = {}
): string {
  const { secret } = requireConfig();
  const payload = {
    resource,
    params: opts.params ?? {},
    exp: Math.round(Date.now() / 1000) + (opts.ttlSeconds ?? 600),
  };
  return jwt.sign(payload, secret);
}

/**
 * Build the iframe URL for embedding a question visually.
 * Example: <iframe src={embedIframeUrl({ question: 10600 })} />
 */
export function embedIframeUrl(
  resource: EmbedResource,
  opts: EmbedTokenOptions & { bordered?: boolean; titled?: boolean; theme?: "light" | "night" | "transparent" } = {}
): string {
  const { url } = requireConfig();
  const token = signEmbedToken(resource, opts);
  const path = "question" in resource ? "question" : "dashboard";
  const hash = new URLSearchParams({
    bordered: String(opts.bordered ?? true),
    titled: String(opts.titled ?? true),
    ...(opts.theme ? { theme: opts.theme } : {}),
  }).toString();
  return `${url}/embed/${path}/${token}#${hash}`;
}

/**
 * Fetch the data of an embedded question as JSON rows.
 * Uses /api/embed/card/:token/query/json — returns an array of objects.
 */
export async function runEmbeddedQuestion(
  questionId: number,
  params: Record<string, string | number | boolean | null> = {}
): Promise<Record<string, unknown>[]> {
  const { url } = requireConfig();
  const token = signEmbedToken({ question: questionId }, { params });
  const res = await fetch(`${url}/api/embed/card/${token}/query/json`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Metabase embed query failed: ${res.status} ${body.slice(0, 300)}`
    );
  }
  return res.json();
}
