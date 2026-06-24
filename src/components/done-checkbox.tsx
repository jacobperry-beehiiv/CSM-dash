"use client";

/**
 * Prominent "mark done" toggle — replaces the native checkbox on
 * to-do rows. 28px button-style affordance that's hard to miss and
 * pops with a quick scale animation when flipping to done.
 *
 *   not done  →  hollow circle with a hover-reveal check (faint)
 *   done      →  emerald-filled circle with a bold white checkmark
 *
 * Animation: the `todo-done-pop` keyframe (see globals.css) runs on
 * the flip via a key change — react re-mounts the inner SVG which
 * triggers the entry animation. Reversal (done → not-done) doesn't
 * re-animate; keeps the UI quiet for accidental clicks.
 */
export function DoneCheckbox({
  done,
  onToggle,
  ariaLabel = "Mark complete",
  size = 28,
}: {
  done: boolean;
  onToggle: () => void;
  ariaLabel?: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={ariaLabel}
      onClick={onToggle}
      style={{ width: size, height: size }}
      className={`group relative flex-shrink-0 rounded-full border-2 transition-all duration-150 flex items-center justify-center ${
        done
          ? "bg-emerald-500 border-emerald-500 hover:bg-emerald-600 hover:border-emerald-600 shadow-sm"
          : "border-border-strong bg-surface hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
      }`}
    >
      {done ? (
        // Bold check that re-mounts on each done-transition (the
        // `key={...}` on the wrapping span uses a numeric trigger
        // tied to render, but the simpler approach is the
        // CSS-class animation below which fires every time `done`
        // is true on mount). Plays via the todo-done-pop keyframe.
        <svg
          viewBox="0 0 24 24"
          width="60%"
          height="60%"
          fill="none"
          stroke="white"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="todo-done-pop"
        >
          <polyline points="5 12 10 17 19 7" />
        </svg>
      ) : (
        // Hover-only hint check so the affordance reads as "click me
        // to mark done" without committing to anything.
        <svg
          viewBox="0 0 24 24"
          width="60%"
          height="60%"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-500 opacity-0 group-hover:opacity-40 transition-opacity"
        >
          <polyline points="5 12 10 17 19 7" />
        </svg>
      )}
    </button>
  );
}
