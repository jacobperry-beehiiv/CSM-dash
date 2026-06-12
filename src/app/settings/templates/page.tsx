"use client";

import { useEffect, useMemo, useState } from "react";
import { templateTeam, type StoredTemplate } from "@/lib/templates/types";
import { TemplateEditor } from "@/components/template-editor";
import { MergeTagLibrary } from "@/components/merge-tag-library";

type Mode = { kind: "list" } | { kind: "edit"; id: string } | { kind: "new" };
type TemplateTeamTab = "csm" | "am";

export default function TemplatesPage() {
  const [list, setList] = useState<StoredTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [teamTab, setTeamTab] = useState<TemplateTeamTab>("csm");
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

  const csmCount = useMemo(
    () => list.filter((t) => templateTeam(t) === "csm").length,
    [list]
  );
  const amCount = useMemo(
    () => list.filter((t) => templateTeam(t) === "am").length,
    [list]
  );

  const filtered = useMemo(() => {
    return list.filter((t) => {
      const team = templateTeam(t);
      if (teamTab === "am" && team !== "am") return false;
      if (teamTab === "csm" && team !== "csm") return false;
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
  }, [list, teamTab, search]);

  if (mode.kind !== "list") {
    const initial =
      mode.kind === "edit" ? list.find((t) => t.id === mode.id) : null;
    return (
      <>
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-fg tracking-tight">
            {mode.kind === "edit" ? "Edit template" : "New template"}
          </h1>
          <button
            onClick={() => setMode({ kind: "list" })}
            className="text-sm text-muted hover:text-fg"
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
          <h1 className="text-3xl font-semibold text-fg tracking-tight">Outreach templates</h1>
          <p className="text-sm text-muted mt-1">
            Rich-text email templates with merge tags. Edit here; everything
            else in the dashboard pulls from this list.
          </p>
        </div>
        <button
          onClick={() => setMode({ kind: "new" })}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
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
          className="px-3 py-2 border border-border-strong rounded-lg text-sm flex-1 min-w-[200px]"
        />
        <div
          className="inline-flex rounded-lg border border-border-strong overflow-hidden"
          role="tablist"
          aria-label="Template team"
        >
          {(
            [
              { key: "csm" as const, label: "CSM", count: csmCount },
              { key: "am" as const, label: "AM", count: amCount },
            ] as const
          ).map((tab) => {
            const active = teamTab === tab.key;
            const activeBg =
              tab.key === "csm"
                ? "bg-indigo-600 text-white"
                : "bg-purple-600 text-white";
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTeamTab(tab.key)}
                className={`px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? activeBg
                    : "bg-surface text-muted hover:text-fg hover:bg-canvas"
                }`}
              >
                {tab.label}{" "}
                <span
                  className={`ml-1 font-mono text-xs ${
                    active ? "opacity-80" : "text-subtle"
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading templates…</p>
      ) : error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted">
          No {teamTab === "am" ? "AM" : "CSM"} templates
          {search ? " match your search" : ""}.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => setMode({ kind: "edit", id: t.id })}
              className="text-left rounded-xl border border-border bg-surface shadow-card p-4 hover:border-border-strong hover:bg-canvas/50"
            >
              <h3 className="font-semibold text-fg">{t.label}</h3>
              {t.blurb ? (
                <p className="text-xs text-muted mt-1">{t.blurb}</p>
              ) : null}
              <div className="text-xs text-muted mt-2">Subject</div>
              <div className="text-sm text-fg mt-0.5 truncate">
                {t.subject}
              </div>
              <div className="mt-3">
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
                    templateTeam(t) === "am"
                      ? "bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-500/40"
                      : "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-500/40"
                  }`}
                >
                  {templateTeam(t) === "am" ? "AM" : "CSM"}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
