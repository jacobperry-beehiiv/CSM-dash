"use client";

import { useEffect, useRef, useState } from "react";
import { useViewerEmail } from "@/lib/auth-client";

/**
 * Floating "Report an issue" button mounted globally in layout.tsx.
 * Click → modal where the user types a message and optionally pastes
 * or uploads a screenshot. Submit forwards everything (message +
 * current page URL + screenshot blob + user agent + signed-in
 * email) to /api/report-issue, which posts it to the configured
 * issue_reports Slack channel.
 *
 * Renders nothing when no viewer is signed in — keeps the login
 * page chrome clean.
 *
 * Screenshot intake:
 *   • Cmd/Ctrl-V on the modal pastes a clipboard image (the common
 *     macOS / Win flow after Shift-Cmd-4 or PrintScreen).
 *   • Click the drop zone to file-pick (image/* only).
 *   • Drag-and-drop is supported as a third path.
 *   Preview shows immediately; X removes.
 */

interface Screenshot {
  base64: string;
  mime: string;
  /** data URL we render in the <img> preview. */
  preview_url: string;
  size_bytes: number;
}

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

export function ReportIssueButton() {
  const viewerEmail = useViewerEmail();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Reset modal state when it closes. Defers so the close animation
  // (if any) doesn't see a flash of empty content.
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      setMessage("");
      setScreenshot(null);
      setResult(null);
      setError(null);
      setBusy(false);
    }, 200);
    return () => clearTimeout(t);
  }, [open]);

  // Wire Cmd/Ctrl-V on the modal to clipboard-image intake. Listens
  // at the modal container so we don't fight the textarea's own
  // paste handler when the user is pasting text.
  useEffect(() => {
    if (!open) return;
    const node = modalRef.current;
    if (!node) return;
    function onPaste(e: ClipboardEvent) {
      if (!e.clipboardData) return;
      // Only intercept image items — leave text paste to the
      // textarea so message editing isn't disrupted.
      for (const item of e.clipboardData.items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void ingestFile(file);
          }
          return;
        }
      }
    }
    node.addEventListener("paste", onPaste);
    return () => node.removeEventListener("paste", onPaste);
  }, [open]);

  async function ingestFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("That doesn't look like an image.");
      return;
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      setError(
        `Screenshot is ${(file.size / 1024 / 1024).toFixed(1)} MB — max ${(MAX_SCREENSHOT_BYTES / 1024 / 1024).toFixed(0)} MB.`
      );
      return;
    }
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    setScreenshot({
      base64,
      mime: file.type,
      preview_url: `data:${file.type};base64,${base64}`,
      size_bytes: file.size,
    });
  }

  function onFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void ingestFile(file);
    // Reset so re-selecting the same file fires again.
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void ingestFile(file);
  }

  async function submit() {
    if (!message.trim()) {
      setError("Tell me what's going on first.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/report-issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          url: typeof window !== "undefined" ? window.location.href : "",
          user_agent:
            typeof navigator !== "undefined" ? navigator.userAgent : "",
          screenshot_base64: screenshot?.base64,
          screenshot_mime: screenshot?.mime,
        }),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        error?: string;
        upload_warning?: string | null;
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setResult(
        j.upload_warning
          ? `Sent — but the screenshot couldn't upload (${j.upload_warning}). Jacob got the text.`
          : "Sent. Jacob will follow up if it's actionable."
      );
      setMessage("");
      setScreenshot(null);
      // Auto-close after a moment so the success message has time to land.
      setTimeout(() => setOpen(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  // Hide for anonymous viewers — the API would 401 anyway, but no
  // sense rendering the button on the login page.
  if (!viewerEmail) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 px-4 py-2.5 rounded-full shadow-card-lg bg-accent text-accent-fg text-sm font-medium hover:bg-accent-hover"
        title="Report an issue or send feedback to Jacob"
        aria-label="Report an issue"
      >
        <span aria-hidden>🐛</span>
        Report an issue
      </button>
      {open ? (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            ref={modalRef}
            tabIndex={-1}
            className="bg-surface rounded-lg w-full max-w-xl max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between p-4 border-b border-border">
              <div>
                <h3 className="font-semibold text-fg">Report an issue</h3>
                <p className="text-xs text-muted mt-0.5">
                  Goes straight to Jacob on Slack with the page URL,
                  your email, and (optionally) a screenshot.
                </p>
              </div>
              <button
                onClick={() => !busy && setOpen(false)}
                className="text-subtle hover:text-muted text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto flex-1">
              <div>
                <label className="text-xs text-muted block mb-1">
                  What&apos;s going on?
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  placeholder="What were you trying to do, what happened instead, anything that looks off…"
                  className="w-full px-3 py-2 border border-border-strong rounded-md text-sm"
                  autoFocus
                  disabled={busy}
                />
              </div>

              <div>
                <label className="text-xs text-muted block mb-1">
                  Screenshot (optional)
                </label>
                {screenshot ? (
                  <div className="border border-border rounded-md p-2 flex items-start gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={screenshot.preview_url}
                      alt="Screenshot preview"
                      className="max-h-40 max-w-full rounded border border-border"
                    />
                    <div className="text-xs text-muted flex-1 min-w-0">
                      <p>{(screenshot.size_bytes / 1024).toFixed(0)} KB · {screenshot.mime}</p>
                      <button
                        onClick={() => setScreenshot(null)}
                        className="text-accent hover:underline mt-1"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={onDrop}
                    className="w-full border border-dashed border-border-strong rounded-md py-6 text-center text-xs text-muted hover:bg-canvas/60"
                  >
                    <p className="font-medium text-fg">
                      Paste, drop, or click to add
                    </p>
                    <p className="mt-0.5">
                      Cmd/Ctrl-V after a screenshot tool works too
                    </p>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={onFileSelect}
                  className="hidden"
                />
              </div>

              <div className="text-xs text-muted">
                We&apos;ll auto-attach the current URL{" "}
                <code className="font-mono bg-surface-2 px-1 rounded text-[11px]">
                  {typeof window !== "undefined" ? window.location.pathname : ""}
                </code>{" "}
                and your sign-in email.
              </div>

              {error ? (
                <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
                  {error}
                </div>
              ) : null}
              {result ? (
                <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-md p-3 text-sm text-emerald-800 dark:text-emerald-300">
                  {result}
                </div>
              ) : null}
            </div>
            <div className="p-4 border-t border-border flex items-center gap-2 justify-end">
              <button
                onClick={() => !busy && setOpen(false)}
                disabled={busy}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy || !message.trim()}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send to Jacob"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Convert ArrayBuffer → base64 without using FileReader (which is
 *  async and adds complexity). Loops in 8 KB chunks to avoid the
 *  "Maximum call stack size exceeded" error on large images when
 *  using `String.fromCharCode(...new Uint8Array(buf))`. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }
  return btoa(binary);
}
