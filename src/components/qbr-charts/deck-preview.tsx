"use client";

import { useEffect } from "react";
import { ChartCard } from "./chart-card";
import type { ChartSpec } from "@/lib/qbr-charts/types";

/**
 * Slide-deck preview — design-agnostic framework. Renders the selected
 * ChartSpecs as a vertical stack of "slides," one per ChartSpec, with
 * a print stylesheet that makes each slide its own page on save-as-
 * PDF. The actual visual design for slides ships in a follow-up; this
 * keeps the data model + plumbing in place so the design swap is just
 * the inside of <DeckSlide>.
 *
 * What's done:
 *   - Full-screen overlay with a fixed top toolbar (close + print +
 *     slide count).
 *   - One DeckSlide per included ChartSpec.
 *   - Per-slide remove button (hidden in print).
 *   - window.print() integration — print CSS hides the rest of the
 *     page and forces each slide onto its own page.
 *
 * Explicit follow-ups:
 *   - PPTX export (needs pptxgenjs + per-slide layout).
 *   - Drag-to-reorder slides.
 *   - Editable takeaway per slide.
 *   - Shareable deck URL (needs KV persistence).
 *   - Cover slide / TOC.
 */
export interface DeckSlide {
  questionId: number;
  spec: ChartSpec;
}

export function DeckPreview({
  slides,
  onClose,
  onRemoveSlide,
}: {
  slides: DeckSlide[];
  onClose: () => void;
  onRemoveSlide: (questionId: number) => void;
}) {
  // Lock body scroll while the overlay is mounted so the underlying
  // page doesn't bleed through on small screens.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePrint = () => window.print();

  return (
    <>
      {/* Print CSS: hide everything outside the deck, give each slide
          its own page, and strip overlay chrome. Inline so the
          framework is self-contained — when the real design lands,
          tweak here. dangerouslySetInnerHTML keeps it as a plain
          stylesheet (no styled-jsx dependency). */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media print {
              body > *:not(.qbr-deck-print-root) {
                display: none !important;
              }
              .qbr-deck-print-root {
                position: static !important;
                background: white !important;
              }
              .qbr-deck-toolbar,
              .qbr-deck-remove {
                display: none !important;
              }
              .qbr-deck-slide {
                break-after: page;
                page-break-after: always;
                box-shadow: none !important;
                border: none !important;
              }
            }
          `,
        }}
      />

      <div
        className="qbr-deck-print-root fixed inset-0 z-50 bg-canvas overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="QBR slide-deck preview"
      >
        <div className="qbr-deck-toolbar sticky top-0 z-10 bg-surface border-b border-border shadow-card">
          <div className="max-w-[1024px] mx-auto px-4 py-3 flex items-center gap-3">
            <div>
              <h2 className="text-base font-semibold text-fg">
                Deck preview
              </h2>
              <p className="text-[11px] text-muted">
                {slides.length} {slides.length === 1 ? "slide" : "slides"} ·
                framework only — full design coming
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrint}
                disabled={slides.length === 0}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                Print / save as PDF
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-surface text-fg hover:bg-canvas/40"
              >
                Close
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-[1024px] mx-auto p-6 space-y-6">
          {slides.length === 0 ? (
            <div className="text-center text-sm text-muted py-12">
              No slides selected. Close this and add some charts to the
              deck from the grid.
            </div>
          ) : (
            slides.map((s, i) => (
              <SlideFrame
                key={s.questionId}
                slide={s}
                index={i}
                total={slides.length}
                onRemove={() => onRemoveSlide(s.questionId)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

/**
 * One slide. Minimal layout — title + ChartCard + footer. The
 * intentional shape: everything that's visual lives inside this
 * component, so the design pass replaces just this. The data model
 * (slides array) and the surrounding chrome (toolbar, print, key
 * handling) stay untouched.
 */
function SlideFrame({
  slide,
  index,
  total,
  onRemove,
}: {
  slide: DeckSlide;
  index: number;
  total: number;
  onRemove: () => void;
}) {
  return (
    <article className="qbr-deck-slide relative bg-surface border border-border rounded-xl shadow-card overflow-hidden">
      <button
        type="button"
        onClick={onRemove}
        className="qbr-deck-remove absolute top-3 right-3 text-[11px] text-muted hover:text-fg px-2 py-1 rounded border border-border bg-surface"
        aria-label="Remove slide from deck"
      >
        Remove
      </button>
      <div className="px-6 pt-5 pb-2">
        <div className="text-[11px] uppercase tracking-wide text-muted">
          Slide {index + 1} of {total}
        </div>
      </div>
      <div className="px-6 pb-6">
        <ChartCard spec={slide.spec} />
      </div>
    </article>
  );
}
