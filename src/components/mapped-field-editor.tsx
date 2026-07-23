"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  FieldMapping,
  MappableDashboardField,
} from "@/lib/data/field-mappings-types";

/**
 * Inline editor for a mapped Customer field on the detail panel.
 * Renders read-only when the field has no mapping or the mapping
 * direction is "off" / "pull" — pull-only means HubSpot is canonical
 * and the dashboard shouldn't let the CSM diverge from it.
 *
 * When direction is "push" or "both", renders an edit affordance:
 *   - enum field → <select> with enum_values
 *   - rich_text  → <textarea>
 *   - string     → <input type="text">
 *
 * On save: POST /api/customer-fields → writes to the
 * customer-overrides KV + (if direction permits) PATCHes the mapped
 * HubSpot property. router.refresh() re-renders the panel against
 * the new value.
 *
 * Mappings are loaded once per mount (single GET to
 * /api/settings/field-mappings shared across all editors on the
 * same panel render via React's automatic request dedupe in dev /
 * the browser's HTTP cache in prod).
 */

interface Props {
  fieldDef: MappableDashboardField;
  /** Current value to display when not in edit mode. Comes from the
   *  Customer record (already with overrides applied). */
  currentValue: string | null | undefined;
  workspaceId: string | null | undefined;
  /** Optional renderer for the read-only display. Defaults to a
   *  plain `{value ?? "—"}` span. Lets callers (RiskLevelChip,
   *  StatusBadge) keep their existing chip styling. */
  renderReadOnly?: (value: string | null | undefined) => React.ReactNode;
  /**
   * Compact mode for narrow contexts (customer-table cells) — hides
   * the "✎ Edit" text button and makes the read-only chip itself
   * clickable to open the editor. The chip stays visually identical
   * to the plain read-only render; a tooltip explains the affordance
   * so first-time users aren't confused about the click behavior.
   * Save / Cancel / status text still render the same way, so the
   * editing UX after the click is unchanged.
   */
  compact?: boolean;
}

interface MappingsResponse {
  mappings: Record<string, FieldMapping>;
}

export function MappedFieldEditor({
  fieldDef,
  currentValue,
  workspaceId,
  renderReadOnly,
  compact = false,
}: Props) {
  const router = useRouter();
  const [mapping, setMapping] = useState<FieldMapping | null>(null);
  const [mappingsLoaded, setMappingsLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(currentValue ?? "");
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  // HubSpot-sourced enum options, when the field def declares one.
  // Loaded lazily on first edit-open so the panel render doesn't block
  // on the property-options endpoint for every editor on the page.
  const [hubspotOptions, setHubspotOptions] = useState<
    Array<{ label: string; value: string }> | null
  >(null);
  const [hubspotOptionsError, setHubspotOptionsError] = useState<string | null>(
    null
  );

  // Single fetch per mount. The dashboard renders this editor inline
  // alongside ~5 other fields on the customer detail panel — each
  // editor fires its own GET, but the browser dedupes identical
  // GETs and Next.js's force-dynamic doesn't add cache-busting
  // params, so in practice this becomes one real network round-trip
  // per panel open.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/field-mappings")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as MappingsResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setMapping(j.mappings[fieldDef.id] ?? null);
        setMappingsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setMappingsLoaded(true); // fail open — render read-only
      });
    return () => {
      cancelled = true;
    };
  }, [fieldDef.id]);

  // Reset draft when the read-through value changes (e.g., a sibling
  // edit triggered router.refresh()).
  useEffect(() => {
    if (!editing) setDraft(currentValue ?? "");
  }, [currentValue, editing]);

  // Fetch HubSpot enum options the first time the user opens the
  // editor (and only when the field declares hubspot_enum_property).
  // Deliberately lazy: most editors on the panel never get opened, so
  // we shouldn't fire one fetch per editor at mount.
  useEffect(() => {
    if (!editing) return;
    if (!fieldDef.hubspot_enum_property) return;
    if (hubspotOptions !== null) return;
    let cancelled = false;
    const params = new URLSearchParams({
      object: fieldDef.hubspot_enum_object ?? "companies",
      property: fieldDef.hubspot_enum_property,
    });
    fetch(`/api/hubspot/property-options?${params.toString()}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as {
          options?: Array<{ label: string; value: string }>;
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok || !Array.isArray(j.options)) {
          setHubspotOptionsError(j.error ?? `HTTP ${r.status}`);
          setHubspotOptions([]);
          return;
        }
        setHubspotOptions(j.options.map((o) => ({ label: o.label, value: o.value })));
      })
      .catch((e) => {
        if (cancelled) return;
        setHubspotOptionsError(
          e instanceof Error ? e.message : "Failed to load options"
        );
        setHubspotOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    editing,
    fieldDef.hubspot_enum_property,
    fieldDef.hubspot_enum_object,
    hubspotOptions,
  ]);

  const direction = mapping?.direction ?? "off";
  const editable =
    mappingsLoaded &&
    (direction === "push" || direction === "both") &&
    Boolean(workspaceId);

  /**
   * Normalize the raw value for display. HubSpot occasionally
   * returns booleans (false) or empty strings on text-typed
   * properties — without coercion those render literally as "false"
   * or as an invisible empty span, both of which look like a bug
   * to the user.
   *
   * Rule: any non-string value, or an empty/whitespace-only string,
   * resolves to null and the read-only view shows "—". Falls
   * through to the caller-supplied renderReadOnly() (e.g.
   * RiskLevelChip) when present, so chip styles aren't lost.
   */
  function normalizeForDisplay(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function renderValue() {
    const display = normalizeForDisplay(currentValue);
    if (renderReadOnly) return renderReadOnly(display);
    return (
      <span className={display ? "text-fg" : "text-subtle italic"}>
        {display ?? "—"}
      </span>
    );
  }

  async function save() {
    if (!workspaceId) return;
    setSaving(true);
    setReport(null);
    try {
      const r = await fetch("/api/customer-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          field_id: fieldDef.id,
          value: draft.trim() === "" ? null : draft,
        }),
      });
      const json = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        hubspot_pushed?: boolean;
        hubspot_error?: string;
        error?: string;
      };
      if (!r.ok && !json.ok) {
        throw new Error(json.error ?? json.hubspot_error ?? `HTTP ${r.status}`);
      }
      // Mixed-success: KV landed, HubSpot push didn't. Surface as a
      // warning rather than success so the CSM knows the change
      // hasn't fully propagated.
      if (json.hubspot_error) {
        setReport({ kind: "err", text: json.hubspot_error });
      } else {
        setReport({
          kind: "ok",
          text: json.hubspot_pushed
            ? "Saved — pushed to HubSpot."
            : "Saved.",
        });
        setEditing(false);
        // Clear the success toast after a beat. Errors stay until
        // the user retries or dismisses.
        window.setTimeout(() => setReport(null), 4000);
      }
      router.refresh();
    } catch (e) {
      setReport({
        kind: "err",
        text: e instanceof Error ? e.message : "Save failed",
      });
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div
        className="space-y-1"
        onClick={compact ? (e) => e.stopPropagation() : undefined}
      >
        {fieldDef.type === "enum" ? (
          (() => {
            // Pick the option source: HubSpot-fetched options win
            // when the field declares one; static enum_values are
            // the fallback for fields where the dashboard owns the
            // taxonomy (risk_level, etc.).
            const sourcedFromHubspot = Boolean(fieldDef.hubspot_enum_property);
            const options = sourcedFromHubspot
              ? hubspotOptions ?? []
              : (fieldDef.enum_values ?? []).map((v) => ({ label: v, value: v }));
            const loading = sourcedFromHubspot && hubspotOptions === null;
            // If the persisted value isn't in the option list (e.g.
            // HubSpot renamed an option mid-flight), still render it
            // as the selected entry so the user doesn't see a
            // mismatched "— None —" placeholder for a value that
            // actually exists.
            const draftInOptions = options.some((o) => o.value === draft);
            return (
              <>
                <select
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={saving || loading}
                  className="px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
                >
                  <option value="">— None —</option>
                  {!draftInOptions && draft ? (
                    <option value={draft}>{draft} (legacy)</option>
                  ) : null}
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {loading ? (
                  <span className="ml-2 text-[11px] text-subtle">
                    Loading options from HubSpot…
                  </span>
                ) : null}
                {hubspotOptionsError ? (
                  <span
                    className="ml-2 text-[11px] text-amber-700 dark:text-amber-300"
                    title={hubspotOptionsError}
                  >
                    ⚠ Couldn&rsquo;t load HubSpot options ({hubspotOptionsError.slice(0, 40)}…)
                  </span>
                ) : null}
              </>
            );
          })()
        ) : fieldDef.type === "rich_text" ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            rows={3}
            className="w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
          />
        ) : (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            className="w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-2 py-0.5 text-xs bg-accent text-accent-fg rounded hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(currentValue ?? "");
              setReport(null);
            }}
            disabled={saving}
            className="px-2 py-0.5 text-xs border border-border-strong rounded hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          {direction === "both" || direction === "push" ? (
            <span
              className="text-[11px] text-subtle"
              title={`This field maps to HubSpot property "${mapping?.hubspot_property}" with direction "${direction}". Saving will write to HubSpot too.`}
            >
              ↗ Pushes to HubSpot
            </span>
          ) : null}
        </div>
        {report ? (
          <p
            className={`text-[11px] ${
              report.kind === "err"
                ? "text-red-700 dark:text-red-300"
                : "text-emerald-700 dark:text-emerald-300"
            }`}
          >
            {report.text}
          </p>
        ) : null}
      </div>
    );
  }

  // Rich-text fields render the value in a block — Edit goes on
  // its own line below so it doesn't trail off the end of a
  // wrapped paragraph (where it gets lost in long copy). Short
  // fields (string + enum) keep the inline-flex layout so Edit
  // sits next to the value chip.
  const isBlockField = fieldDef.type === "rich_text";
  const editButton = editable ? (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-[11px] text-accent hover:underline"
      title={`Edit — bound to HubSpot property "${mapping?.hubspot_property}" with direction "${direction}".`}
    >
      ✎ Edit
    </button>
  ) : null;
  const reportNode =
    report?.kind === "ok" ? (
      <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
        {report.text}
      </span>
    ) : report?.kind === "err" ? (
      <span
        className="text-[11px] text-red-700 dark:text-red-300"
        title={report.text}
      >
        ⚠ {report.text.slice(0, 60)}
        {report.text.length > 60 ? "…" : ""}
      </span>
    ) : null;

  // Compact mode: hide the "✎ Edit" text and make the chip itself the
  // affordance. Used in narrow customer-table cells (engagement + risk)
  // where a separate Edit link would push the chip out of its column.
  //
  // `stopPropagation` on every interaction is deliberate: the compact
  // editor typically nests inside a click-to-expand row (customer-table
  // rows use <tr onClick={toggleExpanded}>). Without stopping the
  // click, opening the picker would ALSO expand the company profile —
  // exactly the "have to expand first" friction the CSMs asked to lose.
  // The wrapper span captures bubbling from the select + Save/Cancel
  // buttons rendered above in the `editing` branch, too.
  //
  // Falls back to the plain read-only chip when the field isn't
  // editable (no push mapping / no workspace), so pull-only fields
  // still render cleanly with no misleading click affordance.
  if (compact) {
    if (!editable) {
      return <span className="inline-flex items-center">{renderValue()}</span>;
    }
    return (
      <span
        className="inline-flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center rounded-sm hover:ring-1 hover:ring-accent/50 focus:outline-none focus:ring-2 focus:ring-accent transition"
          title={`Click to edit — pushes to HubSpot property "${mapping?.hubspot_property}"`}
        >
          {renderValue()}
        </button>
        {reportNode}
      </span>
    );
  }

  if (isBlockField) {
    return (
      <div className="space-y-1">
        <div className="text-fg break-words whitespace-pre-wrap leading-relaxed">
          {renderValue()}
        </div>
        {editButton || reportNode ? (
          <div className="flex items-center gap-2">
            {editButton}
            {reportNode}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5">
      {renderValue()}
      {editButton}
      {reportNode}
    </div>
  );
}
