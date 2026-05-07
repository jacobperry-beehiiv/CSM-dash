"use client";

import { useEffect, useMemo, useState } from "react";
import type { StoredTemplate } from "@/lib/templates/store";
import { TemplateEditor } from "@/components/template-editor";
import { MergeTagLibrary } from "@/components/merge-tag-library";

type Mode = { kind: "list" } | { kind: "edit"; id: string } | { kind: "new" };

export default function TemplatesPage() {
  const [list, setList] = useState<StoredTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [tagFilter, setTagFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/templates");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as StoredTemplate[];
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of list) for (const tag of t.tags) set.add(tag);
    return [...set].sort();
  }, [list]);

  const filtered = useMemo(() => {
    return list.filter((t) => {
      if (tagFilter && !t.tags.includes(tagFilter)) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !t.label.toLowerCase().includes(q) &&
          !t.blurb.toLowerCase().includes(q) &&
          !t.subject.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [list, tagFilter, search]);

  if (mode.kind !== "list") {
    const initial =
      mode.kind === "edit" ? list.find((t) => t.id === mode.id) : null;
    return (
      <>
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            {mode.kind === "edit" ? "Edit template" : "New template"}
          </h1>
          <button
            onClick={() => setMode({ kind: "list" })}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to library
          </button>
        </div>
        <div className="mb-4">
          <MergeTagLibrary defaultOpen={false} />
        </div>
        <TemplateEditor
          initial={initial}
          onSaved={() => {
            refresh();
            setMode({ kind: "list" });
          }}
          onDeleted={() => {
            refresh();
            setMode({ kind: "list" });
          }}
          onCancel={() => setMode({ kind: "list" })}
        />
      </>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Outreach templates</h1>
          <p className="text-sm text-gray-500 mt-1">
            Rich-text email templates with merge tags. Edit here; everything
            else in the dashboard pulls from this list.
          </p>
        </div>
        <button
          onClick={() => setMode({ kind: "new" })}
          className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700"
        >
          + New template
        </button>
      </div>

      <div className="mb-4">
        <MergeTagLibrary />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="text"
          placeholder="Search label / subject / blurb…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm flex-1 min-w-[200px]"
        />
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">All tags ({list.length})</option>
          {allTags.map((tag) => {
            const count = list.filter((t) => t.tags.includes(tag)).length;
            return (
              <option key={tag} value={tag}>
                #{tag} ({count})
              </option>
            );
          })}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading templates…</p>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500">No templates match.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => setMode({ kind: "edit", id: t.id })}
              className="text-left rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:bg-gray-50/50"
            >
              <h3 className="font-semibold text-gray-900">{t.label}</h3>
              {t.blurb ? (
                <p className="text-xs text-gray-500 mt-1">{t.blurb}</p>
              ) : null}
              <div className="text-xs text-gray-500 mt-2">Subject</div>
              <div className="text-sm text-gray-800 mt-0.5 truncate">
                {t.subject}
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {t.tags.length === 0 ? (
                  <span className="text-[10px] text-gray-400 italic">
                    no tags
                  </span>
                ) : (
                  t.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200"
                    >
                      #{tag}
                    </span>
                  ))
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
