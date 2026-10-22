/**
 * External-link helpers — masquerade into a customer workspace and pre-compose
 * an email in Gmail.
 */

import type { AdGapReport, Customer } from "./types";
import { applyMergeTags } from "./templates/merge-tags";
import type { StoredTemplate } from "./templates/store";
import type { EnterpriseTier } from "./tiers/store";

const DEFAULT_MASQUERADE_TEMPLATE =
  "https://app.beehiiv.com/system_admin/users/masquerade?email={email}";

/**
 * beehiiv system-admin page for a workspace.
 *
 * ─── Assumption worth checking ────────────────────────────────────
 * The only system_admin route this repo has ever known is the
 * masquerade one above, so the path here is INFERRED: system_admin is
 * Rails-shaped, and a workspace is an "organization" in beehiiv's
 * data model (every publication belongs to exactly one organization,
 * which is the workspace — the same join the Zendesk sweep relies
 * on). If the real route differs, override with
 * NEXT_PUBLIC_SYSTEM_ADMIN_WORKSPACE_URL_TEMPLATE rather than editing
 * this default, so it travels with the deployment.
 */
const DEFAULT_SYSTEM_ADMIN_WORKSPACE_TEMPLATE =
  "https://app.beehiiv.com/system_admin/organizations/{workspace_id}";

const DEFAULT_METABASE_PUB_TEMPLATE =
  "https://beehiiv.metabaseapp.com/question/3401-all-with-filters?company_%252F_workspace_search={workspace_name}";

/**
 * Masquerade URL keyed on email (per beehiiv system_admin route).
 */
export function masqueradeUrl(email: string | null | undefined): string | null {
  if (!email) return null;
  const tpl =
    process.env.NEXT_PUBLIC_MASQUERADE_URL_TEMPLATE ??
    DEFAULT_MASQUERADE_TEMPLATE;
  return tpl.replace("{email}", encodeURIComponent(email));
}

/**
 * System-admin URL for a workspace, keyed on workspace_id.
 *
 * Returns null without a workspace_id so callers render nothing
 * rather than a link that 404s — same posture as every other helper
 * in this file.
 */
export function systemAdminWorkspaceUrl(
  workspaceId: string | null | undefined
): string | null {
  const id = (workspaceId ?? "").trim();
  if (!id) return null;
  const tpl =
    process.env.NEXT_PUBLIC_SYSTEM_ADMIN_WORKSPACE_URL_TEMPLATE ??
    DEFAULT_SYSTEM_ADMIN_WORKSPACE_TEMPLATE;
  return tpl.replace("{workspace_id}", encodeURIComponent(id));
}

/**
 * HubSpot company-page URL. Returns null when we don't have the
 * `hubspot_company_id` (e.g. the row didn't match during sync-time
 * enrichment). Portal id is the beehiiv workspace's HubSpot account —
 * overridable via NEXT_PUBLIC_HUBSPOT_PORTAL_ID if we ever stand up
 * a second portal.
 *
 * `0-2` in the path is HubSpot's object-type id for companies (vs
 * 0-1 contacts, 0-3 deals).
 */
const DEFAULT_HUBSPOT_PORTAL_ID = "21568530";

export function hubspotCompanyUrl(
  hubspotCompanyId: string | null | undefined
): string | null {
  if (!hubspotCompanyId) return null;
  const portal =
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID ?? DEFAULT_HUBSPOT_PORTAL_ID;
  return `https://app.hubspot.com/contacts/${portal}/record/0-2/${encodeURIComponent(
    hubspotCompanyId
  )}`;
}

/**
 * HubSpot deal record URL — parallel to hubspotCompanyUrl. `0-3` is
 * HubSpot's object-type id for deals (vs 0-2 companies, 0-1 contacts).
 * Same portal-id source as the company helper so a future second-portal
 * setup flows through the env var without touching call sites.
 */
export function hubspotDealUrl(
  hubspotDealId: string | null | undefined
): string | null {
  if (!hubspotDealId) return null;
  const portal =
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID ?? DEFAULT_HUBSPOT_PORTAL_ID;
  return `https://app.hubspot.com/contacts/${portal}/record/0-3/${encodeURIComponent(
    hubspotDealId
  )}`;
}

/**
 * Stripe Dashboard URL for a customer record. Defaults to live mode
 * since this dashboard reads production data; set
 * NEXT_PUBLIC_STRIPE_TEST_MODE=true to point links at the test
 * dashboard for local sandboxing.
 */
export function stripeCustomerUrl(
  stripeCustomerId: string | null | undefined
): string | null {
  if (!stripeCustomerId) return null;
  const test = process.env.NEXT_PUBLIC_STRIPE_TEST_MODE === "true";
  const segment = test ? "test/customers" : "customers";
  return `https://dashboard.stripe.com/${segment}/${encodeURIComponent(
    stripeCustomerId
  )}`;
}

/**
 * Zendesk agent-search deep-link for a customer email. Renders the
 * ticket-search results view — same URL the D&C skill uses to pull
 * a customer's full support footprint before deciding on an upgrade.
 * Path pattern (`/agent/search/1?copy&type=ticket&q=<email>`) is
 * lifted verbatim from Richard's playbook so a "Zendesk history"
 * click lands on the exact view D&C would open by hand.
 *
 * Instance host defaults to beehiiv's help subdomain; override via
 * NEXT_PUBLIC_ZENDESK_URL if the workspace is ever migrated.
 */
const DEFAULT_ZENDESK_URL = "https://beehiivhelp.zendesk.com";

export function zendeskSearchUrl(
  email: string | null | undefined
): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed) return null;
  const base = process.env.NEXT_PUBLIC_ZENDESK_URL ?? DEFAULT_ZENDESK_URL;
  const params = new URLSearchParams({
    copy: "",
    type: "ticket",
    q: trimmed,
  });
  return `${base}/agent/search/1?${params.toString()}`;
}

/**
 * Slack deep-link for a channel ID. Returns the archives URL which
 * works in both the web client and the native app (Slack redirects to
 * the app via custom URL scheme when installed). Workspace subdomain
 * defaults to "beehiiv" — override via NEXT_PUBLIC_SLACK_WORKSPACE if
 * the project is ever pointed at a different org.
 */
const DEFAULT_SLACK_WORKSPACE = "beehiiv";

export function slackChannelUrl(
  channelId: string | null | undefined
): string | null {
  if (!channelId) return null;
  const trimmed = channelId.trim();
  // Sanity-check the shape — Slack IDs are uppercase alphanumerics
  // starting with C (public channel), G (private group), or D (DM).
  if (!/^[CGD][A-Z0-9]{6,}$/.test(trimmed)) return null;
  const workspace =
    process.env.NEXT_PUBLIC_SLACK_WORKSPACE ?? DEFAULT_SLACK_WORKSPACE;
  return `https://${workspace}.slack.com/archives/${trimmed}`;
}

/**
 * Slack deep-link for one message / thread parent.
 *
 * Permalink shape is `/archives/<channel>/p<ts with the dot removed>`
 * — Slack's own `chat.getPermalink` returns exactly this. We build it
 * locally rather than calling the API because the renewals table
 * renders a link per row and we already hold both halves in KV; an
 * API round-trip per row would be absurd for a URL we can derive.
 *
 * `thread_ts` is Slack's message timestamp ("1792519270.123456"), not
 * a date. Strip only the dot — zero-padding or reformatting breaks
 * the link.
 */
export function slackThreadUrl(
  channelId: string | null | undefined,
  threadTs: string | null | undefined
): string | null {
  const channel = slackChannelUrl(channelId);
  if (!channel) return null;
  const ts = (threadTs ?? "").trim();
  // Slack timestamps are "<seconds>.<microseconds>". Anything else
  // isn't one, and a malformed permalink lands on a Slack error page
  // rather than failing visibly, so refuse instead of guessing.
  if (!/^\d{10}\.\d{4,6}$/.test(ts)) return null;
  return `${channel}/p${ts.replace(".", "")}`;
}

/**
 * Returns a Metabase deep link for a specific publication / workspace.
 * Configurable via NEXT_PUBLIC_METABASE_PUB_URL_TEMPLATE — substitution
 * tokens supported: {workspace_id}, {workspace_name}, {publication_id}.
 */
export function metabasePubUrl(args: {
  workspace_id?: string | null;
  workspace_name?: string | null;
  publication_id?: string | null;
}): string | null {
  const tpl =
    process.env.NEXT_PUBLIC_METABASE_PUB_URL_TEMPLATE ??
    DEFAULT_METABASE_PUB_TEMPLATE;
  const ws = args.workspace_id ?? "";
  const wn = args.workspace_name ?? "";
  const pub = args.publication_id ?? "";
  if (!ws && !wn && !pub) return null;
  return tpl
    .replace("{workspace_id}", encodeURIComponent(ws))
    .replace("{workspace_name}", encodeURIComponent(wn))
    .replace("{publication_id}", encodeURIComponent(pub));
}

interface ComposeArgs {
  to: string;
  /** Comma-separated CC list. Optional. */
  cc?: string;
  /** Comma-separated BCC list. Optional. */
  bcc?: string;
  subject: string;
  body: string;
  /**
   * Email of the Google account (or alias's owner account) the
   * compose tab should open under. Switches the URL prefix to
   * `mail/u/<authuser>/` so users on multi-account sessions land in
   * the right inbox. Gmail's web compose URL has no documented
   * `from=` param — the user still picks the alias from the From
   * dropdown inside the compose tab. Unset → primary account.
   */
  authuser?: string;
}

export function gmailComposeUrl({
  to,
  cc,
  bcc,
  subject,
  body,
  authuser,
}: ComposeArgs): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to,
    su: subject,
    body,
  });
  if (cc && cc.trim()) params.set("cc", cc.trim());
  if (bcc && bcc.trim()) params.set("bcc", bcc.trim());
  const trimmedAuth = authuser?.trim();
  const prefix = trimmedAuth
    ? `https://mail.google.com/mail/u/${encodeURIComponent(trimmedAuth)}/`
    : "https://mail.google.com/mail/";
  return `${prefix}?${params.toString()}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<li[^>]*>/gi, "  • ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Build a Gmail compose URL for a customer + a chosen template, applying
 * merge tags. Used by the row-level "Email" quick button after fetching
 * templates from /api/templates client-side.
 */
export function composeUrlForTemplate(
  template: StoredTemplate,
  customer: Customer,
  ladder?: EnterpriseTier[],
  extra?: {
    cc?: string | null;
    bcc?: string | null;
    /** Signed-in CSM's custom merge tags — folded into the compose URL's
     *  merge context so `{{scheduling_text}}` etc. resolve consistently
     *  with the preview text the bulk-drafts modal shows. Without it
     *  the Gmail-compose fallback opens with unresolved tokens. */
    customTags?: Record<string, string>;
  }
): string | null {
  const to = customer.owner_email ?? null;
  if (!to) return null;
  const ctx = { ladder, custom_tags: extra?.customTags };
  const subject = applyMergeTags(template.subject, customer, ctx);
  const body = htmlToText(applyMergeTags(template.body_html, customer, ctx));
  return gmailComposeUrl({
    to,
    cc: extra?.cc ?? undefined,
    bcc: extra?.bcc ?? undefined,
    subject,
    body,
    authuser: template.send_as_email || undefined,
  });
}

/**
 * Variant that also threads an ad-gap report into the merge context so
 * `{{customer.ad_revenue_*}}` tokens resolve. Used by the utilization tab's
 * bulk-draft flow when the ad-revenue template is in play.
 */
export function composeUrlWithAdGap(
  template: StoredTemplate,
  customer: Customer,
  ladder: EnterpriseTier[] | undefined,
  adGap: AdGapReport | null,
  extra?: {
    cc?: string | null;
    bcc?: string | null;
    /** See composeUrlForTemplate — same purpose here. */
    customTags?: Record<string, string>;
  }
): string | null {
  const to = customer.owner_email ?? null;
  if (!to) return null;
  const ctx = { ladder, adGap, custom_tags: extra?.customTags };
  const subject = applyMergeTags(template.subject, customer, ctx);
  const body = htmlToText(applyMergeTags(template.body_html, customer, ctx));
  return gmailComposeUrl({
    to,
    cc: extra?.cc ?? undefined,
    bcc: extra?.bcc ?? undefined,
    subject,
    body,
    authuser: template.send_as_email || undefined,
  });
}
