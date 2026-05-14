import type { Customer } from "../types";
import { kvGet, kvSet } from "../storage/kv";
import { applyMergeTags } from "./merge-tags";

/**
 * CRUD store for outreach templates, persisted via the shared KV
 * (file in dev, Postgres in prod). On first load, seeds from a small set
 * of starter templates so the dashboard isn't empty.
 *
 * Templates are user-editable rich HTML with merge tags. The legacy
 * function-based registry is gone — every template now lives in the store.
 */

export interface StoredTemplate {
  id: string;
  label: string;
  blurb: string;
  /** Free-form descriptive tags (e.g. "renewal", "growth"). UI only. */
  tags: string[];
  /**
   * Lowercased CSM email addresses this template is scoped to. When
   * non-empty, only the listed CSMs see the template in their bulk-draft
   * dropdown / outreach modal. When empty/undefined the template is
   * universal — every CSM sees it. Set via /settings/templates.
   */
  csm_tags?: string[];
  /** Subject line. Plain text. Supports {{merge.tags}}. */
  subject: string;
  /** Body. Rich HTML. Supports {{merge.tags}}. */
  body_html: string;
  created_at: string;
  updated_at: string;
}

/**
 * Returns true if the template is visible to a given viewer. Used by
 * BulkDraftsModal, OutreachModal, and RowActions to scope the template
 * list to the CSM looking at the dashboard.
 */
export function isVisibleToCsm(
  t: Pick<StoredTemplate, "csm_tags">,
  viewerEmail: string | null | undefined
): boolean {
  if (!t.csm_tags || t.csm_tags.length === 0) return true; // universal
  if (!viewerEmail) return true; // pre-session render — don't hide
  return t.csm_tags.includes(viewerEmail.toLowerCase());
}

const KEY = "templates";

function nowIso() {
  return new Date().toISOString();
}

const STARTER_TEMPLATES: StoredTemplate[] = [
  {
    id: "renewal-30d",
    label: "Renewal — 30 days out",
    blurb:
      "Annual renewal inside the 30-day window. Confirms champion is in seat and surfaces wins.",
    tags: ["renewal", "annual"],
    subject: "{{customer.name}} renewal — quick sync this week?",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>Your {{customer.name}} renewal is coming up on {{customer.next_charge}} — wanted to get something on the calendar before then to walk through what's working and what we should adjust for the next term.</p>
<p>A few things I'd love to recap together:</p>
<ul>
  <li>Subscriber growth: you're at {{customer.tier_pct}} of your current tier</li>
  <li>Last newsletter went out {{customer.last_send}}</li>
</ul>
<p>I'll send a couple of times that work — does this week look open?</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "dormant-no-send",
    label: "Dormant — no recent send",
    blurb: "Customer has gone 10+ days without sending. Asks the question directly.",
    tags: ["dormant", "engagement"],
    subject: "Quick check-in on {{customer.name}}",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>Noticed {{customer.name}} hasn't sent a newsletter since {{customer.last_send}} — wanted to make sure nothing's blocked on our end.</p>
<p>If you want, I'm happy to take a look at a draft async this week or hop on a quick call to talk through what's coming up next. No pressure either way.</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "growth-push-under-tier",
    label: "Growth push — under tier",
    blurb: "Customer is below 75% of their subscriber tier. Shares the playbook.",
    tags: ["growth", "subscribers"],
    subject: "Growing {{customer.name}}'s list",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>You're at {{customer.tier_pct}} of the {{customer.tier}} tier — there's real room to grow without bumping plan, and I'd like to put a 60-day push together with you.</p>
<p>A few levers we've seen work for similar Enterprise accounts:</p>
<ul>
  <li>Boosts targeted at your audience profile</li>
  <li>Referral program tuned to your highest-engagement segment</li>
  <li>SEO landing pages tied to evergreen issues</li>
</ul>
<p>Want to spend 30 minutes this week on the playbook?</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "escalation-yellow-red",
    label: "Risk escalation — Yellow / Red",
    blurb: "Account is internally flagged. Names the issue directly + proposes a recovery touchpoint.",
    tags: ["risk", "escalation"],
    subject: "Following up on {{customer.name}}",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>Wanted to reach out directly — I have {{customer.name}} flagged internally for the following reason: <em>{{customer.risk_detail}}</em>.</p>
<p>I want to make sure we're course-correcting on this. Can we get 25 minutes on the calendar this week? I'll come with concrete next steps and the people we need looped in on our side.</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "approaching-ent",
    label: "Approaching Enterprise (AM)",
    blurb: "Growth account approaching 100K subs. Hand-off-ready intro.",
    tags: ["am", "upsell", "enterprise"],
    subject: "{{customer.name}} → Enterprise conversation",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>{{customer.name}} has scaled to a place where Enterprise is the cleaner fit — you're at {{customer.subs}} subscribers (~{{customer.tier_pct}} of your current tier) and {{customer.arr}} ARR.</p>
<p>The quick version of what changes at Enterprise:</p>
<ul>
  <li>Dedicated CSM and a deliverability program</li>
  <li>Direct sponsorships toolkit + Ad Network priority</li>
  <li>Customer-marketing reviews on a fixed cadence</li>
</ul>
<p>Open to a 25-minute walk-through with our Enterprise team this week or next?</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "general-checkin",
    label: "General check-in",
    blurb: "Light-touch fallback when no specific risk pattern fired.",
    tags: ["check-in"],
    subject: "Quick {{customer.name}} check-in",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>Wanted to drop a quick note and see how things are going on your end. Last we connected was around {{customer.last_contacted}}, and I want to make sure we're aligned on what's next.</p>
<p>Anything on your radar I can help unblock — content, growth, monetization?</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "feature-not-using",
    label: "Feature underutilization (bulk-friendly)",
    blurb:
      "Default template the Product Utilization tab picks when a feature filter is active. Generic enough to send to many accounts in one batch.",
    tags: ["feature", "underutilization", "bulk"],
    subject: "{{customer.name}} — quick wins we're seeing on our side",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>I was scanning {{customer.name}}'s usage and noticed a couple of features that look like easy wins given where you're at — {{customer.subs}} subscribers, {{customer.tier_pct}} of your current tier, last send {{customer.last_send}}.</p>
<p>Specifically wanted to flag a few areas worth a look:</p>
<ul>
  <li>Direct sponsorships + Boost monetization — frequent quick-revenue add-ons for accounts your size</li>
  <li>Boost grow + referral program — cleanest paths to subscriber growth without bumping plan</li>
  <li>Recommendations / T4 onboarding — couple of one-time setup steps that compound over time</li>
</ul>
<p>Want to spend 20 minutes next week walking through the ones that fit your goals best? I'll come with a tailored shortlist.</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "ad-revenue-opportunity",
    label: "Ad revenue opportunity (uses ad-gap merge tags)",
    blurb:
      "Default template the Product Utilization tab picks when an ad-network filter is active. Pulls in actual + potential earnings via merge tags.",
    tags: ["ads", "monetization", "bulk", "revenue"],
    subject: "{{customer.name}} — ~{{customer.ad_revenue_gap}} on the table",
    body_html: `<p>Hi {{customer.contact_first_name}},</p>
<p>Pulled the last 90 days of ad-network data for {{customer.name}} this morning and wanted to flag what jumped out:</p>
<ul>
  <li><strong>Actual revenue:</strong> {{customer.ad_revenue_actual}}</li>
  <li><strong>Potential at full fill:</strong> {{customer.ad_revenue_potential}}</li>
  <li><strong>Gap:</strong> ~{{customer.ad_revenue_gap}}</li>
  <li><strong>Sending without ads:</strong> {{customer.ad_zero_pubs}} publication(s)</li>
</ul>
<p>Most of that gap closes by tightening enrollment on the publications that are sending but not ad-enabled, and by raising the fill rate on the ones that already are. Want 20 minutes next week to walk through the publications I'd prioritize first?</p>
<p>Thanks,</p>`,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

let cache: StoredTemplate[] | null = null;

async function persist(list: StoredTemplate[]) {
  await kvSet(KEY, list);
  cache = list;
}

export async function listTemplates(): Promise<StoredTemplate[]> {
  if (cache) return cache;
  const stored = await kvGet<StoredTemplate[]>(KEY);
  if (stored) {
    // Backfill any seed templates that weren't stored yet — covers
    // existing installs picking up newly-added defaults without
    // overwriting user edits to the templates that DO exist.
    const present = new Set(stored.map((t) => t.id));
    const missing = STARTER_TEMPLATES.filter((t) => !present.has(t.id));
    if (missing.length > 0) {
      await persist([...stored, ...missing]);
    } else {
      cache = stored;
    }
  } else {
    await persist(STARTER_TEMPLATES);
  }
  return cache!;
}

export async function getTemplate(id: string): Promise<StoredTemplate | null> {
  const list = await listTemplates();
  return list.find((t) => t.id === id) ?? null;
}

export interface UpsertInput {
  id?: string;
  label: string;
  blurb?: string;
  tags?: string[];
  /** Lowercased CSM emails this template is visible to. Empty = universal. */
  csm_tags?: string[];
  subject: string;
  body_html: string;
}

function genId(label: string, existing: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "template";
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

export async function upsertTemplate(
  input: UpsertInput
): Promise<StoredTemplate> {
  const list = [...(await listTemplates())];
  const existing = input.id ? list.find((t) => t.id === input.id) : null;

  const normalizedCsmTags = input.csm_tags
    ? [...new Set(input.csm_tags.map((e) => e.toLowerCase().trim()).filter(Boolean))]
    : undefined;

  if (existing) {
    Object.assign(existing, {
      label: input.label,
      blurb: input.blurb ?? existing.blurb,
      tags: input.tags ?? existing.tags,
      csm_tags: normalizedCsmTags ?? existing.csm_tags ?? [],
      subject: input.subject,
      body_html: input.body_html,
      updated_at: nowIso(),
    });
    await persist(list);
    return existing;
  }

  const idSet = new Set(list.map((t) => t.id));
  const id = input.id && !idSet.has(input.id) ? input.id : genId(input.label, idSet);
  const tpl: StoredTemplate = {
    id,
    label: input.label,
    blurb: input.blurb ?? "",
    tags: input.tags ?? [],
    csm_tags: normalizedCsmTags ?? [],
    subject: input.subject,
    body_html: input.body_html,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  list.push(tpl);
  await persist(list);
  return tpl;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const list = await listTemplates();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  await persist(list);
  return true;
}

export async function listTags(): Promise<string[]> {
  const list = await listTemplates();
  const set = new Set<string>();
  for (const t of list) for (const tag of t.tags) set.add(tag);
  return [...set].sort();
}

/** Render a template against a customer (subject + body, with merge tags applied). */
export interface RenderedTemplate {
  subject: string;
  body_html: string;
  body_text: string;
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

export function renderTemplate(
  tpl: Pick<StoredTemplate, "subject" | "body_html">,
  customer: Customer
): RenderedTemplate {
  const subject = applyMergeTags(tpl.subject, customer);
  const body_html = applyMergeTags(tpl.body_html, customer);
  return { subject, body_html, body_text: htmlToText(body_html) };
}
