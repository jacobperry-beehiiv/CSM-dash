import { NextResponse, after } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import { applyTodoOps, getTodosForUser } from "@/lib/personal-todos/store";
import { userKeyFromEmail } from "@/lib/personal-todos/identity";
import { buildAssignTodoSequence } from "@/lib/integrations/slack-assign";
import { appendActionLog } from "@/lib/data/customer-signals";
import { loadSettings } from "@/lib/data/settings";
import { resolveLifecycleStepStages } from "@/lib/lifecycle/step-stage-config";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import type { LifecycleStep } from "@/lib/lifecycle/card";

export const dynamic = "force-dynamic";

/**
 * POST /api/lifecycle/backfill-onboarding
 *
 * One-off recovery for a customer sitting on the Onboarding board with
 * an empty checklist because Slack's "@bot assign" flow was never run
 * for them (pre-dates that workflow, or the account was added to
 * HubSpot some other way) — see the button that renders in place of
 * the checklist on a card with zero matched steps. Builds the exact
 * same ONBOARDING_PLAYBOOK sequence @bot assign would have created,
 * dated from today, on the assigned CSM's own personal to-do list.
 *
 * Restricted to the customer's own assigned CSM (same ownership rule
 * as toggling the checklist itself — LifecycleCard.editable) and to
 * the lifecycle-board feature flag, same allowlist as the rest of the
 * board.
 *
 * Body: { workspace_id: string }
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("lifecycle-board", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { workspace_id?: unknown };
  try {
    body = (await req.json()) as { workspace_id?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId =
    typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id required" },
      { status: 400 }
    );
  }

  try {
    const all = await loadCustomers();
    const customer = all.find((c) => c.workspace_id === workspaceId);
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    const csmEmail = customer.customer_success_manager_email ?? "";
    if (
      !csmEmail ||
      csmEmail.trim().toLowerCase() !== email.trim().toLowerCase()
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!customer.hubspot_company_id) {
      return NextResponse.json(
        { error: "This customer has no HubSpot company id on file." },
        { status: 400 }
      );
    }

    const targetUserKey = userKeyFromEmail(email);

    // Same idempotency check @bot assign itself uses — belt-and-
    // suspenders. The button only renders when the card already has
    // zero matched steps, but a second tab or double-click shouldn't
    // seed the sequence twice.
    const existing = await getTodosForUser(targetUserKey);
    const openMatches = existing.filter(
      (t) =>
        t.source === "slack_assign" &&
        t.source_meta?.hubspot_company_id === customer.hubspot_company_id &&
        t.completed_at === null
    );
    if (openMatches.length > 0) {
      return NextResponse.json(
        { error: "This customer already has an onboarding checklist." },
        { status: 409 }
      );
    }

    const companyName =
      customer.company_name ?? customer.workspace_name ?? "This customer";
    const todos = buildAssignTodoSequence({
      companyName,
      hubspotCompanyId: customer.hubspot_company_id,
      requesterEmail: email,
      flow: "Onboarding",
      slackUserId: "web-backfill",
      via: "the Lifecycle board's backfill button",
    });
    await applyTodoOps(
      targetUserKey,
      todos.map((todo) => ({ type: "add" as const, todo }))
    );

    after(() =>
      appendActionLog([
        {
          workspace_id: workspaceId,
          text: `Backfilled onboarding checklist (${todos.length} steps) from the Lifecycle board`,
          created_by: email,
          action_kind: "lifecycle_onboarding_backfill",
        },
      ])
    );

    const settings = await loadSettings();
    const stepStages = resolveLifecycleStepStages(
      settings.lifecycle_step_stages
    );
    const steps: LifecycleStep[] = todos
      .map((t) => ({
        id: t.id,
        title: t.title,
        completed: false,
        due_date: t.due_date,
        stage: stepStages[t.source_meta?.playbook_step ?? ""] ?? null,
      }))
      .sort((a, b) => {
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      });

    return NextResponse.json({ steps });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
