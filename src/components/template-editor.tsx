"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  templateTeam,
  type StoredTemplate,
  type TemplateTeam,
} from "@/lib/templates/types";
import { MERGE_TAGS, applyMergeTags } from "@/lib/templates/merge-tags";
import type { Customer } from "@/lib/types";
import { RichTextEditor } from "./rich-text-editor";
import { getTierLadder } from "@/lib/tiers/client";
import type { EnterpriseTier } from "@/lib/tiers/store";

const PREVIEW_CUSTOMER: Customer = {
  workspace_id: "ws_preview",
  workspace_name: "preview-workspace",
  company_name: "Example Co",
  owner_email: "owner@example.com",
  mrr: 8333,
  arr: 100000,
  active_subs: 250000,
  max_subscriptions: 500000,
  renewal_date: new Date(Date.now() + 14 * 86400000).toISOString(),
  next_invoice: new Date(Date.now() + 14 * 86400000).toISOString(),
  company_engagement: "High Touch",
  customer_success_manager: "Jacob_Perry",
  property_company_status: "Live",
  property_main_contact: "Jane Doe",
  stripe_plan: "Enterprise",
  interval: "annual",
  last_send: new Date(Date.now() - 18 * 86400000).toISOString(),
  last_log_in: null,
  mon_since_1st_ent: 12,
  percent_of_max_subs: 50,
  direct_sponsorships_enabled: false,
  ad_placement: true,
  grew_via_boost: false,
  monetization_via_boost: false,
  property_risk_level: "Yellow",
  property_risk_level_detail: "Down 30% on engagement vs Q1.",
  property_notes_last_contacted: new Date(
    Date.now() - 45 * 86400000
  ).toISOString(),
};

interface Props {
  initial?: StoredTemplate | null;
  onSaved: (t: StoredTemplate) => void;
  onDeleted?: (id: string) => void;
  onCancel: () => void;
}

export function TemplateEditor({
  initial,
  onSaved,
  onDeleted,
  onCancel,
}: Props) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [blurb, setBlurb] = useState(initial?.blurb ?? "");
  const [team, setTeam] = useState<TemplateTeam>(
    initial ? templateTeam(initial) : "csm"
  );
  const [csmTagsInput, setCsmTagsInput] = useState(
    initial?.csm_tags?.join(", ") ?? ""
  );
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial?.body_html ?? "");
  const [sendAsEmail, setSendAsEmail] = useState(initial?.send_as_email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMergeMenu, setShowMergeMenu] = useState(false);
  // Two-step inline confirm for delete. window.confirm() is silently
  // suppressed by some embedded / Vercel-hosted browser contexts, so
  // the first click flips this on and surfaces a "Confirm delete"
  // button; the second click fires the DELETE request.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [ladder, setLadder] = useState<EnterpriseTier[]>([]);
  // Send-as aliases discovered on the connected Gmail account. Loaded
  // lazily on mount; soft-fails to [] so the editor still works
  // without the alias dropdown when /api/auth/google/aliases is down
  // or the new scope hasn't been re-consented yet.
  const [aliases, setAliases] = useState<
    Array<{ email: string; name: string | null; is_primary: boolean }>
  >([]);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [aliasesNeedReconsent, setAliasesNeedReconsent] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getTierLadder()
      .then((list) => !cancelled && setLadder(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load alias list once per editor open. Surfacing the reconsent
  // banner here rather than swallowing the 403 means a CSM gets a
  // clear path to fix it instead of a silently-empty dropdown.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/google/aliases")
      .then(async (r) => {
        const j = (await r.json()) as {
          aliases?: Array<{
            email: string;
            name: string | null;
            is_primary: boolean;
          }>;
          error?: string;
          needs_reconsent?: boolean;
        };
        if (cancelled) return;
        if (!r.ok) {
          setAliasError(j.error ?? `HTTP ${r.status}`);
          setAliasesNeedReconsent(Boolean(j.needs_reconsent));
          setAliases([]);
          return;
        }
        setAliases(j.aliases ?? []);
        setAliasError(null);
      })
      .catch((e) => {
        if (!cancelled) {
          setAliasError(e instanceof Error ? e.message : "Failed to load aliases");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset state when switching to a different template
  useEffect(() => {
    setLabel(initial?.label ?? "");
    setBlurb(initial?.blurb ?? "");
    setTeam(initial ? templateTeam(initial) : "csm");
    setCsmTagsInput(initial?.csm_tags?.join(", ") ?? "");
    setSubject(initial?.subject ?? "");
    setBodyHtml(initial?.body_html ?? "");
    setSendAsEmail(initial?.send_as_email ?? "");
    setError(null);
  }, [initial?.id]);

  const previewSubject = useMemo(
    () => applyMergeTags(subject, PREVIEW_CUSTOMER, { ladder }),
    [subject, ladder]
  );
  const previewBody = useMemo(
    () => applyMergeTags(bodyHtml, PREVIEW_CUSTOMER, { ladder }),
    [bodyHtml, ladder]
  );

  function insertMergeTagIntoSubject(token: string) {
    const input = subjectRef.current;
    if (!input) {
      setSubject(subject + ` {{${token}}}`);
      return;
    }
    const start = input.selectionStart ?? subject.length;
    const end = input.selectionEnd ?? subject.length;
    const next =
      subject.slice(0, start) + `{{${token}}}` + subject.slice(end);
    setSubject(next);
  }

  function insertMergeTagIntoBody(token: string) {
    document.execCommand("insertText", false, `{{${token}}}`);
    const editor = document.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement | null;
    if (editor) setBodyHtml(editor.innerHTML);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const csm_tags = csmTagsInput
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: initial?.id,
          label,
          blurb,
          team,
          csm_tags,
          subject,
          body_html: bodyHtml,
          // Empty string clears the alias on the server; undefined would
          // leave it unchanged. We always send an explicit value so
          // toggling "use my primary" sticks.
          send_as_email: sendAsEmail.trim().toLowerCase(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved(json as StoredTemplate);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  function attemptRemove() {
    if (!initial) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    void remove();
  }

  async function remove() {
    if (!initial) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/templates?id=${encodeURIComponent(initial.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleted?.(initial.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted block mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Renewal — 30 days out"
            className="w-full px-3 py-2 border border-border-strong rounded-md text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">
            Blurb (when to use it)
          </label>
          <input
            type="text"
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            placeholder="Short description"
            className="w-full px-3 py-2 border border-border-strong rounded-md text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted block mb-1.5">Team</label>
          <div
            className="inline-flex rounded-md border border-border-strong overflow-hidden"
            role="group"
            aria-label="Template team"
          >
            {(["csm", "am"] as TemplateTeam[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTeam(t)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  team === t
                    ? t === "csm"
                      ? "bg-indigo-600 text-white"
                      : "bg-purple-600 text-white"
                    : "bg-surface text-muted hover:bg-canvas"
                }`}
              >
                {t === "csm" ? "CSM" : "AM"}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-subtle mt-1">
            Controls which tab this template appears under in the
            library.
          </p>
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">
            Visible to CSMs (comma-separated emails)
          </label>
          <input
            type="text"
            value={csmTagsInput}
            onChange={(e) => setCsmTagsInput(e.target.value)}
            placeholder="leave blank = visible to everyone"
            className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
          />
          <p className="text-[11px] text-subtle mt-1">
            When set, this template only appears in the bulk-draft and
            outreach dropdowns for the listed CSMs. Empty = universal.
          </p>
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">
            Send as (Gmail alias)
          </label>
          {aliasesNeedReconsent ? (
            <div className="text-xs bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-2 text-amber-900 dark:text-amber-200">
              Your Gmail connection predates alias auto-discovery. Visit{" "}
              <a
                href="/api/auth/google/start"
                className="underline font-medium"
              >
                /settings/gmail
              </a>{" "}
              and re-connect to enable the picker.
            </div>
          ) : (
            <>
              <select
                value={sendAsEmail}
                onChange={(e) => setSendAsEmail(e.target.value)}
                className="w-full px-3 py-2 border border-border-strong rounded-md text-sm bg-surface"
              >
                <option value="">
                  Default — the drafting CSM&rsquo;s primary Gmail
                </option>
                {aliases.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.name ? `${a.name} <${a.email}>` : a.email}
                    {a.is_primary ? " (primary)" : ""}
                  </option>
                ))}
                {/* If a previously-saved alias isn't in the live list
                 *  (e.g. the active connection differs from the CSM
                 *  who set it), still show it so the value sticks. */}
                {sendAsEmail &&
                !aliases.some((a) => a.email === sendAsEmail) ? (
                  <option value={sendAsEmail}>
                    {sendAsEmail} (saved · not in current account)
                  </option>
                ) : null}
              </select>
              <p className="text-[11px] text-subtle mt-1">
                Drafts built from this template will use this alias as
                their From address. Each CSM must have the alias
                verified on their own Gmail; unverified senders fall
                back to the primary.
              </p>
              {aliasError && !aliasesNeedReconsent ? (
                <p className="text-[11px] text-red-700 mt-1">{aliasError}</p>
              ) : null}
            </>
          )}
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">Subject</label>
          <input
            ref={subjectRef}
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="{{customer.name}} renewal — quick sync this week?"
            className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-medium"
          />
          <button
            type="button"
            onClick={() => {
              const token = prompt(
                "Insert merge tag for subject (e.g. customer.name)"
              );
              if (token) insertMergeTagIntoSubject(token);
            }}
            className="text-xs mt-1 text-blue-600 dark:text-blue-400 hover:underline"
          >
            + Insert merge tag
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-muted">Body</label>
            <button
              type="button"
              onClick={() => setShowMergeMenu((v) => !v)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {showMergeMenu ? "Hide" : "+ Merge tag"}
            </button>
          </div>
          {showMergeMenu ? (
            <div className="mb-2 max-h-48 overflow-auto border border-border rounded-md p-2 bg-canvas grid grid-cols-1 gap-1 text-xs">
              {MERGE_TAGS.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  onClick={() => {
                    insertMergeTagIntoBody(t.token);
                    setShowMergeMenu(false);
                  }}
                  className="text-left px-2 py-1 hover:bg-surface rounded"
                >
                  <code className="font-mono text-fg">
                    {`{{${t.token}}}`}
                  </code>{" "}
                  <span className="text-muted">— {t.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <RichTextEditor
            value={bodyHtml}
            onChange={setBodyHtml}
            placeholder="Hi {{customer.contact_first_name}}, ..."
          />
        </div>

        {error ? (
          <div className="text-sm text-red-600">{error}</div>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !label || !subject || !bodyHtml}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : initial ? "Save changes" : "Create template"}
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
          >
            Cancel
          </button>
          {initial && onDeleted ? (
            <div className="ml-auto flex items-center gap-2">
              {confirmingDelete && !busy ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="px-2 py-1.5 text-sm text-muted hover:text-fg"
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                onClick={attemptRemove}
                disabled={busy}
                className={`px-3 py-1.5 rounded-md text-sm border disabled:opacity-50 ${
                  confirmingDelete
                    ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                    : "border-red-300 text-red-700 hover:bg-red-50 dark:bg-red-500/10"
                }`}
              >
                {busy
                  ? "Deleting…"
                  : confirmingDelete
                  ? `Confirm delete "${initial.label}"`
                  : "Delete"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">
            Preview
          </h4>
          <p className="text-[11px] text-muted">
            Rendered against an example customer (Jane Doe @ Example Co, $100K
            ARR, 50% of tier).
          </p>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-xs text-muted mb-1">Subject</div>
          <div className="px-3 py-2 bg-canvas rounded text-sm font-medium">
            {previewSubject || (
              <span className="text-subtle italic">empty</span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-xs text-muted mb-1">Body</div>
          <div
            className="px-3 py-2 bg-canvas rounded text-sm prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{
              __html:
                previewBody ||
                '<span class="text-subtle italic">empty</span>',
            }}
          />
        </div>
      </div>
    </div>
  );
}
