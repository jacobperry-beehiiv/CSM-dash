import {
  loadEnterpriseRequestsSnapshot,
  loadOrphans,
  loadShippedCursor,
  saveEnterpriseRequestsSnapshot,
  saveShippedCursor,
  upsertOrphan,
} from "../data/enterprise-requests";
import type {
  EnterpriseRequestRow,
  EnterpriseRequestsBlob,
  PromotionSource,
} from "../data/enterprise-requests-types";
import { hasDevsShippedMatch } from "../data/enterprise-requests-types";
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
 * Shipped-detection sweep — reads two Slack channels, records which
 * snapshot rows were carried by a release post, and files anything
 * that couldn't match (after a 14-day grace period) to the orphans
 * queue for admin review.
 *
 * It no longer decides any row's state. Linear does that, via
 * `linearStateToDerived`. What this sweep produces is the yes/no
 * `devs_shipped_match` flag (plus a link to the post) that sits beside
 * the state and tells a CSM whether the code is provably out.
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

/**
 * Work out what a row's ship signals say, given what we matched.
 *
 * This used to be `decidePromotion`, and it chose the row's
 * `derived_state`. It no longer does: Linear owns the state, and this
 * function's whole output is evidence — did #devs-shipped carry this
 * ticket, and where's the post.
 *
 * Returns null when nothing changes, so an idempotent re-run over the
 * same Slack window doesn't rewrite the blob.
 */
function recordShipSignals(args: {
  row: EnterpriseRequestRow;
  devsShippedHit: DevsShippedHit | null;
  changelogHit: ChangelogHit | null;
  changelogFuzzyMatch: boolean;
}): {
  devs_shipped_match: boolean;
  devs_shipped_url: string | null;
  devs_shipped_at: string | null;
  source: PromotionSource;
  ship_url: string | null;
  ship_date: string | null;
} | null {
  const { row, devsShippedHit, changelogHit, changelogFuzzyMatch } = args;

  // A changelog post is the strongest evidence we have — it's the
  // customer-facing announcement — so it wins the ship_url even when
  // #devs-shipped also carried the ticket.
  if (changelogHit) {
    const source: PromotionSource = changelogHit.linear_key
      ? "changelog"
      : changelogFuzzyMatch
        ? "changelog_fuzzy"
        : "changelog";
    const shipUrl = changelogHit.ship_permalink;
    const alreadyRecorded =
      row.promotion_source === source &&
      row.ship_url === shipUrl &&
      hasDevsShippedMatch(row) === Boolean(devsShippedHit);
    if (alreadyRecorded) return null;
    return {
      devs_shipped_match: Boolean(devsShippedHit),
      devs_shipped_url: devsShippedHit?.ship_permalink ?? null,
      devs_shipped_at: devsShippedHit?.deployed_at_iso ?? null,
      source,
      ship_url: shipUrl,
      ship_date: changelogHit.message_ts
        ? new Date(
            Number.parseFloat(changelogHit.message_ts) * 1000
          ).toISOString()
        : null,
    };
  }

  if (devsShippedHit) {
    // Already flagged against this same post — nothing to write.
    if (
      hasDevsShippedMatch(row) &&
      row.devs_shipped_url === devsShippedHit.ship_permalink
    ) {
      return null;
    }
    return {
      devs_shipped_match: true,
      devs_shipped_url: devsShippedHit.ship_permalink,
      devs_shipped_at: devsShippedHit.deployed_at_iso,
      source: "devs_shipped",
      // Only claim the ship_url when nothing better (a changelog post)
      // already set it.
      ship_url: row.ship_url ?? devsShippedHit.ship_permalink,
      ship_date: row.ship_date ?? devsShippedHit.deployed_at_iso,
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
      const signals = recordShipSignals({
        row,
        devsShippedHit: devsHit,
        changelogHit,
        changelogFuzzyMatch,
      });
      if (devsHit) matchedLinearKeys.add(devsHit.linear_key);
      if (changelogExact?.linear_key) {
        matchedLinearKeys.add(changelogExact.linear_key);
      }
      if (!signals) continue;

      // NOTE: no project-status gate any more. It existed to stop a
      // single ticket shipping out of an unfinished project from
      // claiming the whole request was Live. Nothing here claims a
      // state now — Linear does — so there is nothing to hold back.
      const nextBucket = { ...(nextRows[workspaceId] ?? {}) };
      nextBucket[issueId] = {
        ...row,
        devs_shipped_match: signals.devs_shipped_match,
        devs_shipped_url: signals.devs_shipped_url,
        devs_shipped_at: signals.devs_shipped_at,
        promotion_source: signals.source,
        promoted_at: row.promoted_at ?? now,
        ship_url: signals.ship_url,
        ship_date: signals.ship_date,
        promotion_history: [
          ...row.promotion_history,
          {
            // The row's state is unchanged by this sweep, so both ends
            // of the audit entry are the Linear-derived state. What
            // the entry records is that evidence arrived, and from
            // where — which is the thing a skeptical CSM wants to see.
            from_state: row.derived_state,
            to_state: row.derived_state,
            source: signals.source,
            at: now,
            permalink: signals.ship_url,
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
