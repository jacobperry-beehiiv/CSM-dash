"use client";

import { useEffect, useMemo, useState } from "react";
import { MERGE_TAGS, applyMergeTags } from "@/lib/templates/merge-tags";
import type { Customer } from "@/lib/types";
import { getTierLadder } from "@/lib/tiers/client";
import type { EnterpriseTier } from "@/lib/tiers/store";

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
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
        aria-expanded={open}
      >
        <div>
          <div className="text-sm font-medium text-gray-900">
            Merge tag library
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            Use{" "}
            <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">
              {"{{token}}"}
            </code>{" "}
            in a subject or body to inject customer data at draft time.{" "}
            {MERGE_TAGS.length} tags available.
          </div>
        </div>
        <span
          className={`text-gray-400 text-xl transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▸
        </span>
      </button>

      {open ? (
        <div className="border-t border-gray-200">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50 space-y-2">
            <div className="text-xs text-gray-700">
              <strong>Syntax:</strong> double curly braces around the token
              name. Whitespace inside the braces is fine, so all of these
              behave identically:
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
              <code className="font-mono bg-white border border-gray-200 px-2 py-1 rounded">
                {"{{customer.name}}"}
              </code>
              <code className="font-mono bg-white border border-gray-200 px-2 py-1 rounded">
                {"{{ customer.name }}"}
              </code>
              <code className="font-mono bg-white border border-gray-200 px-2 py-1 rounded">
                {"{{   customer.name   }}"}
              </code>
            </div>
            <div className="text-xs text-gray-600">
              Unknown tokens are left as-is so you can spot typos in the
              preview. Tags work in both the subject line and the rich-text
              body.
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags…"
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
            />
          </div>

          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
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
                      className="px-3 py-6 text-center text-sm text-gray-500"
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
                        className="border-b border-gray-100 hover:bg-blue-50/30 align-top"
                      >
                        <td className="px-3 py-2">
                          <code className="font-mono text-xs text-gray-900 bg-gray-100 px-1.5 py-0.5 rounded">
                            {`{{${t.token}}}`}
                          </code>
                        </td>
                        <td className="px-3 py-2 text-gray-700">{t.label}</td>
                        <td className="px-3 py-2 text-gray-600 text-xs">
                          {t.description}
                        </td>
                        <td className="px-3 py-2 text-gray-700 break-words">
                          {example || (
                            <span className="text-gray-400 italic">empty</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {onInsert ? (
                            <button
                              onClick={() => onInsert(t.token)}
                              className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 whitespace-nowrap"
                              title="Insert at cursor"
                            >
                              Insert
                            </button>
                          ) : (
                            <button
                              onClick={() => copy(t.token)}
                              className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 whitespace-nowrap"
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
