import { getValidAccessTokenFor } from "../data/gmail-token";
import { customerEmailSignals } from "../data/customer-domains";
import type { Customer } from "../types";

/**
 * Gmail-label inference + listing for the customer-label-mapping
 * feature. We only READ labels here — the dashboard never creates
 * Gmail labels. The inference flow inspects what labels a CSM already
 * applies to threads with each customer's contacts and picks the
 * most-likely "this is the customer's label" out of the bunch.
 */

/** Gmail's reserved system labels — never count these as "the
 *  customer's label." Anything starting with `CATEGORY_` is also a
 *  system label, handled in code below. */
const SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "STARRED",
  "UNREAD",
  "IMPORTANT",
  "CHAT",
  "CHATS",
]);

function isSystemLabelId(id: string): boolean {
  if (SYSTEM_LABEL_IDS.has(id)) return true;
  if (id.startsWith("CATEGORY_")) return true;
  return false;
}

export interface GmailLabel {
  id: string;
  name: string;
  /** "user" for hand-managed labels, "system" for INBOX / CATEGORY_*
   *  / etc. The picker UI hides system labels. */
  type: "user" | "system";
}

/** Lists every label in the CSM's Gmail. Used both by the inference
 *  pass (to resolve label-name → id) and the settings-page dropdown. */
export async function listGmailLabels(csmEmail: string): Promise<GmailLabel[]> {
  const token = await getValidAccessTokenFor(csmEmail);
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gmail labels.list ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    labels?: Array<{ id?: string; name?: string; type?: string }>;
  };
  const out: GmailLabel[] = [];
  for (const l of j.labels ?? []) {
    if (!l.id || !l.name) continue;
    out.push({
      id: l.id,
      name: l.name,
      type: l.type === "system" ? "system" : "user",
    });
  }
  // Alphabetize so the picker dropdown is scannable. Case-insensitive,
  // locale-aware so nested labels like "Customers/AcmeCo" group near
  // their parent. Gmail returns labels in creation order otherwise,
  // which is unusable for a 100+-label account.
  out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  return out;
}

interface ThreadHit {
  id: string;
  labelIds: string[];
}

/** Fetch the labelIds across a list of thread ids. One Gmail call per
 *  thread (threads.get) — Gmail has no labelIds-only batch endpoint,
 *  but we keep the per-customer cap small (THREAD_CAP) so cost is
 *  bounded. */
async function fetchThreadLabels(
  csmEmail: string,
  threadIds: string[]
): Promise<ThreadHit[]> {
  if (threadIds.length === 0) return [];
  const token = await getValidAccessTokenFor(csmEmail);
  const out: ThreadHit[] = [];
  // Small concurrency cap — Gmail rate limits per user are generous
  // but a single CSM running a full-book scan could otherwise fire
  // hundreds of calls in a burst.
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < threadIds.length) {
      const my = idx++;
      const id = threadIds[my];
      try {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=minimal`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) continue;
        const j = (await res.json()) as {
          messages?: Array<{ labelIds?: string[] }>;
        };
        // Union the labelIds across every message in the thread —
        // Gmail surfaces label state per-message but for our purposes
        // any label on the thread counts.
        const labels = new Set<string>();
        for (const m of j.messages ?? []) {
          for (const lid of m.labelIds ?? []) labels.add(lid);
        }
        out.push({ id, labelIds: [...labels] });
      } catch {
        // Single-thread failure shouldn't kill the inference — just
        // skip that thread.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

/** Query Gmail for threads matching the participant signals. Caps
 *  at THREAD_CAP threads — newest first. */
async function listMatchingThreads(
  csmEmail: string,
  q: string,
  cap: number
): Promise<string[]> {
  const token = await getValidAccessTokenFor(csmEmail);
  const params = new URLSearchParams({
    q,
    maxResults: String(cap),
  });
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gmail threads.list ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    threads?: Array<{ id?: string }>;
  };
  const ids: string[] = [];
  for (const t of j.threads ?? []) if (t.id) ids.push(t.id);
  return ids;
}

/** Build the Gmail search query for a customer's threads. Specific
 *  emails OR'd together; non-free domains OR'd in as well (matching
 *  the established `customerEmailSignals` semantics). */
function buildCustomerQuery(signals: ReturnType<typeof customerEmailSignals>): string {
  const parts: string[] = [];
  for (const e of signals.emails) {
    parts.push(`from:${e}`);
    parts.push(`to:${e}`);
  }
  for (const d of signals.domains) {
    parts.push(`from:@${d}`);
    parts.push(`to:@${d}`);
  }
  if (parts.length === 0) return "";
  // Wrap each clause so Gmail parses the OR correctly; exclude drafts
  // (we'd otherwise count freshly created drafts toward inference).
  return `(${parts.join(" OR ")}) -in:drafts`;
}

/** Cap on threads scanned per customer. Newest-first; older threads
 *  rarely carry the "current" label name. */
const PER_CUSTOMER_THREAD_CAP = 30;
/** Cap on the CSM's overall recent-thread sample we use to detect
 *  "this label is used on everything." */
const GLOBAL_THREAD_SAMPLE = 100;
/** A label must appear on at least this fraction of the customer's
 *  threads to be considered. Defends against one-off mis-labels. */
const PER_CUSTOMER_FLOOR = 0.3;
/** A label that appears on more than this fraction of the CSM's
 *  recent threads overall is considered "broad" (e.g. "Outreach")
 *  and skipped — those aren't customer-specific. */
const GLOBAL_CEILING = 0.7;

/** Cache the CSM-wide "broad labels" set per inference run so the
 *  full-book scan doesn't recompute it once per customer. */
export interface InferenceContext {
  /** label_id → fraction of recent threads it appears on. */
  globalFrequency: Map<string, number>;
  /** Sample size used to compute the fractions (capped at
   *  GLOBAL_THREAD_SAMPLE). */
  sampleSize: number;
}

/** Build the inference context once per scan — single Gmail call to
 *  list recent threads, then per-thread label fetches under the
 *  concurrency cap. Reuse across `inferCustomerLabel` calls in a
 *  full-book scan. */
export async function buildInferenceContext(
  csmEmail: string
): Promise<InferenceContext> {
  let ids: string[] = [];
  try {
    ids = await listMatchingThreads(csmEmail, "-in:drafts", GLOBAL_THREAD_SAMPLE);
  } catch {
    // Soft-fail — without the global sample we lose the broad-label
    // filter but inference still works (just less noise-resistant).
    return { globalFrequency: new Map(), sampleSize: 0 };
  }
  const hits = await fetchThreadLabels(csmEmail, ids);
  const counts = new Map<string, number>();
  for (const h of hits) {
    for (const lid of h.labelIds) {
      if (isSystemLabelId(lid)) continue;
      counts.set(lid, (counts.get(lid) ?? 0) + 1);
    }
  }
  const sampleSize = hits.length || 1;
  const globalFrequency = new Map<string, number>();
  for (const [lid, n] of counts) {
    globalFrequency.set(lid, n / sampleSize);
  }
  return { globalFrequency, sampleSize };
}

export interface InferredLabel {
  label_id: string;
  label_name: string;
}

export interface InferenceResult {
  inferred: InferredLabel | null;
  /** Human-readable reason when `inferred` is null. Surfaced in the
   *  scan summary for debugging. */
  reason?: string;
}

/**
 * Infer the Gmail label for one customer from the CSM's thread
 * history. Returns null when the bar isn't met. Soft-fails on Gmail
 * errors — they show up as `inferred: null` with a reason string,
 * not exceptions, so a single bad customer doesn't kill the bulk scan.
 *
 * Caller should pass the same `ctx` + `labelsById` across every
 * customer in a scan run to avoid redundant Gmail calls.
 */
export async function inferCustomerLabel(
  csmEmail: string,
  customer: Customer,
  ctx: InferenceContext,
  labelsById: Map<string, GmailLabel>
): Promise<InferenceResult> {
  const signals = customerEmailSignals(customer);
  if (signals.emails.length === 0 && signals.domains.length === 0) {
    return { inferred: null, reason: "no known contact emails/domain" };
  }
  const q = buildCustomerQuery(signals);
  if (!q) return { inferred: null, reason: "empty query" };

  let threadIds: string[];
  try {
    threadIds = await listMatchingThreads(csmEmail, q, PER_CUSTOMER_THREAD_CAP);
  } catch (e) {
    return {
      inferred: null,
      reason: `threads.list failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  if (threadIds.length === 0) {
    return { inferred: null, reason: "no thread history" };
  }

  const hits = await fetchThreadLabels(csmEmail, threadIds);
  if (hits.length === 0) {
    return { inferred: null, reason: "thread fetch returned empty" };
  }

  const counts = new Map<string, number>();
  for (const h of hits) {
    for (const lid of h.labelIds) {
      if (isSystemLabelId(lid)) continue;
      counts.set(lid, (counts.get(lid) ?? 0) + 1);
    }
  }

  // Filter: at least PER_CUSTOMER_FLOOR of threads, not broader than
  // GLOBAL_CEILING in the global sample.
  const eligible: Array<{ id: string; perCustomer: number; global: number }> = [];
  for (const [lid, n] of counts) {
    const perCustomer = n / hits.length;
    if (perCustomer < PER_CUSTOMER_FLOOR) continue;
    const global = ctx.globalFrequency.get(lid) ?? 0;
    if (global > GLOBAL_CEILING) continue;
    eligible.push({ id: lid, perCustomer, global });
  }
  if (eligible.length === 0) {
    return { inferred: null, reason: "no label met thresholds" };
  }

  // Sort: highest per-customer frequency wins, ties broken by lowest
  // global frequency (more specific labels are better).
  eligible.sort((a, b) => {
    if (b.perCustomer !== a.perCustomer) return b.perCustomer - a.perCustomer;
    return a.global - b.global;
  });
  const winner = eligible[0];
  const label = labelsById.get(winner.id);
  if (!label) {
    return {
      inferred: null,
      reason: `label ${winner.id} not in user's label list (deleted mid-scan?)`,
    };
  }
  return {
    inferred: { label_id: label.id, label_name: label.name },
  };
}
