import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadSettings } from "@/lib/data/settings";
import { loadOverrides } from "@/lib/data/customer-overrides";
import {
  getRenewalThread,
  saveRenewalThreadIfAbsent,
  type RenewalThreadRecord,
} from "@/lib/data/renewal-threads";
import { appendActionLog } from "@/lib/data/customer-signals";
import {
  buildRenewalKickoffMessage,
  buildRenewalManualPingReply,
} from "@/lib/renewals/messages";
import { contractRenewalDate } from "@/lib/renewals/date";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";
// Bulk mode over the whole renewals visible set is bounded by the
// number of rows a CSM has selected; 240s is well over what a Slack-
// post-per-workspace run needs (each post ~250-400ms serialized, so
// a 100-row bulk is ~40s worst case). Higher than the default so a
// slow chat.postMessage response doesn't clip a large bulk.
export const maxDuration = 240;

/**
 * POST /api/renewals/kickoff-slack
 *
 * Manual entry point for the renewal-kickoff / thread-ping flow.
 * Accepts one or many workspace_ids and, for each:
 *   - If a renewal thread exists → posts a lightweight "manual ping"
 *     reply into that thread.
 *   - If not → posts the same `buildRenewalKickoffMessage` format the
 *     milestone engine uses as a new parent, and saves the thread
 *     record so future pings + the auto milestone sweeps reuse it.
 *
 * Response mirrors the pattern used by other bulk sweep endpoints:
 *   { ok, total, sent, failed, results: [{workspace_id, thread_created,
 *     thread_ts, permalink, error?}] }
 *
 * Auth: signed-in CSM team member. Not admin-gated — this is
 * everyday CSM tooling.
 */

interface Body {
  workspace_ids?: string[];
}

interface OneResult {
  workspace_id: string;
  workspace_name: string | null;
  thread_created: boolean;
  thread_ts: string | null;
  error?: string;
}

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

async function postToSlack(args: {
  channelId: string;
  text: string;
  threadTs?: string;
}): Promise<{ ts: string | null }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");
  const body: Record<string, unknown> = {
    channel: args.channelId,
    text: args.text,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (args.threadTs) body.thread_ts = args.threadTs;
  const res = await fetch(SLACK_POST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!j.ok) throw new Error(j.error ?? "chat.postMessage failed");
  return { ts: j.ts ?? null };
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json({ error: "CSM team only" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const requested = Array.isArray(body.workspace_ids)
    ? body.workspace_ids
        .filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (requested.length === 0) {
    return NextResponse.json(
      { error: "workspace_ids is required (array of non-empty strings)" },
      { status: 400 }
    );
  }

  const [customers, settings, overrides] = await Promise.all([
    loadCustomers(),
    loadSettings(),
    loadOverrides(),
  ]);
  const channelId = settings.am?.renewals_slack_channel_id?.trim() ?? "";
  if (!channelId) {
    return NextResponse.json(
      {
        error:
          "Renewals Slack channel isn't configured. Set it at /settings/slack → Renewals Slack channel.",
      },
      { status: 400 }
    );
  }
  // Index the book by workspace_id once — cheaper than repeated
  // Array.find calls when the caller selected N rows.
  const byWs = new Map<string, Customer>();
  for (const c of customers) {
    if (c.workspace_id) byWs.set(c.workspace_id, c);
  }

  // Manual pings serialize because chat.postMessage is per-workspace-
  // channel rate-limited (~1 req/sec per channel per Slack's tier
  // guidance) — a Promise.all over 50 rows would trip the limit.
  const results: OneResult[] = [];
  let sent = 0;
  let failed = 0;
  for (const workspaceId of requested) {
    const c = byWs.get(workspaceId);
    if (!c) {
      results.push({
        workspace_id: workspaceId,
        workspace_name: null,
        thread_created: false,
        thread_ts: null,
        error: "Workspace not in the customer book",
      });
      failed++;
      continue;
    }
    try {
      const stage =
        overrides[workspaceId]?.lifecycle_stage?.trim() ?? null;
      const renewalIso = contractRenewalDate(c);
      const existing = await getRenewalThread(workspaceId);
      const actorDisplay = email.split("@")[0] || "a CSM";

      let threadCreated = false;
      let ts: string | null = null;
      if (existing && existing.thread_ts) {
        const replyText = buildRenewalManualPingReply({
          customer: c,
          settings,
          renewalIso: renewalIso ?? null,
          lifecycleStage: stage,
          actorDisplay,
        });
        const r = await postToSlack({
          channelId: existing.channel_id,
          text: replyText,
          threadTs: existing.thread_ts,
        });
        ts = r.ts;
      } else {
        // No existing thread — open a new one with the same kickoff
        // shape the milestone engine uses, add an openedByLine so
        // teammates reading it later can tell it was manual.
        const kickoffText = buildRenewalKickoffMessage({
          customer: c,
          settings,
          renewalIso: renewalIso ?? new Date().toISOString(),
          lifecycleStage: stage,
          openedByLine: `_(manually opened by ${actorDisplay} from the renewals panel.)_`,
        });
        const r = await postToSlack({ channelId, text: kickoffText });
        ts = r.ts;
        if (r.ts) {
          const rec: RenewalThreadRecord = {
            channel_id: channelId,
            thread_ts: r.ts,
            opened_by: email.toLowerCase(),
            opened_at: new Date().toISOString(),
            origin: "manual",
            kickoff_context: {
              workspace_id: workspaceId,
              workspace_name: c.workspace_name ?? undefined,
              lifecycle_stage: stage,
              renewal_date: renewalIso ?? null,
              arr: c.arr ?? null,
            },
          };
          await saveRenewalThreadIfAbsent(workspaceId, rec);
          threadCreated = true;
        }
      }

      // Best-effort audit — a KV blip shouldn't roll back the Slack
      // post that already landed. Same posture as the milestone
      // engine's action-log write.
      try {
        await appendActionLog([
          {
            workspace_id: workspaceId,
            text: threadCreated
              ? `Renewal thread opened via manual ping`
              : `Manual renewal ping fired in existing thread`,
            action_kind: "renewal_manual_ping",
            created_by: email.toLowerCase(),
            metadata: {
              slack_ts: ts,
              thread_created: threadCreated,
            },
          },
        ]);
      } catch {
        // Non-fatal.
      }

      results.push({
        workspace_id: workspaceId,
        workspace_name: c.workspace_name ?? null,
        thread_created: threadCreated,
        thread_ts: ts,
      });
      sent++;
    } catch (e) {
      results.push({
        workspace_id: workspaceId,
        workspace_name: c.workspace_name ?? null,
        thread_created: false,
        thread_ts: null,
        error: e instanceof Error ? e.message : String(e),
      });
      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    total: requested.length,
    sent,
    failed,
    results,
  });
}
