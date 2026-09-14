import { loadCustomers } from "../data/load-customers";
import { customerEmailSignals } from "../data/customer-domains";
import {
  loadEnterpriseRequestsSnapshot,
  loadLinearCommentScanCursor,
  saveEnterpriseRequestsSnapshot,
  saveLinearCommentScanCursor,
} from "../data/enterprise-requests";
import type {
  EnterpriseRequestRow,
  EnterpriseRequestsBlob,
  LinearCommentMeta,
} from "../data/enterprise-requests-types";
import { linearStateToDerived } from "../data/enterprise-requests-types";
import {
  fetchOpenIssuesWithCommentsPage,
  type LinearComment,
  type LinearIssueWithComments,
} from "../integrations/linear";
import { parseIntakeMessage } from "../integrations/enterprise-requests-slack-intake-parser";
import { DB, runNativeQuery } from "../metabase";
import type { Customer } from "../types";

/**
 * Linear-comment scan — walks OPEN Linear issues and looks at each
 * ticket's comments for structured customer-request signals (the
 * same `\`Publication ID\``/`\`User Email\``/mailto shape the
 * feature-request-creator skill posts on both Slack and Linear).
 *
 * For every comment that names a customer we can resolve to a
 * dash workspace, we either:
 *
 *   • annotate an existing snapshot row for that (workspace, issue)
 *     pair with a `linear_comment` block (permalink back to the
 *     comment) — no Linear round-trip needed, we already have the
 *     ticket metadata from this same query, OR
 *   • inject a new row with `intake_source: "linear_comment"` when
 *     no row exists yet (typical case: customer_needs never attached).
 *
 * The scan filters at Linear-side to open issues (statusType NOT
 * completed/canceled) which trims the read to ~1500–2500 tickets in
 * practice. Each page comes back with the first 20 comments inlined,
 * so a typical scan is one paginated query round-trip per 50 issues.
 *
 * The `customer_needs` sync remains canonical: any row it produces
 * on subsequent runs overwrites this one but preserves the
 * `linear_comment` block for context (see runEnterpriseRequestsSync's
 * prior-row merge).
 */

const MAX_PAGES_INCREMENTAL = 40; // 40 × 50 = 2000 issues
const MAX_PAGES_BACKFILL = 100; // 100 × 50 = 5000 issues (belt-and-suspenders)

export interface LinearCommentScanResult {
  processed_issues: number;
  processed_comments: number;
  annotated: number;
  injected: number;
  skipped_no_customer_signal: number;
  skipped_unresolvable: number;
  cursor_advanced_to: string | null;
  backfill: boolean;
  ok: boolean;
}

export interface RunLinearCommentScanOptions {
  /** Ignore the stored cursor and walk every open issue. Idempotent
   *  — re-processing an already-annotated row is a no-op. */
  backfill?: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CustomerLookup {
  byEmail: Map<string, string>;
  byDomain: Map<string, string>;
  byWorkspace: Map<string, Customer>;
}

function buildCustomerLookup(customers: Customer[]): CustomerLookup {
  const byEmail = new Map<string, string>();
  const byDomain = new Map<string, string>();
  const byWorkspace = new Map<string, Customer>();
  for (const c of customers) {
    if (!c.workspace_id) continue;
    byWorkspace.set(c.workspace_id, c);
    const signals = customerEmailSignals(c);
    for (const email of signals.emails) {
      if (!byEmail.has(email)) byEmail.set(email, c.workspace_id);
    }
    for (const domain of signals.domains) {
      if (!byDomain.has(domain)) byDomain.set(domain, c.workspace_id);
    }
  }
  return { byEmail, byDomain, byWorkspace };
}

async function resolvePublicationsToWorkspaces(
  pubIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(pubIds.map((p) => p.toLowerCase()))].filter((p) =>
    UUID_RE.test(p)
  );
  if (unique.length === 0) return map;
  const inClause = unique.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  try {
    const rows = await runNativeQuery(
      DB.POSTGRES,
      `SELECT id::text AS publication_id,
              organization_id::text AS organization_id
         FROM public.publications
         WHERE id::text IN (${inClause})
           AND deleted_at IS NULL
           AND organization_id IS NOT NULL`
    );
    for (const raw of rows) {
      const r = raw as { publication_id?: string; organization_id?: string };
      if (r.publication_id && r.organization_id) {
        map.set(r.publication_id.toLowerCase(), r.organization_id);
      }
    }
  } catch (e) {
    console.warn("[linear-comment-scan] publications lookup failed", e);
  }
  return map;
}

function resolveWorkspace(
  parsed: ReturnType<typeof parseIntakeMessage>,
  lookup: CustomerLookup,
  pub2ws: Map<string, string>
): { workspaceId: string; matched_via: LinearCommentMeta["matched_via"] } | null {
  for (const p of parsed.publication_ids) {
    const ws = pub2ws.get(p);
    if (ws && lookup.byWorkspace.has(ws)) {
      return { workspaceId: ws, matched_via: "publication_id" };
    }
  }
  for (const email of parsed.owner_emails) {
    const ws = lookup.byEmail.get(email);
    if (ws) return { workspaceId: ws, matched_via: "owner_email" };
  }
  for (const email of parsed.owner_emails) {
    const at = email.indexOf("@");
    if (at < 0) continue;
    const domain = email.slice(at + 1);
    const ws = lookup.byDomain.get(domain);
    if (ws) return { workspaceId: ws, matched_via: "domain" };
  }
  return null;
}

function extractLabels(issue: LinearIssueWithComments): {
  work_type: EnterpriseRequestRow["work_type"];
  customer_impact: EnterpriseRequestRow["customer_impact"];
  resurfaced: boolean;
} {
  let work_type: EnterpriseRequestRow["work_type"] = null;
  let customer_impact: EnterpriseRequestRow["customer_impact"] = null;
  let resurfaced = false;
  for (const l of issue.labels?.nodes ?? []) {
    const name = l.name?.trim();
    if (!name) continue;
    if (
      name === "Churn Risk" ||
      name === "Blocking" ||
      name === "Friction" ||
      name === "Nice to have"
    ) {
      customer_impact = name;
    } else if (
      name === "Bug" ||
      name === "Feature" ||
      name === "UI/UX Improvement"
    ) {
      work_type = name;
    } else if (name === "Resurfaced") {
      resurfaced = true;
    }
  }
  return { work_type, customer_impact, resurfaced };
}

function buildRowFromIssueAndComment(
  issue: LinearIssueWithComments,
  workspaceId: string,
  meta: LinearCommentMeta
): EnterpriseRequestRow {
  const labels = extractLabels(issue);
  return {
    linear_issue_id: issue.id,
    linear_identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    linear_state_name: issue.state?.name ?? "Unknown",
    linear_state_type: issue.state?.type ?? "unknown",
    derived_state: linearStateToDerived(issue.state?.type ?? "unknown"),
    work_type: labels.work_type,
    customer_impact: labels.customer_impact,
    resurfaced: labels.resurfaced,
    estimate: issue.estimate ?? null,
    project_name: issue.project?.name ?? null,
    linear_completed_at: issue.completedAt ?? null,
    submitted_at: meta.posted_at,
    submitting_csm_email: meta.author_email,
    arr_snapshot: null,
    promotion_source: null,
    promoted_at: null,
    ship_url: null,
    ship_date: null,
    promotion_history: [],
    intake_source: "linear_comment",
    linear_comment: meta,
  };
}

function commentPreview(text: string): string {
  const cleaned = text
    .replace(/<https?:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned;
}

export async function runLinearCommentScan(
  opts: RunLinearCommentScanOptions = {}
): Promise<LinearCommentScanResult> {
  const backfill = Boolean(opts.backfill);
  const [customers, snapshot, cursor] = await Promise.all([
    loadCustomers(),
    loadEnterpriseRequestsSnapshot(),
    loadLinearCommentScanCursor(),
  ]);
  const lookup = buildCustomerLookup(customers);

  // Track the newest updatedAt we see so the incremental cursor
  // advances forward. On backfill we still advance it — a fresh
  // incremental run after the backfill won't re-walk what we just
  // covered.
  let newestUpdatedAt = cursor.scan_after;
  const cutoff =
    backfill || !cursor.scan_after
      ? null
      : Date.parse(cursor.scan_after);

  const result: LinearCommentScanResult = {
    processed_issues: 0,
    processed_comments: 0,
    annotated: 0,
    injected: 0,
    skipped_no_customer_signal: 0,
    skipped_unresolvable: 0,
    cursor_advanced_to: cursor.scan_after,
    backfill,
    ok: true,
  };

  // Two passes over open issues so we can batch the publication →
  // workspace lookup: pass 1 parses every comment and gathers all
  // publication_ids seen; pass 2 resolves + writes. The issue set
  // itself is walked once — pages are held in memory since ~2500
  // trimmed issues fit in a few MB.
  interface CollectedComment {
    issue: LinearIssueWithComments;
    comment: LinearComment;
    parsed: ReturnType<typeof parseIntakeMessage>;
  }
  const collected: CollectedComment[] = [];
  const allPubIds: string[] = [];

  const maxPages = backfill ? MAX_PAGES_BACKFILL : MAX_PAGES_INCREMENTAL;
  let after: string | null = null;
  let stopPaging = false;
  for (let page = 0; page < maxPages && !stopPaging; page += 1) {
    const { issues, endCursor, hasNextPage } =
      await fetchOpenIssuesWithCommentsPage(after);
    if (issues.length === 0) break;
    for (const issue of issues) {
      result.processed_issues += 1;
      // Advance the "newest seen" tracker off whichever comment has
      // the highest updatedAt on this issue (fallback to the issue's
      // own state — we can't read updatedAt at issue level from this
      // query shape, so we use the max comment updatedAt as a proxy).
      let localMaxTs: string | null = null;
      for (const c of issue.comments?.nodes ?? []) {
        result.processed_comments += 1;
        if (!localMaxTs || c.updatedAt > localMaxTs) localMaxTs = c.updatedAt;
        // Incremental cutoff — orderBy is by issue.updatedAt DESC
        // in Linear (Linear defaults to DESC on `updatedAt` orderBy),
        // so once every comment on a page is older than our cutoff
        // we can stop paging. Conservative: only bail when BOTH the
        // issue-level state-history and every comment on it fall
        // below the cutoff. In practice the comments-only check is
        // safe because a fresh comment bumps issue.updatedAt.
        if (cutoff != null && Date.parse(c.updatedAt) < cutoff) continue;
        const parsed = parseIntakeMessage(c.body ?? "");
        // Fast-drop: no customer signal at all → skip the round-trip.
        if (
          parsed.publication_ids.length === 0 &&
          parsed.owner_emails.length === 0
        ) {
          continue;
        }
        collected.push({ issue, comment: c, parsed });
        allPubIds.push(...parsed.publication_ids);
      }
      if (localMaxTs && (!newestUpdatedAt || localMaxTs > newestUpdatedAt)) {
        newestUpdatedAt = localMaxTs;
      }
    }
    if (!hasNextPage || !endCursor) break;
    after = endCursor;
  }

  const pub2ws =
    allPubIds.length > 0
      ? await resolvePublicationsToWorkspaces(allPubIds)
      : new Map<string, string>();

  const rows: EnterpriseRequestsBlob["rows"] = { ...snapshot.rows };
  for (const item of collected) {
    const { issue, comment, parsed } = item;
    const resolved = resolveWorkspace(parsed, lookup, pub2ws);
    if (!resolved) {
      // Distinguish "no signal" (already filtered above) from
      // "signal present but no matching workspace" — the latter is
      // the more actionable diagnostic.
      if (
        parsed.publication_ids.length === 0 &&
        parsed.owner_emails.length === 0
      ) {
        result.skipped_no_customer_signal += 1;
      } else {
        result.skipped_unresolvable += 1;
      }
      continue;
    }
    const { workspaceId, matched_via } = resolved;
    const meta: LinearCommentMeta = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      comment_id: comment.id,
      permalink: comment.url,
      author_email: comment.user?.email ?? null,
      author_name: comment.user?.name ?? null,
      posted_at: comment.createdAt,
      body_preview: commentPreview(comment.body ?? ""),
      matched_via,
    };
    const bucket = rows[workspaceId] ?? {};
    const existing = bucket[issue.id];
    if (existing) {
      // Only stamp the linear_comment block once — a later comment
      // on the same ticket for the same workspace shouldn't
      // overwrite the intake anchor.
      if (!existing.linear_comment) {
        bucket[issue.id] = { ...existing, linear_comment: meta };
        rows[workspaceId] = bucket;
        result.annotated += 1;
      }
      continue;
    }
    bucket[issue.id] = buildRowFromIssueAndComment(issue, workspaceId, meta);
    rows[workspaceId] = bucket;
    result.injected += 1;
  }

  const nextBlob: EnterpriseRequestsBlob = {
    ...snapshot,
    rows,
    fetched_at: new Date().toISOString(),
  };
  await saveEnterpriseRequestsSnapshot(nextBlob);
  if (newestUpdatedAt && newestUpdatedAt !== cursor.scan_after) {
    await saveLinearCommentScanCursor(newestUpdatedAt);
    result.cursor_advanced_to = newestUpdatedAt;
  }
  return result;
}
