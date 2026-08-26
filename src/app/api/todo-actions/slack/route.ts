import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadEffectiveTodoSourceConfigs } from "@/lib/data/todo-source-configs";
import { applyTemplate } from "@/lib/data/todo-source-configs";
import {
  resolveTodoAction,
  type AutomatedSource,
} from "@/lib/data/todo-source-configs-types";
import { postSlackMessage } from "@/lib/integrations/slack";
import { appendActionLog } from "@/lib/data/customer-signals";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/todo-actions/slack
 *
 * Fires the Slack-action variant of a todo's registry binding. Body:
 *   {
 *     todo_id: string,            // for audit trail only; not looked up
 *     workspace_id?: string,      // customer resolution key #1
 *     hubspot_company_id?: string,// customer resolution key #2
 *     source: AutomatedSource,    // maps back to the registry entry
 *     variant_key?: string | null // per-source variant slug
 *   }
 *
 * The message and channel come from the SERVER'S read of the registry
 * — never from the request body — so a compromised client can't spray
 * arbitrary Slack channels. The client only tells us WHICH todo it is
 * (source + variant), and we look up the corresponding action.
 *
 * Merge tags in the message template:
 *   {{company_name}} — customer.company_name ?? workspace_name
 *   {{workspace_url}} — deep link to /account/[ws]
 *   {{workspace_id}} — raw id
 *   {{arr}} — formatted ARR
 *   {{csm_email}} — the signed-in CSM
 *   {{milestone_days}} — for renewal_milestone
 *   {{playbook_step}} — for slack_assign
 *   {{prior_stage}} — for renewal_confirmed
 * Unknown tags stay in place so a typo doesn't blank the message.
 *
 * Auth: signed-in session (any CSM). Not scoped by CSM book — any CSM
 * can trigger any action button.
 */

interface Body {
  todo_id?: string;
  workspace_id?: string | null;
  hubspot_company_id?: string | null;
  source?: string;
  variant_key?: string | null;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const email = session?.user?.email?.toLowerCase() ?? null;
    if (!email) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }
    const body = (await req.json()) as Body;
    if (!body.source) {
      return NextResponse.json(
        { error: "Missing source" },
        { status: 400 }
      );
    }

    // Load config + resolve action. If the registry says "no action"
    // for this source/variant, reject — the client shouldn't have
    // rendered a button in that case.
    const cfgs = await loadEffectiveTodoSourceConfigs();
    const cfg = cfgs[body.source as AutomatedSource];
    if (!cfg) {
      return NextResponse.json(
        { error: `Unknown source: ${body.source}` },
        { status: 400 }
      );
    }
    const action = resolveTodoAction(cfg, body.variant_key ?? null);
    if (action.kind !== "slack") {
      return NextResponse.json(
        { error: `Configured action is ${action.kind}, not slack` },
        { status: 400 }
      );
    }

    // Resolve the customer for merge-tag context. Workspace_id wins;
    // hubspot_company_id fallback matches the slack_assign case where
    // the todo was spawned before we knew the workspace.
    const wsId = body.workspace_id?.trim() ?? "";
    const hsId = body.hubspot_company_id?.trim() ?? "";
    if (!wsId && !hsId) {
      return NextResponse.json(
        { error: "Missing workspace_id or hubspot_company_id" },
        { status: 400 }
      );
    }
    const all = await loadCustomers();
    const customer = all.find((c: Customer) => {
      if (wsId && c.workspace_id === wsId) return true;
      if (hsId && c.hubspot_company_id != null && String(c.hubspot_company_id) === hsId) {
        return true;
      }
      return false;
    });
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const message = applyTemplate(action.message_template, {
      company_name: customer.company_name ?? customer.workspace_name ?? null,
      workspace_id: customer.workspace_id ?? null,
      workspace_url: customer.workspace_id
        ? `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/account/${encodeURIComponent(
            customer.workspace_id
          )}`
        : null,
      arr: customer.arr != null ? `$${Math.round(customer.arr).toLocaleString()}` : null,
      csm_email: email,
      milestone_days:
        body.source === "renewal_milestone" && body.variant_key
          ? body.variant_key
          : null,
      playbook_step:
        body.source === "slack_assign" ? body.variant_key ?? null : null,
      prior_stage: null,
    }).trim();

    if (!message) {
      return NextResponse.json(
        { error: "Message rendered empty — check the merge tags in the template" },
        { status: 400 }
      );
    }

    try {
      await postSlackMessage({ channel: action.channel_id, text: message });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error("[todo-actions/slack] postSlackMessage failed", reason);
      return NextResponse.json(
        { error: `Slack API rejected the post: ${reason}` },
        { status: 502 }
      );
    }

    // Log to the customer's action stream so a scroll through Notes
    // shows the Slack post that fired against this account — same
    // pattern as the Draft outreach button + Juliet flag actions.
    // Non-blocking; a log failure doesn't undo a successful send.
    if (customer.workspace_id) {
      try {
        await appendActionLog([
          {
            workspace_id: customer.workspace_id,
            text: `Posted Slack action to ${action.channel_id}${
              body.variant_key ? ` (variant ${body.variant_key})` : ""
            }: ${message.slice(0, 200)}${message.length > 200 ? "…" : ""}`,
            created_by: email,
            action_kind: "todo_slack_action",
            metadata: {
              source: body.source,
              variant_key: body.variant_key ?? null,
              channel_id: action.channel_id,
              todo_id: body.todo_id ?? null,
            },
          },
        ]);
      } catch (e) {
        console.warn("[todo-actions/slack] action log append failed", e);
      }
    }

    return NextResponse.json({ ok: true, channel: action.channel_id });
  } catch (error) {
    console.error("[todo-actions/slack] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
