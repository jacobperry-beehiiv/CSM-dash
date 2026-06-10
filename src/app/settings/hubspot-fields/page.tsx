"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  FieldMapping,
  FieldMappingDirection,
  MappableDashboardField,
} from "@/lib/data/field-mappings";

/**
 * /settings/hubspot-fields — admin UI for mapping dashboard fields to
 * HubSpot company properties.
 *
 * For each dashboard field (CSM, cadence, lifecycle stage, notes) the
 * row shows:
 *
 *   - The field's label + description + where it's edited
 *   - A HubSpot property picker (loaded from /api/hubspot/properties)
 *   - A direction picker (off / pull / push / both)
 *   - Audit info (who set the mapping, when)
 *
 * V1 stores the configuration only. The actual sync behavior is
 * wired in a follow-up so the config + UI can be reviewed
 * independently. The page banner spells that out so a CSM looking
 * for a "Sync now" button knows it isn't here yet.
 */

interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  groupName?: string;
  hubspotDefined?: boolean;
  description?: string;
}

interface DraftMapping {
  hubspot_property: string;
  direction: FieldMappingDirection;
  updated_at?: string;
  updated_by?: string;
}

export default function HubspotFieldsPage() {
  const [available, setAvailable] = useState<MappableDashboardField[]>([]);
  const [mappings, setMappings] = useState<Record<string, DraftMapping>>({});
  const [properties, setProperties] = useState<HubspotProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [propsLoading, setPropsLoading] = useState(true);
  const [propsError, setPropsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Optimistic dirty tracking so the Save button only enables when
  // something actually changed since the last load.
  const [originalSnapshot, setOriginalSnapshot] = useState<string>("");

  // Initial load — current mappings + the canonical dashboard field
  // list (so unmapped fields still render a row).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/settings/field-mappings")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as {
          mappings: Record<string, FieldMapping>;
          available_fields: MappableDashboardField[];
        };
      })
      .then((j) => {
        if (cancelled) return;
        setAvailable(j.available_fields);
        // Seed a draft for every dashboard field — fields without
        // a stored mapping start with empty property + "off"
        // direction. This lets the UI render every row uniformly.
        const seeded: Record<string, DraftMapping> = {};
        for (const f of j.available_fields) {
          const stored = j.mappings[f.id];
          seeded[f.id] = stored
            ? { ...stored }
            : { hubspot_property: "", direction: "off" };
        }
        setMappings(seeded);
        setOriginalSnapshot(JSON.stringify(seeded));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setReport({
          kind: "err",
          text: `Couldn't load mappings: ${e instanceof Error ? e.message : "unknown"}`,
        });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // HubSpot properties — single fetch, used by every row's picker.
  useEffect(() => {
    let cancelled = false;
    setPropsLoading(true);
    fetch("/api/hubspot/properties")
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as { properties: HubspotProperty[] };
      })
      .then((j) => {
        if (cancelled) return;
        setProperties(j.properties);
        setPropsLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setPropsError(e instanceof Error ? e.message : "unknown");
        setPropsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(mappings) !== originalSnapshot,
    [mappings, originalSnapshot]
  );

  function patchMapping(fieldId: string, patch: Partial<DraftMapping>) {
    setMappings((prev) => ({
      ...prev,
      [fieldId]: { ...prev[fieldId], ...patch },
    }));
  }

  async function save() {
    setSaving(true);
    setReport(null);
    try {
      // Send only mappings with a non-empty property — entries with
      // direction "off" still persist so the audit row sticks around,
      // but a totally-empty row gets dropped at the server.
      const toSend: Record<string, DraftMapping> = {};
      for (const [id, m] of Object.entries(mappings)) {
        if (m.hubspot_property.trim()) toSend[id] = m;
      }
      const r = await fetch("/api/settings/field-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings: toSend }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as {
        mappings: Record<string, FieldMapping>;
      };
      // Re-seed from the response so audit stamps reflect what the
      // server actually persisted (timestamps + viewer email).
      const next: Record<string, DraftMapping> = {};
      for (const f of available) {
        next[f.id] = j.mappings[f.id]
          ? { ...j.mappings[f.id] }
          : { hubspot_property: "", direction: "off" };
      }
      setMappings(next);
      setOriginalSnapshot(JSON.stringify(next));
      setReport({ kind: "ok", text: "Saved." });
      window.setTimeout(() => setReport(null), 4000);
    } catch (e) {
      setReport({
        kind: "err",
        text: `Save failed: ${e instanceof Error ? e.message : "unknown"}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-fg">HubSpot field mappings</h2>
        <p className="text-sm text-muted mt-1">
          Map dashboard fields to HubSpot company properties + pick a
          sync direction. Mappings persist immediately; the actual{" "}
          <strong>sync behavior is wired in a follow-up</strong> — for
          now this page configures intent, and Pull / Push / Both
          rules will start firing once the underlying sync paths land.
        </p>
      </header>

      <div className="rounded-md border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 p-3 text-sm text-blue-900 dark:text-blue-200">
        <strong>Sync direction reference:</strong>
        <ul className="mt-1 list-disc list-inside space-y-0.5 text-[13px]">
          <li>
            <code className="font-mono">Pull</code> — HubSpot is the
            source of truth. Sync.ts copies the property value onto
            the Customer record each night.
          </li>
          <li>
            <code className="font-mono">Push</code> — Dashboard is the
            source of truth. Edits propagate to HubSpot immediately.
          </li>
          <li>
            <code className="font-mono">Both</code> — Bidirectional.
            Last-write-wins; no merge logic.
          </li>
          <li>
            <code className="font-mono">Off</code> — Mapping persists
            for reference but no data flows.
          </li>
        </ul>
      </div>

      {propsError ? (
        <div className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200">
          Couldn&apos;t load HubSpot properties:{" "}
          <code className="font-mono">{propsError}</code>. Mappings can still be edited but the dropdown won&apos;t show suggestions.
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <div className="rounded-xl border border-border bg-surface shadow-card divide-y divide-border">
          {available.map((field) => {
            const m = mappings[field.id] ?? {
              hubspot_property: "",
              direction: "off" as FieldMappingDirection,
            };
            return (
              <div key={field.id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium text-fg">{field.label}</h3>
                    <p className="text-[13px] text-muted mt-0.5">
                      {field.description}
                    </p>
                    <p className="text-[11px] text-subtle mt-1">
                      <span className="font-mono">{field.id}</span>
                      {" · "}
                      <span>{field.type}</span>
                      {" · "}
                      <span>Edited in: {field.edited_in}</span>
                    </p>
                  </div>
                  {m.updated_at ? (
                    <span
                      className="text-[11px] text-subtle text-right whitespace-nowrap"
                      title={`Last updated by ${m.updated_by ?? "unknown"} at ${m.updated_at}`}
                    >
                      Updated{" "}
                      {new Date(m.updated_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <label className="text-xs text-muted">HubSpot property</label>
                  <select
                    value={m.hubspot_property}
                    onChange={(e) =>
                      patchMapping(field.id, {
                        hubspot_property: e.target.value,
                      })
                    }
                    disabled={propsLoading}
                    className="flex-1 min-w-[200px] px-2 py-1 text-sm border border-border-strong rounded-md bg-surface font-mono"
                  >
                    <option value="">— None —</option>
                    {/* Preserve the configured value even if it's not
                     *  in the live properties response (e.g. property
                     *  was renamed in HubSpot). Lets the admin see
                     *  what's stored and fix it. */}
                    {m.hubspot_property &&
                    !properties.some(
                      (p) => p.name === m.hubspot_property
                    ) ? (
                      <option value={m.hubspot_property}>
                        {m.hubspot_property} (not in HubSpot schema)
                      </option>
                    ) : null}
                    {properties.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.label} — {p.name} ({p.type})
                      </option>
                    ))}
                  </select>
                  <label className="text-xs text-muted ml-2">Direction</label>
                  <select
                    value={m.direction}
                    onChange={(e) =>
                      patchMapping(field.id, {
                        direction: e.target.value as FieldMappingDirection,
                      })
                    }
                    className="px-2 py-1 text-sm border border-border-strong rounded-md bg-surface"
                  >
                    <option value="off">Off</option>
                    <option value="pull">Pull (HubSpot → dash)</option>
                    <option value="push">Push (dash → HubSpot)</option>
                    <option value="both">Both</option>
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save mappings"}
        </button>
        {report ? (
          <span
            className={`text-sm ${
              report.kind === "ok"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-red-700 dark:text-red-300"
            }`}
          >
            {report.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
