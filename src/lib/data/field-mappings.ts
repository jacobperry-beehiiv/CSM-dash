import { kvGet, kvSet } from "../storage/kv";

/**
 * HubSpot ↔ Dashboard field mapping configuration.
 *
 * Admins map each user-editable dashboard field (CSM, lifecycle stage,
 * cadence, notes) to a HubSpot company property and pick a sync
 * direction. The mappings live in one KV row so they survive deploys
 * and can be edited from /settings/hubspot-fields without code.
 *
 * V1 ships the mapping configuration only — the actual sync
 * behavior (pull during sync.ts, push on customer-overrides write)
 * is wired in a follow-up so the config + UI can be reviewed
 * independently.
 *
 * Direction semantics:
 *   "off"  — mapping defined but no sync; useful for staging changes.
 *   "pull" — HubSpot is canonical; sync.ts copies the property
 *            value onto the Customer row. Edits in the dashboard
 *            don't propagate back.
 *   "push" — Dashboard is canonical; edits in the dashboard write
 *            to the mapped HubSpot property immediately. HubSpot
 *            edits don't propagate back.
 *   "both" — Bidirectional. Sync pulls during nightly sync; edits
 *            push immediately. Last-write-wins (no merge logic) —
 *            documented in the UI as a caveat.
 */

export type FieldMappingDirection = "off" | "pull" | "push" | "both";

export interface FieldMapping {
  /** HubSpot company property internal name (e.g. "hubspot_owner_id",
   *  "stripe_customer_id__saas_"). The /settings/hubspot-fields UI
   *  pulls candidates from GET /api/hubspot/properties so the admin
   *  can pick the actual internal name (not the display label). */
  hubspot_property: string;
  direction: FieldMappingDirection;
  /** Audit fields. Set when the mapping was last saved. */
  updated_at?: string;
  updated_by?: string;
}

export interface FieldMappingsState {
  /** Keyed by dashboard field id (matches MAPPABLE_DASHBOARD_FIELDS[].id). */
  mappings: Record<string, FieldMapping>;
}

const KEY = "csm:hubspot-field-mappings:v1";

export async function loadFieldMappings(): Promise<FieldMappingsState> {
  const stored = await kvGet<FieldMappingsState>(KEY);
  return { mappings: stored?.mappings ?? {} };
}

export async function saveFieldMappings(
  next: FieldMappingsState
): Promise<FieldMappingsState> {
  // Drop empty/garbage entries so a half-edited row doesn't poison
  // the file.
  const cleaned: FieldMappingsState = {
    mappings: Object.fromEntries(
      Object.entries(next.mappings ?? {}).filter(
        ([, m]) =>
          m &&
          typeof m.hubspot_property === "string" &&
          m.hubspot_property.trim().length > 0
      )
    ),
  };
  await kvSet(KEY, cleaned);
  return cleaned;
}

/**
 * The canonical list of dashboard fields that can be mapped to a
 * HubSpot company property. V1 ships only the user-editable ones —
 * fields a CSM can change from inside the dashboard UI. Read-only
 * fields (ARR, active_subs, last_send, etc.) come from Metabase
 * and stay out of this mapping table for now.
 *
 * Extending: add an entry here. The settings page picks the list up
 * automatically. New mappings persist with `direction: "off"` by
 * default so adding a field doesn't immediately start syncing it.
 */
export interface MappableDashboardField {
  id: string;
  label: string;
  description: string;
  /** Loose type hint for compatibility warnings in the UI. Doesn't
   *  affect runtime behavior — the sync layer (V2) coerces values
   *  as needed. */
  type: "string" | "enum" | "rich_text";
  /** Where the field is edited in the dashboard. Surfaced in the
   *  settings UI so an admin knows which UX a mapping affects. */
  edited_in: string;
  /** For enum fields, the canonical value set. */
  enum_values?: string[];
}

export const MAPPABLE_DASHBOARD_FIELDS: MappableDashboardField[] = [
  {
    id: "customer_success_manager",
    label: "CSM / Account Owner",
    description:
      "The CSM assigned to this account. Today: refresh-csm button pulls hubspot_owner_id; /update-csm Slack modal pushes back. Mapping here lets you formalize that as a bidirectional rule.",
    type: "string",
    edited_in: "Customer detail panel → Contact section",
  },
  {
    id: "interval",
    label: "Billing cadence",
    description:
      "Monthly vs Annual override (set by the Cadence toggle on the customer detail panel). Stripe is the source of truth via q10600; this override lets a CSM force a different cadence for renewal-tab classification.",
    type: "enum",
    edited_in: "Customer detail panel → Billing cadence toggle",
    enum_values: ["month", "annual"],
  },
  {
    id: "lifecycle_stage",
    label: "Lifecycle stage",
    description:
      "User-facing renewal lifecycle stage (drives the Lifecycle column on /am Renewals). Configurable list lives in settings.am.lifecycle_stages.",
    type: "string",
    edited_in: "/am Renewals → Lifecycle column dropdown",
  },
  {
    id: "notes",
    label: "Customer notes",
    description:
      "Free-text notes added in the dashboard. \"Post to HubSpot\" button on each note already pushes manually; a mapping here would let push-direction fire automatically on save.",
    type: "rich_text",
    edited_in: "Customer detail panel → Notes section",
  },
];
