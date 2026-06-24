"use client";

import { useEffect, useRef, useState } from "react";
import { DogIcon } from "./dog-icon";

/**
 * One-shot "you finished a to-do" animation overlay.
 *
 * Usage: render alongside the to-do row content with `play` flipped
 * true when the user marks the row complete. The component manages
 * its own play state internally (auto-clears after the animation
 * finishes) and calls `onDone` when the sweep ends so the parent can
 * proceed with whatever post-completion state change.
 *
 * Visuals:
 *   - A colorful gradient bar sweeps L→R across the row.
 *   - The dog icon rides the leading edge of the bar.
 *   - A randomly-picked celebration word ("Yay!", "Amazing!", …)
 *     pops in behind the dog.
 *
 * Performance: pure CSS transforms + opacity (compositor-only
 * animations), no layout thrash. Doesn't block clicks on the
 * underlying row — `pointer-events: none` on the overlay.
 */

const CELEBRATION_WORDS = [
  "Yay!",
  "Amazing!",
  "You're incredible",
  "Nice work",
  "Boom!",
  "Crushing it",
  "Big day",
  "Hero",
  "Get it done",
  "Magic",
  "Pawsome!",
  "Top dog",
  "Done & dusted",
  "Way to go",
] as const;

function pickWord(): string {
  return CELEBRATION_WORDS[
    Math.floor(Math.random() * CELEBRATION_WORDS.length)
  ];
}

const ANIMATION_MS = 1500;

interface Props {
  /** Flip true to trigger the animation. The component handles
   *  one-shot semantics — re-triggering requires play to go
   *  false-then-true again. */
  play: boolean;
  /** Fires when the animation finishes. Parent should clear its
   *  trigger state here. */
  onDone?: () => void;
}

export function TodoCelebration({ play, onDone }: Props) {
  const [active, setActive] = useState(false);
  const [word, setWord] = useState<string>("");
  // Ref to the trigger value last seen so the effect only fires on
  // false → true transitions, not on every re-render where `play` is
  // still true.
  const lastTrigger = useRef(false);

  useEffect(() => {
    if (play && !lastTrigger.current) {
      lastTrigger.current = true;
      setWord(pickWord());
      setActive(true);
      const timer = setTimeout(() => {
        setActive(false);
        lastTrigger.current = false;
        onDone?.();
      }, ANIMATION_MS);
      return () => clearTimeout(timer);
    }
    if (!play) {
      lastTrigger.current = false;
    }
  }, [play, onDone]);

  if (!active) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Word — sits behind the sweep, pops + fades. */}
      <div className="absolute inset-0 flex items-center justify-center todo-celebration-word">
        <span
          className="text-2xl md:text-3xl font-bold tracking-tight"
          style={{
            background:
              "linear-gradient(90deg, #ff6b9d 0%, #f8d3ad 25%, #ccedce 50%, #aabdff 75%, #ff6b9d 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            // Soft drop-shadow so the gradient text reads on busy
            // backgrounds (dark mode + light mode).
            filter: "drop-shadow(0 1px 0 rgba(0,0,0,0.05))",
          }}
        >
          {word}
        </span>
      </div>

      {/* Gradient sweep — bar with a translucent rainbow + the dog
       *  positioned at the leading (right) edge. */}
      <div className="absolute inset-y-0 left-0 todo-celebration-sweep">
        <div
          className="h-full w-full"
          style={{
            background:
              "linear-gradient(90deg, rgba(255,107,157,0) 0%, rgba(248,211,173,0.25) 30%, rgba(204,237,206,0.4) 55%, rgba(170,189,255,0.55) 80%, rgba(170,189,255,0.95) 100%)",
          }}
        />
        <div className="absolute top-1/2 right-0 -translate-y-1/2 translate-x-1/2 text-fg dark:text-fg drop-shadow-sm">
          <DogIcon className="w-9 h-7" />
        </div>
      </div>

    </div>
  );
}
