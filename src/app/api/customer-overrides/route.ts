import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadOverrides, setOverride } from "@/lib/data/customer-overrides";
import {
  invalidateCustomerCache,
  loadCustomers,
} from "@/lib/data/load-customers";
import { appendActionLog } from "@/lib/data/customer-signals";
import { getRenewalThread } from "@/lib/data/renewal-threads";
import { applyTodoOps } from "@/lib/personal-todos/store";
import { userKeyFromEmail } from "@/lib/personal-todos/identity";
import {
  newTodoId,
  type PersonalTodo,
} from "@/lib/personal-todos/types";
import { nextRenewalDate } from "@/lib/renewals/date";
import { buildRenewalConfirmedReply } from "@/lib/renewals/messages";

export const dynamic = "force-dynamic";

/** Stage that trips the CSM-owned renewals "renewal confirmed" side
 *  effects. Kept as a constant so a lifecycle rename at
 *  /settings/slack doesn't silently break the hook. If admins rename
 *  the stage, we'd need to update both this constant and the
 *  DEFAULT_LIFECYCLE_STAGES list — surfaced explicitly rather than
 *  hidden behind a config lookup so the coupling is visible. */
const RENEWAL_CONFIRMED_STAGE = "Renewal Confirmed";

/** GET — current overrides map keyed by workspace_id. Lets the
 *  Renewals panel pull just the lifecycle_stage values + audit
 *  metadata without re-running loadCustomers. */
export async function GET() {
  try {
    const map = await loadOverrides();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id: string;
  interval?: "annual" | "month" | null;
  /** Update the user-facing lifecycle stage (renewals dropdown). Pass
   *  null or empty string to clear. Audit fields are stamped from the
   *  session viewer's email. */
  lifecycle_stage?: string | null;
  /** Manual expected send cadence in days. Feeds Flag A's threshold in
   *  place of the ClickHouse-inferred cadence. Pass null / 0 / empty
   *  to clear the override and fall back to inferred. Audit fields
   *  are stamped from the session viewer's email. */
  expected_send_cadence_days?: number | null;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const body = (await req.json()) as PostBody;
    if (!body.workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }

    // Capture the prior lifecycle_stage so we can detect a transition
    // TO "Renewal Confirmed" post-write. Read BEFORE setOverride so a
    // concurrent write from another isolate can't shift the baseline
    // under us — the transition fires exactly once per read-observed
    // flip, which is what the CSM-owned renewals workflow needs
    // (auto-post to pricing thread + verification todo + action_log).
    const priorMap = await loadOverrides();
    const priorLifecycleStage =
      priorMap[body.workspace_id]?.lifecycle_stage?.trim() || null;

    const patch: Parameters<typeof setOverride>[1] = {};
    if ("interval" in body) {
      patch.interval = body.interval === null ? undefined : body.interval;
    }
    if ("lifecycle_stage" in body) {
      const trimmed = body.lifecycle_stage?.trim() || "";
      patch.lifecycle_stage = trimmed || undefined;
      patch.lifecycle_stage_updated_at = trimmed
        ? new Date().toISOString()
        : undefined;
      patch.lifecycle_stage_updated_by = trimmed
        ? session?.user?.email?.toLowerCase() ?? undefined
        : undefined;
    }
    if ("expected_send_cadence_days" in body) {
      const raw = body.expected_send_cadence_days;
      const value =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0
          ? Math.floor(raw)
          : null;
      patch.expected_send_cadence_days = value ?? undefined;
      patch.expected_send_cadence_updated_at = value
        ? new Date().toISOString()
        : undefined;
      patch.expected_send_cadence_updated_by = value
        ? session?.user?.email?.toLowerCase() ?? undefined
        : undefined;
    }

    const map = await setOverride(body.workspace_id, patch);
    invalidateCustomerCache();

    // CSM-owned renewals: fire the "Renewal Confirmed" side effects
    // when the lifecycle_stage transitioned from anything-else to
    // "Renewal Confirmed" on THIS request. Idempotent — the prior
    // value gate stops a re-save from re-firing.
    if ("lifecycle_stage" in body) {
      const nextStage = body.lifecycle_stage?.trim() || "";
      if (
        nextStage === RENEWAL_CONFIRMED_STAGE &&
        priorLifecycleStage !== RENEWAL_CONFIRMED_STAGE
      ) {
        // Fire-and-forget wrapper so a Slack outage or a slow
        // personal-todos KV write doesn't stretch the user's
        // save-lifecycle click into a spinner. Errors log to console
        // but don't fail the response — the write already succeeded.
        void runRenewalConfirmedSideEffects({
          workspaceId: body.workspace_id,
          priorStage: priorLifecycleStage,
          actorEmail: session?.user?.email ?? null,
        });
      }
    }

    return NextResponse.json(map);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

async function runRenewalConfirmedSideEffects(args: {
  workspaceId: string;
  priorStage: string | null;
  actorEmail: string | null;
}): Promise<void> {
  const { workspaceId, priorStage, actorEmail } = args;
  const now = new Date().toISOString();
  const humanActor = actorEmail?.trim().toLowerCase() ?? null;

  try {
    const [customers, thread] = await Promise.all([
      loadCustomers(),
      getRenewalThread(workspaceId),
    ]);
    const customer = customers.find((c) => c.workspace_id === workspaceId);
    if (!customer) {
      console.warn(
        "[customer-overrides] renewal-confirmed side effects: customer not found",
        { workspaceId, priorStage, actorEmail: humanActor }
      );
      return;
    }

    // ── 1. Post confirmation reply into the saved pricing thread ─
    // Best-effort. If no thread exists yet (e.g. a monthly customer
    // that skipped all milestones because it was excluded from the
    // engine, or the CSM confirms mid-cycle without a kickoff), we
    // just skip this step — action_log + todo below still land.
    if (thread?.channel_id && thread.thread_ts) {
      try {
        await postSlackThreadReply({
          channelId: thread.channel_id,
          threadTs: thread.thread_ts,
          text: buildRenewalConfirmedReply({
            customer,
            csmDisplay: humanActor ?? "the CSM",
          }),
        });
      } catch (e) {
        console.warn(
          "[customer-overrides] renewal-confirmed thread reply failed",
          {
            workspaceId,
            error: e instanceof Error ? e.message : String(e),
          }
        );
      }
    }

    // ── 2. Verification todo on the owning CSM's list ────────────
    // Due-dated to the customer's renewal date so the personal-todos
    // reminder ladder (3d / 1d / 0d / -3d) nudges the CSM to confirm
    // the invoice actually landed. Only fires when we can resolve
    // an @beehiiv email for the customer — otherwise the todo has
    // nowhere to go.
    const csmEmail = customer.customer_success_manager_email;
    if (csmEmail) {
      try {
        const renewalIso = nextRenewalDate(customer);
        const dueYmd = renewalIso ? renewalIso.slice(0, 10) : null;
        const todo: PersonalTodo = {
          id: newTodoId(),
          title: `Verify ${
            customer.company_name ??
            customer.workspace_name ??
            workspaceId
          } renewal went through`,
          details: null,
          due_date: dueYmd,
          surface_at: null,
          priority: "high",
          source: "renewal_confirmed",
          source_meta: {
            workspace_id: workspaceId,
            prior_lifecycle_stage: priorStage ?? undefined,
          },
          completed_at: null,
          remind_via_slack: true,
          created_at: now,
          updated_at: now,
        };
        await applyTodoOps(userKeyFromEmail(csmEmail), [
          { type: "add", todo },
        ]);
      } catch (e) {
        console.warn(
          "[customer-overrides] renewal-confirmed todo add failed",
          {
            workspaceId,
            error: e instanceof Error ? e.message : String(e),
          }
        );
      }
    }

    // ── 3. Action log entry on the customer's Notes timeline ──────
    // Renders inline via CompanyNotes with the distinctive action_log
    // rendering (chip icon + created_by). Prior stage carried in
    // metadata so a future audit UI could reconstruct the transition.
    try {
      await appendActionLog([
        {
          workspace_id: workspaceId,
          text: `Renewal confirmed by ${humanActor ?? "the CSM"}`,
          created_by: humanActor ?? undefined,
          action_kind: "renewal_confirmed",
          metadata: {
            prior_stage: priorStage,
            new_stage: RENEWAL_CONFIRMED_STAGE,
            thread_ts: thread?.thread_ts ?? null,
            channel_id: thread?.channel_id ?? null,
          },
        },
      ]);
    } catch (e) {
      console.warn(
        "[customer-overrides] renewal-confirmed action_log failed",
        {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        }
      );
    }

    console.log("[customer-overrides] renewal-confirmed side effects done", {
      workspaceId,
      customer: customer.company_name ?? customer.workspace_name ?? null,
      prior_stage: priorStage,
      actor: humanActor,
      thread_posted: Boolean(thread?.channel_id && thread.thread_ts),
      todo_scoped_to: csmEmail ?? null,
    });
  } catch (e) {
    console.error(
      "[customer-overrides] renewal-confirmed side effects threw",
      {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      }
    );
  }
}

async function postSlackThreadReply(args: {
  channelId: string;
  threadTs: string;
  text: string;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channelId,
      thread_ts: args.threadTs,
      text: args.text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error ?? "chat.postMessage failed");
}

