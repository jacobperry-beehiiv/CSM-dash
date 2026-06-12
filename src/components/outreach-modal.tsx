"use client";

import { useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import {
  suggestTemplates,
  type TemplateScenario,
} from "@/lib/templates/templates";
import { applyMergeTags } from "@/lib/templates/merge-tags";
import {
  isVisibleToCsm,
  templateTeam,
  type StoredTemplate,
} from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import { getTierLadder } from "@/lib/tiers/client";
import type { EnterpriseTier } from "@/lib/tiers/store";
import type { AdGapReport } from "@/lib/types";

interface Props {
  customer: Customer;
  onClose: () => void;
  initialScenario?: TemplateScenario | string;
}

interface GmailStatus {
  connected: boolean;
  email: string | null;
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

export function OutreachModal({ customer, onClose, initialScenario }: Props) {
  const viewerEmail = useViewerEmail();
  const [templates, setTemplates] = useState<StoredTemplate[]>([]);
  const [ladder, setLadder] = useState<EnterpriseTier[]>([]);
  const [adGap, setAdGap] = useState<AdGapReport | null>(null);
  const [chosenId, setChosenId] = useState<string>(
    initialScenario ?? suggestTemplates(customer)[0]
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailMessage, setGmailMessage] = useState<string | null>(null);

  const suggested = useMemo(
    () => new Set(suggestTemplates(customer) as string[]),
    [customer]
  );

  // Build the recipient picker: owner_email + every HubSpot contact whose
  // primary associated company is this customer's. Owner is default-checked.
  const recipientOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { email: string; name: string | null; isOwner: boolean }[] = [];
    if (customer.owner_email) {
      const key = customer.owner_email.toLowerCase();
      seen.add(key);
      out.push({
        email: customer.owner_email,
        name: customer.property_main_contact ?? null,
        isOwner: true,
      });
    }
    for (const c of customer.hubspot_contacts ?? []) {
      if (!c.email) continue;
      const key = c.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ email: c.email, name: c.name, isOwner: false });
    }
    return out;
  }, [customer]);

  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(
    () => new Set(recipientOptions.filter((r) => r.isOwner).map((r) => r.email.toLowerCase()))
  );

  function toggleRecipient(email: string) {
    const key = email.toLowerCase();
    setSelectedRecipients((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const recipientEmails = recipientOptions
    .filter((r) => selectedRecipients.has(r.email.toLowerCase()))
    .map((r) => r.email);
  const toLine = recipientEmails.join(", ");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/google/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setGmail(s as GmailStatus);
      })
      .catch(() => {
        if (!cancelled) setGmail({ connected: false, email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/templates").then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as StoredTemplate[];
      }),
      getTierLadder().catch(() => [] as EnterpriseTier[]),
    ])
      .then(([allList, tiers]) => {
        if (cancelled) return;
        const list = allList.filter((t) => isVisibleToCsm(t, viewerEmail));
        setTemplates(list);
        setLadder(tiers);
        if (!list.find((t) => t.id === chosenId) && list[0]) {
          setChosenId(list[0].id);
        }
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Unknown error")
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const template = templates.find((t) => t.id === chosenId) ?? null;

  // Lazily fetch ad-gap data only when the chosen template references it,
  // and only once per customer per modal session.
  const templateUsesAdGap =
    template != null &&
    /customer\.(ad_revenue_actual|ad_revenue_potential|ad_revenue_gap|ad_zero_pubs)/.test(
      template.subject + template.body_html
    );

  useEffect(() => {
    if (!templateUsesAdGap || adGap || !customer.workspace_id) return;
    const id = customer.workspace_id;
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(Date.now() - 90 * 86400_000)
      .toISOString()
      .slice(0, 10);
    fetch(
      `/api/ad-gap?organization_id=${encodeURIComponent(id)}&start=${start}&end=${end}`
    )
      .then((r) => r.json())
      .then((j) => setAdGap(j?.report ?? null))
      .catch(() => {});
  }, [templateUsesAdGap, adGap, customer.workspace_id]);

  // Drives the first-name resolver — "Hi Eric," when sending to one
  // person, "Hi there," when sending to a group.
  const ctx = { ladder, adGap, recipient_count: recipientEmails.length };
  const subject = template
    ? applyMergeTags(template.subject, customer, ctx)
    : "";
  const body_html = template
    ? applyMergeTags(template.body_html, customer, ctx)
    : "";
  const body_text = body_html ? htmlToText(body_html) : "";

  async function copy() {
    if (!template) return;
    await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body_text}`);
  }

  async function createGmailDraft() {
    if (!template || !toLine) return;
    setGmailBusy(true);
    setGmailMessage(null);
    try {
      const r = await fetch("/api/drafts/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drafts: [
            {
              to: toLine,
              subject,
              body_html,
              from: template.send_as_email || undefined,
            },
          ],
        }),
      });
      const j = (await r.json()) as {
        created?: number;
        failed?: number;
        created_in?: string;
        alias_fallbacks?: number;
        errors?: Array<{ error: string }>;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if ((j.failed ?? 0) > 0 || (j.created ?? 0) === 0) {
        throw new Error(j.errors?.[0]?.error ?? "Draft creation failed");
      }
      const where = j.created_in ?? gmail?.email ?? "your Gmail";
      const fallbackNote =
        (j.alias_fallbacks ?? 0) > 0
          ? " (sent from your primary address — alias not verified)"
          : "";
      setGmailMessage(`Draft created in ${where}'s Drafts folder${fallbackNote}.`);
    } catch (e) {
      setGmailMessage(e instanceof Error ? e.message : "Draft creation failed");
    } finally {
      setGmailBusy(false);
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
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-fg">
              Draft outreach — {customer.company_name ?? customer.workspace_name}
            </h3>
            <p className="text-xs text-muted mt-0.5 truncate">
              To: {toLine || "(no recipients selected)"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {recipientOptions.length > 0 ? (
          <div className="px-4 py-3 border-b border-border bg-canvas">
            <div className="text-xs text-muted mb-2">
              Recipients ({recipientEmails.length} selected)
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
              {recipientOptions.map((r) => {
                const checked = selectedRecipients.has(r.email.toLowerCase());
                return (
                  <li key={r.email} className="text-xs">
                    <label className="flex items-center gap-2 cursor-pointer py-0.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRecipient(r.email)}
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
                        {r.isOwner ? (
                          <span className="ml-1 text-[10px] uppercase tracking-wide text-subtle">
                            owner
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div className="p-4 border-b border-border">
          {loading ? (
            <p className="text-sm text-muted">Loading templates…</p>
          ) : error ? (
            <p className="text-sm text-red-600">Failed to load: {error}</p>
          ) : (
            <>
              <label className="text-xs text-muted block mb-1">Template</label>
              <select
                value={chosenId}
                onChange={(e) => setChosenId(e.target.value)}
                className="w-full px-3 py-2 border border-border-strong rounded-md text-sm"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {suggested.has(t.id) ? "★ " : ""}
                    {t.label}
                  </option>
                ))}
              </select>
              {template?.blurb ? (
                <p className="text-xs text-muted mt-2">{template.blurb}</p>
              ) : null}
              {template ? (
                <div className="mt-2">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
                      templateTeam(template) === "am"
                        ? "bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-500/40"
                        : "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-500/40"
                    }`}
                  >
                    {templateTeam(template) === "am" ? "AM" : "CSM"}
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>

        {template ? (
          <div className="p-4 overflow-y-auto flex-1 space-y-3">
            <div>
              <div className="text-xs text-muted mb-1">Subject</div>
              <div className="px-3 py-2 bg-canvas rounded-md text-sm font-medium">
                {subject}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Body preview</div>
              <div
                className="px-3 py-2 bg-canvas rounded-md text-sm prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: body_html }}
              />
            </div>
          </div>
        ) : null}

        <div className="p-4 border-t border-border space-y-2">
          {gmailMessage ? (
            <p
              className={`text-xs ${
                gmailMessage.startsWith("Draft created")
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-red-700 dark:text-red-300"
              }`}
            >
              {gmailMessage}
            </p>
          ) : null}
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={copy}
              disabled={!template}
              className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
            >
              Copy
            </button>
            {gmail?.connected ? (
              <button
                onClick={createGmailDraft}
                disabled={!template || !toLine || gmailBusy}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
              >
                {gmailBusy ? "Creating draft…" : "Create draft in Gmail"}
              </button>
            ) : (
              <a
                href="/api/auth/google/start"
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
                title="Connect Gmail to create drafts directly in your Drafts folder"
              >
                Connect Gmail to create draft
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
