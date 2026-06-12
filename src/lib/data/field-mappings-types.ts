/**
 * Client-safe types + constants for the HubSpot ↔ dashboard field
 * mapping config. Lives separate from field-mappings.ts (which
 * imports the KV store) so client components can import the type
 * + the MAPPABLE_DASHBOARD_FIELDS catalog without pulling Postgres
 * + Node.js native modules into the browser bundle.
 *
 * The store file re-exports everything here so existing
 * `import { ... } from "field-mappings"` paths keep working.
 */

export type FieldMappingDirection = "off" | "pull" | "push" | "both";

export interface FieldMapping {
  hubspot_property: string;
  direction: FieldMappingDirection;
  updated_at?: string;
  updated_by?: string;
}

export interface FieldMappingsState {
  mappings: Record<string, FieldMapping>;
}

export interface MappableDashboardField {
  id: string;
  label: string;
  description: string;
  type: "string" | "enum" | "rich_text";
  edited_in: string;
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
  {
    id: "property_company_status",
    label: "Company status",
    description:
      "Onboarding vs Live — drives the Status filter on the CSM book table. Pulled from Metabase q10600 today; push-enabling lets a CSM flip an account to Live from the dashboard.",
    type: "enum",
    edited_in: "Customer detail panel → Status section",
    enum_values: ["Onboarding", "Live"],
  },
  {
    id: "property_risk_level",
    label: "Risk level",
    description:
      "Customer health flag — Green / Light Green / Yellow / Red, matching HubSpot's risk-level options. Pulled from HubSpot via q10600 today; making this push-enabled lets a CSM downgrade an account from the dashboard and have HubSpot pick it up.",
    type: "enum",
    edited_in: "Customer detail panel → Status section",
    // Order matches the chip color order (worst → best) so the
    // dropdown reads top-down as severity descending. Strings are
    // case-sensitive on the API side but RiskLevelChip normalizes
    // to lowercase before lookup, so casing only matters for what
    // HubSpot expects on the property — confirm against the
    // HubSpot property's allowed-values list if you see API
    // rejections on push.
    enum_values: ["Red", "Yellow", "Light Green", "Green"],
  },
  {
    id: "property_risk_level_detail",
    label: "Risk level detail",
    description:
      "Free-text explanation behind the risk level (e.g., \"low publishing cadence + 2 support escalations open\"). Pulled from HubSpot today; push-enabling lets CSMs annotate without leaving the dash.",
    type: "rich_text",
    edited_in: "Customer detail panel → Status section",
  },
  {
    id: "property_customer_goals",
    label: "Customer goals",
    description:
      "Headline goal for the account (e.g., \"Growth\", \"Engagement\", \"Monetization\"). HubSpot is canonical today; push-enabling makes the field editable from the dash.",
    type: "string",
    edited_in: "Customer detail panel → Status section",
  },
  {
    id: "property_customer_goals_detail",
    label: "Customer goals detail",
    description:
      "Free-text elaboration on the headline customer goal. Read-only today; push-enabling makes it editable.",
    type: "rich_text",
    edited_in: "Customer detail panel → Status section",
  },
  {
    id: "property_main_contact",
    label: "Main contact",
    description:
      "Primary point of contact at the customer (name + role). Pulled from HubSpot; push-enabling lets a CSM update it after a hand-off conversation without bouncing back to HubSpot.",
    type: "string",
    edited_in: "Customer detail panel → Contact section",
  },
];

export const DASHBOARD_FIELD_TO_CUSTOMER_KEY: Record<string, string> = {
  customer_success_manager: "customer_success_manager",
  interval: "interval",
  lifecycle_stage: "lifecycle_stage",
  notes: "notes",
  property_company_status: "property_company_status",
  property_risk_level: "property_risk_level",
  property_risk_level_detail: "property_risk_level_detail",
  property_customer_goals: "property_customer_goals",
  property_customer_goals_detail: "property_customer_goals_detail",
  property_main_contact: "property_main_contact",
};
