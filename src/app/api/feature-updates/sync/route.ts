import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { mergeFeatureUpdates, getFeatureUpdates } from "@/lib/feature-updates/store";
import { pullFeatureUpdates } from "@/lib/integrations/slack-history";

export const dynamic = "force-dynamic";
// Slack pagination + per-message users.info / chat.getPermalink calls
// can push a backfill to ~30s. Give ourselves headroom.
export const maxDuration = 120;

/**
 * POST /api/feature-updates/sync
 *
 * Reads new messages from the configured Slack channel (env var
 * SLACK_FEATURE_UPDATES_CHANNEL_ID), dedupes against the KV store by
 * Slack `ts`, and persists the merged feed.
 *
 * Auth — accepts either:
 *   • A signed-in NextAuth session (admin "Sync now" button), OR
 *   • Authorization: Bearer ${CRON_SECRET} (Vercel Cron)
 *
 * 401 when neither is present.
 *
 * On success returns: { added, total, last_synced_at, cursor_ts }.
 * On Slack/configuration failure returns 500 with the upstream error
 * message — the caller (cron or UI) is expected to surface it.
 */
export async function POST(req: Request) {
  const auth_ok = await authorize(req);
  if (!auth_ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const channelId = process.env.SLACK_FEATURE_UPDATES_CHANNEL_ID;
  if (!channelId) {
    return NextResponse.json(
      {
        error:
          "SLACK_FEATURE_UPDATES_CHANNEL_ID is not configured. Set it in .env.local and Vercel project env (channel ID, e.g. C093C6MDS1E).",
      },
      { status: 500 }
    );
  }

  try {
    const current = await getFeatureUpdates();
    // Slack's `oldest` is exclusive when `inclusive=false`, so passing
    // the most-recent stored ts only fetches strictly-newer messages.
    // On the very first run (no cursor) we omit oldest entirely and
    // let the pull take the most recent N messages.
    const incoming = await pullFeatureUpdates({
      channelId,
      oldestTs: current.cursor_ts,
      maxMessages: current.cursor_ts ? 200 : 50,
    });
    const result = await mergeFeatureUpdates({
      incoming,
      cursor_ts: incoming[incoming.length - 1]?.id ?? null,
    });
    const after = await getFeatureUpdates();
    return NextResponse.json({
      added: result.added,
      total: result.total,
      last_synced_at: after.last_synced_at,
      cursor_ts: after.cursor_ts,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

async function authorize(req: Request): Promise<boolean> {
  // Cron path — Vercel Cron sends Authorization: Bearer ${CRON_SECRET}.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) return true;
  }
  // Session path — admin clicking "Sync now" in the UI.
  const session = await auth();
  return Boolean(session?.user?.email);
}
