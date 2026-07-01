import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  fetchMessageBody,
  GmailReadScopeError,
  listMessageIds,
} from "@/lib/integrations/gmail-read";
import { parseSybillRecap } from "@/lib/integrations/sybill-parser";
import {
  appendRunRecord,
  getCsmState,
  loadIngestState,
  markMessageProcessed,
  saveIngestState,
  type SybillRunRecord,
} from "@/lib/data/sybill-ingest-state";
import { userKeyFromEmail } from "@/lib/personal-todos/identity";
import { applyTodoOps } from "@/lib/personal-todos/store";
import { newTodoId, type PersonalTodo } from "@/lib/personal-todos/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/csm/sybill/sync
 *
 * Manual button on /settings/sybill triggers this endpoint. Walks
 * the viewer's Gmail for recent emails from @sybill.ai, parses each
 * one's "Action items" section, and creates a personal to-do per
 * action item.
 *
 * Dedup: per-CSM KV row tracks every processed Gmail message id, so
 * clicking Sync twice doesn't re-create the same to-dos.
 *
 * Auth: signed-in viewer + `sybill-ingest` feature flag.
 *
 * Response:
 *   { ok, scanned, todos_created,
 *     skipped_already_processed, skipped_no_action_items,
 *     errors, last_sync_at, recent_runs: [latest 5] }
 */

const SYBILL_QUERY = "from:@sybill.ai newer_than:30d -in:drafts";
const MAX_MESSAGES_PER_SWEEP = 50;
const TITLE_MAX_LEN = 200;

export async function POST() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("sybill-ingest", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }

  const ran_at = new Date().toISOString();
  const errors: string[] = [];
  let messages_scanned = 0;
  let messages_skipped_already_processed = 0;
  let messages_no_action_items = 0;
  let todos_created = 0;

  let messageIds: string[];
  try {
    messageIds = await listMessageIds(email, SYBILL_QUERY, MAX_MESSAGES_PER_SWEEP);
  } catch (e) {
    if (e instanceof GmailReadScopeError) {
      return NextResponse.json(
        {
          error:
            "Gmail token lacks readonly scope — re-connect Google at /settings/gmail and retry.",
          needs_reconsent: true,
        },
        { status: 403 }
      );
    }
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[sybill/sync] Gmail messages.list failed", { email, msg });
    return NextResponse.json(
      { error: `Couldn't search Gmail: ${msg}` },
      { status: 502 }
    );
  }

  const blob = await loadIngestState();
  const csmState = getCsmState(blob, email);
  const userKey = userKeyFromEmail(email);

  for (const id of messageIds) {
    messages_scanned++;
    if (csmState.processed[id]) {
      messages_skipped_already_processed++;
      continue;
    }
    let body;
    try {
      body = await fetchMessageBody(email, id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.error("[sybill/sync] fetchMessageBody failed", {
        email,
        message_id: id,
        msg,
      });
      if (errors.length < 5) errors.push(`fetch ${id}: ${msg.slice(0, 120)}`);
      continue;
    }
    const recap = parseSybillRecap({
      subject: body.subject ?? "",
      html: body.html,
      text: body.text,
    });
    // Mark processed regardless of parse outcome — re-attempting on
    // every subsequent sweep is wasted work, and a Sybill email that
    // never had a parseable action-item block won't grow one later.
    markMessageProcessed(csmState, id, ran_at);
    if (!recap) {
      messages_no_action_items++;
      continue;
    }

    // Base context block shared across every to-do we create from
    // this recap — call title, contact, and the Sybill deep link.
    // Per-item description gets appended on top of this so the
    // detail block reads "meeting context + specific action."
    const contextParts: string[] = [`Call recap: ${recap.title}`];
    if (recap.contact_hint) contextParts.push(`Contact: ${recap.contact_hint}`);
    if (recap.call_url) contextParts.push(`View call: ${recap.call_url}`);
    const contextBlock = contextParts.join("\n");

    const todos: PersonalTodo[] = recap.action_items.map((item) => {
      const titleRaw = item.title;
      const title =
        titleRaw.length > TITLE_MAX_LEN
          ? `${titleRaw.slice(0, TITLE_MAX_LEN - 1)}…`
          : titleRaw;
      const detailsSections: string[] = [];
      if (item.details) detailsSections.push(item.details);
      if (item.owner) detailsSections.push(`Sybill-attributed to: ${item.owner}`);
      detailsSections.push(contextBlock);
      return {
        id: newTodoId(),
        title,
        details: detailsSections.join("\n\n"),
        due_date: null,
        surface_at: null,
        priority: null,
        source: "sybill_callrecap",
        source_meta: {
          gmail_message_id: id,
          sybill_call_url: recap.call_url,
        },
        completed_at: null,
        // Sybill items show up via the normal to-do list; no need
        // to start the 4-stage Slack reminder ladder on top of an
        // already-noisy ingest.
        remind_via_slack: false,
        created_at: ran_at,
        updated_at: ran_at,
      };
    });

    try {
      await applyTodoOps(
        userKey,
        todos.map((todo) => ({ type: "add", todo }))
      );
      todos_created += todos.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.error("[sybill/sync] applyTodoOps failed", {
        email,
        message_id: id,
        msg,
      });
      if (errors.length < 5) errors.push(`todos ${id}: ${msg.slice(0, 120)}`);
    }
  }

  const record: SybillRunRecord = {
    ran_at,
    messages_scanned,
    messages_skipped_already_processed,
    messages_no_action_items,
    todos_created,
    errors,
  };
  appendRunRecord(csmState, record);
  await saveIngestState(blob);

  return NextResponse.json({
    ok: true,
    ran_at,
    scanned: messages_scanned,
    todos_created,
    skipped_already_processed: messages_skipped_already_processed,
    skipped_no_action_items: messages_no_action_items,
    errors,
    last_sync_at: csmState.last_sync_at,
    recent_runs: csmState.recent_runs.slice(0, 5),
  });
}

/** GET surfaces the CSM's current state without running a sweep —
 *  /settings/sybill calls this on page mount to show the last-run
 *  summary + recent activity log. */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("sybill-ingest", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }
  const blob = await loadIngestState();
  const csmState = getCsmState(blob, email);
  return NextResponse.json({
    last_sync_at: csmState.last_sync_at ?? null,
    recent_runs: csmState.recent_runs.slice(0, 10),
    processed_count: Object.keys(csmState.processed).length,
  });
}
