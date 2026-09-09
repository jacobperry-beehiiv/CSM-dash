import { loadCustomers } from "../data/load-customers";
import { customerEmailSignals } from "../data/customer-domains";
import {
  loadEnterpriseRequestsSnapshot,
  loadSlackIntakeCursor,
  saveEnterpriseRequestsSnapshot,
  saveSlackIntakeCursor,
} from "../data/enterprise-requests";
import type {
  EnterpriseRequestRow,
  EnterpriseRequestsBlob,
  SlackIntakeMeta,
} from "../data/enterprise-requests-types";
import { linearStateToDerived } from "../data/enterprise-requests-types";
import {
  fetchChannelMessages,
  fetchPermalink,
  fetchUserDisplayName,
} from "../integrations/slack-history";
import { fetchIssueByIdentifier } from "../integrations/linear";
import { parseIntakeMessage } from "../integrations/enterprise-requests-slack-intake-parser";
import { DB, runNativeQuery } from "../metabase";
import type { Customer } from "../types";

/**
 * Enterprise Request Loop — sweep of
 * #enterprise-bugs-and-feature-requests (C0907JQRXM0).
 *
 * Walks new messages (newer than the stored cursor), parses each for
 * a customer signal + Linear URL, resolves the pair to a
 * (workspace_id, linear_key), and lands it on the snapshot:
 *
 * - If the row already exists (customer_needs sync got there first),
 *   just annotate its `slack_intake` field with the permalink. No
 *   Linear round-trip needed — the customer_needs sync already has
 *   the metadata.
 * - Otherwise fetch the Linear ticket by identifier and inject a new
 *   row with `intake_source: "slack_intake"` + the same
 *   `slack_intake` annotation.
 *
 * Ships alongside the existing shipped-sweep in the nightly cron.
 * Idempotent per message: re-runs land the same annotation and skip
 * rows they already touched.
 */

const INTAKE_CHANNEL_ID = "C0907JQRXM0";
/** Cap per incremental sweep. The channel has ~2 posts/day; 300
 *  covers a rare weekend backlog and worst-case a two-week catch-up
 *  window without a runaway loop. */
const MAX_MESSAGES_PER_SWEEP = 300;
/** Cap for a `backfill: true` run — walks the entire visible
 *  channel history. Slack's `conversations.history` pages at 100
 *  per round-trip, and 5000 covers years of the channel's typical
 *  volume without wedging the endpoint's 240s maxDuration budget.
 *  Sized so we can catch the entire skill-post backlog after a
 *  parser bug fix in one click. */
const MAX_MESSAGES_BACKFILL = 5000;

export interface SlackIntakeResult {
  processed: number;
  annotated: number;
  injected: number;
  linear_lookups: number;
  linear_lookup_misses: number;
  skipped_no_customer_signal: number;
  skipped_no_linear_url: number;
  skipped_unresolvable: number;
  cursor_advanced_to: string | null;
  /** True when the caller asked for a full-history backfill (cursor
   *  ignored). Echoed on the response so an admin eyeballing the
   *  settings status card can tell which mode ran. */
  backfill: boolean;
  ok: boolean;
}

export interface RunSlackIntakeSweepOptions {
  /** Ignore the stored cursor and walk the entire visible channel
   *  history (up to MAX_MESSAGES_BACKFILL). Use after a parser bug
   *  fix or the first-time bootstrap so the sweep doesn't leave
   *  historic posts unprocessed. The cursor still advances to the
   *  newest ts seen, so a subsequent incremental run resumes
   *  correctly. */
  backfill?: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CustomerLookup {
  byEmail: Map<string, string>; // owner_email → workspace_id
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

/** Resolve publication_ids to workspace_ids via one Metabase query
 *  over the publications table. Batched — we hit Postgres once per
 *  sweep regardless of how many pubs we're resolving. Silently
 *  returns an empty map if the query fails; the sweep report
 *  will show the misses so we can debug from there. */
async function resolvePublicationsToWorkspaces(
  pubIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(pubIds.map((p) => p.toLowerCase()))].filter((p) =>
    UUID_RE.test(p)
  );
  if (unique.length === 0) return map;
  // Escape single quotes just in case (though UUIDs never carry them —
  // the UUID_RE guard already blocks anything non-hex).
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
    console.warn("[slack-intake] publications lookup failed", e);
  }
  return map;
}

/** Resolve a single parsed message to a workspace_id. Returns the
 *  workspace_id + the signal that matched, or null when we can't
 *  resolve. */
function resolveWorkspace(
  parsed: ReturnType<typeof parseIntakeMessage>,
  lookup: CustomerLookup,
  pub2ws: Map<string, string>
): { workspaceId: string; matched_via: SlackIntakeMeta["matched_via"] } | null {
  // 1. Publication ID — highest signal (comes from the skill template).
  for (const p of parsed.publication_ids) {
    const ws = pub2ws.get(p);
    if (ws && lookup.byWorkspace.has(ws)) {
      return { workspaceId: ws, matched_via: "publication_id" };
    }
  }
  // 2. Owner email from `User Email:` or a `mailto:`.
  for (const email of parsed.owner_emails) {
    const ws = lookup.byEmail.get(email);
    if (ws) return { workspaceId: ws, matched_via: "owner_email" };
  }
  // 3. Domain fallback from the owner email's host.
  for (const email of parsed.owner_emails) {
    const at = email.indexOf("@");
    if (at < 0) continue;
    const domain = email.slice(at + 1);
    const ws = lookup.byDomain.get(domain);
    if (ws) return { workspaceId: ws, matched_via: "domain" };
  }
  return null;
}

/** Build a fresh EnterpriseRequestRow from a fetched Linear issue.
 *  Used only for slack_intake — the customer_needs sync builds its
 *  own rows via runEnterpriseRequestsSync's buildRow(). */
function buildRowFromLinear(
  issue: Awaited<ReturnType<typeof fetchIssueByIdentifier>>,
  workspaceId: string,
  intakeMeta: SlackIntakeMeta
): EnterpriseRequestRow | null {
  if (!issue) return null;
  // Label extraction — same shape as the sync engine's buildRow, but
  // inlined to keep the two engines independent. If the label lists
  // grow, factor into shared enterprise-requests-labels.ts.
  const labels = issue.labels?.nodes ?? [];
  let work_type: EnterpriseRequestRow["work_type"] = null;
  let customer_impact: EnterpriseRequestRow["customer_impact"] = null;
  let resurfaced = false;
  for (const l of labels) {
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

  // Prefer the ARR from the ticket's customer_need if present; else
  // fall back to the intake meta's posted_at date as the submitted_at
  // stamp. The sync will overwrite this with the canonical
  // customer_need createdAt on the next run once a need is attached.
  const need = issue.customerNeeds?.nodes?.[0];
  return {
    linear_issue_id: issue.id,
    linear_identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    linear_state_name: issue.state?.name ?? "Unknown",
    linear_state_type: issue.state?.type ?? "unknown",
    derived_state: linearStateToDerived(issue.state?.type ?? "unknown"),
    work_type,
    customer_impact,
    resurfaced,
    estimate: issue.estimate ?? null,
    project_name: issue.project?.name ?? null,
    linear_completed_at: issue.completedAt ?? null,
    submitted_at: need?.createdAt ?? intakeMeta.posted_at,
    submitting_csm_email:
      need?.creator?.email ?? intakeMeta.submitter_email ?? null,
    arr_snapshot: need?.customer?.revenue ?? null,
    promotion_source: null,
    promoted_at: null,
    ship_url: null,
    ship_date: null,
    promotion_history: [],
    intake_source: "slack_intake",
    slack_intake: intakeMeta,
  };
}

export async function runSlackIntakeSweep(
  opts: RunSlackIntakeSweepOptions = {}
): Promise<SlackIntakeResult> {
  const backfill = Boolean(opts.backfill);
  const [customers, snapshot, cursor] = await Promise.all([
    loadCustomers(),
    loadEnterpriseRequestsSnapshot(),
    loadSlackIntakeCursor(),
  ]);
  const lookup = buildCustomerLookup(customers);

  const messages = await fetchChannelMessages({
    channelId: INTAKE_CHANNEL_ID,
    // Backfill deliberately drops the cursor so we re-walk every
    // visible message. The parser is idempotent on annotation and
    // Linear ticket injection (existing rows are matched by
    // linear_identifier + workspace_id), so re-processing an
    // already-seen post costs one no-op annotation + zero Linear
    // lookups. Safe to click any time after a parser fix.
    oldestTs: backfill ? null : cursor.intake_ts,
    maxMessages: backfill
      ? MAX_MESSAGES_BACKFILL
      : MAX_MESSAGES_PER_SWEEP,
  });

  const result: SlackIntakeResult = {
    processed: 0,
    annotated: 0,
    injected: 0,
    linear_lookups: 0,
    linear_lookup_misses: 0,
    skipped_no_customer_signal: 0,
    skipped_no_linear_url: 0,
    skipped_unresolvable: 0,
    cursor_advanced_to: cursor.intake_ts,
    backfill,
    ok: true,
  };

  // First pass: parse everything so we can batch the publication →
  // workspace query. Batching keeps the sweep to a single Metabase
  // round-trip regardless of message volume.
  interface Parsed {
    ts: string;
    user_id: string | null;
    text: string;
    parsed: ReturnType<typeof parseIntakeMessage>;
  }
  const parsedMessages: Parsed[] = [];
  const allPubIds: string[] = [];
  for (const m of messages) {
    // Skip channel meta (joins, purpose changes, etc.).
    if (m.subtype && m.subtype !== "bot_message" && m.subtype !== "thread_broadcast") {
      continue;
    }
    if (!m.text) continue;
    const parsed = parseIntakeMessage(m.text);
    // Fast-path filters — save the Metabase round-trip on posts we
    // can't do anything with.
    if (
      parsed.publication_ids.length === 0 &&
      parsed.owner_emails.length === 0
    ) {
      result.processed += 1;
      result.skipped_no_customer_signal += 1;
      continue;
    }
    if (parsed.linear_keys.length === 0) {
      result.processed += 1;
      result.skipped_no_linear_url += 1;
      continue;
    }
    parsedMessages.push({
      ts: m.ts,
      user_id: m.user ?? null,
      text: m.text,
      parsed,
    });
    allPubIds.push(...parsed.publication_ids);
  }

  const pub2ws =
    allPubIds.length > 0
      ? await resolvePublicationsToWorkspaces(allPubIds)
      : new Map<string, string>();

  // Mutable copy of the snapshot rows we'll write back at the end.
  const rows: EnterpriseRequestsBlob["rows"] = { ...snapshot.rows };
  const linearCache = new Map<
    string,
    Awaited<ReturnType<typeof fetchIssueByIdentifier>>
  >();
  let maxTs = cursor.intake_ts;

  for (const pm of parsedMessages) {
    result.processed += 1;
    if (!maxTs || pm.ts > maxTs) maxTs = pm.ts;
    const resolved = resolveWorkspace(pm.parsed, lookup, pub2ws);
    if (!resolved) {
      result.skipped_unresolvable += 1;
      continue;
    }
    const { workspaceId, matched_via } = resolved;
    const permalink = await fetchPermalink({
      channel: INTAKE_CHANNEL_ID,
      ts: pm.ts,
    });
    const submitterEmail = pm.parsed.owner_emails[0] ?? null;
    // Slack user display names are cached inside slack-history.ts;
    // resolving here is fine even for large sweeps.
    const submitterName = pm.user_id
      ? await fetchUserDisplayName(pm.user_id)
      : null;
    const intakeMeta: SlackIntakeMeta = {
      channel_id: INTAKE_CHANNEL_ID,
      ts: pm.ts,
      permalink,
      submitter_email: submitterEmail,
      submitter_slack_id: pm.user_id,
      posted_at: new Date(
        Math.floor(Number(pm.ts) * 1000)
      ).toISOString(),
      body_preview: pm.parsed.body_preview,
      matched_via,
    };
    // For each Linear key on this post, either annotate the existing
    // row or inject a new one (after a Linear API lookup).
    for (const key of pm.parsed.linear_keys) {
      // Existing snapshot rows are keyed by Linear issue.id (UUID),
      // not identifier. Scan the workspace's bucket for a matching
      // identifier first — that's cheap and avoids an unnecessary
      // Linear round-trip on tickets we already have.
      const bucket = rows[workspaceId] ?? {};
      let matched: [string, EnterpriseRequestRow] | null = null;
      for (const [id, row] of Object.entries(bucket)) {
        if (row.linear_identifier === key) {
          matched = [id, row];
          break;
        }
      }
      if (matched) {
        // Annotate in place, and preserve submitter unless it was
        // already set (posts don't have a canonical CSM identity —
        // customer_needs.creator.email is the higher-signal field).
        const [id, existing] = matched;
        // Preserve the earliest slack_intake reference so a later
        // discussion post doesn't overwrite the intake permalink.
        // If the existing row already has slack_intake, only update
        // the permalink when ours is fresher AND not yet stamped.
        if (!existing.slack_intake || !existing.slack_intake.permalink) {
          bucket[id] = { ...existing, slack_intake: intakeMeta };
          result.annotated += 1;
        }
        rows[workspaceId] = bucket;
        continue;
      }
      // Fetch from Linear (cached across the sweep in case a single
      // message references the same key twice).
      let issue = linearCache.get(key);
      if (issue === undefined) {
        try {
          result.linear_lookups += 1;
          issue = await fetchIssueByIdentifier(key);
          linearCache.set(key, issue);
        } catch (e) {
          console.warn(
            `[slack-intake] Linear lookup for ${key} failed`,
            e
          );
          result.linear_lookup_misses += 1;
          linearCache.set(key, null);
          issue = null;
        }
      }
      if (!issue) {
        result.linear_lookup_misses += 1;
        continue;
      }
      const newRow = buildRowFromLinear(issue, workspaceId, intakeMeta);
      if (!newRow) continue;
      bucket[issue.id] = newRow;
      rows[workspaceId] = bucket;
      result.injected += 1;
    }
    // Silence unused-var warning for submitter_name; it's captured
    // above intentionally in case a future UI wants "posted by
    // <name>" but the field isn't on SlackIntakeMeta yet — keep the
    // resolver call so its cache warms.
    void submitterName;
  }

  const nextBlob: EnterpriseRequestsBlob = {
    ...snapshot,
    rows,
    fetched_at: new Date().toISOString(),
  };
  await saveEnterpriseRequestsSnapshot(nextBlob);
  if (maxTs && maxTs !== cursor.intake_ts) {
    await saveSlackIntakeCursor(maxTs);
    result.cursor_advanced_to = maxTs;
  }
  return result;
}
