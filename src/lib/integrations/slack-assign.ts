/**
 * Slack @bot assign — onboard a newly-handed-off customer in one
 * modal. Triggered by an @-mention of the bot with the word `assign`;
 * the bot posts a button-bearing reply in-thread, the user clicks it
 * to open the modal, and on submit we:
 *
 *   1. PATCH HubSpot — sets hubspot_owner_id so the new CSM owns the
 *      company in CRM.
 *   2. Write to customer-overrides KV — sets CSM, lifecycle stage,
 *      and risk level so the dashboard reflects the new state
 *      immediately (without waiting for the next sync to pull
 *      HubSpot back through q10600).
 *   3. Create a personal to-do on the assigned CSM's list — gives
 *      them a "you've been handed Acme — go say hi" reminder in
 *      their home-page checklist.
 *   4. Create a Drive folder named after the company under the
 *      shared parent folder — gives the CSM a working space for
 *      onboarding docs without the manual "make folder, set
 *      sharing" dance.
 *
 * The Slack-side dispatch uses the same registries as the existing
 * /update-csm + /find flows (block_actions → action_id, modal
 * submit → callback_id). See src/app/api/slack-webhook/route.ts for
 * the actual routing; this file defines the modal + handler bodies
 * and the helpers that wire @-mention text → button → modal context.
 */

import { loadCustomers } from "../data/load-customers";
import { setOverride } from "../data/customer-overrides";
import { loadSettings } from "../data/settings";
import { resolveLifecycleStages } from "../data/settings-types";
import { applyTodoOps } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import {
  listHubspotOwners,
  patchHubspotCompanyProperties,
  type HubspotOwner,
} from "./hubspot";
import { createDriveFolder, hasDriveAccess, folderUrl } from "./google-drive";
import type {
  ViewSubmissionPayload,
  ViewSubmitHandler,
  ViewSubmitResponse,
} from "./slack-views";
import {
  getTextValue,
  getDateValue,
  getSelectValue,
} from "./slack-views";

// ─── Constants ────────────────────────────────────────────────────────

export const ASSIGN_OPEN_BUTTON_ACTION_ID = "assign_open_modal";
export const ASSIGN_MODAL_CALLBACK_ID = "assign_modal";

const RISK_LEVELS = ["Red", "Yellow", "Light Green", "Green"] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

/** Parent folder under which all assignment folders are created.
 *  Configurable via env so we can point at a staging folder in dev. */
const DRIVE_PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

/** Days from today the default to-do due date lands on. CSMs usually
 *  want to reach out in the first few days; 3 days gives a buffer
 *  for the new CSM to read up + check the calendar. */
const DEFAULT_TODO_DUE_OFFSET_DAYS = 3;

// ─── In-thread button (posted by app_mention handler) ─────────────────

interface ThreadContext {
  channel: string;
  thread_ts: string;
  requester_user: string;
}

/** Build the chat.postMessage blocks the bot posts in-thread after
 *  an "@bot assign" mention. Single button whose `value` encodes the
 *  thread context (channel + thread_ts + requester) so the modal can
 *  reply in the right place on submit. */
export function buildAssignButtonBlocks(
  ctx: ThreadContext
): Array<Record<string, unknown>> {
  const value = JSON.stringify(ctx);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Assign a new account?* I'll update HubSpot (owner/lifecycle/risk), add a to-do to the new CSM's list, and create a Drive folder under the shared parent — all from one form.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ASSIGN_OPEN_BUTTON_ACTION_ID,
          text: { type: "plain_text", text: "📋 Open Assign form" },
          style: "primary",
          value,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "Tip: copy the *Workspace ID* from the dashboard's company panel before opening the form — Slack modals don't let me autocomplete the customer list yet.",
        },
      ],
    },
  ];
}

// ─── Modal (opened on button click) ───────────────────────────────────

/**
 * Build the assign modal's Block Kit JSON. Owners + lifecycle stages
 * are passed in (pre-loaded by the caller before `views.open` so the
 * dropdowns are populated immediately — Slack rejects empty
 * static_selects).
 *
 * `threadContext` is JSON-stringified into `private_metadata` so the
 * submit handler can post the confirmation back into the original
 * thread without re-deriving the channel.
 */
export function buildAssignView(
  owners: HubspotOwner[],
  lifecycleStages: string[],
  threadContext: ThreadContext
): Record<string, unknown> {
  // Same 100-cap as /update-csm; we have ~50 owners so this is
  // headroom not a real limit.
  const ownerOptions = owners.slice(0, 100).map((o) => ({
    text: {
      type: "plain_text",
      text: ((o.owner_name ? `${o.owner_name} ` : "") + `<${o.owner_email}>`).slice(0, 75),
    },
    // Encode email alongside owner_id so the submit handler doesn't
    // need to re-fetch the owners list to translate id → email
    // (needed to look up the assigned CSM's userKey for the to-do).
    value: `${o.owner_id}::${o.owner_email}`,
  }));

  const lifecycleOptions = lifecycleStages.slice(0, 100).map((stage) => ({
    text: { type: "plain_text", text: stage.slice(0, 75) },
    value: stage,
  }));

  const riskOptions = RISK_LEVELS.map((r) => ({
    text: { type: "plain_text", text: r },
    value: r,
  }));

  // Default due date = today + 3 days, ISO YYYY-MM-DD.
  const today = new Date();
  const due = new Date(today);
  due.setDate(due.getDate() + DEFAULT_TODO_DUE_OFFSET_DAYS);
  const dueIso = due.toISOString().slice(0, 10);

  return {
    type: "modal",
    callback_id: ASSIGN_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(threadContext),
    title: { type: "plain_text", text: "Assign new account" },
    submit: { type: "plain_text", text: "Assign" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Updates HubSpot · creates a to-do for the new CSM · drops a Drive folder under the shared parent.",
          },
        ],
      },
      {
        type: "input",
        block_id: "workspace_id",
        label: { type: "plain_text", text: "Workspace ID" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Paste from the dashboard — Copy workspace ID button",
          },
        },
        hint: {
          type: "plain_text",
          text: "UUID. Resolves to the company via the customer book.",
        },
      },
      {
        type: "input",
        block_id: "owner",
        label: { type: "plain_text", text: "Assign to CSM (HubSpot owner)" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a CSM" },
          options: ownerOptions,
        },
      },
      {
        type: "input",
        block_id: "lifecycle_stage",
        optional: true,
        label: { type: "plain_text", text: "Lifecycle stage" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a lifecycle stage" },
          options: lifecycleOptions,
        },
      },
      {
        type: "input",
        block_id: "risk_level",
        optional: true,
        label: { type: "plain_text", text: "Risk level" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a risk level" },
          options: riskOptions,
        },
      },
      {
        type: "input",
        block_id: "todo_title",
        label: { type: "plain_text", text: "First to-do for the new CSM" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: "Welcome the account — initial outreach",
          placeholder: {
            type: "plain_text",
            text: "Title for the to-do that lands on their list",
          },
        },
      },
      {
        type: "input",
        block_id: "todo_due_date",
        optional: true,
        label: { type: "plain_text", text: "To-do due date" },
        element: {
          type: "datepicker",
          action_id: "value",
          initial_date: dueIso,
        },
      },
    ],
  };
}

/**
 * Open the assign modal via Slack's views.open API. Called from the
 * block_actions handler when the user clicks the "Open Assign form"
 * button in-thread. Loads HubSpot owners + lifecycle stages up-front
 * so the dropdowns aren't empty (Slack rejects views.open with an
 * empty static_select options array).
 */
export async function openAssignModal(args: {
  triggerId: string;
  threadContext: ThreadContext;
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  }

  // Pre-load: owners + lifecycle stages.
  let owners: HubspotOwner[] = [];
  try {
    owners = await listHubspotOwners();
  } catch (e) {
    console.error("[slack-assign] listHubspotOwners failed", e);
    return { ok: false, error: "Couldn't load HubSpot owners — check the bot's HubSpot scope." };
  }
  if (owners.length === 0) {
    return { ok: false, error: "No HubSpot owners returned." };
  }

  const settings = await loadSettings();
  const lifecycleStages = resolveLifecycleStages(
    settings.am?.lifecycle_stages
  );

  const view = buildAssignView(owners, lifecycleStages, args.threadContext);

  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: args.triggerId, view }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) {
    console.error("[slack-assign] views.open failed", json);
    return { ok: false, error: json.error ?? "views.open failed" };
  }
  return { ok: true };
}

// ─── Modal submission ────────────────────────────────────────────────

interface AssignFormValues {
  workspaceId: string;
  ownerId: string;
  ownerEmail: string;
  lifecycleStage: string | null;
  riskLevel: RiskLevel | null;
  todoTitle: string;
  todoDueDate: string | null;
}

function readAssignForm(
  payload: ViewSubmissionPayload
): { ok: true; values: AssignFormValues } | { ok: false; errors: Record<string, string> } {
  const workspaceIdRaw = getTextValue(payload, "workspace_id");
  const ownerRaw = getSelectValue(payload, "owner");
  const lifecycleStage = getSelectValue(payload, "lifecycle_stage");
  const riskRaw = getSelectValue(payload, "risk_level");
  const todoTitle = getTextValue(payload, "todo_title");
  const todoDueDate = getDateValue(payload, "todo_due_date");

  const errors: Record<string, string> = {};
  if (!workspaceIdRaw) errors.workspace_id = "Workspace ID is required.";
  if (!ownerRaw) errors.owner = "Pick a CSM.";
  if (!todoTitle) errors.todo_title = "Add a to-do title.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // owner option value is "<id>::<email>"; split on the first "::"
  // sentinel so unusual emails (no "+" or "=") still parse.
  const sepIdx = (ownerRaw ?? "").indexOf("::");
  const ownerId = sepIdx > 0 ? ownerRaw!.slice(0, sepIdx) : ownerRaw!;
  const ownerEmail = sepIdx > 0 ? ownerRaw!.slice(sepIdx + 2) : "";

  const risk: RiskLevel | null =
    riskRaw && (RISK_LEVELS as readonly string[]).includes(riskRaw)
      ? (riskRaw as RiskLevel)
      : null;

  return {
    ok: true,
    values: {
      workspaceId: workspaceIdRaw!.trim(),
      ownerId,
      ownerEmail: ownerEmail.toLowerCase(),
      lifecycleStage,
      riskLevel: risk,
      todoTitle: todoTitle!,
      todoDueDate,
    },
  };
}

/** Submission handler — registered in slack-views.ts's dispatch table. */
export const assignModalHandler: ViewSubmitHandler = async ({
  payload,
  userKey: requesterUserKey,
}) => {
  const form = readAssignForm(payload);
  if (!form.ok) {
    return { response_action: "errors", errors: form.errors } as ViewSubmitResponse;
  }
  const v = form.values;

  // Resolve workspace_id → customer (needed for company_name, the
  // canonical hubspot_company_id, and the Drive folder name).
  const customers = await loadCustomers();
  const customer = customers.find(
    (c) => c.workspace_id?.toLowerCase() === v.workspaceId.toLowerCase()
  );
  if (!customer) {
    return {
      response_action: "errors",
      errors: {
        workspace_id: `No customer found for workspace_id "${v.workspaceId}". Use the Copy workspace ID button on the dashboard.`,
      },
    } as ViewSubmitResponse;
  }
  if (!customer.hubspot_company_id) {
    return {
      response_action: "errors",
      errors: {
        workspace_id: `${customer.company_name ?? customer.workspace_name ?? v.workspaceId} has no hubspot_company_id on file — can't reach HubSpot for it.`,
      },
    } as ViewSubmitResponse;
  }

  // Parse private_metadata to find where to post the confirmation.
  let threadContext: ThreadContext | null = null;
  try {
    threadContext = JSON.parse(payload.view.private_metadata ?? "{}");
  } catch {
    threadContext = null;
  }

  const companyName =
    customer.company_name ?? customer.workspace_name ?? "the company";
  const requesterEmailFromMeta = threadContext?.requester_user ?? null;

  // ── HubSpot PATCH (owner only — the rest go via customer-overrides
  // so the dashboard reflects them immediately). Worth the direct
  // hit on owner because hubspot_owner_id is HubSpot's canonical
  // assignment field and the dashboard's CSM column reads from it.
  const hubspotErrors: string[] = [];
  try {
    await patchHubspotCompanyProperties(customer.hubspot_company_id, {
      hubspot_owner_id: v.ownerId,
    });
  } catch (e) {
    hubspotErrors.push(
      `HubSpot owner: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // ── Customer overrides — CSM + lifecycle + risk. Writes immediately
  // visible in the dashboard. Risk lives in the field_overrides bag
  // since it's a mappable field (per src/lib/data/field-mappings-types.ts).
  const now = new Date().toISOString();
  const fieldOverrides: Record<string, { value: string | null; updated_at: string; updated_by: string }> = {};
  if (v.riskLevel) {
    fieldOverrides.property_risk_level = {
      value: v.riskLevel,
      updated_at: now,
      updated_by: requesterEmailFromMeta ?? requesterUserKey,
    };
  }
  try {
    await setOverride(customer.workspace_id!, {
      customer_success_manager: ownerNameFromEmail(v.ownerEmail),
      customer_success_manager_email: v.ownerEmail,
      csm_refreshed_at: now,
      csm_refreshed_by: requesterEmailFromMeta ?? requesterUserKey,
      lifecycle_stage: v.lifecycleStage ?? undefined,
      lifecycle_stage_updated_at: v.lifecycleStage ? now : undefined,
      lifecycle_stage_updated_by: v.lifecycleStage
        ? requesterEmailFromMeta ?? requesterUserKey
        : undefined,
      ...(Object.keys(fieldOverrides).length > 0
        ? { field_overrides: fieldOverrides }
        : {}),
    });
  } catch (e) {
    hubspotErrors.push(
      `Override write: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // ── Personal to-do for the assigned CSM.
  const todoErrors: string[] = [];
  try {
    const targetUserKey = userKeyFromEmail(v.ownerEmail);
    const todo: PersonalTodo = {
      id: newTodoId(),
      title: substituteCompanyToken(v.todoTitle, companyName),
      details:
        `Account auto-assigned via @bot assign by ${
          requesterEmailFromMeta ?? "a teammate"
        }.\nWorkspace: ${customer.workspace_id}`,
      due_date: v.todoDueDate,
      surface_at: null,
      priority: null,
      source: "slack_slash",
      source_meta: { slack_user_id: payload.user.id },
      completed_at: null,
      remind_via_slack: true,
      created_at: now,
      updated_at: now,
    };
    await applyTodoOps(targetUserKey, [{ type: "add", todo }]);
  } catch (e) {
    todoErrors.push(e instanceof Error ? e.message : String(e));
  }

  // ── Drive folder (under the shared parent). Skipped with a clear
  // hint when the requester hasn't reconsented with the drive.file
  // scope yet — the rest of the assignment still lands.
  let driveResult:
    | { ok: true; id: string; webViewLink: string; name: string }
    | { ok: false; error: string } = { ok: false, error: "skipped" };

  if (requesterEmailFromMeta) {
    try {
      if (!(await hasDriveAccess(requesterEmailFromMeta))) {
        driveResult = {
          ok: false,
          error:
            "Drive scope not granted yet — visit /settings/gmail and click Reconnect Google to enable the drive.file scope. The rest of the assignment landed.",
        };
      } else {
        const folder = await createDriveFolder(
          requesterEmailFromMeta,
          DRIVE_PARENT_FOLDER_ID,
          companyName
        );
        driveResult = {
          ok: true,
          id: folder.id,
          webViewLink: folder.webViewLink ?? folderUrl(folder.id),
          name: folder.name,
        };
      }
    } catch (e) {
      driveResult = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } else {
    driveResult = {
      ok: false,
      error: "Couldn't determine requester email — Drive folder skipped.",
    };
  }

  // ── Compose confirmation message + post back in the thread.
  if (threadContext?.channel && threadContext.thread_ts) {
    await postAssignmentSummary({
      channel: threadContext.channel,
      threadTs: threadContext.thread_ts,
      companyName,
      assignedCsmEmail: v.ownerEmail,
      hubspotErrors,
      todoErrors,
      driveResult,
    });
  }

  // ── Ack DM to the requester (Slack closes the modal silently
  // otherwise; the DM is permanent confirmation in their DM history).
  const ackParts: string[] = [
    `:white_check_mark: Assigned *${companyName}* to *${v.ownerEmail}*.`,
  ];
  if (hubspotErrors.length) ackParts.push(`⚠ HubSpot: ${hubspotErrors.join(" · ")}`);
  if (todoErrors.length) ackParts.push(`⚠ To-do: ${todoErrors.join(" · ")}`);
  if (driveResult.ok) {
    ackParts.push(`📂 Drive folder: ${driveResult.webViewLink}`);
  } else {
    ackParts.push(`⚠ Drive: ${driveResult.error}`);
  }

  return { _ack_message: ackParts.join("\n") };
};

// ─── Helpers ──────────────────────────────────────────────────────────

/** Synthesize a CSM handle ("Jacob_Perry") from an owner email.
 *  Matches the convention used in q10600 / the rest of the app for
 *  customer_success_manager. Falls back to the email prefix when
 *  parsing fails — never returns empty. */
function ownerNameFromEmail(email: string): string {
  const prefix = email.split("@")[0] ?? email;
  return prefix
    .split(".")
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p))
    .join("_");
}

/** Substitute `{company}` placeholder in to-do titles with the
 *  resolved company name. Empty when neither is set; safe pass-
 *  through when no placeholder is present. */
function substituteCompanyToken(template: string, companyName: string): string {
  if (!template.includes("{company}")) return template;
  return template.replace(/\{company\}/g, companyName);
}

async function postAssignmentSummary(args: {
  channel: string;
  threadTs: string;
  companyName: string;
  assignedCsmEmail: string;
  hubspotErrors: string[];
  todoErrors: string[];
  driveResult:
    | { ok: true; id: string; webViewLink: string; name: string }
    | { ok: false; error: string };
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const lines: string[] = [];
  lines.push(
    `:white_check_mark: *${args.companyName}* assigned to *${args.assignedCsmEmail}*.`
  );
  if (args.hubspotErrors.length === 0) {
    lines.push("• HubSpot owner updated.");
  } else {
    lines.push(`• ⚠ HubSpot: ${args.hubspotErrors.join(" · ")}`);
  }
  if (args.todoErrors.length === 0) {
    lines.push("• To-do added to their list.");
  } else {
    lines.push(`• ⚠ To-do: ${args.todoErrors.join(" · ")}`);
  }
  if (args.driveResult.ok) {
    lines.push(
      `• Drive folder: <${args.driveResult.webViewLink}|${args.driveResult.name}>`
    );
  } else {
    lines.push(`• ⚠ Drive: ${args.driveResult.error}`);
  }
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: args.channel,
        thread_ts: args.threadTs,
        text: lines.join("\n"),
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
  } catch (e) {
    console.warn(
      "[slack-assign] postAssignmentSummary failed",
      e instanceof Error ? e.message : e
    );
  }
}
