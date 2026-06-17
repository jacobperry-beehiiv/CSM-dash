"use client";

import { useWorkspacePublications } from "@/lib/hooks/customer-publications-cache";

/**
 * Publication dropdown — chained off WorkspacePicker. Loads the
 * publication list for the selected workspace via the existing
 * customer-publications-cache hook (already used by the expanded
 * company view + AM Copy Pub IDs). That gives us automatic dedup +
 * tab-session cache for free.
 *
 * Optional input: an empty value means "no publication filter," which
 * the chart-spec endpoint treats as workspace-wide. The "All
 * publications" option below is the sentinel for that.
 */
export function PublicationPicker({
  workspaceId,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string;
  value: string;
  onChange: (publicationId: string) => void;
  disabled?: boolean;
}) {
  const result = useWorkspacePublications(workspaceId);

  let hint: string | null = null;
  let options: { id: string; label: string }[] = [];

  if (!workspaceId) {
    hint = "Select a workspace first.";
  } else if (result === null) {
    hint = "Loading publications…";
  } else if (result instanceof Error) {
    hint = `Failed to load publications: ${result.message}`;
  } else {
    options = result.map((p) => ({
      id: p.publication_id,
      label: p.subscribers != null
        ? `${p.publication_name} (${p.subscribers.toLocaleString()} subs)`
        : p.publication_name,
    }));
  }

  return (
    <div>
      <span className="text-[11px] text-muted">Publication</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !workspaceId || options.length === 0}
        className="mt-1 w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg disabled:opacity-50"
      >
        <option value="">All publications</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="text-[10px] text-subtle">{hint}</span>
      ) : (
        <span className="text-[10px] text-subtle">
          Leave on “All publications” for workspace-wide charts.
        </span>
      )}
    </div>
  );
}
