"use client";

import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

/**
 * Lightweight contenteditable rich-text editor — produces Gmail-compatible
 * HTML using document.execCommand. No external dependencies.
 *
 * Toolbar: bold / italic / underline / link / unordered list / ordered list /
 * heading / paragraph / undo / redo / insert merge tag (handled separately
 * by the template editor that wraps this component).
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

  function onInput() {
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
        onInput={onInput}
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
