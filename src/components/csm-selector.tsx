"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useViewerEmail } from "@/lib/auth-client";

interface Props {
  csms: string[];
}

/**
 * Dropdown that drives the page's `?csm=` URL param. Three values
 * are meaningful:
 *
 *   • absent      — first load. Server defaults to the viewer's own
 *                   CSM handle (if they're in the book). The
 *                   dropdown reflects that auto-scope by displaying
 *                   the viewer's handle as the selected option, so
 *                   what's selected always matches what's filtered.
 *   • "all"       — explicit "show everyone". User picks this from
 *                   the dropdown; we write `?csm=all` so the page
 *                   knows to skip the auto-scope.
 *   • "Foo_Bar"   — a specific CSM. User picks from the dropdown
 *                   OR a deep link includes it.
 *
 * The viewer's CSM handle comes from /api/me/csm — a cheap lookup
 * that walks the customer book for a row owned by the viewer's
 * email. Fetched once on mount; null when the viewer isn't a CSM
 * (admin / ex-employee), in which case the dropdown defaults to
 * "All CSMs".
 */
export function CsmSelector({ csms }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const viewerEmail = useViewerEmail();
  const rawParam = params.get("csm");
  const [myCsm, setMyCsm] = useState<string | null>(null);

  // Resolve the viewer's own CSM handle once per signed-in session.
  // The result feeds the dropdown's "auto-selected" state when the
  // URL doesn't carry an explicit `?csm=` value.
  useEffect(() => {
    if (!viewerEmail) {
      setMyCsm(null);
      return;
    }
    let cancelled = false;
    fetch("/api/me/csm")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setMyCsm((j as { csm?: string | null })?.csm ?? null);
      })
      .catch(() => {
        if (!cancelled) setMyCsm(null);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerEmail]);

  /** What option should be highlighted as "currently selected"? */
  const effective = (() => {
    if (rawParam === "all") return "all";
    if (rawParam) return rawParam;
    // No param in the URL — page is server-rendering against the
    // auto-default. Mirror that here.
    return myCsm ?? "all";
  })();

  function set(value: string) {
    const next = new URLSearchParams(params.toString());
    // Always write an explicit value to the URL so the server-side
    // resolution doesn't reapply the auto-default once the user
    // makes a choice. "all" is the explicit-everyone sentinel.
    next.set("csm", value || "all");
    const href = `${pathname}?${next.toString()}`;
    router.replace(href, { scroll: false });
    router.refresh();
  }

  return (
    <select
      value={effective}
      onChange={(e) => set(e.target.value)}
      className="px-2 py-1 border border-border-strong rounded-md text-sm bg-surface"
    >
      <option value="all">All CSMs</option>
      {csms.map((c) => (
        <option key={c} value={c}>
          {c.replace(/_/g, " ")}
          {c === myCsm ? " (you)" : ""}
        </option>
      ))}
    </select>
  );
}
