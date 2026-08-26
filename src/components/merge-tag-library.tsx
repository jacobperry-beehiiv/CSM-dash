"use client";

import { useEffect, useMemo, useState } from "react";
import { MERGE_TAGS, applyMergeTags } from "@/lib/templates/merge-tags";
import type { Customer } from "@/lib/types";
import { getTierLadder } from "@/lib/tiers/client";
import type { EnterpriseTier } from "@/lib/tiers/store";
import { useCustomMergeTags } from "@/lib/data/use-custom-merge-tags";
import Link from "next/link";

const PREVIEW_CUSTOMER: Customer = {
  workspace_id: "ws_preview",
  workspace_name: "preview-workspace",
  company_name: "Example Co",
  owner_email: "owner@example.com",
  mrr: 8333,
  arr: 100000,
  active_subs: 380_000,
  max_subscriptions: 500_000,
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
  property_customer_goals: "Hit 500K subs by EOY",
};

interface Props {
  /** Default open/closed state. Defaults to closed on /templates list, open
   *  inside the editor where it's most useful. */
  defaultOpen?: boolean;
  /** When set, clicking a row inserts the tag via this callback instead of
   *  copying to clipboard. Used by the template editor. */
  onInsert?: (token: string) => void;
}

export function MergeTagLibrary({ defaultOpen = false, onInsert }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState("");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [ladder, setLadder] = useState<EnterpriseTier[]>([]);
  // Per-CSM custom tags — surfaced in their own section below the
  // built-in library so a CSM can find + insert their own
  // {{scheduling_text}} / {{signature_line}} / etc. Values are
  // per-viewer, so what someone else's template renders will differ
  // from what you see here.
  const customTags = useCustomMergeTags();

  useEffect(() => {
    let cancelled = false;
    getTierLadder()
      .then((list) => !cancelled && setLadder(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return MERGE_TAGS;
    return MERGE_TAGS.filter(
      (t) =>
        t.token.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [search]);

  // The custom-tags section only re-filters on the same search box —
  // keeps the UI feeling like one library, not two.
  const filteredCustom = useMemo(() => {
    const q = search.trim().toLowerCase();
    const entries = Object.entries(customTags ?? {});
    if (!q) return entries;
    return entries.filter(
      ([name, value]) =>
        name.toLowerCase().includes(q) || value.toLowerCase().includes(q)
    );
  }, [search, customTags]);

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(`{{${token}}}`);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface shadow-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-canvas"
        aria-expanded={open}
      >
        <div>
          <div className="text-sm font-medium text-fg">
            Merge tag library
          </div>
          <div className="text-xs text-muted mt-0.5">
            Use{" "}
            <code className="font-mono bg-surface-2 px-1 py-0.5 rounded">
              {"{{token}}"}
            </code>{" "}
            in a subject or body to inject customer data at draft time.{" "}
            {MERGE_TAGS.length} tags available.
          </div>
        </div>
        <span
          className={`text-subtle text-xl transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▸
        </span>
      </button>

      {open ? (
        <div className="border-t border-border">
          <div className="px-4 py-3 border-b border-border bg-canvas/50 space-y-2">
            <div className="text-xs text-muted">
              <strong>Syntax:</strong> double curly braces around the token
              name. Whitespace inside the braces is fine, so all of these
              behave identically:
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
              <code className="font-mono bg-surface border border-border px-2 py-1 rounded">
                {"{{customer.name}}"}
              </code>
              <code className="font-mono bg-surface border border-border px-2 py-1 rounded">
                {"{{ customer.name }}"}
              </code>
              <code className="font-mono bg-surface border border-border px-2 py-1 rounded">
                {"{{   customer.name   }}"}
              </code>
            </div>
            <div className="text-xs text-muted">
              Unknown tokens are left as-is so you can spot typos in the
              preview. Tags work in both the subject line and the rich-text
              body.
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags…"
              className="w-full px-3 py-1.5 border border-border-strong rounded-md text-sm bg-surface"
            />
          </div>

          {/* Per-CSM custom tags. Rendered as a separate section so
              it's obvious they aren't part of the built-in library —
              other CSMs may not have the same tags registered, so a
              template using yours will still render but they'll see
              the raw {{name}} in their preview until they register
              their own value. Same insert/copy row shape as the
              built-in table so it feels of a piece. */}
          <div className="border-b border-border bg-canvas/40 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-fg">
                  Your custom tags{" "}
                  <span className="text-muted font-normal">
                    · per-CSM · fills in your copy at render time
                  </span>
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  Manage these at{" "}
                  <Link
                    href="/settings/merge-tags"
                    className="text-accent hover:underline font-medium"
                  >
                    /settings/merge-tags
                  </Link>
                  . Other CSMs will only see resolved copy for tags
                  they&rsquo;ve registered themselves.
                </div>
              </div>
            </div>
            {customTags == null ? (
              <div className="mt-2 text-xs text-muted italic">
                Loading your tags…
              </div>
            ) : filteredCustom.length === 0 ? (
              <div className="mt-2 text-xs text-muted italic">
                {Object.keys(customTags).length === 0
                  ? "No custom tags yet — add one at /settings/merge-tags."
                  : "No custom tags match your search."}
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-1 gap-1.5">
                {filteredCustom.map(([name, value]) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
                  >
                    <code className="font-mono text-xs text-fg bg-surface-2 px-1.5 py-0.5 rounded shrink-0">
                      {`{{${name}}}`}
                    </code>
                    <div className="flex-1 text-xs text-muted truncate">
                      {value || (
                        <span className="text-subtle italic">empty</span>
                      )}
                    </div>
                    {onInsert ? (
                      <button
                        onClick={() => onInsert(name)}
                        className="px-2 py-1 text-xs border border-border-strong rounded hover:bg-canvas whitespace-nowrap"
                        title="Insert at cursor"
                      >
                        Insert
                      </button>
                    ) : (
                      <button
                        onClick={() => copy(name)}
                        className="px-2 py-1 text-xs border border-border-strong rounded hover:bg-canvas whitespace-nowrap"
                        title="Copy token to clipboard"
                      >
                        {copiedToken === name ? "Copied" : "Copy"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas sticky top-0">
                <tr className="text-left text-xs text-muted border-b border-border">
                  <th className="px-3 py-2 font-medium w-[28%]">Token</th>
                  <th className="px-3 py-2 font-medium w-[18%]">Label</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium w-[20%]">
                    Example output
                  </th>
                  <th className="px-3 py-2 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-6 text-center text-sm text-muted"
                    >
                      No tags match.
                    </td>
                  </tr>
                ) : (
                  filtered.map((t) => {
                    const example = applyMergeTags(
                      `{{${t.token}}}`,
                      PREVIEW_CUSTOMER,
                      { ladder }
                    );
                    return (
                      <tr
                        key={t.token}
                        className="border-b border-border hover:bg-blue-50 dark:bg-blue-500/30 align-top"
                      >
                        <td className="px-3 py-2">
                          <code className="font-mono text-xs text-fg bg-surface-2 px-1.5 py-0.5 rounded">
                            {`{{${t.token}}}`}
                          </code>
                        </td>
                        <td className="px-3 py-2 text-muted">{t.label}</td>
                        <td className="px-3 py-2 text-muted text-xs">
                          {t.description}
                        </td>
                        <td className="px-3 py-2 text-muted break-words">
                          {example || (
                            <span className="text-subtle italic">empty</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {onInsert ? (
                            <button
                              onClick={() => onInsert(t.token)}
                              className="px-2 py-1 text-xs border border-border-strong rounded hover:bg-canvas whitespace-nowrap"
                              title="Insert at cursor"
                            >
                              Insert
                            </button>
                          ) : (
                            <button
                              onClick={() => copy(t.token)}
                              className="px-2 py-1 text-xs border border-border-strong rounded hover:bg-canvas whitespace-nowrap"
                              title="Copy token to clipboard"
                            >
                              {copiedToken === t.token ? "Copied" : "Copy"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
