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
import { loadSettings } from "../data/settings";
import { applyTodoOps, getTodosForUser } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import { ONBOARDING_PLAYBOOK, LIVE_PLAYBOOK } from "./playbook-templates";
import {
  fetchDealAssociatedCompanyIds,
  fetchHubspotCompany,
  fetchHubspotDeal,
  listHubspotOwners,
  patchHubspotCompanyProperties,
  type HubspotOwner,
} from "./hubspot";
import {
  createDriveFolder,
  hasDriveAccess,
  folderUrl,
  copyDriveFolderContents,
  type SeedResult,
} from "./google-drive";
import { hubspotCompanyUrl, hubspotDealUrl } from "../links";
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
/** beehiiv's CSM-team custom property — enumeration keyed by HubSpot
 *  owner_id values. q10600 + the dashboard read from THIS property.
 *  Sister field hubspot_owner_id (the standard "Company owner") is
 *  intentionally NOT touched here — it's used for sales workflows
 *  and often diverges from the CSM assignment on Enterprise accounts. */
const HUBSPOT_CSM_PROPERTY = "customer_success_manager";
const DEFAULT_RISK_LEVEL = "Light Green";

const STATUS_VALUES = ["Live", "Onboarding"] as const;
type AccountStatus = (typeof STATUS_VALUES)[number];

const DRIVE_PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

/** Deal-side fields copied onto the company. The third tuple slot is
 *  the human-readable label used in the Slack summary so a CSM can
 *  see what changed without grepping the HubSpot API names. The
 *  `name` mapping handles "Primary Company Name" → company `name`,
 *  the rest are same-name on both objects (admin must create them on
 *  Company; until then the per-field PATCH fails gracefully). */
const DEAL_TO_COMPANY_FIELDS: Array<{
  dealProp: string;
  companyProp: string;
  label: string;
  /** True → required (still soft-fails; just used to scope where the
   *  "optional" Enablement Survey Link sits in the field list). */
  required: boolean;
}> = [
  { dealProp: "primary_company_name", companyProp: "name", label: "Company name", required: true },
  { dealProp: "touch_level", companyProp: "touch_level", label: "Touch level", required: true },
  {
    dealProp: "subscriber_tier_billing_cadence",
    companyProp: "subscriber_tier_billing_cadence",
    label: "Subscriber tier + billing cadence",
    required: true,
  },
  { dealProp: "onboarding_package", companyProp: "onboarding_package", label: "Onboarding package", required: true },
  { dealProp: "is_solutions_involved", companyProp: "is_solutions_involved", label: "Solutions involved", required: true },
  { dealProp: "enablement_survey_link", companyProp: "enablement_survey_link", label: "Enablement survey link", required: false },
];

type TemplateVariant = "with_op" | "no_op";

interface TransposeResult {
  /** Number of fields successfully PATCHed onto the company. */
  copied: number;
  /** Fields the company already had a value for — left untouched. */
  skipped: number;
  /** Per-field failures with a short reason (HubSpot 400 body). */
  failures: Array<{ label: string; reason: string }>;
  /** The raw `onboarding_package` value off the deal (Yes / No / null).
   *  Surfaced separately so the seed-template branch + Ashley-to-do
   *  branch can read it without re-fetching. */
  dealOnboardingPackage: string | null;
}

function isEmptyHubspotValue(v: string | null | undefined): boolean {
  return v == null || v.trim() === "";
}

/** Pull the configured deal fields, read the same fields on the
 *  company, and per-field PATCH the holes. Per-field so a missing
 *  company-side property (admin hasn't created it yet) takes only
 *  itself down. */
async function runDealToCompanyTranspose(
  dealId: string,
  companyId: string
): Promise<TransposeResult> {
  const result: TransposeResult = {
    copied: 0,
    skipped: 0,
    failures: [],
    dealOnboardingPackage: null,
  };
  let deal: { properties: Record<string, string | null> } | null = null;
  try {
    deal = await fetchHubspotDeal(
      dealId,
      DEAL_TO_COMPANY_FIELDS.map((f) => f.dealProp)
    );
  } catch (e) {
    result.failures.push({
      label: "deal read",
      reason: e instanceof Error ? e.message : String(e),
    });
    return result;
  }
  if (!deal) {
    result.failures.push({
      label: "deal read",
      reason: `deal ${dealId} not found`,
    });
    return result;
  }
  result.dealOnboardingPackage = deal.properties.onboarding_package ?? null;

  let company: { properties: Record<string, string | null> } | null = null;
  try {
    company = await fetchHubspotCompany(
      companyId,
      DEAL_TO_COMPANY_FIELDS.map((f) => f.companyProp)
    );
  } catch (e) {
    result.failures.push({
      label: "company read",
      reason: e instanceof Error ? e.message : String(e),
    });
    return result;
  }
  if (!company) {
    result.failures.push({
      label: "company read",
      reason: `company ${companyId} not found`,
    });
    return result;
  }

  for (const field of DEAL_TO_COMPANY_FIELDS) {
    const dealVal = deal.properties[field.dealProp];
    const companyVal = company.properties[field.companyProp];
    if (isEmptyHubspotValue(dealVal)) continue;
    if (!isEmptyHubspotValue(companyVal)) {
      result.skipped++;
      continue;
    }
    try {
      await patchHubspotCompanyProperties(companyId, {
        [field.companyProp]: dealVal,
      });
      result.copied++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Trim to keep the Slack summary scannable; full error still in
      // Vercel logs via patchHubspotCompanyProperties' own throw site.
      result.failures.push({
        label: field.label,
        reason: msg.length > 120 ? `${msg.slice(0, 120)}…` : msg,
      });
    }
  }
  return result;
}

/**
 * Resolve a CSM email to a Slack mention token (`<@U02ABC123>`) so
 * the thread reply pings the newly-assigned person.
 *
 * Two-step lookup:
 *   1. customer book   → email → customer_success_manager handle
 *   2. settings.slack.csm_user_ids[handle] → Slack user id
 *
 * If either step misses, falls back to the email as plain text — the
 * CSM won't get notified but the reply still reads correctly. Logged
 * so an admin can fill in the missing csm_user_ids mapping next time
 * they're in /settings/slack.
 */
async function resolveCsmMention(email: string): Promise<string> {
  const fallback = `*${email}*`;
  try {
    const [customers, settings] = await Promise.all([
      loadCustomers(),
      loadSettings(),
    ]);
    const target = email.trim().toLowerCase();
    let handle: string | null = null;
    for (const c of customers) {
      if (
        c.customer_success_manager_email?.toLowerCase() === target &&
        c.customer_success_manager
      ) {
        handle = c.customer_success_manager;
        break;
      }
    }
    if (!handle) {
      console.warn("[slack-assign] no handle found for", email);
      return fallback;
    }
    const slackId = settings.slack?.csm_user_ids?.[handle];
    if (!slackId) {
      console.warn(
        "[slack-assign] no slack user id for handle",
        handle,
        "— add it at /settings/slack"
      );
      return fallback;
    }
    return `<@${slackId}>`;
  } catch (e) {
    console.warn(
      "[slack-assign] resolveCsmMention threw",
      e instanceof Error ? e.message : e
    );
    return fallback;
  }
}

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
      {
        type: "input",
        block_id: "folder_name",
        optional: true,
        label: { type: "plain_text", text: "Drive folder name" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Leave blank to use the HubSpot company name",
          },
        },
        hint: {
          type: "plain_text",
          text: "Folder is created under the shared CSM parent in Drive. Defaults to the HubSpot company name when this field is blank.",
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
  /** Optional override for the Drive folder name. When null/blank,
   *  the submit handler falls back to the resolved HubSpot company
   *  name. We can't pre-populate this in the modal because the
   *  company hasn't been fetched yet at modal-open time. */
  folderName: string | null;
}

function readAssignForm(
  payload: ViewSubmissionPayload
): { ok: true; values: AssignFormValues } | { ok: false; errors: Record<string, string> } {
  const hubspotCompanyRaw = getTextValue(payload, "hubspot_company");
  const ownerRaw = getSelectValue(payload, "owner");
  const statusRaw = getSelectValue(payload, "status");
  const folderNameRaw = getTextValue(payload, "folder_name");

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
      folderName: folderNameRaw?.trim() || null,
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
  // Three HubSpot fields only — Customer Success Manager (the CSM-team
  // custom property, which q10600 and the dashboard read from),
  // Company Status, and Risk Level. We deliberately do NOT touch
  // hubspot_owner_id (HubSpot's standard "Owner" — used for sales
  // workflows; often the AE, not the CSM) or owner_email__csm_
  // (derivable from the owner record). Keeping the write set tight
  // means a future HubSpot schema change can only break the three
  // fields we actually care about for this flow.
  const hubspotErrors: string[] = [];
  try {
    await patchHubspotCompanyProperties(company.id, {
      [HUBSPOT_CSM_PROPERTY]: v.ownerId,
      [HUBSPOT_STATUS_PROPERTY]: v.status,
      [HUBSPOT_RISK_LEVEL_PROPERTY]: DEFAULT_RISK_LEVEL,
    });
  } catch (e) {
    hubspotErrors.push(e instanceof Error ? e.message : String(e));
  }
  const hubspotOk = hubspotErrors.length === 0;

  // ── Deal → Company field transpose (deal path only).
  // Sales now populates touch_level / subscriber_tier_billing_cadence
  // / onboarding_package / is_solutions_involved / enablement_survey_link
  // on the deal itself; this block copies them onto the company so the
  // company page (and the dashboard) carries the same context. Only
  // fills holes — if the company already has a non-empty value we
  // don't clobber it. Each field PATCHes individually so a missing
  // company-side property (admin hasn't created it yet) doesn't kill
  // the others.
  let transposeResult: TransposeResult | null = null;
  let dealOnboardingPackage: string | null = null;
  if (hubspotOk && dealResolution) {
    transposeResult = await runDealToCompanyTranspose(
      dealResolution.dealId,
      company.id
    );
    dealOnboardingPackage = transposeResult.dealOnboardingPackage;
  }

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
        // When the deal carries Onboarding Package = Yes, prepend an
        // immediate-surface "Schedule check-in with Ashley" item so
        // the CSM books the pre-kickoff sync the day they're
        // assigned. Kept separate from the existing day-1
        // "(With-package) Internal sync" 3-person playbook item —
        // that one's the sync itself; this is the CSM's own
        // calendar-booking nudge.
        const opYes =
          (dealOnboardingPackage ?? "").trim().toLowerCase() === "yes";
        if (opYes) {
          todos.unshift(
            buildAshleyCheckinTodo({
              companyName,
              hubspotCompanyId: company.id,
              requesterEmail: requesterEmail || "a teammate",
              slackUserId: payload.user.id,
            })
          );
        }
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
    | {
        ok: true;
        id: string;
        webViewLink: string;
        name: string;
        /** Outcome of the template-seeding pass when one ran. Null
         *  when no template is configured OR the folder already
         *  existed (idempotent re-run — see `created` on createDriveFolder).
         *  Set with `skipped: [{ reason }]` when the user hasn't
         *  granted drive.readonly yet so the Slack summary can tell
         *  them to reconnect. */
        seed: SeedResult | { skipped_reason: string } | null;
        /** Which template variant the seed pass used. Surfaced in
         *  the Slack reply so it's obvious whether the OP or no-OP
         *  kit shipped. Null when no seed attempted. */
        seed_variant: TemplateVariant | null;
        /** Soft-failure indicator for the post-create PATCH that
         *  writes the URL back into the company's "Customer Folder"
         *  HubSpot property. Folder is still real + Slack still
         *  posts the URL — this just means HubSpot didn't accept
         *  the property write (custom prop missing, perm mismatch,
         *  etc.). Surfaced in the Slack thread reply so an admin
         *  knows to backfill manually. */
        hubspot_property_error?: string;
      }
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
        // Use the user-supplied folder name when provided; fall back
        // to the resolved HubSpot company name otherwise. The
        // company name isn't available at modal-open time (we don't
        // have the HubSpot record yet), so the form field can't be
        // pre-populated — handle the default here at submit time.
        const desiredFolderName = v.folderName || companyName;
        const folder = await createDriveFolder(
          requesterEmail,
          DRIVE_PARENT_FOLDER_ID,
          desiredFolderName
        );

        // Template seeding — only when (1) a template ID is
        // configured for the selected variant, (2) this is a brand-
        // new folder (not an idempotent reuse), and (3) the
        // requester has granted drive.readonly. Variant pick:
        // dealOnboardingPackage === "Yes" → with-OP template;
        // anything else (No / missing / company-triggered no-deal
        // flow) → no-OP template, falling back to with-OP if no-OP
        // isn't configured.
        const driveSettings = await loadSettings();
        const opTemplate = (
          driveSettings.am?.onboarding_drive_template_folder_id ?? ""
        ).trim();
        const noOpTemplate = (
          driveSettings.am?.onboarding_drive_template_folder_id_no_op ?? ""
        ).trim();
        const opYes =
          (dealOnboardingPackage ?? "").trim().toLowerCase() === "yes";
        const templateVariant: TemplateVariant = opYes ? "with_op" : "no_op";
        const templateId = opYes
          ? opTemplate
          : noOpTemplate || opTemplate /* fallback when no-OP unset */;

        let seed: SeedResult | { skipped_reason: string } | null = null;
        if (templateId && folder.created) {
          if (
            !(await hasDriveAccess(requesterEmail, {
              requireReadonly: true,
            }))
          ) {
            seed = {
              skipped_reason:
                "drive.readonly not granted — reconnect at /settings/gmail to enable template seeding",
            };
          } else {
            try {
              seed = await copyDriveFolderContents(
                requesterEmail,
                templateId,
                folder.id,
                { companyName }
              );
            } catch (e) {
              seed = {
                skipped_reason: `seeding failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              };
            }
          }
        }

        driveResult = {
          ok: true,
          id: folder.id,
          webViewLink: folder.webViewLink ?? folderUrl(folder.id),
          name: folder.name,
          seed,
          seed_variant: seed ? templateVariant : null,
        };

        // Mirror the folder URL onto the HubSpot company's
        // "Customer Folder" property so it shows up on the company
        // record + flows through into the next dashboard sync. Best-
        // effort: if HubSpot rejects the write (custom property
        // missing, perm mismatch, etc.) we don't fail the whole
        // assign — the folder still exists in Drive + Slack still
        // posts the URL. The error gets surfaced inside driveResult
        // so the Slack thread reply can mention it.
        try {
          await patchHubspotCompanyProperties(company.id, {
            customer_folder: driveResult.webViewLink,
          });
        } catch (e) {
          driveResult = {
            ...driveResult,
            hubspot_property_error:
              e instanceof Error ? e.message : String(e),
          };
        }
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

  // ── Thread reply. Resolve the assignee's Slack id ahead of the
  // call so the reply tags them — they get a Slack notification that
  // they're newly assigned.
  if (threadContext?.channel && threadContext.thread_ts) {
    const assignedCsmMention = await resolveCsmMention(v.ownerEmail);
    await postAssignmentSummary({
      channel: threadContext.channel,
      threadTs: threadContext.thread_ts,
      companyName,
      hubspotCompanyId: company.id,
      assignedCsmEmail: v.ownerEmail,
      assignedCsmMention,
      status: v.status,
      todoCount,
      todoSkippedAsDuplicate,
      hubspotErrors,
      todoErrors,
      driveResult,
      dealResolution,
      transposeResult,
    });
  }

  // ── DM ack. Headline reflects whether HubSpot landed — when it
  // failed, the assignment never actually took, so leading with a
  // green check would lie about what happened.
  const companyUrl = hubspotCompanyUrl(company.id);
  const ackParts: string[] = hubspotOk
    ? [
        `:white_check_mark: Assigned *${companyName}* to *${v.ownerEmail}* (${v.status}).`,
        `• HubSpot: <${companyUrl}|company record> — owner + status + risk (Light Green) set.`,
      ]
    : [
        `:x: Assignment did NOT land — HubSpot PATCH failed for *${companyName}*.`,
        `• Nothing else was applied (no to-dos, no Drive folder) since the HubSpot reassignment didn't take.`,
        `• HubSpot record: <${companyUrl}|company record>`,
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

  // Explicit Links: block at the end so the URLs are grabbable in the
  // DM without parsing the narrative. Mirrors the thread reply.
  if (hubspotOk && companyUrl) {
    ackParts.push("");
    ackParts.push("*Links*");
    ackParts.push(`🔗 HubSpot: ${companyUrl}`);
    if (driveResult.ok) {
      ackParts.push(`📂 Drive: ${driveResult.webViewLink}`);
    } else {
      ackParts.push(`📂 Drive: _not created — ${driveResult.error}_`);
    }
  }

  return { _ack_message: ackParts.join("\n") };
};

// ─── To-do sequence ──────────────────────────────────────────────────
// Templates themselves live in playbook-templates.ts (a pure, importable
// list with no server-only deps) so the Lifecycle board's settings page
// can read the exact same step_key/title list without pulling this
// file's Slack/Drive imports into a client bundle.

/** Compose the to-do sequence for a given assignment. Exported so the
 *  Lifecycle board's onboarding-backfill route (see
 *  /api/lifecycle/backfill-onboarding) can build the exact same
 *  sequence for a customer @bot assign was never run for, instead of
 *  maintaining a second copy of this construction logic. */
export function buildAssignTodoSequence(args: {
  companyName: string;
  hubspotCompanyId: string;
  requesterEmail: string;
  flow: AccountStatus;
  slackUserId: string;
  /** Provenance phrasing baked into each todo's `details`. Defaults
   *  to the Slack flow's own wording — the backfill route overrides
   *  this so the audit trail doesn't claim @bot assign ran when it
   *  didn't. */
  via?: string;
}): PersonalTodo[] {
  const playbook =
    args.flow === "Onboarding" ? ONBOARDING_PLAYBOOK : LIVE_PLAYBOOK;
  const now = new Date();
  const nowIso = now.toISOString();
  const hubspotUrl =
    hubspotCompanyUrl(args.hubspotCompanyId) ?? args.hubspotCompanyId;
  const provenance =
    `Auto-scheduled via ${args.via ?? "@bot assign"} by ${args.requesterEmail} for ${args.companyName}.\n` +
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
        // Stable playbook step key. Persisted so the personal-todos
        // panel can look up a per-step outreach template binding
        // from the todo-source-configs registry (/settings/todo-
        // automation) — same shape as the renewal_milestone
        // per-stage bindings, keyed by this string instead of days.
        playbook_step: tpl.step_key,
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

/** One-off "Schedule check-in with Ashley" to-do appended when the
 *  deal's onboarding_package reads "Yes". Surfaces immediately
 *  (offset 0, no surface_at) and is due 2 days out so the CSM
 *  doesn't lose a week before booking the pre-kickoff sync.
 *  Shares the same source_meta hubspot_company_id key as the rest
 *  of the playbook batch, so the dedupe check that skips re-assigns
 *  catches this item too. */
function buildAshleyCheckinTodo(args: {
  companyName: string;
  hubspotCompanyId: string;
  requesterEmail: string;
  slackUserId: string;
}): PersonalTodo {
  const now = new Date();
  const nowIso = now.toISOString();
  const hubspotUrl =
    hubspotCompanyUrl(args.hubspotCompanyId) ?? args.hubspotCompanyId;
  return {
    id: newTodoId(),
    title: `${args.companyName} — Schedule check-in with Ashley prior to kickoff call`,
    details:
      `Auto-added because the deal carries Onboarding Package = Yes. ` +
      `Book a quick check-in with Ashley before the customer kickoff ` +
      `so the OP scope is aligned and pre-kickoff context is shared.\n\n` +
      `Auto-scheduled via @bot assign by ${args.requesterEmail} for ${args.companyName}.\n` +
      `HubSpot: ${hubspotUrl}`,
    due_date: addDays(now, 2).toISOString().slice(0, 10),
    // surface_at: null → visible immediately. Different from the
    // day-1 "(With-package) Internal sync" item in the playbook,
    // which surfaces tomorrow.
    surface_at: null,
    priority: null,
    source: "slack_assign",
    source_meta: {
      slack_user_id: args.slackUserId,
      hubspot_company_id: args.hubspotCompanyId,
    },
    completed_at: null,
    remind_via_slack: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function postAssignmentSummary(args: {
  channel: string;
  threadTs: string;
  companyName: string;
  hubspotCompanyId: string;
  assignedCsmEmail: string;
  /** Slack mention token for the assigned CSM (`<@U02ABC123>`) when
   *  we could resolve their Slack id, or the email as a fallback.
   *  Used in the headline so the new CSM gets a notification that
   *  they've been assigned. */
  assignedCsmMention: string;
  status: AccountStatus;
  todoCount: number;
  /** True when the dedupe check found an existing open assign batch
   *  for this company on the target user and we left it alone. */
  todoSkippedAsDuplicate: boolean;
  hubspotErrors: string[];
  todoErrors: string[];
  driveResult:
    | {
        ok: true;
        id: string;
        webViewLink: string;
        name: string;
        /** Template-seed outcome (see DriveResult shape in the
         *  submission handler). Null means no seeding ran — either
         *  no template configured, or the folder was reused from a
         *  prior assignment. */
        seed: SeedResult | { skipped_reason: string } | null;
        seed_variant: TemplateVariant | null;
        /** Soft-failure indicator for the post-create HubSpot
         *  "Customer Folder" property write. See the submission
         *  handler comment for the rationale; rendered in the
         *  thread reply only when set. */
        hubspot_property_error?: string;
      }
    | { ok: false; error: string };
  /** Outcome of the deal→company field transpose pass. Null when the
   *  flow was triggered with a company ID (no deal source). */
  transposeResult?: TransposeResult | null;
  /** Non-null when the user pasted a deal URL/ID; surfaces a note so
   *  they can verify the right associated company was picked. */
  dealResolution?:
    | { dealId: string; companyId: string; otherCompanyCount: number }
    | null;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const hubspotOk = args.hubspotErrors.length === 0;
  const companyUrl = hubspotCompanyUrl(args.hubspotCompanyId);
  const lines: string[] = [];
  // When HubSpot fails the assignment never actually landed — the
  // headline reflects that so the thread doesn't read as a success.
  if (hubspotOk) {
    lines.push(
      `:white_check_mark: *<${companyUrl}|${args.companyName}>* assigned to ${args.assignedCsmMention} (${args.status}).`
    );
  } else {
    lines.push(
      `:x: Assignment did NOT land — HubSpot PATCH failed for *<${companyUrl}|${args.companyName}>* (intended owner: ${args.assignedCsmMention}).`
    );
    lines.push(
      "• To-dos + Drive folder were skipped (no point scheduling them when the HubSpot reassignment didn't take)."
    );
  }
  if (args.dealResolution) {
    const extras = args.dealResolution.otherCompanyCount;
    const dealUrl = hubspotDealUrl(args.dealResolution.dealId);
    lines.push(
      `• Resolved from deal <${dealUrl}|${args.dealResolution.dealId}>` +
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
  if (args.transposeResult) {
    const t = args.transposeResult;
    const parts: string[] = [];
    if (t.copied > 0) parts.push(`${t.copied} copied`);
    if (t.skipped > 0) parts.push(`${t.skipped} already set`);
    if (t.failures.length > 0) {
      const first = t.failures
        .slice(0, 3)
        .map((f) => f.label)
        .join(", ");
      parts.push(
        `${t.failures.length} failed (${first}${
          t.failures.length > 3 ? "…" : ""
        })`
      );
    }
    if (parts.length === 0) {
      lines.push("• Deal → Company transpose: nothing to copy.");
    } else {
      lines.push(`• Deal → Company transpose: ${parts.join(" · ")}.`);
    }
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
    // Template seed status — only one of three shapes is possible:
    // null (no template configured or idempotent reuse, nothing to say);
    // { copied, skipped } (real pass ran); { skipped_reason } (scope
    // missing or list call threw). Keeps the thread reply quiet when
    // the feature isn't in use.
    const seed = args.driveResult.seed;
    if (seed) {
      if ("skipped_reason" in seed) {
        lines.push(`   ⚠ Template seeding: ${seed.skipped_reason}`);
      } else if (seed.copied === 0 && seed.skipped.length === 0) {
        lines.push("   • Template folder was empty — nothing to seed.");
      } else {
        const variantLabel =
          args.driveResult.seed_variant === "with_op"
            ? "with-OP"
            : args.driveResult.seed_variant === "no_op"
              ? "no-OP"
              : null;
        const partsParts: string[] = [
          `${seed.copied} file${seed.copied === 1 ? "" : "s"} copied from ${
            variantLabel ? `${variantLabel} ` : ""
          }template`,
        ];
        const failed = seed.skipped.filter(
          (s) => s.reason !== "subfolder (not recursed)"
        );
        if (failed.length > 0) {
          partsParts.push(
            `${failed.length} failed (${failed
              .map((s) => s.name)
              .slice(0, 3)
              .join(", ")}${failed.length > 3 ? "…" : ""})`
          );
        }
        const subfolders = seed.skipped.filter(
          (s) => s.reason === "subfolder (not recursed)"
        );
        if (subfolders.length > 0) {
          partsParts.push(
            `${subfolders.length} subfolder${
              subfolders.length === 1 ? "" : "s"
            } skipped (not recursed)`
          );
        }
        lines.push(`   • Seeded: ${partsParts.join(" · ")}`);
      }
    }
    // HubSpot "Customer Folder" property write status. Silent on
    // success (the URL appears on the company record + flows
    // through into the next dashboard sync); surface only when
    // the write failed so an admin knows to backfill by hand.
    if (args.driveResult.hubspot_property_error) {
      lines.push(
        `   ⚠ Customer Folder property: ${args.driveResult.hubspot_property_error}`
      );
    }
  } else {
    lines.push(`• ⚠ Drive: ${args.driveResult.error}`);
  }

  // Explicit Links: footer so the HubSpot record + Drive folder are
  // immediately grabbable from the thread reply — the inline links
  // above sit inside narrative bullets and are easy to miss when the
  // thread gets long. This block always renders on success so the
  // assigned CSM can copy them out without scrolling. Skipped on the
  // failure path (no Drive folder yet; HubSpot URL is already in the
  // failure headline).
  if (hubspotOk && companyUrl) {
    const driveLine = args.driveResult.ok
      ? `📂 Drive: <${args.driveResult.webViewLink}|${args.driveResult.name}>`
      : `📂 Drive: _not created — ${args.driveResult.error}_`;
    lines.push("");
    lines.push("*Links*");
    lines.push(`🔗 HubSpot: <${companyUrl}|${args.companyName}>`);
    lines.push(driveLine);
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
