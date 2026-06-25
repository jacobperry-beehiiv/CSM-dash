"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamMascot } from "@/lib/data/team-mascots";

/**
 * /settings/team-mascots — manage the team-mascot rotation.
 *
 * Any CSM team member can upload their own pet photo + give it a
 * label ("Sherlock — Jacob's dog"). New uploads enter the rotation
 * immediately for both the header logo and the to-do celebration.
 * Anyone CSM-team can also delete entries; the page surfaces the
 * uploader's email so it's clear who added what.
 *
 * Storage: Vercel Blob (public CDN) for the image, KV for the
 * metadata row. Talks to /api/team-mascots.
 *
 * "Not configured" state: when BLOB_READ_WRITE_TOKEN isn't set in
 * the deploy env (Vercel Blob hasn't been enabled), the page shows
 * an explainer instead of the upload form.
 */

interface ApiList {
  mascots: TeamMascot[];
  blobConfigured: boolean;
}

const MAX_BYTES = 4 * 1024 * 1024;

export default function TeamMascotsPage() {
  const [mascots, setMascots] = useState<TeamMascot[] | null>(null);
  const [blobConfigured, setBlobConfigured] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/team-mascots", { cache: "no-store" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as ApiList;
      setMascots(j.mascots);
      setBlobConfigured(j.blobConfigured);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  async function upload() {
    setError(null);
    setMessage(null);
    const file = fileInputRef.current?.files?.[0] ?? null;
    if (!file) {
      setError("Pick an image first.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — max 4 MB.`
      );
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("label", label);
      const r = await fetch("/api/team-mascots", {
        method: "POST",
        body: fd,
      });
      const j = (await r.json().catch(() => ({}))) as
        | { mascot: TeamMascot }
        | { error?: string };
      if (!r.ok || !("mascot" in j)) {
        throw new Error(("error" in j && j.error) || `HTTP ${r.status}`);
      }
      setMessage(`Added ${j.mascot.label}.`);
      setLabel("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: TeamMascot) {
    if (!window.confirm(`Remove "${m.label}" from the rotation?`)) return;
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const r = await fetch(
        `/api/team-mascots?id=${encodeURIComponent(m.id)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setMessage(`Removed ${m.label}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">
            Team mascots
          </h2>
          <p className="text-xs text-muted mt-1 max-w-prose">
            Upload your pet&rsquo;s photo — the CSM team header logo
            and the to-do celebration both cycle randomly through
            this list. Anyone on the CSM team can add or remove.
          </p>
          <p className="text-xs text-muted mt-1 max-w-prose">
            <strong className="text-fg">Fallback:</strong> when the
            list is empty, the dashboard uses the two bundled
            defaults (detective dog + bee dog). Upload your first
            mascot to take over the rotation.
          </p>
        </div>

        {!blobConfigured ? (
          <div className="rounded-md border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
            <p className="font-medium">Image storage not configured.</p>
            <p className="mt-1">
              Uploads need Vercel Blob enabled on this project. In the
              Vercel dashboard: <em>Storage → Blob → Create</em>. The{" "}
              <code className="font-mono">BLOB_READ_WRITE_TOKEN</code>{" "}
              env var auto-populates; a redeploy picks it up.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-canvas p-3 space-y-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                Image file
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={busy}
                className="block text-xs text-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-accent file:text-accent-fg file:text-xs file:font-medium hover:file:bg-accent-hover"
              />
              <p className="text-[11px] text-muted">
                PNG, JPG, WEBP, or GIF. 4 MB max. Tall portrait shots
                work best — they line up cleanly with the header
                logo + the &ldquo;-folio Overview&rdquo; heading.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                Label (shown on hover + as alt text)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Sherlock — Jacob's dog"
                maxLength={120}
                disabled={busy}
                className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <button
              type="button"
              onClick={() => void upload()}
              disabled={busy}
              className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Uploading…" : "Add mascot"}
            </button>
          </div>
        )}

        {message ? (
          <div className="text-xs text-emerald-700 dark:text-emerald-300">
            {message}
          </div>
        ) : null}
        {error ? (
          <div className="text-xs text-red-700 dark:text-red-300">{error}</div>
        ) : null}
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-5">
        <h3 className="text-sm font-semibold text-fg mb-3">
          Current rotation
          {mascots ? (
            <span className="ml-2 text-[11px] font-normal text-muted">
              {mascots.length} mascot{mascots.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </h3>
        {loading ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : !mascots || mascots.length === 0 ? (
          <div className="text-xs text-muted">
            No uploaded mascots yet — the dashboard falls back to the
            bundled detective dog + bee dog.
          </div>
        ) : (
          <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {mascots.map((m) => (
              <li
                key={m.id}
                className="border border-border rounded-md overflow-hidden bg-canvas"
              >
                <div className="aspect-square bg-canvas flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={m.url}
                    alt={m.label}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="p-2 space-y-1">
                  <div
                    className="text-xs font-medium text-fg truncate"
                    title={m.label}
                  >
                    {m.label}
                  </div>
                  <div className="text-[10px] text-muted truncate">
                    {m.added_by ?? "—"} ·{" "}
                    {(m.size_bytes / 1024).toFixed(0)} KB
                  </div>
                  <button
                    type="button"
                    onClick={() => void remove(m)}
                    disabled={busy}
                    className="text-[11px] text-muted hover:text-red-700 dark:hover:text-red-300 underline disabled:opacity-50"
                  >
                    remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
