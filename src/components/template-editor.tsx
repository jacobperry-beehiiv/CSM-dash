"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredTemplate } from "@/lib/templates/store";
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
  const [tagsInput, setTagsInput] = useState(initial?.tags?.join(", ") ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial?.body_html ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMergeMenu, setShowMergeMenu] = useState(false);
  const [ladder, setLadder] = useState<EnterpriseTier[]>([]);
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

  // Reset state when switching to a different template
  useEffect(() => {
    setLabel(initial?.label ?? "");
    setBlurb(initial?.blurb ?? "");
    setTagsInput(initial?.tags?.join(", ") ?? "");
    setSubject(initial?.subject ?? "");
    setBodyHtml(initial?.body_html ?? "");
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
      const tags = tagsInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: initial?.id,
          label,
          blurb,
          tags,
          subject,
          body_html: bodyHtml,
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

  async function remove() {
    if (!initial) return;
    if (!confirm(`Delete template "${initial.label}"?`)) return;
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
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Renewal — 30 days out"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">
            Blurb (when to use it)
          </label>
          <input
            type="text"
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            placeholder="Short description"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">
            Tags (comma-separated)
          </label>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="renewal, annual, escalation"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Subject</label>
          <input
            ref={subjectRef}
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="{{customer.name}} renewal — quick sync this week?"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-medium"
          />
          <button
            type="button"
            onClick={() => {
              const token = prompt(
                "Insert merge tag for subject (e.g. customer.name)"
              );
              if (token) insertMergeTagIntoSubject(token);
            }}
            className="text-xs mt-1 text-blue-600 hover:underline"
          >
            + Insert merge tag
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-500">Body</label>
            <button
              type="button"
              onClick={() => setShowMergeMenu((v) => !v)}
              className="text-xs text-blue-600 hover:underline"
            >
              {showMergeMenu ? "Hide" : "+ Merge tag"}
            </button>
          </div>
          {showMergeMenu ? (
            <div className="mb-2 max-h-48 overflow-auto border border-gray-200 rounded-md p-2 bg-gray-50 grid grid-cols-1 gap-1 text-xs">
              {MERGE_TAGS.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  onClick={() => {
                    insertMergeTagIntoBody(t.token);
                    setShowMergeMenu(false);
                  }}
                  className="text-left px-2 py-1 hover:bg-white rounded"
                >
                  <code className="font-mono text-gray-900">
                    {`{{${t.token}}}`}
                  </code>{" "}
                  <span className="text-gray-500">— {t.label}</span>
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
            className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : initial ? "Save changes" : "Create template"}
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          {initial && onDeleted ? (
            <button
              onClick={remove}
              disabled={busy}
              className="ml-auto px-3 py-1.5 border border-red-300 text-red-700 rounded-md text-sm hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
            Preview
          </h4>
          <p className="text-[11px] text-gray-500">
            Rendered against an example customer (Jane Doe @ Example Co, $100K
            ARR, 50% of tier).
          </p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <div className="text-xs text-gray-500 mb-1">Subject</div>
          <div className="px-3 py-2 bg-gray-50 rounded text-sm font-medium">
            {previewSubject || (
              <span className="text-gray-400 italic">empty</span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <div className="text-xs text-gray-500 mb-1">Body</div>
          <div
            className="px-3 py-2 bg-gray-50 rounded text-sm prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{
              __html:
                previewBody ||
                '<span class="text-gray-400 italic">empty</span>',
            }}
          />
        </div>
      </div>
    </div>
  );
}
