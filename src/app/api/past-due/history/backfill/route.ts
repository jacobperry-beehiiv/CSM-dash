import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { kvGet, kvSet } from "@/lib/storage/kv";
import type {
  PastDueHistoryEntry,
  PastDueHistoryMap,
} from "@/lib/data/past-due-history-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/past-due/history/backfill
 *
 *   { mode: "merge" | "replace", data: { [customer_id]: PastDueHistoryEntry } }
 *
 * One-shot import for the historical episode log. Used to seed the
 * dashboard from offline payment-fails reports (weekly snapshots
 * collected outside the live sync). Subsequent reconciliations from
 * the forward-only sweep keep merging fresh state on top.
 *
 * Modes:
 *   • merge   — existing customers keep their episodes; incoming
 *               episodes are appended UNLESS an existing episode
 *               shares the same `episode_started_at` (dedupe).
 *               New customers are added.
 *   • replace — wipes the existing KV and uses the incoming map
 *               verbatim.
 *
 * Auth: signed-in session only. Stores the viewer email as the
 * backfill operator so future audits can trace where the data came
 * from. This is a destructive admin action; the cron bearer path
 * is intentionally NOT honored here.
 */

const KEY = "csm:past-due-history:v1";

interface PostBody {
  mode?: "merge" | "replace";
  data?: PastDueHistoryMap;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mode = body.mode ?? "merge";
  if (mode !== "merge" && mode !== "replace") {
    return NextResponse.json(
      { error: "mode must be 'merge' or 'replace'" },
      { status: 400 }
    );
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return NextResponse.json(
      { error: "data must be an object keyed by customer_id" },
      { status: 400 }
    );
  }

  // Light validation — every entry should at least have an episodes
  // array. Anything missing fields gets surfaced as a count, not a
  // hard error, so a partial import doesn't reject the whole batch.
  let valid = 0;
  let invalid = 0;
  const incoming: PastDueHistoryMap = {};
  for (const [cid, raw] of Object.entries(data)) {
    if (!raw || typeof raw !== "object") {
      invalid++;
      continue;
    }
    const entry = raw as Partial<PastDueHistoryEntry>;
    if (!Array.isArray(entry.episodes)) {
      invalid++;
      continue;
    }
    incoming[cid] = {
      customer_id: entry.customer_id ?? cid,
      email: entry.email ?? null,
      workspace_name: entry.workspace_name ?? null,
      customer_success_manager: entry.customer_success_manager ?? null,
      episodes: entry.episodes.filter(
        (ep) =>
          ep &&
          typeof ep.episode_started_at === "string" &&
          ep.episode_started_at.length > 0
      ),
      last_observed_at: entry.last_observed_at ?? new Date().toISOString(),
    };
    valid++;
  }

  let next: PastDueHistoryMap;
  let added_customers = 0;
  let merged_customers = 0;
  let added_episodes = 0;
  if (mode === "replace") {
    next = incoming;
    added_customers = Object.keys(incoming).length;
    added_episodes = Object.values(incoming).reduce(
      (s, e) => s + e.episodes.length,
      0
    );
  } else {
    next = { ...((await kvGet<PastDueHistoryMap>(KEY)) ?? {}) };
    for (const [cid, entry] of Object.entries(incoming)) {
      const existing = next[cid];
      if (!existing) {
        next[cid] = entry;
        added_customers++;
        added_episodes += entry.episodes.length;
        continue;
      }
      merged_customers++;
      // Dedupe by episode_started_at — assume two episodes that share
      // a start date are the same one regardless of source.
      const seen = new Set(
        existing.episodes.map((ep) => ep.episode_started_at)
      );
      for (const ep of entry.episodes) {
        if (seen.has(ep.episode_started_at)) continue;
        existing.episodes.push(ep);
        seen.add(ep.episode_started_at);
        added_episodes++;
      }
      existing.episodes.sort((a, b) =>
        a.episode_started_at.localeCompare(b.episode_started_at)
      );
      // Refresh stable metadata if the incoming version has fresher info.
      existing.email = entry.email ?? existing.email;
      existing.workspace_name =
        entry.workspace_name ?? existing.workspace_name;
      existing.customer_success_manager =
        entry.customer_success_manager ?? existing.customer_success_manager;
    }
  }

  await kvSet<PastDueHistoryMap>(KEY, next);
  return NextResponse.json({
    ok: true,
    mode,
    operator: session.user.email,
    valid_incoming: valid,
    invalid_incoming: invalid,
    added_customers,
    merged_customers,
    added_episodes,
    total_customers_after: Object.keys(next).length,
  });
}
