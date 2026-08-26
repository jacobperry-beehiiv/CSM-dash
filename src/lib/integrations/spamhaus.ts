/**
 * Spamhaus DBL (Domain Block List) lookup — used by the D&C Upgrade
 * Analysis engine's Network & History pillar to flag customer
 * publications whose sending domain is on Spamhaus's blocklist.
 *
 * How it works
 * ------------
 * A DNS `A` query for `<domain>.dbl.spamhaus.org` returns a
 * 127.0.1.x address when the domain is listed, or NXDOMAIN when it
 * isn't. The last octet identifies the listing category:
 *
 *   127.0.1.2   spam
 *   127.0.1.4   phish
 *   127.0.1.5   malware
 *   127.0.1.6   botnet C&C
 *   127.0.1.24  spammed redirector
 *   127.0.1.25  spammed redirector (special)
 *   127.0.1.26  spammed redirector (abused)
 *   127.0.1.102 abused legit spam
 *   127.0.1.103 abused legit spammed redirector
 *   127.0.1.104 abused legit phish
 *   127.0.1.105 abused legit malware
 *   127.0.1.106 abused legit botnet C&C
 *   127.0.1.255 typing error — the DNS response indicates a bad query
 *
 * We don't need to enumerate every code: any 127.0.1.x answer counts
 * as "listed" for scorecard purposes. The category label is best-
 * effort so the CSM sees why (spam vs botnet drives different
 * remediation).
 *
 * Rate-limit posture
 * ------------------
 * Spamhaus's free DNSBL is IP-throttled and their TOS restricts
 * commercial high-volume use. Our footprint is small (a handful of
 * scans per day, ≤ 3 domains each), and the scan result is persisted
 * in KV so a re-open doesn't re-query. Force-refresh a scan to
 * re-query.
 *
 * Every failure mode returns `status: "unknown"` — the caller
 * treats "unknown" as amber, not red, so a Vercel egress-IP block or
 * a DNS timeout can't flip a customer's verdict to hold on its own.
 *
 * DQS upgrade path
 * ----------------
 * If we ever hit real rate limits, Spamhaus's Data Query Service
 * (DQS) exposes the same signals via HTTP with a per-account key
 * and explicit commercial-use permission. Adding a `SPAMHAUS_DQS_KEY`
 * env var + a fetch fallback here is a straight follow-up. Not
 * needed at current volume.
 */

import { promises as dns } from "node:dns";

export type SpamhausStatus = "clean" | "listed" | "unknown";

export type SpamhausCategory =
  | "spam"
  | "phish"
  | "malware"
  | "botnet"
  | "redirector"
  | "abused_legit"
  | "bad_query"
  | "unknown";

export interface SpamhausCheck {
  /** The lowercased, IDN-normalized domain that was queried. */
  domain: string;
  status: SpamhausStatus;
  /** Raw 127.0.1.x code when listed; null otherwise. */
  code: string | null;
  /** Human-readable category so the CSM sees why it's listed. */
  category: SpamhausCategory | null;
  /** When `status === "unknown"`, a short reason for the pillar UI
   *  (e.g. "DNS timeout"). Null on success. */
  reason: string | null;
}

/** DNS-lookup timeout. Spamhaus usually resolves in <100ms; a 2s
 *  cap keeps a slow query from stalling the whole scan while still
 *  giving enough headroom that a transient jitter doesn't fail. */
const DNS_TIMEOUT_MS = 2000;

/** Domains we deliberately never check — our own infra (a legit
 *  beehiiv customer's `mail.beehiiv.com` sending subdomain is our
 *  reputation, not theirs; we've been through the delisting process
 *  ourselves) and localhost / private-space hostnames that would
 *  never be on the blocklist anyway. */
const SKIP_SUFFIXES = [
  ".beehiiv.com",
  "beehiiv.com",
  ".localhost",
  "localhost",
];

/** DNS resolver signature — matches `dns.promises.resolve4`. Exposed
 *  as an optional argument so tests can inject a mock without
 *  monkey-patching the built-in module. */
export type Resolve4 = (hostname: string) => Promise<string[]>;

/**
 * Query Spamhaus DBL for a single domain. Best-effort; NEVER throws
 * — any failure is reported as `status: "unknown"` so the calling
 * pillar can fall back gracefully.
 *
 * `resolve4` is an optional injectable — defaults to the real
 * `dns.promises.resolve4` and only gets overridden by tests.
 */
export async function checkSpamhausDBL(
  domain: string,
  resolve4: Resolve4 = dns.resolve4
): Promise<SpamhausCheck> {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return {
      domain: domain,
      status: "unknown",
      code: null,
      category: null,
      reason: "empty or unparseable domain",
    };
  }
  if (shouldSkip(normalized)) {
    return {
      domain: normalized,
      status: "clean",
      code: null,
      category: null,
      reason: "beehiiv-owned domain — skipped",
    };
  }

  const queryHost = `${normalized}.dbl.spamhaus.org`;
  try {
    const addresses = await withTimeout(
      resolve4(queryHost),
      DNS_TIMEOUT_MS
    );
    const code = addresses[0] ?? null;
    if (!code) {
      // resolve4 succeeded but returned an empty list — treat as
      // clean since NXDOMAIN would have thrown.
      return {
        domain: normalized,
        status: "clean",
        code: null,
        category: null,
        reason: null,
      };
    }
    return {
      domain: normalized,
      status: "listed",
      code,
      category: categoryFromCode(code),
      reason: null,
    };
  } catch (e) {
    // NXDOMAIN / ENOTFOUND / NODATA are the "not listed" outcomes.
    // Everything else (timeout, server failure, refused) is
    // "unknown" so we don't misclassify a query failure as clean.
    const err = e as NodeJS.ErrnoException;
    if (
      err.code === "ENOTFOUND" ||
      err.code === "ENODATA" ||
      err.code === "NXDOMAIN"
    ) {
      return {
        domain: normalized,
        status: "clean",
        code: null,
        category: null,
        reason: null,
      };
    }
    return {
      domain: normalized,
      status: "unknown",
      code: null,
      category: null,
      reason:
        err.code === "ETIMEOUT" || err.message === "timeout"
          ? "DNS timeout"
          : `DNS error: ${err.code ?? err.message ?? "unknown"}`,
    };
  }
}

/** Batch helper — the pillar collects several sending domains per
 *  scan (from_address domain, custom_email_domain, custom_domain);
 *  this runs them concurrently and dedupes on the way in. */
export async function checkSpamhausDBLBatch(
  domains: readonly string[],
  resolve4: Resolve4 = dns.resolve4
): Promise<SpamhausCheck[]> {
  const unique = new Map<string, string>();
  for (const raw of domains) {
    const n = normalizeDomain(raw);
    if (!n) continue;
    if (!unique.has(n)) unique.set(n, raw);
  }
  return Promise.all(
    Array.from(unique.keys()).map((d) => checkSpamhausDBL(d, resolve4))
  );
}

/** Canonicalize the domain before it becomes a DNS query. Empty /
 *  non-string inputs return null. Strips protocol + path + port +
 *  trailing dots + wrapping whitespace, lowercases, and drops the
 *  `www.` prefix (`www.foo.com` and `foo.com` are the same on the
 *  blocklist). Does NOT punycode-encode: Node's DNS resolver
 *  handles IDNs on its own. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // Strip protocol + everything after the first slash / port.
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split("/")[0] ?? s;
  s = s.split(":")[0] ?? s;
  s = s.replace(/\.+$/, "");
  s = s.replace(/^www\./, "");
  if (!s || !/[a-z]/.test(s) || !s.includes(".")) return null;
  return s;
}

function shouldSkip(normalized: string): boolean {
  return SKIP_SUFFIXES.some(
    (suffix) => normalized === suffix.replace(/^\./, "") || normalized.endsWith(suffix)
  );
}

function categoryFromCode(code: string): SpamhausCategory {
  switch (code) {
    case "127.0.1.2":
      return "spam";
    case "127.0.1.4":
      return "phish";
    case "127.0.1.5":
      return "malware";
    case "127.0.1.6":
      return "botnet";
    case "127.0.1.24":
    case "127.0.1.25":
    case "127.0.1.26":
      return "redirector";
    case "127.0.1.102":
    case "127.0.1.103":
    case "127.0.1.104":
    case "127.0.1.105":
    case "127.0.1.106":
      return "abused_legit";
    case "127.0.1.255":
      return "bad_query";
    default:
      return "unknown";
  }
}

/** Race a promise against a timer that rejects with `"timeout"`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
