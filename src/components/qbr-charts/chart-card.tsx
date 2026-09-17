"use client";

import { forwardRef, type ReactNode } from "react";
import { ChartCanvas } from "./chart-canvas";
import { BeehiivLogo } from "@/components/beehiiv-logo";
import { beehiiv } from "@/lib/qbr-charts/colors";
import type { ChartSpec } from "@/lib/qbr-charts/types";

/**
 * Screenshot-ready wrapper around <ChartCanvas />. Holds the title +
 * subtitle, a small beehiiv badge (so screenshots are recognizably
 * branded in slide decks), the chart itself at a fixed height, and
 * the takeaway + source line at the bottom.
 *
 * Fixed width on desktop (~960px) so slide-pasted charts have
 * consistent dimensions regardless of who screenshots them.
 *
 * `headerActions` slot lets a parent inject controls into the top-
 * right of the card (e.g. the axis editor pencil) without the card
 * having to know about them. Slotted controls sit next to the
 * beehiiv badge and are hidden by the PNG-export walker via the
 * `data-qbr-hide-in-export` attribute so the exported image stays
 * clean.
 *
 * `ref` forwards the outer card element so the export flow can
 * snapshot the exact rendered chrome + chart at its 960px width.
 */
export const ChartCard = forwardRef<
  HTMLDivElement,
  { spec: ChartSpec; headerActions?: ReactNode }
>(function ChartCard({ spec, headerActions }, ref) {
  return (
    <div
      ref={ref}
      className="bg-surface border border-border rounded-xl shadow-card p-6 mx-auto"
      style={{ maxWidth: 960 }}
    >
      <header className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-fg tracking-tight">
            {spec.title}
          </h2>
          {spec.subtitle ? (
            <p className="text-sm text-muted mt-1">{spec.subtitle}</p>
          ) : null}
        </div>
        <div
          className="flex items-center gap-2 text-[11px] text-muted shrink-0"
          aria-label="beehiiv badge"
        >
          {headerActions ? (
            <div data-qbr-hide-in-export className="flex items-center">
              {headerActions}
            </div>
          ) : null}
          <BeehiivLogo className="h-4 w-4" />
          <span style={{ color: beehiiv.purple, fontWeight: 600 }}>
            beehiiv
          </span>
        </div>
      </header>

      <ChartCanvas spec={spec} />

      {spec.takeaway ? (
        <p className="mt-4 text-sm text-fg italic">{spec.takeaway}</p>
      ) : null}
      {spec.source ? (
        <p className="mt-2 text-[11px] text-subtle">{spec.source}</p>
      ) : null}
    </div>
  );
});
