"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

/**
 * Lightweight contenteditable rich-text editor — produces Gmail-compatible
 * HTML using document.execCommand. No external dependencies.
 *
 * Toolbar: bold / italic / underline / text color / highlight color /
 * link / unordered list / ordered list / heading / paragraph / undo /
 * redo / insert merge tag (handled separately by the template editor
 * that wraps this component).
 */
export function RichTextEditor({ value, onChange, placeholder }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Sync external value → DOM only when they differ. Avoids cursor jumps.
  useEffect(() => {
    if (ref.current && value !== ref.current.innerHTML) {
      ref.current.innerHTML = value;
    }
  }, [value]);

  function exec(cmd: string, arg?: string) {
    document.execCommand(cmd, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function insertLink() {
    const url = prompt("Link URL");
    if (!url) return;
    exec("createLink", url);
  }

  function insertHeading() {
    exec("formatBlock", "<h3>");
  }

  function insertParagraph() {
    exec("formatBlock", "<p>");
  }

  return (
    <div className="border border-border-strong rounded-md overflow-hidden">
      <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-border bg-canvas text-xs">
        <ToolButton onClick={() => exec("bold")} label="B" tip="Bold" bold />
        <ToolButton onClick={() => exec("italic")} label="I" tip="Italic" italic />
        <ToolButton onClick={() => exec("underline")} label="U" tip="Underline" underline />
        <Divider />
        <ColorMenu
          kind="text"
          onPick={(color) => exec("foreColor", color)}
          onClear={() => {
            // Removing just a foreColor without dropping bold/italic/etc.
            // is deliberately not built into execCommand. Best we can do
            // safely from a contenteditable is set the color to "inherit"
            // via a fresh foreColor call — the ancestor styles bleed
            // through cleanly for downstream Gmail rendering.
            exec("foreColor", "inherit");
          }}
        />
        <ColorMenu
          kind="highlight"
          onPick={(color) => exec("hiliteColor", color)}
          onClear={() => exec("hiliteColor", "transparent")}
        />
        <Divider />
        <ToolButton onClick={insertHeading} label="H" tip="Heading" />
        <ToolButton onClick={insertParagraph} label="P" tip="Paragraph" />
        <Divider />
        <ToolButton onClick={() => exec("insertUnorderedList")} label="•" tip="Bullet list" />
        <ToolButton onClick={() => exec("insertOrderedList")} label="1." tip="Numbered list" />
        <Divider />
        <ToolButton onClick={insertLink} label="🔗" tip="Insert link" />
        <ToolButton onClick={() => exec("removeFormat")} label="✕" tip="Clear formatting" />
        <Divider />
        <ToolButton onClick={() => exec("undo")} label="↶" tip="Undo" />
        <ToolButton onClick={() => exec("redo")} label="↷" tip="Redo" />
      </div>
      <div
        ref={ref}
        contentEditable
        onInput={() => ref.current && onChange(ref.current.innerHTML)}
        suppressContentEditableWarning
        className="px-3 py-2 min-h-[180px] text-sm focus:outline-none prose prose-sm max-w-none [&_h3]:text-base [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2"
        data-placeholder={placeholder}
      />
    </div>
  );
}

function ToolButton({
  onClick,
  label,
  tip,
  bold,
  italic,
  underline,
}: {
  onClick: () => void;
  label: string;
  tip: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}) {
  return (
    <button
      type="button"
      // Keep the contenteditable's selection alive across the click.
      // Without preventDefault the mousedown steals focus, the caret
      // collapses, and execCommand runs against an empty range — the
      // format silently no-ops on the "selected" text. Same trick we
      // apply to the color-menu swatches below.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={tip}
      className={`px-2 py-1 rounded hover:bg-surface border border-transparent hover:border-border-strong ${
        bold ? "font-bold" : ""
      } ${italic ? "italic" : ""} ${underline ? "underline" : ""}`}
    >
      {label}
    </button>
  );
}

function Divider() {
  return <div className="w-px bg-gray-300 mx-1" />;
}

/**
 * Two curated palettes — one for foreground (text), one for
 * highlight (background). Kept small on purpose: a big color wheel
 * inside an email template invites the "seven colors of the rainbow
 * in one send" antipattern that trashes readability. The "Custom…"
 * row at the bottom opens the native color picker for the rare
 * off-palette need.
 *
 * Colors picked to read cleanly against BOTH light and dark email
 * backgrounds. Highlight swatches skew pastel so black text on top
 * stays legible without needing a paired foreColor edit.
 */
const TEXT_SWATCHES: Array<{ label: string; value: string }> = [
  { label: "Default", value: "#111827" },
  { label: "Muted", value: "#6b7280" },
  { label: "Red", value: "#b91c1c" },
  { label: "Amber", value: "#b45309" },
  { label: "Green", value: "#047857" },
  { label: "Blue", value: "#1d4ed8" },
  { label: "Purple", value: "#6d28d9" },
  { label: "White", value: "#ffffff" },
];

const HIGHLIGHT_SWATCHES: Array<{ label: string; value: string }> = [
  { label: "Yellow", value: "#fef3c7" },
  { label: "Green", value: "#d1fae5" },
  { label: "Blue", value: "#dbeafe" },
  { label: "Pink", value: "#fce7f3" },
  { label: "Gray", value: "#e5e7eb" },
  { label: "Amber", value: "#fde68a" },
];

function ColorMenu({
  kind,
  onPick,
  onClear,
}: {
  kind: "text" | "highlight";
  onPick: (color: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Outside-click close. `mousedown` so a swatch click inside the
  // popover (which needs to fire BEFORE the popover unmounts) doesn't
  // race the close handler. Matches the pattern the MappedFieldEditor
  // compact picker uses.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const swatches = kind === "text" ? TEXT_SWATCHES : HIGHLIGHT_SWATCHES;
  const label = kind === "text" ? "A" : "▍";
  const tip =
    kind === "text"
      ? "Text color"
      : "Highlight (background) color";
  // Visual affordance on the trigger: text-color menu shows a red
  // underline under the "A"; highlight-color shows a yellow bar so
  // the two menus are distinguishable at a glance without a legend.
  const triggerAccent =
    kind === "text"
      ? "border-b-2 border-red-600"
      : "bg-yellow-200 dark:bg-yellow-500/40";

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title={tip}
        aria-haspopup="true"
        aria-expanded={open}
        className={`px-2 py-1 rounded hover:bg-surface border border-transparent hover:border-border-strong ${triggerAccent}`}
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 rounded-md border border-border-strong bg-surface shadow-lg p-2 space-y-2 min-w-[10rem]"
          // The whole popover preventDefaults on mousedown too, so
          // clicks anywhere inside (spacer padding, labels) don't
          // yank focus out of the contenteditable before the swatch
          // handler fires.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="grid grid-cols-4 gap-1.5">
            {swatches.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => {
                  onPick(s.value);
                  setOpen(false);
                }}
                title={s.label}
                className="w-7 h-7 rounded border border-border-strong hover:ring-2 hover:ring-accent/50 focus:outline-none focus:ring-2 focus:ring-accent transition"
                style={{ backgroundColor: s.value }}
                aria-label={`${kind === "text" ? "Text" : "Highlight"} color: ${s.label}`}
              />
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
            <input
              type="color"
              className="w-6 h-6 rounded border border-border-strong cursor-pointer p-0"
              // The native picker fires `input` per keystroke and
              // `change` on close — use `change` so we don't flood
              // execCommand with a color per drag frame (which
              // muddies the undo history).
              onChange={(e) => {
                onPick(e.target.value);
                setOpen(false);
              }}
            />
            Custom…
          </label>
          <button
            type="button"
            onClick={() => {
              onClear();
              setOpen(false);
            }}
            className="w-full text-left px-1.5 py-1 rounded text-[11px] text-subtle italic hover:bg-canvas hover:text-fg border-t border-border pt-1.5"
          >
            {kind === "text" ? "Clear text color" : "Clear highlight"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
