"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface CompanyOption {
  workspace_id: string;
  name: string;
}

interface Props {
  companies: CompanyOption[];
  /** Selected workspace_id, "" = none — same empty-value convention a
   *  plain <select> would use. */
  value: string;
  onChange: (workspaceId: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
}

/**
 * Type-to-filter company picker. A plain <select> gets unwieldy once
 * a CSM's book passes the ~70 accounts most have — this is the same
 * data (playbookCompanies, already loaded once server-side; no
 * network call here), just filtered client-side as the CSM types,
 * case-insensitive substring match against the company name.
 *
 * The input always shows either the current search text or (when not
 * actively editing) the selected company's name — never a value the
 * composer hasn't actually committed. Typing over an existing
 * selection immediately clears it via onChange("") so the displayed
 * text can never drift out of sync with what would actually submit;
 * a real selection only happens by clicking an option or pressing
 * Enter on the highlighted one. Blurring (click elsewhere, or Tab)
 * without picking anything reverts the text back to the current
 * selection, same as abandoning an edit.
 */
export function CompanySearchSelect({
  companies,
  value,
  onChange,
  placeholder = "No company",
  className = "",
  title,
}: Props) {
  const selected = companies.find((c) => c.workspace_id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the displayed text in sync when the selection changes from
  // OUTSIDE this component (e.g. the composer resets after Add).
  useEffect(() => {
    setQuery(selected?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((c) => c.name.toLowerCase().includes(q));
  }, [companies, query]);

  useEffect(() => {
    setHighlighted(0);
  }, [filtered.length, open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selected?.name ?? "");
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, selected]);

  function selectCompany(c: CompanyOption | null) {
    onChange(c?.workspace_id ?? "");
    setQuery(c?.name ?? "");
    setOpen(false);
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (value) onChange("");
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Deferred so a click on an option — which dodges blur via
          // onMouseDown+preventDefault below — resolves first.
          setTimeout(() => {
            setOpen(false);
            setQuery(selected?.name ?? "");
          }, 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlighted((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlighted((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && filtered[highlighted]) selectCompany(filtered[highlighted]);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery(selected?.name ?? "");
          }
        }}
        placeholder={placeholder}
        title={title}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="w-full px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
      />
      {open && filtered.length > 0 ? (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-surface border border-border-strong rounded-md shadow-card">
          {filtered.map((c, i) => (
            <li key={c.workspace_id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectCompany(c)}
                className={`w-full text-left px-2 py-1 text-xs truncate ${
                  i === highlighted ? "bg-accent text-accent-fg" : "text-fg hover:bg-canvas"
                }`}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open && query.trim() && filtered.length === 0 ? (
        <div className="absolute z-20 mt-1 w-full bg-surface border border-border-strong rounded-md shadow-card px-2 py-1.5 text-xs text-muted">
          No matches
        </div>
      ) : null}
    </div>
  );
}
