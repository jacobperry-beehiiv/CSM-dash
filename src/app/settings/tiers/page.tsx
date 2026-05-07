"use client";

import { useEffect, useState } from "react";
import type { EnterpriseTier } from "@/lib/tiers/store";
import { invalidateTierCache } from "@/lib/tiers/client";

interface DraftTier {
  name: string;
  max_subs: number | "";
  monthly_usd: number | "";
  annual_usd: number | "";
  notes?: string;
}

function emptyDraft(): DraftTier {
  return { name: "", max_subs: "", monthly_usd: "", annual_usd: "", notes: "" };
}

export default function TiersPage() {
  const [tiers, setTiers] = useState<DraftTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/tiers");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = (await r.json()) as EnterpriseTier[];
      setTiers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update<K extends keyof DraftTier>(idx: number, key: K, value: DraftTier[K]) {
    setTiers((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [key]: value };
      return next;
    });
  }

  function addRow() {
    setTiers((prev) => [...prev, emptyDraft()]);
  }

  function removeRow(idx: number) {
    setTiers((prev) => prev.filter((_, i) => i !== idx));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const cleaned: EnterpriseTier[] = tiers.map((t) => ({
        name: t.name.trim(),
        max_subs: Number(t.max_subs),
        monthly_usd: Number(t.monthly_usd),
        annual_usd: Number(t.annual_usd),
        notes: t.notes?.trim() || undefined,
      }));
      const r = await fetch("/api/tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiers: cleaned }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setTiers(json as EnterpriseTier[]);
      invalidateTierCache();
      setMessage("Saved. Merge tags now use these prices.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Enterprise tiers</h1>
          <p className="text-sm text-gray-500 mt-1">
            The subscriber-tier ladder Enterprise contracts use. Templates can
            reference{" "}
            <code className="bg-gray-100 px-1 py-0.5 rounded">
              {"{{customer.current_tier}}"}
            </code>
            ,{" "}
            <code className="bg-gray-100 px-1 py-0.5 rounded">
              {"{{customer.next_tier_1}}"}
            </code>
            , and the next 2-3 tiers above any customer's current cap.
          </p>
        </div>
      </div>

      {error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-3 text-sm text-emerald-800">
          {message}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-gray-500">Loading tiers…</p>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[14%]" />
                <col className="w-[20%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
                <col className="w-[24%]" />
                <col className="w-[6%]" />
              </colgroup>
              <thead className="bg-gray-50">
                <tr className="text-left border-b border-gray-200">
                  <th className="px-3 py-2 text-xs font-medium text-gray-600">
                    Tier label
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-gray-600">
                    Max subs
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-gray-600">
                    Monthly USD
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-gray-600">
                    Annual USD
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-gray-600">
                    Notes
                  </th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {tiers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-sm text-gray-500"
                    >
                      No tiers — click + Add tier below to create one.
                    </td>
                  </tr>
                ) : null}
                {tiers.map((t, i) => (
                  <tr key={i} className="border-b border-gray-100 align-top">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={t.name}
                        onChange={(e) => update(i, "name", e.target.value)}
                        placeholder="500K"
                        className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm font-medium"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={t.max_subs}
                        onChange={(e) =>
                          update(
                            i,
                            "max_subs",
                            e.target.value === "" ? "" : Number(e.target.value)
                          )
                        }
                        placeholder="500000"
                        className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={t.monthly_usd}
                        onChange={(e) =>
                          update(
                            i,
                            "monthly_usd",
                            e.target.value === "" ? "" : Number(e.target.value)
                          )
                        }
                        placeholder="5000"
                        className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={t.annual_usd}
                        onChange={(e) =>
                          update(
                            i,
                            "annual_usd",
                            e.target.value === "" ? "" : Number(e.target.value)
                          )
                        }
                        placeholder="50000"
                        className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={t.notes ?? ""}
                        onChange={(e) => update(i, "notes", e.target.value)}
                        placeholder="(optional)"
                        className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => removeRow(i)}
                        title="Delete row"
                        className="px-2 py-1 text-xs border border-red-300 text-red-700 rounded-md hover:bg-red-50"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              onClick={addRow}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
            >
              + Add tier
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save ladder"}
            </button>
            <button
              onClick={load}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
            >
              Reset
            </button>
            <span className="text-xs text-gray-500 ml-auto">
              Order is sub-count ascending — small tiers at the top.
            </span>
          </div>
        </>
      )}
    </>
  );
}
