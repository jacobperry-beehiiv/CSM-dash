"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

// ─── Shared mappings loader ────────────────────────────────────────
// This editor renders MANY times per page: twice per customer-table
// row (engagement + risk) across the whole book, plus ~5 on each
// detail panel. If every instance fired its own GET on mount the
// endpoint would see 2×N requests per table render — the request
// fan-out behind the /api/settings/field-mappings load spike.
//
// The browser does NOT dedupe concurrent in-flight fetches (only
// cached responses), so we dedupe here: one shared in-flight promise
// that every instance awaits, plus a short-TTL memo of the result.
// A full-book render now costs a single round-trip. The config
// changes rarely, so the TTL staleness is a non-issue; an admin's
// edit on /settings/hubspot-fields is picked up on the next reload.
const MAPPINGS_TTL_MS = 30_000;
let mappingsMemo: { at: number; data: Record<string, FieldMapping> } | null =
  null;
let mappingsInFlight: Promise<Record<string, FieldMapping>> | null = null;

function loadFieldMappingsShared(): Promise<Record<string, FieldMapping>> {
  if (mappingsMemo && Date.now() - mappingsMemo.at < MAPPINGS_TTL_MS) {
    return Promise.resolve(mappingsMemo.data);
  }
  if (mappingsInFlight) return mappingsInFlight;
  mappingsInFlight = fetch("/api/settings/field-mappings")
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as MappingsResponse;
      const data = j.mappings ?? {};
      mappingsMemo = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      // Clear the in-flight handle regardless of outcome so a failed
      // load (which leaves the memo empty) is retried on the next
      // mount rather than being wedged behind a rejected promise.
      mappingsInFlight = null;
    });
  return mappingsInFlight;
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

  // Mappings come from the shared loader above — one round-trip per
  // page regardless of how many editors mount, instead of one GET
  // per instance.
  useEffect(() => {
    let cancelled = false;
    loadFieldMappingsShared()
      .then((mappings) => {
        if (cancelled) return;
        setMapping(mappings[fieldDef.id] ?? null);
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

  async function save(explicitValue?: string | null) {
    if (!workspaceId) return;
    setSaving(true);
    setReport(null);
    // `explicitValue` lets the compact chip picker pass the option
    // it was clicked with directly, sidestepping the `setDraft` →
    // re-render → save race. Falls back to the `draft` state for the
    // full-panel editor's Save button which does drive `draft` first.
    const rawValue =
      explicitValue !== undefined ? explicitValue : draft.trim() === "" ? null : draft;
    try {
      const r = await fetch("/api/customer-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          field_id: fieldDef.id,
          value: rawValue,
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

  if (editing && compact && fieldDef.type === "enum") {
    return (
      <CompactEnumPicker
        fieldDef={fieldDef}
        currentValue={currentValue}
        hubspotOptions={hubspotOptions}
        hubspotOptionsError={hubspotOptionsError}
        renderReadOnly={renderReadOnly}
        saving={saving}
        report={report}
        onPick={(value) => void save(value)}
        onClose={() => {
          setEditing(false);
          setReport(null);
        }}
      />
    );
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

/**
 * Compact enum picker for the customer-table cells. Instead of a
 * native `<select>` + Save/Cancel buttons, opens a popover with each
 * option rendered as the same chip (`renderReadOnly(value)`) the read-
 * only view uses — so the CSM sees "these are the risk levels I can
 * pick" in the exact visual language of the row. Clicking an option
 * saves immediately; clicking outside or hitting Esc closes without
 * saving.
 *
 * Callers must pass `renderReadOnly` for the visual to make sense —
 * a picker of plain text values would defeat the point. When the
 * chip renderer isn't available (fields with no styled chip), the
 * picker still renders the label but with a neutral pill.
 */
interface CompactEnumPickerProps {
  fieldDef: MappableDashboardField;
  currentValue: string | null | undefined;
  hubspotOptions: Array<{ label: string; value: string }> | null;
  hubspotOptionsError: string | null;
  renderReadOnly?: (value: string | null | undefined) => React.ReactNode;
  saving: boolean;
  report: { kind: "ok" | "err"; text: string } | null;
  onPick: (value: string | null) => void;
  onClose: () => void;
}

function CompactEnumPicker({
  fieldDef,
  currentValue,
  hubspotOptions,
  hubspotOptionsError,
  renderReadOnly,
  saving,
  report,
  onPick,
  onClose,
}: CompactEnumPickerProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Portal the menu to document.body with viewport-fixed positioning
  // so it escapes the customer-table cells' `overflow-hidden`. Without
  // this, longer chips like "Light Green" get clipped by the cell's
  // ~8% column width — same reason a native <select> works: the OS
  // renders its menu at the browser layer, not inside the DOM tree.
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Compute the menu position relative to the anchor's viewport rect.
  // `useLayoutEffect` runs after DOM mutation but before paint, so
  // the menu's first visible frame is already placed — no "menu flashes
  // at 0,0 for a tick" flicker.
  useLayoutEffect(() => {
    function reposition() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Clamp the left edge so a right-edge cell doesn't push the menu
      // off-screen. The menu's own width is capped by max-w below.
      const menuWidthEstimate = 224; // matches min-w-[14rem]
      const maxLeft = Math.max(
        8,
        window.innerWidth - menuWidthEstimate - 8
      );
      setMenuPos({
        top: rect.bottom + 4,
        left: Math.min(rect.left, maxLeft),
      });
    }
    reposition();
    // Reposition on scroll / resize so the menu tracks the trigger.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, []);

  // Close on outside-click. `mousedown` so a chip click inside the
  // menu doesn't race the close-on-outside handler between
  // mousedown+mouseup on slower devices. Both the anchor + the
  // portaled menu are "inside" — check both refs.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const sourcedFromHubspot = Boolean(fieldDef.hubspot_enum_property);
  const options = sourcedFromHubspot
    ? hubspotOptions ?? []
    : (fieldDef.enum_values ?? []).map((v) => ({ label: v, value: v }));
  const loading = sourcedFromHubspot && hubspotOptions === null;
  const currentLc = (currentValue ?? "").trim().toLowerCase();

  const renderOptionChip = (value: string, label: string) => {
    // Prefer the caller-supplied chip renderer so the option shows
    // the exact same style (RiskLevelChip / StatusBadge / …) as the
    // read-only cell. Fallback to a neutral pill for fields without
    // a chip renderer.
    if (renderReadOnly) return renderReadOnly(value);
    return (
      <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-full bg-surface-2 text-fg border border-border">
        {label}
      </span>
    );
  };

  const menuNode = menuPos ? (
    <div
      ref={menuRef}
      // z-[60] sits above the table row's hover state (blue-50) plus
      // any sticky headers. `whitespace-nowrap` on each option keeps
      // "Light Green" from wrapping mid-chip. min-w-[14rem] gives the
      // widest option (currently "Very High Touch" on engagement)
      // room without truncation, and max-w-xs caps super-long HubSpot
      // options from stretching across half the viewport.
      className="fixed z-[60] min-w-[14rem] max-w-xs rounded-md border border-border-strong bg-surface shadow-lg p-1.5 space-y-1"
      style={{ top: menuPos.top, left: menuPos.left }}
      role="listbox"
      onClick={(e) => e.stopPropagation()}
    >
      {loading ? (
        <div className="px-2 py-1 text-[11px] text-subtle italic">
          Loading options…
        </div>
      ) : options.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-subtle italic">
          {hubspotOptionsError
            ? `Couldn't load options: ${hubspotOptionsError.slice(0, 40)}`
            : "No options available"}
        </div>
      ) : (
        <>
          {options.map((o) => {
            const isCurrent = o.value.trim().toLowerCase() === currentLc;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isCurrent}
                disabled={saving}
                onClick={() => onPick(o.value)}
                className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-left text-xs hover:bg-canvas disabled:opacity-50 whitespace-nowrap ${
                  isCurrent ? "bg-canvas ring-1 ring-accent/40" : ""
                }`}
                title={
                  isCurrent
                    ? "Currently selected"
                    : `Set to "${o.label}" — pushes to HubSpot`
                }
              >
                {renderOptionChip(o.value, o.label)}
                {isCurrent ? (
                  <span className="ml-auto text-[10px] text-subtle">✓</span>
                ) : null}
              </button>
            );
          })}
          {currentValue ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => onPick(null)}
              className="w-full text-left px-1.5 py-1 rounded text-[11px] text-subtle italic hover:bg-canvas hover:text-fg disabled:opacity-50 border-t border-border mt-1 pt-1.5"
              title="Clear the value — pushes an empty value to HubSpot"
            >
              Clear
            </button>
          ) : null}
        </>
      )}
      {saving ? (
        <div className="px-2 py-1 text-[11px] text-subtle italic">
          Saving…
        </div>
      ) : null}
      {report?.kind === "err" ? (
        <div
          className="px-2 py-1 text-[11px] text-red-700 dark:text-red-300"
          title={report.text}
        >
          ⚠ {report.text.slice(0, 40)}
          {report.text.length > 40 ? "…" : ""}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <span
      ref={anchorRef}
      className="inline-flex items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="opacity-60">
        {renderOptionChip(currentValue ?? "", currentValue ?? "—")}
      </span>
      {mounted && menuNode ? createPortal(menuNode, document.body) : null}
    </span>
  );
}
