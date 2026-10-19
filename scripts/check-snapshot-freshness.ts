/**
 * Fail the sync workflow when a snapshot has gone stale.
 *
 * ─── Why this exists ──────────────────────────────────────────────
 * The cohort loop in scripts/sync.ts soft-fails per cohort on purpose:
 * one bad question must not stop the book of business from shipping.
 * The cost of that choice is that a PERMANENTLY broken question looks
 * exactly like a healthy run — exit 0, workflow green, every other
 * file committed as normal.
 *
 * That is not hypothetical. Metabase q24620's source table was dropped
 * on 2026-10-02; the sync went green twice a day for seventeen days
 * while the dashboard served the same Oct-2 rows, and it surfaced only
 * because somebody eventually distrusted the numbers by eye.
 *
 * So this runs as its own step AFTER the commit — never before, or a
 * single stale cohort would block the good snapshots from being pushed,
 * which is the failure mode the soft-fail was protecting against in the
 * first place. It inspects what actually landed on disk rather than
 * whether sync threw, so it catches staleness from any cause.
 */
import { readCohortSnapshot } from "../src/lib/data/cohort-snapshots";

/** Matches SNAPSHOT_STALE_AFTER_MS in src/lib/engines/am-cohorts.ts.
 *  Sync runs 08:00 + 16:00 UTC, so the normal worst case is ~16h; 36h
 *  absorbs one missed run without crying wolf. */
const STALE_AFTER_HOURS = 36;

const COHORTS = ["past-due", "approaching-enterprise"] as const;

async function main() {
  const problems: string[] = [];
  const ok: string[] = [];

  for (const basename of COHORTS) {
    let snap: Awaited<ReturnType<typeof readCohortSnapshot>> = null;
    try {
      snap = await readCohortSnapshot(basename);
    } catch (e) {
      problems.push(
        `${basename}: unreadable (${e instanceof Error ? e.message : e})`
      );
      continue;
    }
    if (!snap) {
      problems.push(`${basename}: missing — sync has never written it`);
      continue;
    }
    const ms = Date.parse(snap.generated_at);
    if (!Number.isFinite(ms)) {
      problems.push(`${basename}: unparseable generated_at "${snap.generated_at}"`);
      continue;
    }
    const hours = (Date.now() - ms) / 3_600_000;
    const origin = snap.source ?? (snap.question_id ? `q${snap.question_id}` : "unknown source");
    const line = `${basename}: ${hours.toFixed(1)}h old, ${snap.row_count} rows (${origin})`;
    if (hours > STALE_AFTER_HOURS) problems.push(line);
    else ok.push(line);
  }

  for (const line of ok) console.error(`  ok   ${line}`);
  for (const line of problems) console.error(`  STALE ${line}`);

  if (problems.length > 0) {
    console.error(
      `\n::error::${problems.length} snapshot(s) older than ${STALE_AFTER_HOURS}h. ` +
        `The sync job is green but the data is not refreshing — check the ` +
        `"Sync + encrypt snapshot" step log for a soft-failed cohort.`
    );
    process.exitCode = 1;
    return;
  }
  console.error(`snapshot-freshness: all ${COHORTS.length} cohorts within ${STALE_AFTER_HOURS}h.`);
}

main().catch((e) => {
  console.error("snapshot-freshness: check itself failed:", e);
  process.exitCode = 1;
});
