"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";
import { RenewalPanel } from "./renewal-panel";
import { RenewalCalendarPanel } from "./renewal-calendar-panel";

/**
 * Wraps the two renewal surfaces (list + calendar) behind a small
 * sub-tab bar so they live nested inside one top-level "Renewals"
 * tab. Legacy URLs (`?tab=renewal-calendar`) get redirected to
 * `?tab=renewals&view=calendar` at the page level; this component
 * itself just switches based on the `initialView` prop and its own
 * local state.
 */

interface Props {
  customers: Customer[];
  csms: string[];
  showTeamRollup: boolean;
  initialView: "list" | "calendar";
}

export function RenewalsWithCalendar({
  customers,
  csms,
  showTeamRollup,
  initialView,
}: Props) {
  const [view, setView] = useState<"list" | "calendar">(initialView);

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Renewals view"
        className="inline-flex rounded-lg border border-border-strong overflow-hidden"
      >
        {(
          [
            { key: "list" as const, label: "Renewals" },
            { key: "calendar" as const, label: "Calendar" },
          ] as const
        ).map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(t.key)}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-accent text-accent-fg"
                  : "bg-surface text-muted hover:text-fg hover:bg-canvas"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {view === "list" ? (
        <RenewalPanel
          customers={customers}
          csms={csms}
          showTeamRollup={showTeamRollup}
        />
      ) : (
        <RenewalCalendarPanel customers={customers} csms={csms} />
      )}
    </div>
  );
}
