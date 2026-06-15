/**
 * Slack @bot assign — onboard a newly-handed-off customer in one
 * modal, HubSpot-first.
 *
 * Triggered by an @-mention of the bot with the word `assign`; the
 * bot posts a button-bearing reply in-thread, the user clicks the
 * button to open the modal, and on submit we:
 *
 *   1. PATCH HubSpot — sets hubspot_owner_id (new CSM) and
 *      property_risk_level_csm_ (risk).
 *   2. Add a personal to-do to the assigned CSM's list — gives
 *      them a "you've been handed X — go say hi" reminder in their
 *      home-page checklist.
 *   3. Create a Drive folder named after the company under the
 *      shared parent folder so the CSM has a working space for
 *      onboarding docs.
 *
 * Crucially, HubSpot is canonical here. The dashboard's customer
 * book is NOT consulted for the resolution (the input is a HubSpot
 * URL or ID directly), and we DON'T write to the customer-overrides
 * KV — the next twice-daily sync will pull the new owner/risk back
 * down from HubSpot via q10600 + the Stripe-ID resolver. That keeps
 * a single source of truth and lets `@bot assign` work for accounts
 * not yet in the dashboard's book.
 *
 * The Slack-side dispatch uses the same registries as the existing
 * /update-csm + /find flows (block_actions → action_id, modal
 * submit → callback_id). See src/app/api/slack-webhook/route.ts for
 * the actual routing; this file defines the modal + handler bodies.
 */

import { applyTodoOps } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import {
  fetchHubspotCompany,
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

/** HubSpot internal name for the CSM team's risk-level property.
 *  Same property the customer detail panel reads from (q10600
 *  surfaces it as `property_risk_level_csm_`). */
const HUBSPOT_RISK_LEVEL_PROPERTY = "property_risk_level_csm_";

/** Parent folder under which all assignment folders are created.
 *  Configurable via env so we can point at a staging folder in dev. */
const DRIVE_PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

/** Days from today the default to-do due date lands on. */
const DEFAULT_TODO_DUE_OFFSET_DAYS = 3;

// ─── In-thread button (posted by app_mention handler) ─────────────────

interface ThreadContext {
  channel: string;
  thread_ts: string;
  /** The @-mentioner's email, resolved at mention time via the
   *  customer book + slack-id mapping. Round-tripped through the
   *  button's value field so the modal handler knows whose Google
   *  tokens to use for the Drive folder. */
  requester_user: string;
}

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
          "*Assign a new account?* I'll update HubSpot (owner + risk), add a to-do to the new CSM's list, and create a Drive folder under the shared parent — all from one form.",
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
            "Tip: open the company record in HubSpot first — you'll paste its URL or company ID into the form.",
        },
      ],
    },
  ];
}

// ─── HubSpot company-id parsing ───────────────────────────────────────

/**
 * Accepts any of:
 *   • Bare HubSpot company ID:           `22204103285`
 *   • Old-style URL:                     `https://app.hubspot.com/contacts/<portalId>/company/22204103285`
 *   • New-style v3 URL:                  `https://app.hubspot.com/contacts/<portalId>/record/0-2/22204103285`
 *   • Either URL with trailing `/...`, query string, etc.
 *
 * Returns the company ID string, or null if the input doesn't match
 * any of the above. The handler surfaces the null as a modal-level
 * error so the CSM sees the failure inline instead of a silent skip.
 */
export function parseHubspotCompanyInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Bare numeric ID — HubSpot company IDs are 10+ digit integers.
  if (/^\d+$/.test(trimmed)) return trimmed;
  // New-style: .../record/0-2/<id>
  const recordMatch = trimmed.match(/\/record\/0-2\/(\d+)/);
  if (recordMatch) return recordMatch[1];
  // Old-style: .../company/<id>
  const companyMatch = trimmed.match(/\/company\/(\d+)/);
  if (companyMatch) return companyMatch[1];
  return null;
}

// ─── Modal (opened on button click) ───────────────────────────────────

export function buildAssignView(
  owners: HubspotOwner[],
  threadContext: ThreadContext
): Record<string, unknown> {
  // Slack static_select cap is 100. ~50 owners in the org today,
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

  const riskOptions = RISK_LEVELS.map((r) => ({
    text: { type: "plain_text", text: r },
    value: r,
  }));

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
            text: "HubSpot is the source of truth. Dashboard catches up on the next sync (within ~12h, sooner if you hit Refresh).",
          },
        ],
      },
      {
        type: "input",
        block_id: "hubspot_company",
        label: { type: "plain_text", text: "HubSpot company URL or ID" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Paste from HubSpot's URL bar, or the bare company ID",
          },
        },
        hint: {
          type: "plain_text",
          text: "e.g. https://app.hubspot.com/contacts/123/record/0-2/22204103285 — or just 22204103285",
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
        hint: {
          type: "plain_text",
          text: "Use {company} as a placeholder for the HubSpot company name.",
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
 * block_actions handler when the user clicks the button in-thread.
 */
export async function openAssignModal(args: {
  triggerId: string;
  threadContext: ThreadContext;
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  }

  let owners: HubspotOwner[] = [];
  try {
    owners = await listHubspotOwners();
  } catch (e) {
    console.error("[slack-assign] listHubspotOwners failed", e);
    return {
      ok: false,
      error: "Couldn't load HubSpot owners — check the bot's HubSpot scope.",
    };
  }
  if (owners.length === 0) {
    return { ok: false, error: "No HubSpot owners returned." };
  }

  const view = buildAssignView(owners, args.threadContext);

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
  hubspotCompanyInput: string;
  ownerId: string;
  ownerEmail: string;
  riskLevel: RiskLevel | null;
  todoTitle: string;
  todoDueDate: string | null;
}

function readAssignForm(
  payload: ViewSubmissionPayload
): { ok: true; values: AssignFormValues } | { ok: false; errors: Record<string, string> } {
  const hubspotCompanyRaw = getTextValue(payload, "hubspot_company");
  const ownerRaw = getSelectValue(payload, "owner");
  const riskRaw = getSelectValue(payload, "risk_level");
  const todoTitle = getTextValue(payload, "todo_title");
  const todoDueDate = getDateValue(payload, "todo_due_date");

  const errors: Record<string, string> = {};
  if (!hubspotCompanyRaw) errors.hubspot_company = "HubSpot company URL or ID is required.";
  if (!ownerRaw) errors.owner = "Pick a CSM.";
  if (!todoTitle) errors.todo_title = "Add a to-do title.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // owner option value is "<id>::<email>"; split on the first "::"
  // sentinel so unusual emails still parse.
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
      hubspotCompanyInput: hubspotCompanyRaw!,
      ownerId,
      ownerEmail: ownerEmail.toLowerCase(),
      riskLevel: risk,
      todoTitle: todoTitle!,
      todoDueDate,
    },
  };
}

export const assignModalHandler: ViewSubmitHandler = async ({
  payload,
}) => {
  const form = readAssignForm(payload);
  if (!form.ok) {
    return { response_action: "errors", errors: form.errors } as ViewSubmitResponse;
  }
  const v = form.values;

  // Parse the pasted input → HubSpot company ID.
  const companyId = parseHubspotCompanyInput(v.hubspotCompanyInput);
  if (!companyId) {
    return {
      response_action: "errors",
      errors: {
        hubspot_company:
          "Couldn't read a HubSpot company ID from that. Paste either the bare ID (e.g. 22204103285) or a HubSpot URL containing it.",
      },
    } as ViewSubmitResponse;
  }

  // Verify the company exists + grab its name (for the Drive folder
  // + confirmation message). 404 = bad ID; surface inline.
  let company: { id: string; name: string | null } | null = null;
  try {
    company = await fetchHubspotCompany(companyId);
  } catch (e) {
    return {
      response_action: "errors",
      errors: {
        hubspot_company: `HubSpot lookup failed: ${
          (e instanceof Error ? e.message : String(e)).slice(0, 180)
        }`,
      },
    } as ViewSubmitResponse;
  }
  if (!company) {
    return {
      response_action: "errors",
      errors: {
        hubspot_company: `No HubSpot company with ID ${companyId} — double-check the URL or ID you pasted.`,
      },
    } as ViewSubmitResponse;
  }

  const companyName = company.name?.trim() || `company ${company.id}`;

  // Parse private_metadata for thread context + requester email.
  let threadContext: ThreadContext | null = null;
  try {
    threadContext = JSON.parse(payload.view.private_metadata ?? "{}");
  } catch {
    threadContext = null;
  }
  const requesterEmail = threadContext?.requester_user || "";

  // ── HubSpot PATCH — owner + risk in one call.
  const hubspotProps: Record<string, string> = {
    hubspot_owner_id: v.ownerId,
  };
  if (v.riskLevel) {
    hubspotProps[HUBSPOT_RISK_LEVEL_PROPERTY] = v.riskLevel;
  }
  const hubspotErrors: string[] = [];
  try {
    await patchHubspotCompanyProperties(company.id, hubspotProps);
  } catch (e) {
    hubspotErrors.push(e instanceof Error ? e.message : String(e));
  }

  // ── Personal to-do for the assigned CSM.
  const todoErrors: string[] = [];
  const now = new Date().toISOString();
  try {
    const targetUserKey = userKeyFromEmail(v.ownerEmail);
    const todo: PersonalTodo = {
      id: newTodoId(),
      title: substituteCompanyToken(v.todoTitle, companyName),
      details:
        `Auto-assigned via @bot assign by ${
          requesterEmail || "a teammate"
        }.\nHubSpot company: https://app.hubspot.com/contacts/0/record/0-2/${company.id}`,
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

  // ── Drive folder (under shared parent).
  let driveResult:
    | { ok: true; id: string; webViewLink: string; name: string }
    | { ok: false; error: string } = { ok: false, error: "skipped" };

  if (requesterEmail) {
    try {
      if (!(await hasDriveAccess(requesterEmail))) {
        driveResult = {
          ok: false,
          error:
            "Drive scope not granted yet — visit /settings/gmail and click Reconnect Google to enable the drive.file scope. The rest of the assignment landed.",
        };
      } else {
        const folder = await createDriveFolder(
          requesterEmail,
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
      hubspotCompanyId: company.id,
      assignedCsmEmail: v.ownerEmail,
      hubspotErrors,
      todoErrors,
      driveResult,
    });
  }

  // ── Ack DM to the requester.
  const ackParts: string[] = [
    `:white_check_mark: Assigned *${companyName}* to *${v.ownerEmail}*.`,
    `• HubSpot: <https://app.hubspot.com/contacts/0/record/0-2/${company.id}|company record>`,
  ];
  if (hubspotErrors.length) {
    ackParts.push(`⚠ HubSpot PATCH: ${hubspotErrors.join(" · ")}`);
  }
  if (todoErrors.length) {
    ackParts.push(`⚠ To-do: ${todoErrors.join(" · ")}`);
  }
  if (driveResult.ok) {
    ackParts.push(`• 📂 Drive folder: ${driveResult.webViewLink}`);
  } else {
    ackParts.push(`⚠ Drive: ${driveResult.error}`);
  }
  ackParts.push(
    "• Dashboard catches up on the next sync (or click Refresh in the dashboard header for sooner)."
  );

  return { _ack_message: ackParts.join("\n") };
};

// ─── Helpers ──────────────────────────────────────────────────────────

function substituteCompanyToken(template: string, companyName: string): string {
  if (!template.includes("{company}")) return template;
  return template.replace(/\{company\}/g, companyName);
}

async function postAssignmentSummary(args: {
  channel: string;
  threadTs: string;
  companyName: string;
  hubspotCompanyId: string;
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
    `:white_check_mark: *<https://app.hubspot.com/contacts/0/record/0-2/${args.hubspotCompanyId}|${args.companyName}>* assigned to *${args.assignedCsmEmail}*.`
  );
  if (args.hubspotErrors.length === 0) {
    lines.push("• HubSpot updated (owner + risk).");
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
