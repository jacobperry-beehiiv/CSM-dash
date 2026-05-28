"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "./copy-button";
import { fmtNumber } from "./format";

/**
 * Scrollable list of every publication under a workspace. Replaces
 * the older static FeatureBreakdown grid in the expanded customer
 * panel — readers told us they cared about the actual publication
 * list (with IDs to deep-link into Metabase / beehiiv) far more than
 * the four ambiguous "feature in use?" cards.
 *
 * Lazy-loaded on mount via /api/customers/[workspace_id]/publications.
 * Bounded height + overflow-y so a workspace with 50 publications
 * doesn't push the rest of the detail panel off-screen.
 */

interface PublicationRow {
  publication_id: string;
  publication_name: string;
  subscribers: number | null;
}

interface Props {
  workspaceId: string;
}

export function CustomerPublicationsList({ workspaceId }: Props) {
  const [rows, setRows] = useState<PublicationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetch(`/api/customers/${encodeURIComponent(workspaceId)}/publications`)
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        const j = (await r.json()) as { publications: PublicationRow[] };
        if (cancelled) return;
        setRows(j.publications);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return (
    <section className="bg-surface rounded-md border border-border">
      <header className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">
          Publications{" "}
          {rows ? (
            <span className="text-xs text-muted font-normal">
              ({rows.length})
            </span>
          ) : null}
        </h3>
      </header>

      {error ? (
        <div className="p-3 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10">
          Publications fetch failed: {error}
        </div>
      ) : rows === null ? (
        <div className="p-3 text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-3 text-sm text-muted">
          No publications found under this workspace.
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto divide-y divide-border">
          {rows.map((p) => (
            <li
              key={p.publication_id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-canvas/40"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fg truncate">
                  {p.publication_name || "(unnamed)"}
                </div>
                <div className="text-xs text-muted truncate">
                  {fmtNumber(p.subscribers ?? 0)} subscribers
                </div>
              </div>
              <CopyButton
                value={p.publication_id}
                label={`Copy publication ID ${p.publication_id}`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
