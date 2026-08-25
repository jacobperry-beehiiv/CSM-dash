"use client";

import { useEffect, useMemo, useState } from "react";
import { TEAM_CC_OPTIONS } from "@/lib/data/team-cc";

export interface BulkDraftRecipient {
  email: string;
  name: string | null;
  /** True for the customer's owner_email (default-checked). */
  default: boolean;
  /** HubSpot association labels for this contact at this customer
   *  ("Main Contact", "Decision Maker", "Champion", etc.). Empty
   *  for the owner-only entry + for HubSpot contacts that don't
   *  carry any USER_DEFINED labels. */
  labels?: string[];
}

export interface RerenderContext {
  /** The email being addressed when exactly one recipient is checked.
   *  When 0 or >1 are checked, this is null and the renderer falls
   *  back to either "there" (>1) or the per-customer default (0). */
  recipient_email: string | null;
  recipient_count: number;
}

export interface RerenderResult {
  subject: string;
  body_text: string;
  body_html?: string;
}

export interface BulkDraft {
  customer_label: string;
  /** Opaque caller-supplied id used by `onDraftCreated` to report
   *  back which source customers actually got drafts. Past Due wires
   *  this to stripe_customer_id; Proactive Outreach uses workspace_id.
   *  Stays optional so callers that don't care about the lifecycle
   *  hook keep working unchanged. */
  tracking_id?: string;
  /** BCC-batch drafts carry every customer id in the batch so
   *  lifecycle stamping covers the full cohort when one draft lands. */
  tracking_ids?: string[];
  /** Default recipient list (the customer's owner_email when present),
   *  used as the initial selection when the modal first renders.
   *  Comma-separated to match how a Gmail compose `to=` field is built. */
  to: string;
  /** Optional CC list (comma-separated). Used by the Enterprise past-due
   *  flow to CC the assigned CSM on every draft. Surfaced in the
   *  per-row preview so the sender can see it before send. */
  cc?: string;
  /** Optional BCC list (comma-separated). Reserved for future flows. */
  bcc?: string;
  subject: string;
  body_text: string;
  /** Rich-HTML body — Gmail API drafts use this; CSV/Open-in-Gmail fall back to body_text. */
  body_html?: string;
  /** Compose URL with the *default* `to` baked in. The modal recomputes
   *  this live whenever the user toggles recipients. */
  compose_url: string;
  /** Every viable recipient for this customer (owner_email + every
   *  HubSpot contact whose primary associated company is this one).
   *  The modal lets the user check/uncheck each before opening tabs /
   *  creating Gmail drafts. */
  recipients: BulkDraftRecipient[];
  /** Optional Gmail send-as alias to use as From for this draft.
   *  Populated from the chosen template's `send_as_email` field.
   *  Gmail-API drafts honor this in the RFC822 From header; the
   *  compose-tab flow opens the right Google account via the URL's
   *  /mail/u/<from>/ prefix (the user still flips the From dropdown
   *  inside the compose tab). Unset → drafts use the CSM's primary. */
  from?: string;
  /** Re-render subject + bodies when the user changes the recipient
   *  selection inside the modal. Lets merge tags that depend on the
   *  addressee (e.g. `{{customer.contact_first_name}}`) update live
   *  so the body always matches who's actually being emailed.
   *
   *  Optional — when absent the modal keeps the originally-rendered
   *  subject/body (current behaviour for callers that haven't
   *  migrated yet). */
  rerender?: (ctx: RerenderContext) => RerenderResult;
  /** True for Below-$3.5K BCC batches — recipients stay in BCC, not To. */
  bcc_batch?: boolean;
  /** Optional audit-log target. When set with `audit_label`, the
   *  server appends a `kind: "action_log"` note to that workspace's
   *  feed once the draft lands. Past-due / renewals callers use
   *  this so the Notes feed shows "Past-due email sent" etc. */
  audit_workspace_id?: string;
  /** Multi-workspace audit-log target — used by BCC-batch drafts
   *  where one draft covers N customers. Server writes one action_log
   *  entry per id when the batch lands. Same `audit_label` applies to
   *  all. Either this OR `audit_workspace_id` (not both) should be set. */
  audit_workspace_ids?: string[];
  audit_label?: string;
}

function buildGmailComposeUrl(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string
): string {
  const params = new URLSearchParams({ view: "cm", fs: "1", to, su: subject, body });
  if (cc && cc.trim()) params.set("cc", cc.trim());
  if (bcc && bcc.trim()) params.set("bcc", bcc.trim());
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function csvEscape(s: string): string {
  if (s == null) return "";
  // Always quote — keeps subject lines with commas safe.
  return `"${String(s).replace(/"/g, '""')}"`;
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface GmailStatus {
  connected: boolean;
  email?: string | null;
}

interface TemplateOption {
  id: string;
  label: string;
}

interface Props {
  templates: TemplateOption[];
  templateId: string;
  onTemplateChange: (id: string) => void;
  drafts: BulkDraft[];
  loading: boolean;
  loadingProgress: { done: number; total: number } | null;
  error: string | null;
  onClose: () => void;
  /** Fires AFTER the user actions a batch of drafts (opens all in
   *  Gmail compose OR creates Gmail-API drafts). Receives the
   *  `tracking_id` of every draft that got handled so callers can
   *  stamp their own lifecycle state (e.g. past-due touched,
   *  proactive outreach_logged). Drafts whose tracking_id is unset
   *  are silently filtered out. */
  onDraftCreated?: (tracking_ids: string[]) => void;
  /** Initial value for the From alias dropdown. Takes precedence
   *  over the chosen template's `send_as_email` if both are present
   *  — used by Past Due's Below-$3.5K flow to pre-select the
   *  settings-configured bulk alias. The user can still change it
   *  in the dropdown before creating drafts. */
  defaultFromAlias?: string;
}

/**
 * Shape mirrors the `AliasRow` exposed by
 * src/lib/integrations/gmail-aliases.ts (the server normalizes
 * Gmail's verbose camelCase response into this snake_case form
 * before sending it down). Don't drift these names — getting them
 * wrong renders every option with `value=""` and the dropdown looks
 * like it only has the primary entry.
 */
interface AliasRow {
  /** sendAs email address (primary or alias). */
  email: string;
  /** Display name configured for the alias, if any. */
  name: string | null;
  is_default: boolean;
  is_primary: boolean;
  /** True only when Gmail's verificationStatus is "accepted".
   *  Unverified aliases fall back to the primary server-side; we
   *  flag them in the dropdown so the user knows that's coming. */
  verified: boolean;
}

/**
 * Drafts queue modal. Shown after the user clicks "Draft for N" so the
 * browser popup blocker doesn't silently swallow most of the tabs.
 *
 * Strategy:
 *   1. Render every pre-built draft in a list.
 *   2. "Open all" tries to fire window.open() for every URL synchronously
 *      inside a single click handler — most browsers allow ~6-20 tabs from
 *      one gesture. Shows how many succeeded.
 *   3. Per-row buttons let the user open / copy any draft that got blocked
 *      or that they want to review individually.
 */
export function BulkDraftsModal({
  templates,
  templateId,
  onTemplateChange,
  drafts,
  loading,
  loadingProgress,
  error,
  onClose,
  onDraftCreated,
  defaultFromAlias,
}: Props) {
  const [openedCount, setOpenedCount] = useState<number | null>(null);
  const [copyHit, setCopyHit] = useState<string | null>(null);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailMessage, setGmailMessage] = useState<string | null>(null);
  // Available send-as aliases on the active Gmail account. Loaded
  // lazily when the modal opens (one API hit, then we cache for the
  // lifetime of the modal). The dropdown stays usable while loading
  // by including just the chosen template's send_as_email until the
  // verified list arrives.
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [aliasesLoaded, setAliasesLoaded] = useState(false);
  // The currently-selected From alias. Initialized from
  // defaultFromAlias / template's send_as_email / "" (=primary).
  // Empty string means "let the server fall through to the primary"
  // — the same behavior as before this picker existed.
  const [selectedFrom, setSelectedFrom] = useState<string>("");
  // Per-draft recipient selection. Keyed by the draft's compose_url
  // (stable across re-renders for a single open-of-modal). Set of
  // lowercased email addresses.
  const [recipientSelection, setRecipientSelection] = useState<
    Record<string, Set<string>>
  >({});
  // Which drafts have the recipient list expanded inline.
  const [expandedRecipients, setExpandedRecipients] = useState<Set<string>>(
    new Set()
  );
  // Which drafts have the body preview expanded. Separate from
  // recipient expansion so the CSM can review the body without
  // dismissing the recipient picker.
  const [expandedBodies, setExpandedBodies] = useState<Set<string>>(
    new Set()
  );
  // Client-side BCC-combine mode. When on, every recipient across
  // every draft gets folded into one synthetic draft with the union
  // BCC'd. Sits alongside the existing server-built `bcc_batch`
  // flag (Past Due Below-$3.5K) — that one is template-driven; this
  // one is a per-batch override the user can toggle on top of any
  // open modal. Per-customer merge tags fall back to the first
  // draft's render (the body shows in Gmail compose before send, so
  // the user can edit if needed).
  const [combineBcc, setCombineBcc] = useState(false);
  // Quick-include-by-label state. Each entry is a HubSpot
  // association label active across the batch. Activating a label
  // ticks every recipient (across every draft) whose contact
  // carries that label; deactivating un-ticks them UNLESS another
  // active label keeps them in or the recipient is the owner
  // (default-checked). Owners stay default-checked regardless.
  const [activeLabels, setActiveLabels] = useState<Set<string>>(new Set());
  // Team leads the user has opted to CC on this batch (Richard / Juliet).
  // Applied on top of any per-draft CC (e.g. the Enterprise CC-the-CSM
  // path) and — unlike per-customer CCs — carried onto the combined-BCC
  // blast too, since it's a deliberate team-wide choice, not per-customer.
  const [teamCcEmails, setTeamCcEmails] = useState<Set<string>>(new Set());

  /** Merge the batch-level team CCs into a draft's own `cc` string,
   *  de-duped case-insensitively (first-seen casing wins). Returns
   *  undefined when the result is empty so we don't emit a bare `Cc:`. */
  function mergeTeamCc(baseCc?: string): string | undefined {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (raw: string) => {
      const e = raw.trim();
      if (!e) return;
      const key = e.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    };
    (baseCc ?? "").split(",").forEach(add);
    teamCcEmails.forEach(add);
    return out.length > 0 ? out.join(", ") : undefined;
  }

  function toggleBody(draftKey: string) {
    setExpandedBodies((prev) => {
      const next = new Set(prev);
      if (next.has(draftKey)) next.delete(draftKey);
      else next.add(draftKey);
      return next;
    });
  }

  // Initialise selection from each draft's default recipients when the
  // drafts list arrives / changes. Drafts already-keyed are preserved so
  // a user's manual toggles survive a template re-render.
  useEffect(() => {
    setRecipientSelection((prev) => {
      const next = { ...prev };
      for (const d of drafts) {
        if (next[d.compose_url]) continue;
        const defaults = d.recipients
          .filter((r) => r.default)
          .map((r) => r.email.toLowerCase());
        // Fallback: if nothing is marked default, pick the first recipient.
        const seed =
          defaults.length > 0
            ? defaults
            : d.recipients[0]
              ? [d.recipients[0].email.toLowerCase()]
              : [];
        next[d.compose_url] = new Set(seed);
      }
      return next;
    });
  }, [drafts]);

  /** Resolve the live `to:` string (comma-separated) for a draft based
   *  on current selection state. Falls back to the draft's stored `to`
   *  when no selection has been initialised yet. */
  function liveTo(d: BulkDraft): string {
    if (d.bcc_batch) return d.to;
    const sel = recipientSelection[d.compose_url];
    if (!sel) return d.to;
    const emails = d.recipients
      .filter((r) => sel.has(r.email.toLowerCase()))
      .map((r) => r.email);
    return emails.join(", ");
  }

  /** Currently-selected recipient emails for a draft, in their
   *  declared `recipients[]` order (so the "first" selected for
   *  single-recipient detection is deterministic). */
  function liveRecipientEmails(d: BulkDraft): string[] {
    const sel = recipientSelection[d.compose_url];
    if (!sel) return d.to ? [d.to] : [];
    return d.recipients
      .filter((r) => sel.has(r.email.toLowerCase()))
      .map((r) => r.email);
  }

  /**
   * Re-render the subject + bodies for a draft against the current
   * recipient selection. Drives `{{customer.contact_first_name}}` (and
   * any future per-recipient tokens) so the body always agrees with
   * who's checked — that's the speedtoscale.com fix where the body
   * said "Hi Cait," while Colton was selected.
   *
   * Drafts without a `rerender` closure (back-compat for callers that
   * haven't migrated) keep their originally-baked subject + bodies.
   */
  function liveContent(d: BulkDraft): {
    subject: string;
    body_text: string;
    body_html?: string;
  } {
    if (!d.rerender) {
      return { subject: d.subject, body_text: d.body_text, body_html: d.body_html };
    }
    const emails = liveRecipientEmails(d);
    const rerendered = d.rerender({
      // Single-recipient signal so the resolver knows which contact to
      // address. >1 → null, the resolver returns "there".
      recipient_email: emails.length === 1 ? emails[0] : null,
      recipient_count: emails.length || 1,
    });
    return {
      subject: rerendered.subject,
      body_text: rerendered.body_text,
      body_html: rerendered.body_html ?? d.body_html,
    };
  }

  function liveComposeUrl(d: BulkDraft): string {
    const to = liveTo(d);
    if (!to) return d.compose_url;
    const { subject, body_text } = liveContent(d);
    return buildGmailComposeUrl(to, subject, body_text, mergeTeamCc(d.cc), d.bcc);
  }

  function toggleRecipient(draftKey: string, email: string) {
    const e = email.toLowerCase();
    setRecipientSelection((prev) => {
      const next = { ...prev };
      const cur = new Set(next[draftKey] ?? []);
      if (cur.has(e)) cur.delete(e);
      else cur.add(e);
      next[draftKey] = cur;
      return next;
    });
  }

  function toggleExpand(draftKey: string) {
    setExpandedRecipients((prev) => {
      const next = new Set(prev);
      if (next.has(draftKey)) next.delete(draftKey);
      else next.add(draftKey);
      return next;
    });
  }

  /** Drafts the user actually wants to act on right now — at least one
   *  selected recipient. Used by every "send to all" path so unchecking
   *  every recipient excludes the draft entirely. Subject + body are
   *  resolved against the LIVE recipient selection so merge tags like
   *  `{{customer.contact_first_name}}` follow whoever's currently
   *  checked. */
  const actionableDrafts = useMemo(
    () =>
      drafts
        .map((d) => {
          const live = liveContent(d);
          return {
            ...d,
            to: liveTo(d),
            cc: mergeTeamCc(d.cc),
            subject: live.subject,
            body_text: live.body_text,
            body_html: live.body_html,
            compose_url: liveComposeUrl(d),
            // Override the template-supplied `from` with whatever the
            // user has selected in the modal's From dropdown. Empty
            // string → strip the field entirely so the server falls
            // back to the primary account (matches pre-picker
            // behavior). The Gmail API path validates the alias
            // against the user's verified list and falls through to
            // the primary on mismatch, with a count surfaced in the
            // response so we can warn the user.
            from: selectedFrom || undefined,
          };
        })
        .filter(
          (d) =>
            d.to.length > 0 || (d.bcc_batch && Boolean(d.bcc?.trim()))
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, recipientSelection, selectedFrom, teamCcEmails]
  );

  /**
   * Synthetic single draft built from every recipient across every
   * actionable draft. Only produced when the user has flipped on the
   * "Combine into single BCC email" toggle. Returns null when the
   * combine mode is off OR the batch is empty.
   *
   * Shape rules:
   *   • TO  = sender's primary Gmail (or empty if not connected) —
   *           Gmail expects a TO header; using the sender's own
   *           address is the standard BCC-blast convention so the
   *           sent message lands in their own inbox as a record.
   *   • CC  = nothing. Per-draft CC's (e.g. Enterprise-CC-the-CSM)
   *           don't generalize across customers; keeping CC empty
   *           avoids leaking one customer's CSM onto another's BCC.
   *   • BCC = union of every selected recipient across every draft
   *           (deduped, case-insensitive).
   *   • Subject + body = the first draft's live-rendered values.
   *           Customer-specific merge tags will resolve to the
   *           first customer; the user reviews + edits in Gmail
   *           compose before send.
   *
   * Tracking + audit ids are unioned across the source drafts so
   * lifecycle stamping covers every customer the BCC actually
   * reached — same shape as the existing server-built bcc_batch
   * flow.
   */
  const combinedDraft = useMemo(() => {
    if (!combineBcc) return null;
    if (actionableDrafts.length === 0) return null;
    const allEmails: string[] = [];
    const seen = new Set<string>();
    const trackingIds: string[] = [];
    const auditIds: string[] = [];
    for (const d of actionableDrafts) {
      // For server-built bcc_batch drafts the recipients live in
      // d.bcc; for client-built drafts they live in the `to` after
      // the user's recipient toggles. Combine handles both so a
      // mixed batch (rare) still gets folded correctly.
      const sources = d.bcc_batch
        ? (d.bcc ?? "").split(",")
        : d.to.split(",");
      for (const raw of sources) {
        const e = raw.trim();
        if (!e) continue;
        const k = e.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        allEmails.push(e);
      }
      if (d.tracking_ids?.length) trackingIds.push(...d.tracking_ids);
      else if (d.tracking_id) trackingIds.push(d.tracking_id);
      if (d.audit_workspace_ids?.length)
        auditIds.push(...d.audit_workspace_ids);
      else if (d.audit_workspace_id) auditIds.push(d.audit_workspace_id);
    }
    const first = actionableDrafts[0];
    const toAddress = gmail?.email ?? "";
    const bccString = allEmails.join(", ");
    // Per-draft CCs (e.g. Enterprise-CC-the-CSM) don't generalize across
    // customers, so they're intentionally NOT folded in here. The
    // batch-level team CC (Richard / Juliet) IS applied — it's a
    // deliberate team-wide choice, not per-customer data.
    const combinedCc = mergeTeamCc(undefined);
    const draft: BulkDraft = {
      customer_label: `BCC blast — ${allEmails.length} recipient${allEmails.length === 1 ? "" : "s"}`,
      tracking_ids: trackingIds,
      to: toAddress,
      cc: combinedCc,
      bcc: bccString,
      subject: first.subject,
      body_text: first.body_text,
      body_html: first.body_html,
      compose_url: buildGmailComposeUrl(
        toAddress,
        first.subject,
        first.body_text,
        combinedCc,
        bccString
      ),
      // Empty: the synthetic draft doesn't surface a per-recipient
      // picker — recipients have already been chosen in their
      // source drafts.
      recipients: [],
      from: selectedFrom || undefined,
      bcc_batch: true,
      audit_workspace_ids: auditIds.length > 0 ? auditIds : undefined,
      audit_label: first.audit_label,
    };
    return draft;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combineBcc, actionableDrafts, gmail?.email, selectedFrom, teamCcEmails]);

  /** The list the action buttons + draft preview render from.
   *  Either the original per-customer batch OR the single combined
   *  draft, depending on the toggle. */
  const finalDrafts: BulkDraft[] = combinedDraft
    ? [combinedDraft]
    : actionableDrafts;

  /** Union of every HubSpot association label seen across every
   *  contact in the current batch. Sorted for stable button order.
   *  Empty when no contact in the batch carries any label, in which
   *  case the Quick-include toolbar hides itself entirely.
   *
   *  Iterates the RAW `drafts` list, not `actionableDrafts` — the
   *  latter is filtered to drafts with a non-empty selected `to`, so
   *  a row where the user unticked every recipient wouldn't
   *  contribute its labels back into the toolbar and a subsequent
   *  Quick-include click couldn't re-add anyone from it. */
  const allLabelsInBatch = useMemo(() => {
    const s = new Set<string>();
    for (const d of drafts) {
      for (const r of d.recipients) {
        for (const label of r.labels ?? []) {
          if (label) s.add(label);
        }
      }
    }
    return Array.from(s).sort();
  }, [drafts]);

  /** Toggle a label active/inactive. Activating ticks every
   *  recipient whose contact carries that label across every draft;
   *  deactivating unticks them UNLESS another active label still
   *  applies. Owners (default-checked) are never auto-unticked.
   *
   *  Iterates the RAW `drafts` list — every reader
   *  (`liveTo` / `toggleRecipient` / the render loop) keys
   *  `recipientSelection` by the ORIGINAL `d.compose_url` from the
   *  drafts prop. `actionableDrafts` overwrites `compose_url` via
   *  `liveComposeUrl`, and those live URLs diverge from the original
   *  whenever the template has a `send_as_email` alias (different
   *  `/mail/u/<alias>/` path) or a per-recipient merge tag like
   *  `{{customer.contact_first_name}}` — writing to the live key
   *  makes the audience selection land in a phantom entry that
   *  liveTo never reads, so the BCC combine (and the row's
   *  compose URL) silently keep the un-toggled recipient set.
   *  That was the reported "merge as BCC ignores audience
   *  selections" symptom. */
  function toggleLabel(label: string) {
    const wasActive = activeLabels.has(label);
    const nextActive = new Set(activeLabels);
    if (wasActive) nextActive.delete(label);
    else nextActive.add(label);
    setActiveLabels(nextActive);

    setRecipientSelection((sel) => {
      const out = { ...sel };
      for (const d of drafts) {
        const draftSel = new Set(out[d.compose_url] ?? []);
        for (const r of d.recipients) {
          const labels = r.labels ?? [];
          if (!labels.includes(label)) continue;
          if (wasActive) {
            // Deactivating — drop the recipient only if no OTHER
            // active label still applies + they're not the owner.
            const stillMatched = labels.some(
              (l) => l !== label && nextActive.has(l)
            );
            if (!stillMatched && !r.default) {
              draftSel.delete(r.email.toLowerCase());
            }
          } else {
            draftSel.add(r.email.toLowerCase());
          }
        }
        out[d.compose_url] = draftSel;
      }
      return out;
    });
  }

  // Lazy-load Gmail connection status when the modal mounts
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/google/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setGmail(s as GmailStatus);
      })
      .catch(() => {
        if (!cancelled) setGmail({ connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load the user's verified send-as aliases once the modal
  // mounts. Single request, then we cache for the lifetime of the
  // modal. Failure is non-fatal — we just keep the dropdown to a
  // best-guess (template alias or primary) and the server will fall
  // back to the primary if the chosen alias isn't actually verified.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/google/aliases")
      .then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as { aliases?: AliasRow[] };
      })
      .then((j) => {
        if (cancelled || !j?.aliases) return;
        setAliases(j.aliases);
        setAliasesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setAliasesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the initial From selection. Priority:
  //   1. Caller-supplied defaultFromAlias (Past Due Below-3.5K
  //      passes settings.am.bulk_alias_email here).
  //   2. The chosen template's send_as_email (drafts[0].from).
  //   3. Empty — server uses the primary Gmail account.
  // Re-runs whenever the template changes (and therefore drafts[0].from
  // changes) so flipping the template flips the default From.
  useEffect(() => {
    const fallback = drafts[0]?.from ?? "";
    const next = (defaultFromAlias ?? "").trim() || fallback;
    setSelectedFrom(next);
  }, [defaultFromAlias, drafts]);

  function openAll() {
    let opened = 0;
    const handed: string[] = [];
    for (const d of finalDrafts) {
      const w = window.open(d.compose_url, "_blank", "noopener,noreferrer");
      if (w) {
        opened++;
        if (d.tracking_ids?.length) handed.push(...d.tracking_ids);
        else if (d.tracking_id) handed.push(d.tracking_id);
      }
    }
    setOpenedCount(opened);
    // Fire the lifecycle hook only with the tracking IDs of drafts
    // that actually opened — popup-blocked drafts shouldn't be
    // counted as "outreach sent" yet.
    if (handed.length > 0 && onDraftCreated) onDraftCreated(handed);
  }

  function downloadCsv() {
    const header = ["email", "subject", "body"].join(",");
    const lines = finalDrafts.map((d) =>
      [csvEscape(d.to), csvEscape(d.subject), csvEscape(d.body_text)].join(",")
    );
    const ts = new Date().toISOString().slice(0, 10);
    downloadFile(
      `bulk-drafts-${ts}.csv`,
      [header, ...lines].join("\n"),
      "text/csv;charset=utf-8"
    );
  }

  async function createGmailDrafts() {
    if (finalDrafts.length === 0) return;
    setGmailBusy(true);
    setGmailMessage(null);
    console.log("[bulk-drafts] Submit", {
      count: finalDrafts.length,
      combineBcc,
      with_cc: finalDrafts.filter((d) => d.cc).length,
      with_bcc: finalDrafts.filter((d) => d.bcc).length,
      with_from_alias: finalDrafts.filter((d) => d.from).length,
      with_tracking_id: finalDrafts.filter((d) => d.tracking_id)
        .length,
    });
    // Chunked POST — Vercel serverless functions cap request bodies
    // at ~4.5 MB at the edge (a limit no Next.js config touches). A
    // 190-draft batch with pre-rendered HTML bodies + merge tags is
    // enough to cross it; production hit a 413 mid-session on the
    // third batch after two smaller ones succeeded. Firing many
    // smaller sequential POSTs keeps every request comfortably below
    // the ceiling regardless of body-length outliers.
    //
    // 40 drafts × ~25 KB body ≈ 1 MB — 5x safety margin. Adjust
    // downward here (and via the "batch too large" error surface
    // below) if the size distribution shifts.
    const CHUNK_SIZE = 40;
    const draftPayloads = finalDrafts.map((d) => ({
      to: d.to,
      // CC/BCC ride through to Gmail API drafts too so the
      // Enterprise-CC behavior + future BCC flows match what the
      // compose URL preview shows.
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body_html: d.body_html ?? d.body_text,
      // Template-level send-as alias. Server validates against
      // the user's verified aliases and falls back to the
      // primary on mismatch so the draft still lands.
      from: d.from,
      // Stable per-customer identifier so the server can echo
      // back which input drafts actually succeeded (we only
      // stamp those as "touched" / "outreach logged"). Without
      // this we'd over-stamp partial failures.
      tracking_id: d.tracking_id,
      tracking_ids: d.tracking_ids,
      audit_workspace_id: d.audit_workspace_id,
      audit_workspace_ids: d.audit_workspace_ids,
      audit_label: d.audit_label,
    }));
    const chunks: (typeof draftPayloads)[] = [];
    for (let i = 0; i < draftPayloads.length; i += CHUNK_SIZE) {
      chunks.push(draftPayloads.slice(i, i + CHUNK_SIZE));
    }

    // Aggregate every chunk's response into a merged `j`-shape so
    // the downstream code (message string, alias fallback tally,
    // onDraftCreated echo-back) reads the same object it always
    // did — no branching required past this loop.
    const j: {
      created: number;
      failed: number;
      created_in: string | null;
      alias_fallbacks: number;
      succeeded_tracking_ids: string[];
      failed_tracking_ids: string[];
      errors: Array<{ to: string; tracking_id?: string; error: string }>;
    } = {
      created: 0,
      failed: 0,
      created_in: null,
      alias_fallbacks: 0,
      succeeded_tracking_ids: [],
      failed_tracking_ids: [],
      errors: [],
    };

    try {
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunk = chunks[idx];
        if (chunks.length > 1) {
          setGmailMessage(
            `Sending batch ${idx + 1} of ${chunks.length} (${chunk.length} drafts)…`
          );
        }
        console.log("[bulk-drafts] Chunk", {
          batch: `${idx + 1}/${chunks.length}`,
          count: chunk.length,
        });
        const r = await fetch("/api/drafts/bulk-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ drafts: chunk }),
        });
        if (!r.ok) {
          // Distinguish edge-level failures (413 body-too-big, 502
          // etc.) from JSON error responses, because Vercel's 413
          // returns plain text — trying to `r.json()` on it blows
          // up with "Unexpected token 'R'..." like production did.
          const text = await r.text().catch(() => "");
          const isTooLarge = r.status === 413;
          const inferred = isTooLarge
            ? `Batch too large (413) — lower CHUNK_SIZE below ${CHUNK_SIZE}.`
            : `HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
          console.error("[bulk-drafts] Chunk failed", {
            batch: `${idx + 1}/${chunks.length}`,
            status: r.status,
            body: text.slice(0, 400),
          });
          j.failed += chunk.length;
          j.errors.push({
            to: `(batch ${idx + 1}/${chunks.length})`,
            error: inferred,
          });
          // 413 means the chunk size is too big for this session's
          // draft bodies — later chunks would 413 identically. Bail
          // out; earlier chunks already landed drafts so we surface
          // partial success rather than looping through futile POSTs.
          if (isTooLarge) break;
          continue;
        }
        const chunkJ = (await r.json()) as {
          created?: number;
          failed?: number;
          created_in?: string;
          alias_fallbacks?: number;
          succeeded_tracking_ids?: string[];
          failed_tracking_ids?: string[];
          errors?: Array<{ to: string; tracking_id?: string; error: string }>;
          error?: string;
        };
        j.created += chunkJ.created ?? 0;
        j.failed += chunkJ.failed ?? 0;
        j.alias_fallbacks += chunkJ.alias_fallbacks ?? 0;
        j.succeeded_tracking_ids.push(...(chunkJ.succeeded_tracking_ids ?? []));
        j.failed_tracking_ids.push(...(chunkJ.failed_tracking_ids ?? []));
        j.errors.push(...(chunkJ.errors ?? []));
        j.created_in ??= chunkJ.created_in ?? null;
      }
      console.log("[bulk-drafts] Merged", {
        chunks: chunks.length,
        created: j.created,
        failed: j.failed,
        alias_fallbacks: j.alias_fallbacks,
        succeeded_tracking_ids_count: j.succeeded_tracking_ids.length,
        failed_tracking_ids_count: j.failed_tracking_ids.length,
        first_errors: j.errors.slice(0, 3),
      });
      const where = j.created_in ?? gmail?.email ?? "your Gmail";
      const fallbacks = j.alias_fallbacks ?? 0;
      const parts = [
        `Created ${j.created} draft${j.created === 1 ? "" : "s"} in ${where}'s Drafts folder`,
      ];
      if ((j.failed ?? 0) > 0) {
        // List up to 3 specific failures inline so the user can fix
        // them without going to Vercel logs. The rest live in the
        // server log — surfaced via the success_rate field.
        const firstErrors = (j.errors ?? []).slice(0, 3);
        const errorList = firstErrors
          .map((e) => `${e.to}: ${e.error.slice(0, 80)}`)
          .join("; ");
        const moreCount =
          (j.failed ?? 0) - firstErrors.length;
        parts.push(
          `${j.failed} failed${errorList ? ` — ${errorList}` : ""}${
            moreCount > 0 ? ` (+${moreCount} more)` : ""
          }`
        );
      }
      if (fallbacks > 0) {
        // Drafts landed, but Gmail rejected the alias and we fell back
        // to the auth account. Tell the user so they can either flip
        // the From dropdown in Gmail or get the alias verified.
        parts.push(
          `${fallbacks} fell back to your primary — the template's alias isn't verified on this Gmail account`
        );
      }
      setGmailMessage(`${parts.join(" · ")}.`);
      // Only stamp lifecycle state for drafts the server confirmed
      // landed. Falls back to the old "trust the submit" behavior
      // when the response doesn't carry succeeded_tracking_ids (e.g.
      // old server / cached preview) so we don't lose stamping
      // entirely if a deploy lag bites.
      let handed: string[];
      if (Array.isArray(j.succeeded_tracking_ids)) {
        handed = j.succeeded_tracking_ids;
      } else {
        handed = finalDrafts.flatMap((d) =>
          d.tracking_ids?.length
            ? d.tracking_ids
            : d.tracking_id
              ? [d.tracking_id]
              : []
        );
        console.warn(
          "[bulk-drafts] Response missing succeeded_tracking_ids — falling back to client-side list",
          { handed_count: handed.length }
        );
      }
      if (handed.length > 0 && onDraftCreated) onDraftCreated(handed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.error("[bulk-drafts] Top-level failure", msg);
      setGmailMessage(`Gmail draft creation failed: ${msg}`);
    } finally {
      setGmailBusy(false);
    }
  }

  async function copy(d: BulkDraft, hitKey: string) {
    try {
      await navigator.clipboard.writeText(
        `To: ${d.to}\nSubject: ${d.subject}\n\n${d.body_text}`
      );
      setCopyHit(hitKey);
      setTimeout(() => setCopyHit(null), 1200);
    } catch {
      /* clipboard blocked — silent */
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-fg">
              Bulk drafts ({drafts.length})
            </h3>
            {/* From-alias picker. One selection drives every draft in
             *  the batch — Gmail's API only takes one From header per
             *  draft and the template-level alias is meant to be the
             *  same across the batch anyway. The dropdown shows the
             *  primary + every verified send-as alias the active
             *  Gmail account has registered. Pre-selected from
             *  defaultFromAlias (if caller passed one) else the
             *  template's send_as_email. The server validates against
             *  the user's verified list and falls back to the primary
             *  on mismatch, returning a count we surface in the
             *  result toast. */}
            {gmail?.connected ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted mt-0.5">
                <label htmlFor="bulk-from-select">Sending as:</label>
                <select
                  id="bulk-from-select"
                  value={selectedFrom}
                  onChange={(e) => setSelectedFrom(e.target.value)}
                  className="text-[11px] px-1.5 py-0.5 border border-border-strong rounded bg-surface text-fg font-mono max-w-[280px]"
                  title="Pick the From address every draft will use. Falls back to your primary if the alias isn't verified on this Gmail account."
                >
                  {/* Primary first — Gmail returns it with
                   *  isPrimary: true. When aliases haven't loaded
                   *  yet (or fetch failed), the gmail.email is the
                   *  only thing we know for sure. */}
                  <option value="">
                    {gmail.email
                      ? `${gmail.email} (primary)`
                      : "Primary account"}
                  </option>
                  {/* Surface the template's preferred alias even if
                   *  it's not in the verified list yet (mid-load) so
                   *  the picker reflects the actual selection. */}
                  {drafts[0]?.from &&
                  !aliases.some((a) => a.email === drafts[0].from) &&
                  drafts[0].from !== gmail.email ? (
                    <option value={drafts[0].from}>{drafts[0].from}</option>
                  ) : null}
                  {aliases
                    .filter((a) => !a.is_primary && a.email !== gmail.email)
                    .map((a) => (
                      <option key={a.email} value={a.email}>
                        {a.email}
                        {a.verified ? "" : " (unverified — will fall back)"}
                      </option>
                    ))}
                </select>
                {!aliasesLoaded ? (
                  <span className="text-subtle">loading…</span>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center gap-2 mt-1.5">
              <label
                htmlFor="bulk-template-select"
                className="text-xs text-muted whitespace-nowrap"
              >
                Template:
              </label>
              <select
                id="bulk-template-select"
                value={templateId}
                onChange={(e) => onTemplateChange(e.target.value)}
                disabled={loading || templates.length === 0}
                className="text-xs px-2 py-1 border border-border-strong rounded-md bg-surface max-w-full disabled:opacity-50"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border bg-canvas space-y-2">
          {/* Quick include by HubSpot association label. Visible only
           *  when at least one contact in the batch carries a label
           *  (otherwise the toolbar would be empty + noisy). Each
           *  button toggles: activating ticks every contact across
           *  every draft that carries the label; deactivating un-
           *  ticks them unless they're the owner or another active
           *  label still applies. Per-row pickers still work as
           *  manual overrides after a quick-include. */}
          {allLabelsInBatch.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">Quick include:</span>
              {allLabelsInBatch.map((label) => {
                const active = activeLabels.has(label);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleLabel(label)}
                    className={`px-2 py-0.5 text-[11px] rounded-md border transition ${
                      active
                        ? "bg-accent text-accent-fg border-accent"
                        : "bg-surface text-fg border-border-strong hover:bg-canvas"
                    }`}
                    title={`Tick every contact with the "${label}" HubSpot association label across all drafts.`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {/* Optional team-lead CCs (Richard / Juliet). Applied to
           *  every draft in the batch on top of any per-draft CC, and
           *  carried onto the combined-BCC blast too. */}
          {TEAM_CC_OPTIONS.length > 0 && actionableDrafts.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
              <span className="text-muted">CC on all drafts:</span>
              {TEAM_CC_OPTIONS.map((opt) => {
                const checked = teamCcEmails.has(opt.email);
                return (
                  <label
                    key={opt.email}
                    className="flex items-center gap-1.5 cursor-pointer text-fg"
                    title={opt.email}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setTeamCcEmails((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(opt.email);
                          else next.delete(opt.email);
                          return next;
                        })
                      }
                      className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                    />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-subtle">({opt.email})</span>
                  </label>
                );
              })}
            </div>
          ) : null}
          {/* Toggle: fold the whole batch into one BCC blast. Lives
           *  above the action buttons so the user sees what they're
           *  about to do before clicking. The action-button labels
           *  reflect the active mode (1 BCC blast vs. N per-customer
           *  drafts). */}
          {actionableDrafts.length > 1 ? (
            <label className="flex items-start gap-2 text-xs text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={combineBcc}
                onChange={(e) => setCombineBcc(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
              />
              <span>
                <strong className="text-fg">Combine into one BCC email</strong>
                <span className="text-muted">
                  {" "}— fold every selected recipient across {actionableDrafts.length}{" "}
                  drafts into a single email with everyone BCC&rsquo;d.
                  Customer-specific merge tags will resolve to the
                  first customer; review the body in Gmail compose
                  before sending.
                </span>
              </span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {gmail?.connected ? (
              <button
                onClick={createGmailDrafts}
                disabled={loading || finalDrafts.length === 0 || gmailBusy}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
              >
                {gmailBusy
                  ? "Creating drafts…"
                  : combinedDraft
                    ? `📥 Create 1 BCC draft in ${gmail.email ?? "Gmail"}`
                    : `📥 Create ${finalDrafts.length} drafts in ${gmail.email ?? "Gmail"}`}
              </button>
            ) : (
              <a
                href="/api/auth/google/start"
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
                title="Connect Gmail to create drafts directly without opening tabs"
              >
                Connect Gmail to create drafts directly
              </a>
            )}
            <button
              onClick={downloadCsv}
              disabled={loading || finalDrafts.length === 0}
              className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
              title="Download a CSV of every draft (email/subject/body) for use with mail-merge tools like YAMM."
            >
              ⬇ Download CSV
            </button>
            <button
              onClick={openAll}
              disabled={loading || finalDrafts.length === 0}
              className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
            >
              {combinedDraft ? "Open BCC draft in Gmail" : "Open all in Gmail tabs"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            {loading && loadingProgress ? (
              <span>
                Building drafts… {loadingProgress.done}/{loadingProgress.total}
              </span>
            ) : null}
            {openedCount != null ? (
              <span>
                Browser opened {openedCount} of {drafts.length} tabs.
                {openedCount < drafts.length ? (
                  <> The rest were blocked — open them individually below.</>
                ) : null}
              </span>
            ) : null}
            {gmailMessage ? <span>{gmailMessage}</span> : null}
          </div>
        </div>

        {error ? (
          <div className="m-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="overflow-y-auto flex-1 divide-y divide-border">
          {drafts.length === 0 && !loading ? (
            <p className="p-4 text-sm text-muted">No drafts to show.</p>
          ) : null}
          {/* In combine mode, render only the synthetic single draft —
           *  the per-customer rows would just confuse the picture
           *  ("which one is the modal actually going to send?"). The
           *  source drafts are still in `drafts` so flipping the toggle
           *  off restores the per-customer view. */}
          {(combinedDraft ? [combinedDraft] : drafts).map((d) => {
            const draftKey = d.compose_url;
            const sel = recipientSelection[draftKey] ?? new Set();
            const liveToStr = liveTo(d);
            const liveUrl = liveComposeUrl(d);
            // Re-resolve subject + body against the CURRENT recipient
            // selection so the visible preview always agrees with who's
            // checked. Without this the row shows whatever was rendered
            // at template-pick time, even after the user swaps
            // recipients.
            const liveContentForRow = liveContent(d);
            const isExpanded = expandedRecipients.has(draftKey);
            const bodyOpen = expandedBodies.has(draftKey);
            const hasContactsBeyondDefault = d.recipients.some((r) => !r.default);
            return (
              <div key={draftKey} className="p-3 hover:bg-canvas/60">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-fg truncate">
                      {d.customer_label}
                    </div>
                    <div className="text-xs text-muted truncate flex items-center gap-1.5">
                      <span className="truncate">
                        {d.bcc_batch ? "From" : "To"}: {liveToStr || "(none)"}
                      </span>
                      {d.recipients.length > 0 && !d.bcc_batch ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(draftKey)}
                          className="text-[10px] uppercase tracking-wide text-accent hover:underline whitespace-nowrap flex-shrink-0"
                          title="Toggle which contacts to include"
                        >
                          {isExpanded
                            ? "Hide"
                            : hasContactsBeyondDefault
                              ? `+${d.recipients.length - 1} contact${d.recipients.length - 1 === 1 ? "" : "s"}`
                              : "Edit"}
                        </button>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted mt-1 flex items-center gap-1.5 min-w-0">
                      <span className="truncate flex-1 min-w-0">
                        {liveContentForRow.subject}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleBody(draftKey)}
                        className="text-[10px] uppercase tracking-wide text-accent hover:underline whitespace-nowrap flex-shrink-0"
                        title="Toggle the rendered email body preview"
                      >
                        {bodyOpen ? "Hide body" : "Preview body"}
                      </button>
                    </div>
                    {d.cc && d.cc.trim() ? (
                      <div className="text-[11px] text-muted mt-0.5 truncate" title={d.cc}>
                        CC <span className="text-fg font-mono">{d.cc}</span>
                      </div>
                    ) : null}
                    {d.bcc && d.bcc.trim() ? (
                      <div className="text-[11px] text-muted mt-0.5 truncate" title={d.bcc}>
                        BCC <span className="text-fg font-mono">{d.bcc}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() =>
                        copy(
                          {
                            ...d,
                            to: liveToStr,
                            compose_url: liveUrl,
                            subject: liveContentForRow.subject,
                            body_text: liveContentForRow.body_text,
                            body_html: liveContentForRow.body_html,
                          },
                          draftKey
                        )
                      }
                      className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                    >
                      {copyHit === draftKey ? "Copied" : "Copy"}
                    </button>
                    <a
                      href={liveUrl}
                      onClick={(e) => {
                        if (!liveToStr) {
                          e.preventDefault();
                        }
                      }}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`px-2 py-1 text-xs rounded-md ${
                        liveToStr
                          ? "bg-accent text-accent-fg hover:bg-accent-hover"
                          : "bg-surface-2 text-subtle cursor-not-allowed"
                      }`}
                    >
                      Open
                    </a>
                  </div>
                </div>
                {isExpanded && d.recipients.length > 0 ? (
                  <ul className="mt-2 ml-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                    {d.recipients.map((r) => {
                      const checked = sel.has(r.email.toLowerCase());
                      return (
                        <li key={r.email} className="text-xs">
                          <label className="flex items-center gap-2 cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRecipient(draftKey, r.email)}
                              className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                            />
                            <span className="truncate">
                              {r.name ? (
                                <>
                                  <span className="text-fg">{r.name}</span>
                                  <span className="text-subtle"> · </span>
                                </>
                              ) : null}
                              <span className="text-muted">{r.email}</span>
                              {r.default ? (
                                <span className="ml-1 text-[10px] uppercase tracking-wide text-subtle">
                                  owner
                                </span>
                              ) : null}
                              {(r.labels ?? []).map((label) => (
                                <span
                                  key={label}
                                  className="ml-1 inline-flex items-center px-1.5 py-0 rounded-full text-[10px] font-medium border bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/40 text-indigo-900 dark:text-indigo-200"
                                  title={`HubSpot association label: ${label}`}
                                >
                                  {label}
                                </span>
                              ))}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {bodyOpen ? (
                  /* Rendered HTML body the modal will create as a Gmail
                     draft (or open via the compose URL). Reads from
                     liveContentForRow so swapping the recipient (above)
                     updates the body live — the speedtoscale.com bug
                     where the preview kept saying "Hi Cait," after
                     toggling to Colton. Falls back to the plain-text
                     version when body_html is absent (legacy callers).
                     The block is sandboxed visually with the same card
                     chrome as the rest of the row so it can't blow
                     out layout. */
                  <div className="mt-2 ml-1 border border-border rounded-md bg-canvas/40 p-3">
                    {liveContentForRow.body_html ? (
                      <div
                        className="prose prose-sm max-w-none text-sm text-fg"
                        // Body templates are authored by trusted admins
                        // in /settings/templates; merge-tag values come
                        // from our own snapshot. This is the same
                        // dangerouslySetInnerHTML path the single-customer
                        // OutreachModal uses.
                        dangerouslySetInnerHTML={{
                          __html: liveContentForRow.body_html,
                        }}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap break-words text-sm text-fg font-sans">
                        {liveContentForRow.body_text}
                      </pre>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-border flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
