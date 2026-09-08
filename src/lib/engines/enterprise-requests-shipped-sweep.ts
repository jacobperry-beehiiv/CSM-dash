import {
  loadEnterpriseRequestsSnapshot,
  loadOrphans,
  loadShippedCursor,
  saveEnterpriseRequestsSnapshot,
  saveShippedCursor,
  upsertOrphan,
} from "../data/enterprise-requests";
import type {
  EnterpriseRequestDerivedState,
  EnterpriseRequestRow,
  EnterpriseRequestsBlob,
  PromotionSource,
} from "../data/enterprise-requests-types";
import {
  fetchChannelMessages,
  fetchPermalink,
} from "../integrations/slack-history";
import {
  parseDevsShippedMessage,
  type DevsShippedHit,
} from "../integrations/shipped-devs-shipped-parser";
import {
  FUZZY_MATCH_THRESHOLD,
  fuzzyScore,
  parseChangelogMessage,
  type ChangelogHit,
} from "../integrations/shipped-changelog-parser";

/**
 * Shipped-detection sweep — reads two Slack channels, promotes
 * matching snapshot rows to a shipped state, and files anything
 * that couldn't match (after a 14-day grace period) to the orphans
 * queue for admin review.
 *
 * Runs AFTER the Linear sync — the sync pulls fresh Linear state and
 * carries prior promotion metadata forward; this sweep then re-applies
 * whatever the two channels currently say. Cron ordering matters:
 * .github/workflows/enterprise-requests-sync.yml calls both endpoints
 * in sequence.
 *
 * Promotion rules (per PDF Piece 3):
 *   - Bug / UI-UX + #devs-shipped hit → Live (source: devs_shipped)
 *   - Feature + #devs-shipped only → "Live, possibly in beta"
 *   - Feature + #devs-shipped + #topic-product-changelog match →
 *     Live (upgrade), source: changelog, stamps ship_url
 *   - Any + Linear state → Dismissed/Canceled → Not planned
 *     (that path lives on the sync engine's derived-state seed;
 *     this sweep never demotes)
 *   - NEVER promotes off Linear state alone.
 */

// Channel IDs — hardcoded per the PDF, they don't change. If beehiiv
// ever renames or splits the channel, update here.
const DEVS_SHIPPED_CHANNEL = "C0AE7EX6C06";
const CHANGELOG_CHANNEL = "C093C6MDS1E";

/** Orphans threshold — a shipped-channel hit that hasn't matched to
 *  any snapshot row after this many days lands on the admin orphans
 *  queue. Below the threshold we keep it silent so the queue isn't
 *  flooded on the first sweep after a big release. */
const ORPHAN_GRACE_DAYS = 14;

/** How many messages to look back per channel per sweep. 500 is
 *  generous for either channel — even during a heavy release week
 *  the #devs-shipped throughput is ~20 posts. Keeps the sweep well
 *  under maxDuration. */
const MAX_MESSAGES_PER_CHANNEL = 500;

export interface ShippedSweepResult {
  ok: boolean;
  checked_devs_shipped: number;
  checked_changelog: number;
  promoted: number;
  orphans_added: number;
  fetched_at: string;
}

/** Slice a work type from what the #devs-shipped parens produced.
 *  Ship parens use loose spellings (Bug, Bug fix, UI/UX Improvement,
 *  Chore, etc.). The parser hands us the raw string; here we normalize
 *  onto the three buckets that matter for the promotion rules. */
function normalizeWorkType(raw: string | null): "bug" | "feature" | "ui_ux" | "other" {
  if (!raw) return "other";
  const lc = raw.toLowerCase();
  if (lc.includes("bug")) return "bug";
  if (lc.includes("ui") || lc.includes("ux")) return "ui_ux";
  if (lc.includes("feature")) return "feature";
  return "other";
}

/** Decide the target state for a row given the shipped signals it
 *  matched. Used inside the sweep — returns null when the signals
 *  don't warrant any change from the current state. */
function decidePromotion(args: {
  row: EnterpriseRequestRow;
  devsShippedHit: DevsShippedHit | null;
  changelogHit: ChangelogHit | null;
  changelogFuzzyMatch: boolean;
}): {
  target_state: EnterpriseRequestDerivedState;
  source: PromotionSource;
  ship_url: string | null;
  ship_date: string | null;
} | null {
  const { row, devsShippedHit, changelogHit, changelogFuzzyMatch } = args;
  const currentState = row.derived_state;

  // A changelog match (exact or fuzzy) always promotes to Live. When
  // both channels hit, changelog wins as the source of truth for the
  // ship_url since the changelog links to the customer-facing release.
  if (changelogHit) {
    // Skip if we've already promoted from this exact source with
    // the same permalink — idempotent re-runs.
    if (
      row.promotion_source === "changelog" &&
      row.ship_url === changelogHit.ship_permalink &&
      currentState === "Live"
    ) {
      return null;
    }
    return {
      target_state: "Live",
      source: changelogHit.linear_key
        ? "changelog"
        : (changelogFuzzyMatch ? "changelog_fuzzy" : "changelog"),
      ship_url: changelogHit.ship_permalink,
      ship_date: changelogHit.message_ts
        ? new Date(
            Number.parseFloat(changelogHit.message_ts) * 1000
          ).toISOString()
        : null,
    };
  }

  // #devs-shipped only — the classification depends on the ROW's
  // work_type label (from Linear), not what the ship parens say,
  // because Linear is authoritative on what the ticket actually is.
  if (devsShippedHit) {
    const rowType =
      row.work_type === "Bug"
        ? "bug"
        : row.work_type === "UI/UX Improvement"
          ? "ui_ux"
          : row.work_type === "Feature"
            ? "feature"
            : normalizeWorkType(devsShippedHit.work_type_raw);
    if (rowType === "bug" || rowType === "ui_ux" || rowType === "other") {
      // Not a feature → straight to Live.
      if (
        currentState === "Live" &&
        row.promotion_source === "devs_shipped" &&
        row.ship_url === devsShippedHit.ship_permalink
      ) {
        return null;
      }
      return {
        target_state: "Live",
        source: "devs_shipped",
        ship_url: devsShippedHit.ship_permalink,
        ship_date: devsShippedHit.deployed_at_iso,
      };
    }
    // Feature without a changelog match → beta caveat.
    if (
      currentState === "Live, possibly in beta" &&
      row.promotion_source === "devs_shipped" &&
      row.ship_url === devsShippedHit.ship_permalink
    ) {
      return null;
    }
    // Never demote — if the row was already Live via a changelog
    // hit and #devs-shipped mentions it later, keep it Live.
    if (currentState === "Live") return null;
    return {
      target_state: "Live, possibly in beta",
      source: "devs_shipped",
      ship_url: devsShippedHit.ship_permalink,
      ship_date: devsShippedHit.deployed_at_iso,
    };
  }

  return null;
}

/** Slack `ts` comparison — string-lex works because ts is a
 *  zero-padded epoch. Returns the max (newest). */
function maxTs(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Try to enrich each Slack message with its permalink. Best-effort
 *  — a failure returns null and the audit trail carries a permalink-
 *  less entry. Concurrency is bounded implicitly by fetchPermalink's
 *  in-run cache. */
async function withPermalinks<T extends { ts: string }>(
  channelId: string,
  msgs: T[]
): Promise<Array<T & { permalink: string | null }>> {
  const out: Array<T & { permalink: string | null }> = [];
  for (const m of msgs) {
    let permalink: string | null = null;
    try {
      permalink = await fetchPermalink({ channel: channelId, ts: m.ts });
    } catch {
      // Ignore — the sweep can proceed without permalinks.
    }
    out.push({ ...m, permalink });
  }
  return out;
}

/**
 * Run one shipped-detection pass. Reads both channels since the last
 * cursor, applies promotions to the snapshot, and files unmatched
 * hits (past the 14-day grace) to the orphans queue.
 */
export async function runEnterpriseRequestsShippedSweep(): Promise<ShippedSweepResult> {
  const [snapshot, cursor, priorOrphans] = await Promise.all([
    loadEnterpriseRequestsSnapshot(),
    loadShippedCursor(),
    loadOrphans(),
  ]);

  const [rawDevs, rawChangelog] = await Promise.all([
    fetchChannelMessages({
      channelId: DEVS_SHIPPED_CHANNEL,
      oldestTs: cursor.devs_shipped_ts ?? undefined,
      maxMessages: MAX_MESSAGES_PER_CHANNEL,
    }),
    fetchChannelMessages({
      channelId: CHANGELOG_CHANNEL,
      oldestTs: cursor.changelog_ts ?? undefined,
      maxMessages: MAX_MESSAGES_PER_CHANNEL,
    }),
  ]);

  // Enrich with permalinks up front so the audit trail is complete.
  const devsWithLinks = await withPermalinks(DEVS_SHIPPED_CHANNEL, rawDevs);
  const changeWithLinks = await withPermalinks(CHANGELOG_CHANNEL, rawChangelog);

  // Parse all messages into structured hits.
  const devsHits: DevsShippedHit[] = [];
  for (const m of devsWithLinks) {
    const parsed = parseDevsShippedMessage({
      text: m.text ?? "",
      message_ts: m.ts,
      ship_permalink: m.permalink,
    });
    devsHits.push(...parsed);
  }

  const changelogHits: ChangelogHit[] = [];
  for (const m of changeWithLinks) {
    const parsed = parseChangelogMessage({
      text: m.text ?? "",
      message_ts: m.ts,
      ship_permalink: m.permalink,
    });
    if (parsed) changelogHits.push(parsed);
  }

  // Index hits for lookup. #devs-shipped: keep the FIRST hit per
  // Linear key (oldest ts wins per the PDF's "first appearance"
  // rule). #topic-product-changelog: exact hits by linear_key
  // (unique), fuzzy hits stay as a list scanned per row.
  const devsByKey = new Map<string, DevsShippedHit>();
  for (const hit of devsHits) {
    const existing = devsByKey.get(hit.linear_key);
    if (!existing || hit.message_ts < existing.message_ts) {
      devsByKey.set(hit.linear_key, hit);
    }
  }
  const changelogByKey = new Map<string, ChangelogHit>();
  const changelogWithoutLink: ChangelogHit[] = [];
  for (const hit of changelogHits) {
    if (hit.linear_key) changelogByKey.set(hit.linear_key, hit);
    else changelogWithoutLink.push(hit);
  }

  // Walk every snapshot row; consider promotions.
  const now = new Date().toISOString();
  const promoted: Array<{ workspaceId: string; issueId: string }> = [];
  const nextRows: EnterpriseRequestsBlob["rows"] = { ...snapshot.rows };
  const matchedLinearKeys = new Set<string>();

  for (const [workspaceId, bucket] of Object.entries(snapshot.rows)) {
    for (const [issueId, row] of Object.entries(bucket)) {
      const devsHit = devsByKey.get(row.linear_identifier) ?? null;
      const changelogExact = changelogByKey.get(row.linear_identifier) ?? null;
      // Fuzzy fallback — only when we don't have an exact link
      // match AND the ticket is a feature (bugs/UI/UX ship via
      // #devs-shipped alone; fuzzy-matching a bug against a
      // changelog entry is more noise than signal).
      let changelogFuzzy: ChangelogHit | null = null;
      let changelogFuzzyMatch = false;
      if (!changelogExact && row.work_type === "Feature") {
        for (const hit of changelogWithoutLink) {
          if (fuzzyScore(hit.feature_name, row.title) >= FUZZY_MATCH_THRESHOLD) {
            changelogFuzzy = hit;
            changelogFuzzyMatch = true;
            break;
          }
        }
      }
      const changelogHit = changelogExact ?? changelogFuzzy;
      const decision = decidePromotion({
        row,
        devsShippedHit: devsHit,
        changelogHit,
        changelogFuzzyMatch,
      });
      if (devsHit) matchedLinearKeys.add(devsHit.linear_key);
      if (changelogExact?.linear_key) matchedLinearKeys.add(changelogExact.linear_key);
      if (!decision) continue;
      const nextBucket = { ...(nextRows[workspaceId] ?? {}) };
      nextBucket[issueId] = {
        ...row,
        derived_state: decision.target_state,
        promotion_source: decision.source,
        promoted_at: now,
        ship_url: decision.ship_url,
        ship_date: decision.ship_date,
        promotion_history: [
          ...row.promotion_history,
          {
            from_state: row.derived_state,
            to_state: decision.target_state,
            source: decision.source,
            at: now,
            permalink: decision.ship_url,
          },
        ],
      };
      nextRows[workspaceId] = nextBucket;
      promoted.push({ workspaceId, issueId });
    }
  }

  // Orphans — shipped-channel hits that never matched to a snapshot
  // row AND are older than the grace window. Idempotent upsert so
  // an already-dismissed orphan doesn't come back on the next run.
  const nowMs = Date.now();
  const graceMs = ORPHAN_GRACE_DAYS * 24 * 60 * 60 * 1000;
  let orphansAdded = 0;
  const addOrphanIfEligible = async (args: {
    source_channel: "devs_shipped" | "changelog";
    permalink: string | null;
    ts: string;
    linear_key: string | null;
    feature_name: string | null;
  }) => {
    if (!args.permalink) return; // Without a permalink we can't dedupe.
    if (priorOrphans.orphans[args.permalink]) return; // Already tracked.
    const ageMs = nowMs - Number.parseFloat(args.ts) * 1000;
    if (ageMs < graceMs) return; // Inside grace window — silent.
    await upsertOrphan({
      source_channel: args.source_channel,
      ship_permalink: args.permalink,
      ship_ts: args.ts,
      linear_key: args.linear_key,
      feature_name: args.feature_name,
      first_seen_at: new Date().toISOString(),
      status: "pending",
    });
    orphansAdded += 1;
  };
  for (const hit of devsHits) {
    if (matchedLinearKeys.has(hit.linear_key)) continue;
    await addOrphanIfEligible({
      source_channel: "devs_shipped",
      permalink: hit.ship_permalink,
      ts: hit.message_ts,
      linear_key: hit.linear_key,
      feature_name: null,
    });
  }
  for (const hit of changelogHits) {
    if (hit.linear_key && matchedLinearKeys.has(hit.linear_key)) continue;
    await addOrphanIfEligible({
      source_channel: "changelog",
      permalink: hit.ship_permalink,
      ts: hit.message_ts,
      linear_key: hit.linear_key,
      feature_name: hit.feature_name,
    });
  }

  // Advance cursors to the newest ts we saw per channel. Handles the
  // empty-message case cleanly: `maxTs(null, null) === null` leaves
  // the cursor where it was so the next run picks up the same window.
  const newestDevsTs = devsHits.reduce<string | null>(
    (acc, h) => maxTs(acc, h.message_ts),
    null
  );
  const newestChangelogTs = changelogHits.reduce<string | null>(
    (acc, h) => maxTs(acc, h.message_ts),
    null
  );
  await saveShippedCursor({
    devs_shipped_ts: maxTs(cursor.devs_shipped_ts, newestDevsTs),
    changelog_ts: maxTs(cursor.changelog_ts, newestChangelogTs),
  });

  await saveEnterpriseRequestsSnapshot({
    ...snapshot,
    rows: nextRows,
    fetched_at: now,
  });

  return {
    ok: true,
    checked_devs_shipped: devsHits.length,
    checked_changelog: changelogHits.length,
    promoted: promoted.length,
    orphans_added: orphansAdded,
    fetched_at: now,
  };
}
