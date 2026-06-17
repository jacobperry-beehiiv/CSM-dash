import type { AdGapReport, Customer } from "../types";
import { lastContacted } from "../customer-helpers";
import type { EnterpriseTier } from "../tiers/store";
import {
  fmtTier,
  fmtTierLadderHtml,
  fmtTierLadderText,
  fmtTierPrice,
  findCurrentTier,
  nextTiers,
} from "../tiers/helpers";

/**
 * Merge-tag interpolator. Replaces `{{token}}` occurrences in a string with
 * a value computed from the customer record (and optional context).
 */

export interface MergeContext {
  /** Loaded by callers that want tier-related tags to resolve. When absent,
   *  tier tokens resolve to "—" so the placeholder is visible in the draft. */
  ladder?: EnterpriseTier[];
  /** Loaded by callers that want ad-revenue tags to resolve (single-customer
   *  flows only — bulk drafting skips this for performance). */
  adGap?: AdGapReport | null;
  /** Number of recipients the rendered draft will be addressed to. Used by
   *  the first-name resolver — when sending to a group there's no single
   *  "first name" to greet, so it falls back to "there". Default 1. */
  recipient_count?: number;
  /** When exactly one recipient is selected, the bulk-drafts modal passes
   *  the recipient's email here so the first-name resolver can match
   *  hubspot_contacts[].email and use THAT person's name — not whichever
   *  HubSpot contact happens to be first in the array. Set to null when
   *  no specific recipient is in scope (e.g. single-customer OutreachModal
   *  with multiple checkboxes ticked). */
  recipient_email?: string | null;
  /** Past-due context — set only when drafting from the Past Due panel.
   *  `past_due_month` is the full month name of the failed charge
   *  ("June", "July", …) parsed from PastDueRow.charge_attempted_at.
   *  `past_due_reason` is a humanized phrase derived from
   *  PastDueRow.failure_code / failure_message ("due to insufficient
   *  funds", "due to card decline", "due to a payment issue").
   *  Both render as "—" when absent, so a template that references
   *  these tags still works (visibly degraded) outside the Past Due
   *  flow. */
  past_due_month?: string | null;
  past_due_reason?: string | null;
  /** Deliverability-outreach context. Filled in by callers building
   *  a one-off deliverability warning email — populates the
   *  `publication_name`, `send_name`, `flagged_metric`, `flagged_value`,
   *  `above_or_below`, `benchmark_value`, `cta`, `sender_name`, and
   *  `sender_title` tags below.
   *
   *  Designed as a single nested object instead of nine top-level
   *  fields so it's clear which tags belong to the same flow — and
   *  so a future second deliverability template (warning-resolved,
   *  follow-up, etc.) can share the same shape.
   *
   *  Each field is independently optional: a template that
   *  references `send_name` still renders cleanly on a draft where
   *  send_name is unknown — the conditional-block syntax
   *  `{{#send_name}}…{{/send_name}}` (handled in applyMergeTags)
   *  drops the wrapping copy on absent values. */
  deliverability?: {
    publication_name?: string | null;
    send_name?: string | null;
    /** Human label for the metric being flagged. e.g. "open rate",
     *  "spam rate", "click-through rate". Capitalize as you'd read
     *  it in prose. */
    flagged_metric?: string | null;
    /** Pre-formatted value, e.g. "0.23%", "12.4K". The library
     *  doesn't try to format from a number here because metrics
     *  in this flow come pre-rendered from the deliverability
     *  panel's existing formatters. */
    flagged_value?: string | null;
    /** "above" or "below". Free-text so a template can also use
     *  phrases like "well below" without us coercing. */
    above_or_below?: string | null;
    benchmark_value?: string | null;
    /** Call-to-action sentence. e.g. "Reply here if you'd like
     *  me to dig in" or a calendar link. */
    cta?: string | null;
    /** Sender's display name. Defaults to the customer's CSM
     *  (humanized) when absent. */
    sender_name?: string | null;
    /** Sender's title. Defaults to "Customer Success Manager"
     *  when absent. */
    sender_title?: string | null;
  };
}

export interface MergeTag {
  token: string;
  label: string;
  description: string;
  resolve: (c: Customer, ctx: MergeContext) => string;
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null) return "$—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Resolve `s` to a usable first name. Returns "there" when:
 *   - the value is empty / null / whitespace
 *   - the value looks like an email address (contains `@`). HubSpot's
 *     `main_contact` field is often just the owner email when no real
 *     contact has been set, and "Hi eric@plugivery.com," reads worse
 *     than "Hi there,".
 *
 * Otherwise it takes the first whitespace-delimited token, which
 * handles "First Last" and "First Middle Last" cleanly.
 */
function firstName(s: string | null | undefined): string {
  if (!s) return "there";
  const trimmed = s.trim();
  if (!trimmed) return "there";
  if (/\S+@\S+\.\S+/.test(trimmed)) return "there";
  return trimmed.split(/\s+/)[0] || "there";
}

/**
 * Pull a usable first name out of the sync-time HubSpot enrichment
 * when one's available. Preferred over property_main_contact because:
 *
 *   • hubspot_contacts carry a structured `name` field that
 *     property_main_contact often doesn't (HubSpot's main_contact
 *     property on the company record is just the owner email for ~80%
 *     of rows in beehiiv's portal).
 *   • Enrichment covers ~75% of customers; for those, the HubSpot
 *     name is "Eric Nolot" while property_main_contact is
 *     "eric@plugivery.com".
 *
 * Pick order:
 *   1. Contact flagged `is_primary` (HubSpot's hs_primary_contact_id
 *      when the enrichment can resolve it).
 *   2. First contact with a non-email, non-empty `name`.
 *   3. null — caller falls back to property_main_contact / "there".
 */
function bestHubspotFirstName(c: Customer): string | null {
  const contacts = c.hubspot_contacts;
  if (!contacts || contacts.length === 0) return null;
  const candidate =
    contacts.find((x) => x.is_primary && x.name) ??
    contacts.find(
      (x) => x.name && x.name.trim() && !/@/.test(x.name)
    ) ??
    null;
  if (!candidate?.name) return null;
  const name = firstName(candidate.name);
  return name === "there" ? null : name;
}

/**
 * Greeting helper for the `customer.contact_first_name` token.
 *
 * Resolution order:
 *   1. "there" — when the draft is going to more than one recipient
 *      (a personal "Hi Eric," reads strangely on a group send).
 *   2. **Per-recipient lookup** — when the caller passed a specific
 *      `recipient_email`, find THAT contact in hubspot_contacts and
 *      use their name. If we don't know who that email is, return
 *      "there" rather than guessing a different HubSpot contact —
 *      that was the speedtoscale.com bug where selecting Colton
 *      gave "Hi Cait,".
 *   3. **Best-guess HubSpot contact** — no specific recipient in
 *      scope (single-customer modal with default behaviour). Pick
 *      is_primary first, then the first contact with a real name.
 *   4. **property_main_contact** — the legacy Metabase q10600
 *      column. Often an email which `firstName()` detects and bails
 *      from with "there".
 *   5. "there" — last resort.
 */
function firstNameForContext(
  c: Customer,
  ctx: MergeContext
): string {
  if ((ctx.recipient_count ?? 1) > 1) return "there";

  if (ctx.recipient_email) {
    const target = ctx.recipient_email.toLowerCase();
    const matched = c.hubspot_contacts?.find(
      (x) => x.email && x.email.toLowerCase() === target && x.name
    );
    if (matched?.name) {
      const n = firstName(matched.name);
      if (n !== "there") return n;
    }
    // We know who we're addressing but don't have their name —
    // "there" beats picking the wrong person's name.
    return "there";
  }

  const fromHubspot = bestHubspotFirstName(c);
  if (fromHubspot) return fromHubspot;
  return firstName(c.property_main_contact);
}

function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = n > 1 ? n : n * 100;
  return `${v.toFixed(0)}%`;
}

// ─── Tier-aware resolvers ─────────────────────────────────────────────
// All return "—" when no ladder context is provided so the missing data is
// visible in the rendered preview rather than silently empty.

function tierResolver(
  pick: (
    customer: Customer,
    ladder: EnterpriseTier[]
  ) => string | null
): (c: Customer, ctx: MergeContext) => string {
  return (c, ctx) => {
    if (!ctx.ladder) return "—";
    return pick(c, ctx.ladder) ?? "—";
  };
}

function nthNextTier(n: number) {
  return (c: Customer, ladder: EnterpriseTier[]): string | null => {
    const list = nextTiers(c, ladder, n + 1);
    const t = list[n];
    return t ? fmtTier(t, c) : null;
  };
}

function nthNextTierSubs(n: number) {
  return (c: Customer, ladder: EnterpriseTier[]): string | null => {
    const list = nextTiers(c, ladder, n + 1);
    return list[n]?.name ?? null;
  };
}

function nthNextTierPrice(n: number) {
  return (c: Customer, ladder: EnterpriseTier[]): string | null => {
    const list = nextTiers(c, ladder, n + 1);
    const t = list[n];
    return t ? fmtTierPrice(t, c) : null;
  };
}

export const MERGE_TAGS: MergeTag[] = [
  {
    token: "customer.name",
    label: "Company name",
    description: "Company display name (falls back to workspace name).",
    resolve: (c) => c.company_name ?? c.workspace_name ?? "your team",
  },
  {
    token: "customer.contact",
    label: "Main contact",
    description: "HubSpot 'main contact' for the account.",
    resolve: (c) => c.property_main_contact ?? c.owner_email ?? "there",
  },
  {
    token: "customer.contact_first_name",
    label: "Contact first name",
    description:
      "First name of the main contact. Falls back to \"there\" when the contact is an email address or the draft is going to multiple recipients.",
    resolve: (c, ctx) => firstNameForContext(c, ctx),
  },
  {
    token: "customer.email",
    label: "Owner email",
    description: "Workspace owner email.",
    resolve: (c) => c.owner_email ?? "",
  },
  {
    token: "customer.csm",
    label: "CSM",
    description: "Customer success manager (e.g., Jacob Perry).",
    resolve: (c) =>
      c.customer_success_manager?.replace(/_/g, " ") ?? "your CSM",
  },
  {
    token: "customer.arr",
    label: "ARR",
    description: "Annual recurring revenue, currency-formatted.",
    resolve: (c) => fmtCurrency(c.arr),
  },
  {
    token: "customer.mrr",
    label: "MRR",
    description: "Monthly recurring revenue, currency-formatted.",
    resolve: (c) => fmtCurrency(c.mrr),
  },
  {
    token: "customer.subs",
    label: "Active subscribers",
    description: "Number of active subscribers.",
    resolve: (c) => fmtNumber(c.active_subs),
  },
  {
    token: "customer.tier",
    label: "Subscriber tier (cap)",
    description: "Max subscribers on their current plan.",
    resolve: (c) => fmtNumber(c.max_subscriptions),
  },
  {
    token: "customer.tier_pct",
    label: "% of subscriber tier",
    description: "Percent of max subs in use.",
    resolve: (c) => pct(c.percent_of_max_subs),
  },
  {
    token: "customer.plan",
    label: "Plan",
    description: "Stripe plan name.",
    resolve: (c) => c.stripe_plan ?? "—",
  },
  {
    token: "customer.last_send",
    label: "Last send",
    description: "Date the customer most recently sent a newsletter.",
    resolve: (c) => fmtDate(c.last_send),
  },
  {
    token: "customer.last_login",
    label: "Last login",
    description: "Most recent login (q10600 only populates within 14d).",
    resolve: (c) => fmtDate(c.last_log_in),
  },
  {
    token: "customer.last_contacted",
    label: "Last contacted",
    description:
      "Most-recent activity across any HubSpot contact at this company " +
      "(emails / calls / meetings / notes). Falls back to the legacy " +
      "notes_last_contacted field when HubSpot enrichment isn't available.",
    resolve: (c) => fmtDate(lastContacted(c).date),
  },
  {
    token: "customer.next_charge",
    label: "Next charge / renewal",
    description: "next_invoice from Stripe, or contract renewal date.",
    resolve: (c) => fmtDate(c.next_invoice ?? c.renewal_date),
  },
  {
    token: "customer.risk_level",
    label: "Risk level",
    description: "CSM-set HubSpot risk level (Yellow / Red / Light Green).",
    resolve: (c) => c.property_risk_level ?? "—",
  },
  {
    token: "customer.risk_detail",
    label: "Risk detail",
    description: "Free-text reason from HubSpot risk_level_detail.",
    resolve: (c) => c.property_risk_level_detail ?? "",
  },
  {
    token: "customer.goal",
    label: "Customer goal",
    description: "HubSpot customer_goals_csm property.",
    resolve: (c) => c.property_customer_goals ?? "",
  },

  // ─── Enterprise tier ladder (editable on /tiers) ──────────────────
  {
    token: "customer.current_tier",
    label: "Current tier",
    description:
      "The customer's current Enterprise tier formatted as 'subs / price' (price honors their billing cadence).",
    resolve: tierResolver((c, ladder) => {
      const t = findCurrentTier(c, ladder);
      return t ? fmtTier(t, c) : null;
    }),
  },
  {
    token: "customer.current_tier_subs",
    label: "Current tier — subs",
    description: "Tier name (subscriber bucket), e.g. '500K'.",
    resolve: tierResolver(
      (c, ladder) => findCurrentTier(c, ladder)?.name ?? null
    ),
  },
  {
    token: "customer.current_tier_price",
    label: "Current tier — price",
    description:
      "Tier price formatted with cadence (e.g. '$50K/yr' or '$5K/mo').",
    resolve: tierResolver((c, ladder) => {
      const t = findCurrentTier(c, ladder);
      return t ? fmtTierPrice(t, c) : null;
    }),
  },
  {
    token: "customer.next_tier_1",
    label: "Next tier — full",
    description: "First tier above the current — 'subs / price' format.",
    resolve: tierResolver(nthNextTier(0)),
  },
  {
    token: "customer.next_tier_1_subs",
    label: "Next tier — subs",
    description: "First-up tier subscriber name (e.g. '1M').",
    resolve: tierResolver(nthNextTierSubs(0)),
  },
  {
    token: "customer.next_tier_1_price",
    label: "Next tier — price",
    description: "First-up tier price.",
    resolve: tierResolver(nthNextTierPrice(0)),
  },
  {
    token: "customer.next_tier_2",
    label: "Tier +2",
    description: "Two tiers above the current.",
    resolve: tierResolver(nthNextTier(1)),
  },
  {
    token: "customer.next_tier_2_subs",
    label: "Tier +2 — subs",
    description: "Two-up tier subscriber name.",
    resolve: tierResolver(nthNextTierSubs(1)),
  },
  {
    token: "customer.next_tier_2_price",
    label: "Tier +2 — price",
    description: "Two-up tier price.",
    resolve: tierResolver(nthNextTierPrice(1)),
  },
  {
    token: "customer.next_tier_3",
    label: "Tier +3",
    description: "Three tiers above the current.",
    resolve: tierResolver(nthNextTier(2)),
  },
  {
    token: "customer.next_tier_3_subs",
    label: "Tier +3 — subs",
    description: "Three-up tier subscriber name.",
    resolve: tierResolver(nthNextTierSubs(2)),
  },
  {
    token: "customer.next_tier_3_price",
    label: "Tier +3 — price",
    description: "Three-up tier price.",
    resolve: tierResolver(nthNextTierPrice(2)),
  },
  {
    token: "customer.tier_ladder_html",
    label: "Tier ladder (HTML <ul>)",
    description:
      "HTML list of the next 3 tiers above the customer — drop into the rich-text body.",
    resolve: tierResolver((c, ladder) =>
      fmtTierLadderHtml(nextTiers(c, ladder, 3), c)
    ),
  },
  {
    token: "customer.tier_ladder_text",
    label: "Tier ladder (plain text)",
    description: "Bullet list of the next 3 tiers, rendered as plain text.",
    resolve: tierResolver((c, ladder) =>
      fmtTierLadderText(nextTiers(c, ladder, 3), c)
    ),
  },

  // ─── Ad network revenue (last 90d window) ─────────────────────────
  // These resolve when the caller passes `ctx.adGap`. The OutreachModal
  // does this for single-customer drafts; bulk paths leave them as "—".
  {
    token: "customer.ad_revenue_actual",
    label: "Ad network — actual revenue (90d)",
    description: "Sum of approved disbursements over the last 90 days.",
    resolve: (_, ctx) =>
      ctx.adGap ? fmtCurrency(ctx.adGap.portfolio_actual_dollars) : "—",
  },
  {
    token: "customer.ad_revenue_potential",
    label: "Ad network — potential at 100% fill",
    description:
      "Estimate of revenue if every missed-ad opportunity had filled at the customer's average per-ad rate.",
    resolve: (_, ctx) =>
      ctx.adGap
        ? fmtCurrency(ctx.adGap.portfolio_potential_at_full_fill_dollars)
        : "—",
  },
  {
    token: "customer.ad_revenue_gap",
    label: "Ad network — revenue gap",
    description:
      "Potential at 100% fill minus actual revenue — what they're leaving on the table.",
    resolve: (_, ctx) => {
      if (!ctx.adGap) return "—";
      const gap = Math.max(
        0,
        ctx.adGap.portfolio_potential_at_full_fill_dollars -
          ctx.adGap.portfolio_actual_dollars
      );
      return fmtCurrency(gap);
    },
  },
  {
    token: "customer.ad_zero_pubs",
    label: "Ad network — zero-ad publications",
    description:
      "Count of publications that are actively sending but have run zero ads in the period.",
    resolve: (_, ctx) =>
      ctx.adGap ? String(ctx.adGap.zero_ad_sending_pubs.length) : "—",
  },
  // ─── Past Due — failed-charge context ─────────────────────────────
  // These two tags only resolve when the draft is being built from
  // the Past Due panel (which threads charge metadata into ctx via
  // extraContextFor). Outside that flow they render as "—" so a
  // template can still be previewed without crashing.
  //
  // Token case mirrors what a CSM would type: MONTH / REASON, all
  // caps, no `customer.` prefix — short enough that pasting them
  // into a templated body reads naturally ("Your {{MONTH}} charge
  // failed {{REASON}}").
  {
    token: "MONTH",
    label: "Past Due — month of failed charge",
    description:
      "Full month name of the failed charge (e.g. \"June\"). Pulled from PastDueRow.charge_attempted_at. Only resolves when drafting from the Past Due panel.",
    resolve: (_, ctx) => ctx.past_due_month || "—",
  },
  {
    token: "REASON",
    label: "Past Due — reason phrase",
    description:
      "Humanized phrase for why the charge failed (e.g. \"due to insufficient funds\", \"due to card decline\"). Derived from Stripe's failure_code on PastDueRow. Falls back to \"due to a payment issue\" for codes we haven't mapped.",
    resolve: (_, ctx) => ctx.past_due_reason || "—",
  },

  // ─── Deliverability warning template ──────────────────────────────
  //
  // Powers the "we noticed a deliverability signal" outreach email.
  // All resolve via ctx.deliverability — when that's missing, each
  // returns an empty string (NOT "—") so the conditional-block
  // wrapper `{{#token}}…{{/token}}` can correctly hide the
  // surrounding sentence on absent fields.
  //
  // Unprefixed token names (no `customer.` prefix) match the
  // convention MONTH/REASON established for the Past Due template:
  // when the tag is template-specific rather than customer-attribute
  // derived, dropping the prefix reads cleaner in the source
  // template ("noticed {{flagged_metric}} of {{flagged_value}}").
  {
    token: "first_name",
    label: "Recipient first name (unprefixed alias)",
    description:
      "Convenience alias for customer.contact_first_name — reads cleaner in unprefixed templates like the deliverability warning.",
    resolve: (c, ctx) => firstNameForContext(c, ctx),
  },
  {
    token: "publication_name",
    label: "Publication — name",
    description:
      "Name of the publication being flagged. Set by the caller (deliverability panel's outreach launcher).",
    resolve: (_, ctx) => ctx.deliverability?.publication_name?.trim() || "",
  },
  {
    token: "send_name",
    label: "Send — name / subject",
    description:
      "Name or subject line of the specific send being flagged. Optional — wrap dependent copy in {{#send_name}}…{{/send_name}} to hide it cleanly when absent.",
    resolve: (_, ctx) => ctx.deliverability?.send_name?.trim() || "",
  },
  {
    token: "flagged_metric",
    label: "Flagged metric — label",
    description:
      "Human label for the metric being flagged (e.g. \"an open rate\", \"a spam rate\"). Set by the caller; not auto-derived from the deliverability snapshot.",
    resolve: (_, ctx) => ctx.deliverability?.flagged_metric?.trim() || "",
  },
  {
    token: "flagged_value",
    label: "Flagged metric — value",
    description:
      "Pre-formatted value of the flagged metric (e.g. \"0.23%\", \"43%\"). Library does not coerce numbers — pass formatted strings from the deliverability panel's formatters.",
    resolve: (_, ctx) => ctx.deliverability?.flagged_value?.trim() || "",
  },
  {
    token: "above_or_below",
    label: "Direction — above or below benchmark",
    description:
      "\"above\" or \"below\" (free-text so callers can also use phrases like \"well below\"). Renders the comparator copy: \"X% above the Y% we'd typically expect\".",
    resolve: (_, ctx) => ctx.deliverability?.above_or_below?.trim() || "",
  },
  {
    token: "benchmark_value",
    label: "Benchmark — value",
    description:
      "Pre-formatted benchmark the flagged value is being compared against (e.g. \"0.10%\", \"25%\").",
    resolve: (_, ctx) => ctx.deliverability?.benchmark_value?.trim() || "",
  },
  {
    token: "cta",
    label: "Call-to-action",
    description:
      "Closing sentence offering the next step. Free-text so it can be a question, a calendar link, or a meeting invite.",
    resolve: (_, ctx) => ctx.deliverability?.cta?.trim() || "",
  },
  {
    token: "sender_name",
    label: "Sender — display name",
    description:
      "Sender's full name. Defaults to the customer's CSM (humanized) when ctx.deliverability.sender_name is unset, so a template renders cleanly without explicit context.",
    resolve: (c, ctx) =>
      ctx.deliverability?.sender_name?.trim() ||
      c.customer_success_manager?.replace(/_/g, " ") ||
      "",
  },
  {
    token: "sender_title",
    label: "Sender — title",
    description:
      "Sender's job title. Defaults to \"Customer Success Manager\" when unset.",
    resolve: (_, ctx) =>
      ctx.deliverability?.sender_title?.trim() || "Customer Success Manager",
  },
];

const TAG_INDEX = new Map(MERGE_TAGS.map((t) => [t.token, t]));

/**
 * Replace `{{token}}` occurrences with resolved values. Two passes:
 *
 *   1. Conditional blocks: `{{#token}}…{{/token}}` renders the
 *      inner content only when `token` resolves to a non-empty
 *      string. Useful for optional fields where the surrounding
 *      copy would read awkwardly with the value missing — e.g.
 *      `"Your recent send{{#send_name}}, \"{{send_name}},\"{{/send_name}}
 *      showed…"` keeps the comma + quotes only when the send has a
 *      name to surface. Subset of Mustache section syntax (no
 *      iteration, no nesting); enough for the templates we have.
 *
 *   2. Plain `{{token}}` substitution against the resolved value.
 *      Unknown tokens are left as-is so the user can see them in
 *      the preview rather than getting a silently-empty render.
 *
 * Pass `ctx.ladder` from any caller that wants tier-aware tags to
 * resolve; `ctx.deliverability` for the deliverability-template
 * tags; etc. — see MergeContext.
 */
export function applyMergeTags(
  template: string,
  customer: Customer,
  ctx: MergeContext = {}
): string {
  // Resolve a token to its string value once per call so the
  // conditional-block check and the substitution agree (a tag's
  // resolver could theoretically return different values across
  // calls; cache once for consistency).
  const resolveToken = (token: string): string | null => {
    const tag = TAG_INDEX.get(token);
    if (!tag) return null;
    return tag.resolve(customer, ctx);
  };

  // Pass 1: conditional sections. We match {{#NAME}}…{{/NAME}}
  // non-greedily (the `.` flag is implicit via [\s\S]) so multiple
  // blocks in the same template don't gobble each other. Inner
  // content keeps its own {{token}}s — they're substituted in pass
  // 2 below.
  let out = template.replace(
    /\{\{\s*#\s*([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}/g,
    (_match, token: string, inner: string) => {
      const value = resolveToken(token);
      // Truthy = non-null + non-empty after trim. Unknown tags
      // (resolveToken returns null) also drop the block — there's
      // no value to anchor the surrounding copy to.
      return value && value.trim().length > 0 ? inner : "";
    }
  );

  // Pass 2: plain tokens.
  out = out.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, token) => {
    const resolved = resolveToken(token);
    return resolved !== null ? resolved : match;
  });

  return out;
}

export function isKnownTag(token: string): boolean {
  return TAG_INDEX.has(token);
}
