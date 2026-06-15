/**
 * Slack @bot assign — onboard a newly-handed-off customer in one modal,
 * HubSpot-first.
 *
 * Three modal fields only:
 *   1. CSM (filtered to the CSM team — owners who have at least one
 *      customer in q10600's book of business, not every HubSpot owner)
 *   2. Account status (Live or Onboarding)
 *   3. HubSpot company URL or ID
 *
 * On submit:
 *   • PATCH HubSpot — hubspot_owner_id (selected CSM),
 *     property_company_status (Live/Onboarding from the toggle),
 *     property_risk_level_csm_ ("Light Green" — hardcoded; CSMs can
 *     override later if they think it's warranted).
 *   • Create Drive folder named after the company under the shared
 *     parent (requester's Google account; drive.file scope).
 *   • Schedule a to-do sequence on the assigned CSM's personal list:
 *      - "Onboarding" → 16-step playbook spanning ~90 days
 *      - "Live" → 4-step get-up-to-speed sequence
 *     Each todo has a `surface_at` offset so they don't all dump into
 *     the CSM's list on day one — only the next-up tasks are visible.
 *
 * HubSpot is canonical: we don't touch the customer-overrides KV. The
 * twice-daily sync pulls the new owner/status/risk back through q10600
 * + the Stripe-ID resolver. Lets @bot assign work for accounts not yet
 * in the dashboard's snapshot.
 */

import { loadCustomers } from "../data/load-customers";
import { applyTodoOps, getTodosForUser } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import {
  fetchDealAssociatedCompanyIds,
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
import { getTextValue, getSelectValue } from "./slack-views";

// ─── Constants ────────────────────────────────────────────────────────

export const ASSIGN_OPEN_BUTTON_ACTION_ID = "assign_open_modal";
export const ASSIGN_MODAL_CALLBACK_ID = "assign_modal";

/** HubSpot's internal property names — NOT the q10600 column names.
 *  q10600 (via Metabase's data model) surfaces these with a
 *  `property_` prefix and single underscores; the actual HubSpot
 *  REST API uses the raw HubSpot internal names (verified via the
 *  HubSpot properties endpoint).
 *
 *  Risk level: enum (Red / Yellow / Light Green / Green).
 *  Company status: enum (Onboarding / Live / Churned (off beehiiv) /
 *    Downgraded (on beehiiv) / Do Not Use (Awaiting Onboarding)). */
const HUBSPOT_RISK_LEVEL_PROPERTY = "risk_level__csm_";
const HUBSPOT_STATUS_PROPERTY = "company_status";
const DEFAULT_RISK_LEVEL = "Light Green";

const STATUS_VALUES = ["Live", "Onboarding"] as const;
type AccountStatus = (typeof STATUS_VALUES)[number];

const DRIVE_PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

// ─── In-thread button (posted by app_mention handler) ─────────────────

interface ThreadContext {
  channel: string;
  thread_ts: string;
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
          "*Assign a new account?* I'll update HubSpot (owner + status + risk = Light Green), schedule the onboarding to-do sequence on the new CSM's list, and create a Drive folder under the shared parent.",
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
          text: "Tip: open the HubSpot company first — you'll paste its URL or ID into the form.",
        },
      ],
    },
  ];
}

// ─── HubSpot company-id parsing ───────────────────────────────────────

/** Parsed result of a HubSpot URL/ID input. */
export type ParsedHubspotRef =
  | { kind: "company"; id: string }
  | { kind: "deal"; id: string };

/**
 * Recognize either a HubSpot company or deal from the user's paste.
 * URL shapes:
 *   • company old:  .../company/<id>
 *   • company new:  .../record/0-2/<id>           (object type 0-2)
 *   • deal old:     .../deal/<id>
 *   • deal new:     .../record/0-3/<id>           (object type 0-3)
 * Bare numeric IDs default to "company" since we can't disambiguate
 * a deal ID from a company ID without context. CSMs who want to use
 * a deal ID directly should paste the URL.
 *
 * Deal inputs get resolved to a company via the associations endpoint
 * in the submit handler — see fetchDealAssociatedCompanyIds().
 */
export function parseHubspotCompanyInput(raw: string): ParsedHubspotRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Deal URLs first — the more specific match wins.
  const dealRecordMatch = trimmed.match(/\/record\/0-3\/(\d+)/);
  if (dealRecordMatch) return { kind: "deal", id: dealRecordMatch[1] };
  const dealMatch = trimmed.match(/\/deal\/(\d+)/);
  if (dealMatch) return { kind: "deal", id: dealMatch[1] };

  // Company URLs.
  const companyRecordMatch = trimmed.match(/\/record\/0-2\/(\d+)/);
  if (companyRecordMatch) return { kind: "company", id: companyRecordMatch[1] };
  const companyMatch = trimmed.match(/\/company\/(\d+)/);
  if (companyMatch) return { kind: "company", id: companyMatch[1] };

  // Bare numeric → company (can't disambiguate; matches v1 behavior).
  if (/^\d+$/.test(trimmed)) return { kind: "company", id: trimmed };

  return null;
}

// ─── CSM team filter ──────────────────────────────────────────────────

/**
 * Filter HubSpot owners down to the CSM team. Approach: collect the
 * distinct `customer_success_manager_email` values from the customer
 * book (q10600 surfaces this per row from HubSpot's CSM property), and
 * keep only owners whose email matches. Captures the same set the rest
 * of the dashboard recognizes as a CSM — no separate config to keep in
 * sync.
 *
 * Falls back to "all owners" when the customer book load fails or
 * returns no emails — better to show the whole HubSpot owner list than
 * a blocking empty dropdown. Logged so the failure is visible.
 */
async function csmTeamOwners(owners: HubspotOwner[]): Promise<HubspotOwner[]> {
  try {
    const customers = await loadCustomers();
    const csmEmails = new Set<string>();
    for (const c of customers) {
      const email = c.customer_success_manager_email;
      if (email) csmEmails.add(email.toLowerCase());
    }
    if (csmEmails.size === 0) {
      console.warn(
        "[slack-assign] csmTeamOwners: customer book has 0 CSM emails — falling back to all owners"
      );
      return owners;
    }
    const filtered = owners.filter((o) =>
      csmEmails.has(o.owner_email.toLowerCase())
    );
    if (filtered.length === 0) {
      console.warn(
        "[slack-assign] csmTeamOwners: 0 HubSpot owners matched the CSM email set — falling back to all owners",
        { csmEmailCount: csmEmails.size, ownerCount: owners.length }
      );
      return owners;
    }
    return filtered;
  } catch (e) {
    console.warn(
      "[slack-assign] csmTeamOwners: loadCustomers failed — falling back to all owners",
      e instanceof Error ? e.message : e
    );
    return owners;
  }
}

// ─── Modal ────────────────────────────────────────────────────────────

export function buildAssignView(
  owners: HubspotOwner[],
  threadContext: ThreadContext
): Record<string, unknown> {
  const ownerOptions = owners.slice(0, 100).map((o) => ({
    text: {
      type: "plain_text",
      text: ((o.owner_name ? `${o.owner_name} ` : "") + `<${o.owner_email}>`).slice(0, 75),
    },
    value: `${o.owner_id}::${o.owner_email}`,
  }));

  const statusOptions = STATUS_VALUES.map((s) => ({
    text: { type: "plain_text", text: s },
    value: s,
  }));

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
            text:
              "Sets HubSpot owner + status + risk (= Light Green), creates a Drive folder, and schedules the onboarding to-do playbook on the new CSM's list. Dashboard catches up on next sync.",
          },
        ],
      },
      {
        type: "input",
        block_id: "owner",
        label: { type: "plain_text", text: "CSM" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a CSM" },
          options: ownerOptions,
        },
      },
      {
        type: "input",
        block_id: "status",
        label: { type: "plain_text", text: "Account status" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Live or Onboarding" },
          options: statusOptions,
        },
        hint: {
          type: "plain_text",
          text: "Onboarding → 16-step playbook on the CSM's list. Live → 4-step get-up-to-speed sequence.",
        },
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
    ],
  };
}

export async function openAssignModal(args: {
  triggerId: string;
  threadContext: ThreadContext;
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" };

  let owners: HubspotOwner[] = [];
  try {
    owners = await listHubspotOwners();
  } catch (e) {
    console.error("[slack-assign] listHubspotOwners failed", e);
    return { ok: false, error: "Couldn't load HubSpot owners — check the bot's HubSpot scope." };
  }
  if (owners.length === 0) return { ok: false, error: "No HubSpot owners returned." };

  const csmOnly = await csmTeamOwners(owners);
  const view = buildAssignView(csmOnly, args.threadContext);

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
  status: AccountStatus;
}

function readAssignForm(
  payload: ViewSubmissionPayload
): { ok: true; values: AssignFormValues } | { ok: false; errors: Record<string, string> } {
  const hubspotCompanyRaw = getTextValue(payload, "hubspot_company");
  const ownerRaw = getSelectValue(payload, "owner");
  const statusRaw = getSelectValue(payload, "status");

  const errors: Record<string, string> = {};
  if (!hubspotCompanyRaw) errors.hubspot_company = "HubSpot company URL or ID is required.";
  if (!ownerRaw) errors.owner = "Pick a CSM.";
  if (!statusRaw) errors.status = "Pick Live or Onboarding.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const sepIdx = (ownerRaw ?? "").indexOf("::");
  const ownerId = sepIdx > 0 ? ownerRaw!.slice(0, sepIdx) : ownerRaw!;
  const ownerEmail = sepIdx > 0 ? ownerRaw!.slice(sepIdx + 2) : "";

  if (!(STATUS_VALUES as readonly string[]).includes(statusRaw!)) {
    return {
      ok: false,
      errors: { status: `Unrecognized status "${statusRaw}".` },
    };
  }

  return {
    ok: true,
    values: {
      hubspotCompanyInput: hubspotCompanyRaw!,
      ownerId,
      ownerEmail: ownerEmail.toLowerCase(),
      status: statusRaw as AccountStatus,
    },
  };
}

export const assignModalHandler: ViewSubmitHandler = async ({ payload }) => {
  const form = readAssignForm(payload);
  if (!form.ok) {
    return { response_action: "errors", errors: form.errors } as ViewSubmitResponse;
  }
  const v = form.values;

  const parsed = parseHubspotCompanyInput(v.hubspotCompanyInput);
  if (!parsed) {
    return {
      response_action: "errors",
      errors: {
        hubspot_company:
          "Couldn't read a HubSpot company or deal ID. Paste a HubSpot company URL, a deal URL, or a bare company ID.",
      },
    } as ViewSubmitResponse;
  }

  // Deal → resolve to associated company first. Surface a clear error
  // if the deal has no associated company yet (CSM should add one in
  // HubSpot before assigning) or multiple (we pick the first and note
  // it in the confirmation, so the CSM can correct if it's the wrong
  // one).
  let companyId = parsed.id;
  let dealResolution:
    | { dealId: string; companyId: string; otherCompanyCount: number }
    | null = null;
  if (parsed.kind === "deal") {
    let associated: string[] | null = null;
    try {
      associated = await fetchDealAssociatedCompanyIds(parsed.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Missing-scope path: surface a clear hint so the user can fix
      // it in the HubSpot Private App config instead of staring at a
      // raw 403 + correlation ID. Same pattern as the rest of the
      // hubspot integration when a scope is missing.
      const friendly = /403/.test(msg)
        ? "HubSpot deal lookup needs the `crm.objects.deals.read` scope on the Private App. Add it in HubSpot → Settings → Integrations → Private Apps → Scopes, then retry. (Or paste the company URL/ID directly.)"
        : `HubSpot deal lookup failed: ${msg.slice(0, 180)}`;
      return {
        response_action: "errors",
        errors: { hubspot_company: friendly },
      } as ViewSubmitResponse;
    }
    if (associated === null) {
      return {
        response_action: "errors",
        errors: {
          hubspot_company: `No HubSpot deal with ID ${parsed.id}.`,
        },
      } as ViewSubmitResponse;
    }
    if (associated.length === 0) {
      return {
        response_action: "errors",
        errors: {
          hubspot_company: `Deal ${parsed.id} has no associated company. Link a company on the deal record in HubSpot, then re-open this form.`,
        },
      } as ViewSubmitResponse;
    }
    companyId = associated[0];
    dealResolution = {
      dealId: parsed.id,
      companyId,
      otherCompanyCount: associated.length - 1,
    };
  }

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
        hubspot_company: `No HubSpot company with ID ${companyId}${
          dealResolution
            ? ` (resolved from deal ${dealResolution.dealId})`
            : ""
        }.`,
      },
    } as ViewSubmitResponse;
  }

  const companyName = company.name?.trim() || `company ${company.id}`;

  let threadContext: ThreadContext | null = null;
  try {
    threadContext = JSON.parse(payload.view.private_metadata ?? "{}");
  } catch {
    threadContext = null;
  }
  const requesterEmail = threadContext?.requester_user || "";

  // ── HubSpot PATCH — owner + status + risk in one call. This is the
  // gate for everything downstream: if the assignment didn't land in
  // HubSpot, there's nothing real to schedule to-dos or build a Drive
  // folder for. The to-do batch + Drive folder steps are skipped in
  // that case so we don't strand 17 to-dos against a customer whose
  // owner reassignment never took.
  const hubspotErrors: string[] = [];
  try {
    await patchHubspotCompanyProperties(company.id, {
      hubspot_owner_id: v.ownerId,
      [HUBSPOT_STATUS_PROPERTY]: v.status,
      [HUBSPOT_RISK_LEVEL_PROPERTY]: DEFAULT_RISK_LEVEL,
    });
  } catch (e) {
    hubspotErrors.push(e instanceof Error ? e.message : String(e));
  }
  const hubspotOk = hubspotErrors.length === 0;

  // ── Personal to-do sequence for the assigned CSM (gated on HubSpot).
  const todoErrors: string[] = [];
  let todoCount = 0;
  // True when we found an existing batch for this CSM + company; the
  // re-run becomes a no-op for to-dos and the response says so.
  let todoSkippedAsDuplicate = false;
  if (hubspotOk) {
    try {
      const targetUserKey = userKeyFromEmail(v.ownerEmail);
      // Idempotency check: scan the target user's open to-dos for an
      // existing assign-playbook batch for this same HubSpot company.
      // If we find one, skip the whole batch — the CSM doesn't want
      // 32 to-dos for the same onboarding. Completed to-dos don't
      // block (re-onboarding a previously-completed account gets a
      // fresh batch).
      const existing = await getTodosForUser(targetUserKey);
      const openMatches = existing.filter(
        (t) =>
          t.source === "slack_assign" &&
          t.source_meta?.hubspot_company_id === company.id &&
          t.completed_at === null
      );
      if (openMatches.length > 0) {
        todoSkippedAsDuplicate = true;
        console.log("[slack-assign] dedupe hit — skipping to-do batch", {
          targetUserKey,
          hubspot_company_id: company.id,
          existingOpen: openMatches.length,
        });
      } else {
        const todos = buildAssignTodoSequence({
          companyName,
          hubspotCompanyId: company.id,
          requesterEmail: requesterEmail || "a teammate",
          flow: v.status,
          slackUserId: payload.user.id,
        });
        await applyTodoOps(
          targetUserKey,
          todos.map((todo) => ({ type: "add" as const, todo }))
        );
        todoCount = todos.length;
      }
    } catch (e) {
      todoErrors.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    todoErrors.push("skipped — HubSpot PATCH failed");
  }

  // ── Drive folder (gated on HubSpot).
  let driveResult:
    | { ok: true; id: string; webViewLink: string; name: string }
    | { ok: false; error: string } = { ok: false, error: "skipped" };

  if (!hubspotOk) {
    driveResult = {
      ok: false,
      error: "skipped — HubSpot PATCH failed",
    };
  } else if (requesterEmail) {
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
      driveResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    driveResult = {
      ok: false,
      error: "Couldn't determine requester email — Drive folder skipped.",
    };
  }

  // ── Thread reply.
  if (threadContext?.channel && threadContext.thread_ts) {
    await postAssignmentSummary({
      channel: threadContext.channel,
      threadTs: threadContext.thread_ts,
      companyName,
      hubspotCompanyId: company.id,
      assignedCsmEmail: v.ownerEmail,
      status: v.status,
      todoCount,
      todoSkippedAsDuplicate,
      hubspotErrors,
      todoErrors,
      driveResult,
      dealResolution,
    });
  }

  // ── DM ack. Headline reflects whether HubSpot landed — when it
  // failed, the assignment never actually took, so leading with a
  // green check would lie about what happened.
  const ackParts: string[] = hubspotOk
    ? [
        `:white_check_mark: Assigned *${companyName}* to *${v.ownerEmail}* (${v.status}).`,
        `• HubSpot: <https://app.hubspot.com/contacts/0/record/0-2/${company.id}|company record> — owner + status + risk (Light Green) set.`,
      ]
    : [
        `:x: Assignment did NOT land — HubSpot PATCH failed for *${companyName}*.`,
        `• Nothing else was applied (no to-dos, no Drive folder) since the HubSpot reassignment didn't take.`,
        `• HubSpot record: <https://app.hubspot.com/contacts/0/record/0-2/${company.id}|company record>`,
      ];
  if (dealResolution) {
    const extras = dealResolution.otherCompanyCount;
    ackParts.push(
      `• Resolved from deal ${dealResolution.dealId}` +
        (extras > 0
          ? ` (note: ${extras} other associated compan${extras === 1 ? "y" : "ies"} on this deal — used primary).`
          : ".")
    );
  }
  if (hubspotErrors.length) ackParts.push(`⚠ HubSpot PATCH: ${hubspotErrors.join(" · ")}`);
  if (todoErrors.length) {
    ackParts.push(`⚠ To-dos: ${todoErrors.join(" · ")}`);
  } else if (todoSkippedAsDuplicate) {
    ackParts.push(
      "• To-do batch already on their list for this company — left as-is to avoid duplicates."
    );
  } else {
    ackParts.push(`• ${todoCount} to-do${todoCount === 1 ? "" : "s"} scheduled on their list.`);
  }
  if (driveResult.ok) {
    ackParts.push(`• 📂 Drive folder: ${driveResult.webViewLink}`);
  } else {
    ackParts.push(`⚠ Drive: ${driveResult.error}`);
  }
  ackParts.push("• Dashboard catches up on the next sync.");

  return { _ack_message: ackParts.join("\n") };
};

// ─── To-do sequence ──────────────────────────────────────────────────

interface TodoTemplate {
  title: string;
  details: string;
  /** Days from today to hide the to-do until. 0 = visible immediately.
   *  Lets a 90-day playbook land all at once without flooding the CSM's
   *  list — items show up as they become relevant. */
  surface_offset_days: number;
  /** Days from today the to-do is due. */
  due_offset_days: number;
}

/** Onboarding playbook — full ~90-day sequence. Mirrors the CSM team's
 *  onboarding doc; each title/details pair is the operational substance
 *  of one step. */
const ONBOARDING_PLAYBOOK: TodoTemplate[] = [
  {
    title: "Confirm handoff message is complete",
    details:
      "Verify the AE's #topic-enterprise-customers post has: HubSpot link, subscriber tier + billing cadence, workspace owner email, timezone, touch level, Stripe ID, enablement survey link, deliverability info screenshot, package status, Solutions Engineer involvement. Ask the AE if anything's missing.",
    surface_offset_days: 0,
    due_offset_days: 1,
  },
  {
    title: "(No-package) Check sales timeline + scope expectations",
    details:
      "Check HubSpot or ask the AE when the sales process started. Before March 2026 + needs extra support → flag internally, consider free Solutions work or expert directory. After March 2026 + needs extra support → flag with AE to confirm opt-out and resell if needed. Keep CSM scope in mind: guided launch plan, one live platform orientation, ad-hoc ongoing support.",
    surface_offset_days: 0,
    due_offset_days: 2,
  },
  {
    title: "(With-package) Internal sync — AE + Solutions Engineer + Ashley",
    details:
      "15-min pre-kickoff sync. Cover sales context, customer expectations, kickoff attendees, plan questions.",
    surface_offset_days: 1,
    due_offset_days: 3,
  },
  {
    title: "Watch for the CSM intro email from Sales",
    details:
      "Sales sends the email introducing you to the customer. Reply when it lands to book the kickoff.",
    surface_offset_days: 1,
    due_offset_days: 3,
  },
  {
    title: "Complete internal setup — verify HubSpot fields",
    details:
      "Drive folder is auto-created by @bot assign. Confirm HubSpot company has: company engagement, owner email, Stripe customer ID, main contact, renewal date (if annual).",
    surface_offset_days: 1,
    due_offset_days: 3,
  },
  {
    title: "Schedule the kickoff call (45-min)",
    details:
      "Reply to Sales intro email with the kickoff email template. Add Ashley Hays (and anyone else from beehiiv who needs to join) — reference her calendar. Set agenda on the invite.",
    surface_offset_days: 2,
    due_offset_days: 5,
  },
  {
    title: "Prep the kickoff: newsletter breakdown + deck",
    details:
      "Save newsletter breakdown spreadsheet to the customer folder + fill it in (or plan for the customer to complete). Save and update the kickoff deck. (With-package) Align with Ashley on her portion of the deck.",
    surface_offset_days: 4,
    due_offset_days: 7,
  },
  {
    title: "Run the kickoff call",
    details:
      "Walk through the kickoff deck — align on migration process, goals/challenges, ongoing support model.",
    surface_offset_days: 6,
    due_offset_days: 8,
  },
  {
    title: "Post-kickoff follow-up",
    details:
      "Email the customer (attach kickoff deck, send newsletter breakdown spreadsheet if they need to fill it, and schedule the ~1-hour training session). Update HubSpot with customer goals and apply contact labels (billing, main, enterprise roadmap invite, priority).",
    surface_offset_days: 8,
    due_offset_days: 9,
  },
  {
    title: "Build migration plan in Notch + submit CWUP form",
    details:
      "With-package: get the Notch link from Ashley. No-package: copy the CSM ENT onboarding Notch template. Update Overview tab (team, goals, kickoff deck PDF, newsletter breakdown). Submit the New Customer Warm Up Schedule form (Mac builds the CWUP, 1-3 business days; DNC or a template substitute if Mac is out), then link CWUP under the Migration tab.",
    surface_offset_days: 9,
    due_offset_days: 14,
  },
  {
    title: "Run the training session",
    details:
      "Confirm the migration plan is complete (review past walkthrough recordings if needed). On the call: present the migration plan, give a high-level platform walkthrough focused on launch, offer growth/monetization strategy sessions, and mention the upcoming 90-day check-in.",
    surface_offset_days: 14,
    due_offset_days: 21,
  },
  {
    title: "Post-training follow-up + backend asks",
    details:
      "Email the customer (recording, migration plan, 30-min 90-day check-in availability). Update Notch Training & Resources tab. Post in #topic-email-deliverability to move publication(s) to the medium IP pool (include pub IDs). Post in #ent-ad-network-tiers to assign an Ad Network tier (publisher name, publisher ID, MRR, tier rec 1–3, likelihood of complaining).",
    surface_offset_days: 21,
    due_offset_days: 22,
  },
  {
    title: "(No-package) 14-day check-in email",
    details:
      "Light-touch check-in. High-touch customers: bump to weekly/bi-weekly cadence instead.",
    surface_offset_days: 12,
    due_offset_days: 15,
  },
  {
    title: "(No-package) 30-day check-in email",
    details: "Check progress against the migration plan. Surface blockers early.",
    surface_offset_days: 28,
    due_offset_days: 32,
  },
  {
    title: "(No-package) 60-day check-in email + workspace pre-audit",
    details:
      "Email check-in. Audit the workspace before the 90-day call lands.",
    surface_offset_days: 58,
    due_offset_days: 62,
  },
  {
    title: "Run the 90-day check-in",
    details:
      "Audit the workspace via the CSM dashboard. Copy the beehiiv utilization spreadsheet to the customer folder and link it on the Notch 90 Day Check In tab. (No-package) Confirm Notch Account Setup steps are done. On the call: review the spreadsheet, revisit goals, ask for a referral (mention the partner program).",
    surface_offset_days: 85,
    due_offset_days: 90,
  },
  {
    title: "Post-90-day: CSAT + flip HubSpot to Live",
    details:
      "Send the 90-day CSAT survey. Update HubSpot: risk level (re-evaluate), company engagement, status → Live.",
    surface_offset_days: 90,
    due_offset_days: 91,
  },
];

/** Shorter sequence for accounts assigned as Live (already past
 *  onboarding — the new CSM just needs to get up to speed). */
const LIVE_PLAYBOOK: TodoTemplate[] = [
  {
    title: "Get up to speed on this account",
    details:
      "Read the HubSpot company record (recent notes, deal history, contact list). Skim the dashboard's customer detail panel for last-send, deliverability, and risk signals.",
    surface_offset_days: 0,
    due_offset_days: 2,
  },
  {
    title: "Schedule introduction call with main contact",
    details:
      "Send a brief intro email and book a 30-min call. If they have a renewal coming up, reference the annual renewal process.",
    surface_offset_days: 1,
    due_offset_days: 5,
  },
  {
    title: "Confirm Drive folder + workspace tracking",
    details:
      "Drive folder is auto-created by @bot assign. Make sure any historical notes/decks from the previous CSM are saved there.",
    surface_offset_days: 0,
    due_offset_days: 3,
  },
  {
    title: "First 30-day check-in",
    details:
      "Light-touch email check-in. Confirm relationship health, surface blockers.",
    surface_offset_days: 28,
    due_offset_days: 32,
  },
];

/** Compose the to-do sequence for a given assignment. */
function buildAssignTodoSequence(args: {
  companyName: string;
  hubspotCompanyId: string;
  requesterEmail: string;
  flow: AccountStatus;
  slackUserId: string;
}): PersonalTodo[] {
  const playbook =
    args.flow === "Onboarding" ? ONBOARDING_PLAYBOOK : LIVE_PLAYBOOK;
  const now = new Date();
  const nowIso = now.toISOString();
  const hubspotUrl = `https://app.hubspot.com/contacts/0/record/0-2/${args.hubspotCompanyId}`;
  const provenance =
    `Auto-scheduled via @bot assign by ${args.requesterEmail} for ${args.companyName}.\n` +
    `HubSpot: ${hubspotUrl}`;

  return playbook.map((tpl) => {
    const surfaceAt = addDays(now, tpl.surface_offset_days)
      .toISOString()
      .slice(0, 10);
    const dueDate = addDays(now, tpl.due_offset_days).toISOString().slice(0, 10);
    return {
      id: newTodoId(),
      title: `${args.companyName} — ${tpl.title}`,
      details: `${tpl.details}\n\n${provenance}`,
      due_date: dueDate,
      // surface_offset 0 → no surface_at, todo visible immediately.
      // Non-zero → hide until that date.
      surface_at: tpl.surface_offset_days > 0 ? surfaceAt : null,
      priority: null,
      source: "slack_assign",
      source_meta: {
        slack_user_id: args.slackUserId,
        // Idempotency key — a re-run of `@bot assign` for the same
        // company on the same CSM detects this and skips rather than
        // duplicating the whole batch.
        hubspot_company_id: args.hubspotCompanyId,
      },
      completed_at: null,
      remind_via_slack: true,
      created_at: nowIso,
      updated_at: nowIso,
    };
  });
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function postAssignmentSummary(args: {
  channel: string;
  threadTs: string;
  companyName: string;
  hubspotCompanyId: string;
  assignedCsmEmail: string;
  status: AccountStatus;
  todoCount: number;
  /** True when the dedupe check found an existing open assign batch
   *  for this company on the target user and we left it alone. */
  todoSkippedAsDuplicate: boolean;
  hubspotErrors: string[];
  todoErrors: string[];
  driveResult:
    | { ok: true; id: string; webViewLink: string; name: string }
    | { ok: false; error: string };
  /** Non-null when the user pasted a deal URL/ID; surfaces a note so
   *  they can verify the right associated company was picked. */
  dealResolution?:
    | { dealId: string; companyId: string; otherCompanyCount: number }
    | null;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const hubspotOk = args.hubspotErrors.length === 0;
  const lines: string[] = [];
  // When HubSpot fails the assignment never actually landed — the
  // headline reflects that so the thread doesn't read as a success.
  if (hubspotOk) {
    lines.push(
      `:white_check_mark: *<https://app.hubspot.com/contacts/0/record/0-2/${args.hubspotCompanyId}|${args.companyName}>* assigned to *${args.assignedCsmEmail}* (${args.status}).`
    );
  } else {
    lines.push(
      `:x: Assignment did NOT land — HubSpot PATCH failed for *<https://app.hubspot.com/contacts/0/record/0-2/${args.hubspotCompanyId}|${args.companyName}>*.`
    );
    lines.push(
      "• To-dos + Drive folder were skipped (no point scheduling them when the HubSpot reassignment didn't take)."
    );
  }
  if (args.dealResolution) {
    const extras = args.dealResolution.otherCompanyCount;
    lines.push(
      `• Resolved from deal <https://app.hubspot.com/contacts/0/record/0-3/${args.dealResolution.dealId}|${args.dealResolution.dealId}>` +
        (extras > 0
          ? ` — note: ${extras} other associated compan${extras === 1 ? "y" : "ies"} on this deal; assignment used the primary.`
          : ".")
    );
  }
  if (args.hubspotErrors.length === 0) {
    lines.push("• HubSpot updated — owner + status + risk (Light Green).");
  } else {
    lines.push(`• ⚠ HubSpot: ${args.hubspotErrors.join(" · ")}`);
  }
  if (args.todoErrors.length === 0) {
    if (args.todoSkippedAsDuplicate) {
      lines.push(
        "• To-do batch already on their list for this company — left as-is to avoid duplicates."
      );
    } else {
      lines.push(
        `• ${args.todoCount} to-do${args.todoCount === 1 ? "" : "s"} scheduled on their list (surface dates staggered).`
      );
    }
  } else {
    lines.push(`• ⚠ To-dos: ${args.todoErrors.join(" · ")}`);
  }
  if (args.driveResult.ok) {
    lines.push(
      `• 📂 Drive folder: <${args.driveResult.webViewLink}|${args.driveResult.name}>`
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
