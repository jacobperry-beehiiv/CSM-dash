"use client";

import { CopyButton } from "./copy-button";
import { fmtNumber } from "./format";
import { CollapsibleSection } from "./collapsible-section";
import { useWorkspacePublications } from "@/lib/hooks/customer-publications-cache";

/**
 * Scrollable list of every publication under a workspace. Replaces
 * the older static FeatureBreakdown grid in the expanded customer
 * panel — readers told us they cared about the actual publication
 * list (with IDs to deep-link into Metabase / beehiiv) far more than
 * the four ambiguous "feature in use?" cards.
 *
 * Lazy-loaded via the shared `customer-publications-cache` module so
 * the AM bulk "Copy pub IDs" action reuses the same data we already
 * pulled for the expanded view (and vice versa) — same endpoint, same
 * cache, no duplicate Metabase round-trip.
 *
 * Bounded height + overflow-y so a workspace with 50 publications
 * doesn't push the rest of the detail panel off-screen.
 */

interface Props {
  workspaceId: string;
}

export function CustomerPublicationsList({ workspaceId }: Props) {
  const state = useWorkspacePublications(workspaceId);
  const rows = Array.isArray(state) ? state : null;
  const error = state instanceof Error ? state.message : null;

  const titleSuffix = rows ? ` (${rows.length})` : "";
  return (
    <CollapsibleSection
      title={`Publications${titleSuffix}`}
      // Body uses its own padding (per-state empty/loading/error/list),
      // so opt out of the wrapper's default `p-3` to avoid double pad.
      bodyClassName=""
    >
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
              className="flex items-center gap-4 px-4 py-3 hover:bg-canvas/40"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fg break-words">
                  {p.publication_name || "(unnamed)"}
                </div>
                <div className="text-xs text-muted break-words">
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
    </CollapsibleSection>
  );
}
