"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MAX_TAG_NAME_LENGTH,
  MAX_TAG_VALUE_LENGTH,
  MAX_TAGS_PER_CSM,
  TAG_NAME_REGEX,
  type PerCsmMergeTag,
  type PerCsmMergeTagsResponse,
} from "@/lib/data/per-csm-merge-tags-types";

/**
 * /settings/merge-tags — per-CSM customizable merge tags.
 *
 * Motivating case: a "scheduling text" tag. Each CSM has their own
 * preferred calendar-scheduling blurb (Calendly link, "grab time
 * here" wording). Shared outreach templates reference the tag as
 * `{{scheduling_text}}` and each CSM's stored copy fills in at
 * render time — no per-CSM forks of the template needed.
 *
 * State model mirrors /settings/personalize:
 *   - Load current on mount via GET.
 *   - Local form state (rows) mirrors the saved value, with `dirty`
 *     gating the Save button + a Reset button that snaps back.
 *   - PUT on Save returns the sanitized stored list (server strips
 *     invalid names, dedupes, length-caps values). We mirror the
 *     response back into local state so any silent drops appear
 *     immediately.
 *
 * The "registered by any CSM" panel lists every tag name currently
 * in use anywhere on the team — nudges everyone toward a shared
 * convention (one `scheduling_text`, not `calendly` +
 * `book_meeting` + `time_slot`). Values are private per-CSM; only
 * names + usage counts cross the wire.
 */

interface Row {
  name: string;
  value: string;
}

function toRows(tags: PerCsmMergeTag[]): Row[] {
  return tags.map((t) => ({ name: t.name, value: t.value }));
}

function rowsEqual(a: Row[], b: Row[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].value !== b[i].value) return false;
  }
  return true;
}

export default function MergeTagsSettingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<Row[]>([]);
  const [registered, setRegistered] = useState<
    PerCsmMergeTagsResponse["registered"]
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/merge-tags", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as PerCsmMergeTagsResponse;
      })
      .then((body) => {
        if (cancelled) return;
        const initial = toRows(body.mine);
        setRows(initial);
        setSaved(initial);
        setRegistered(body.registered ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = !rowsEqual(rows, saved);

  const rowValidity = useMemo(() => {
    // Per-row validation surfaces problems inline instead of waiting
    // for the server round-trip. Mirrors the server sanitizer's rules
    // in per-csm-merge-tags.ts — keep the two in sync when the rules
    // change.
    const seen = new Set<string>();
    return rows.map((r) => {
      const name = r.name.trim();
      if (name.length === 0) {
        return { ok: false as const, reason: "Name required" };
      }
      if (name.length > MAX_TAG_NAME_LENGTH) {
        return {
          ok: false as const,
          reason: `Name too long (max ${MAX_TAG_NAME_LENGTH})`,
        };
      }
      if (!TAG_NAME_REGEX.test(name)) {
        return {
          ok: false as const,
          reason: "Only letters, numbers, underscores",
        };
      }
      if (seen.has(name)) {
        return { ok: false as const, reason: "Duplicate name" };
      }
      seen.add(name);
      if (r.value.length > MAX_TAG_VALUE_LENGTH) {
        return {
          ok: false as const,
          reason: `Value too long (max ${MAX_TAG_VALUE_LENGTH})`,
        };
      }
      return { ok: true as const };
    });
  }, [rows]);

  const anyInvalid = rowValidity.some((v) => !v.ok);
  const atCap = rows.length >= MAX_TAGS_PER_CSM;

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        tags: rows.map((r) => ({ name: r.name.trim(), value: r.value })),
      };
      const r = await fetch("/api/settings/merge-tags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json().catch(() => ({}))) as {
        tags?: PerCsmMergeTag[];
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const next = toRows(j.tags ?? []);
      const dropped = rows.length - next.length;
      setRows(next);
      setSaved(next);
      // Re-fetch registered so a new tag name the viewer just added
      // (or one they removed) reflects in the "registered by any
      // CSM" panel.
      fetch("/api/settings/merge-tags", { cache: "no-store" })
        .then((rr) =>
          rr.ok ? (rr.json() as Promise<PerCsmMergeTagsResponse>) : null
        )
        .then((body) => {
          if (body) setRegistered(body.registered ?? []);
        })
        .catch(() => {});
      setMessage(
        dropped > 0
          ? `Saved. ${dropped} entry${dropped === 1 ? "" : "s"} dropped by validation.`
          : "Saved."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown");
    } finally {
      setBusy(false);
    }
  }

  function addRow() {
    setRows((r) => [...r, { name: "", value: "" }]);
    setMessage(null);
  }
  function removeRow(idx: number) {
    setRows((r) => r.filter((_, i) => i !== idx));
    setMessage(null);
  }
  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    setMessage(null);
  }
  function resetForm() {
    setRows(saved);
    setError(null);
    setMessage(null);
  }

  return (
    <div className="space-y-5">
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">
            Your custom merge tags
          </h2>
          <p className="text-xs text-muted mt-1 max-w-prose">
            Register per-CSM merge tags — a name (used as{" "}
            <code className="font-mono">{"{{name}}"}</code> in a
            template) and the text it should substitute to. Shared
            outreach templates that reference the tag will render your
            copy for you and each other CSM&rsquo;s copy for them —
            handy for a Calendly / scheduling link, a signature line,
            or any snippet that&rsquo;s personalized per CSM. Tag
            names may only contain letters, numbers, and underscores,
            and can&rsquo;t collide with a built-in tag.
          </p>
        </div>

        {loading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : (
          <>
            {rows.length === 0 ? (
              <div className="text-sm text-muted italic">
                No custom tags yet. Add one to get started.
              </div>
            ) : (
              <div className="space-y-3">
                {rows.map((row, idx) => {
                  const v = rowValidity[idx];
                  return (
                    <div
                      key={idx}
                      className="rounded-md border border-border bg-canvas/50 p-3 space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex-1 space-y-1">
                          <label className="block text-[11px] font-medium text-muted uppercase tracking-wide">
                            Tag name
                          </label>
                          <div className="flex items-center gap-2">
                            <code className="text-xs text-subtle font-mono">
                              {"{{"}
                            </code>
                            <input
                              type="text"
                              value={row.name}
                              onChange={(e) =>
                                updateRow(idx, { name: e.target.value })
                              }
                              placeholder="scheduling_text"
                              maxLength={MAX_TAG_NAME_LENGTH}
                              className="flex-1 px-3 py-1.5 text-sm font-mono bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                            <code className="text-xs text-subtle font-mono">
                              {"}}"}
                            </code>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          disabled={busy}
                          className="self-end px-2.5 py-1.5 text-xs border border-border-strong rounded-md text-muted hover:bg-canvas hover:text-fg disabled:opacity-50"
                          title="Remove this tag"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[11px] font-medium text-muted uppercase tracking-wide">
                          Substitution text
                        </label>
                        <textarea
                          value={row.value}
                          onChange={(e) =>
                            updateRow(idx, { value: e.target.value })
                          }
                          placeholder="Grab a spot on my calendar: https://calendly.com/…"
                          rows={3}
                          maxLength={MAX_TAG_VALUE_LENGTH}
                          className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                        />
                        <div className="flex items-center justify-between text-[11px] text-muted">
                          <span>
                            {v.ok ? (
                              <span className="text-subtle">Looks good.</span>
                            ) : (
                              <span className="text-red-700 dark:text-red-300">
                                {v.reason}
                              </span>
                            )}
                          </span>
                          <span>
                            {row.value.length}/{MAX_TAG_VALUE_LENGTH}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || busy || anyInvalid}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
                title={
                  anyInvalid
                    ? "Fix the highlighted rows first"
                    : dirty
                      ? "Save your changes"
                      : "No changes to save"
                }
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={resetForm}
                disabled={!dirty || busy}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={addRow}
                disabled={busy || atCap}
                className="ml-auto px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
                title={
                  atCap
                    ? `Cap of ${MAX_TAGS_PER_CSM} tags per CSM reached`
                    : "Add a new tag"
                }
              >
                + Add tag
              </button>
            </div>

            {message ? (
              <div className="text-xs text-emerald-700 dark:text-emerald-300">
                {message}
              </div>
            ) : null}
            {error ? (
              <div className="text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">
            Registered by any CSM
          </h3>
          <p className="text-xs text-muted mt-1 max-w-prose">
            Every tag name currently registered by someone on the CSM
            team, and how many CSMs use it. Use the same name as your
            teammates so shared templates work for everyone — a
            template referencing{" "}
            <code className="font-mono">{"{{scheduling_text}}"}</code>{" "}
            won&rsquo;t find your value if you called it{" "}
            <code className="font-mono">{"{{calendly}}"}</code>{" "}
            instead. Values themselves stay private per CSM — this
            list only shows names.
          </p>
        </div>
        {registered.length === 0 ? (
          <div className="text-sm text-muted italic">
            Nothing registered yet. Yours will be the first!
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm">
            {registered.map((r) => (
              <li
                key={r.name}
                className="flex items-center justify-between rounded-md border border-border bg-canvas/40 px-3 py-1.5"
              >
                <code className="font-mono text-xs text-fg">
                  {`{{${r.name}}}`}
                </code>
                <span className="text-[11px] text-muted">
                  {r.used_by_csm_count} CSM
                  {r.used_by_csm_count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
