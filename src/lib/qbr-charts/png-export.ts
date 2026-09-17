import { toPng } from "html-to-image";
import JSZip from "jszip";

/**
 * PNG-export helpers for QBR chart tiles.
 *
 * Recharts sizes its <ResponsiveContainer> from the parent's
 * measured width, and dispatches its own resize listener; when we
 * render a card into a fixed-width offscreen host, we need to give
 * the container a moment to size + paint before html-to-image
 * snapshots. `waitForCardReady` handles that with a two-frame
 * rAF loop + a small settle delay — same trick deck-preview uses
 * before window.print().
 */

/** Two rAF ticks + a settle delay so Recharts has painted at the
 *  target width. 250ms is enough for the largest QBR spec on a
 *  M1 MacBook; smaller machines see the same ceiling because we
 *  render one card at a time. */
const SETTLE_MS = 250;

export async function waitForCardReady(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  // ResponsiveContainer registers its own resize handler; nudging
  // it once here catches specs that rendered before we appended
  // the offscreen host.
  window.dispatchEvent(new Event("resize"));
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
}

/** Snapshot one already-mounted element to a PNG data URL. */
export async function snapshotElement(el: HTMLElement): Promise<string> {
  return toPng(el, {
    pixelRatio: 2,
    backgroundColor: "#ffffff",
    // html-to-image walks the DOM cloning styles; anything with the
    // data-qbr-hide-in-export attribute is stripped out of the clone
    // so per-tile edit chrome (axis pencil etc.) doesn't leak into
    // the downloaded image.
    filter: (node) => {
      if (!(node instanceof HTMLElement)) return true;
      return node.dataset.qbrHideInExport === undefined;
    },
  });
}

/** Slug for the filename inside the .zip. Keeps ASCII, drops
 *  slashes, collapses whitespace. */
export function slugForFilename(title: string, questionId: number): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${questionId}-${cleaned || "chart"}`;
}

/** Convert a "data:image/png;base64,…" URL into raw bytes for
 *  JSZip. Avoids the async round-trip through fetch(). */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Build the final .zip and hand the caller a blob. */
export async function zipPngs(
  entries: Array<{ filename: string; bytes: Uint8Array }>
): Promise<Blob> {
  const zip = new JSZip();
  for (const e of entries) {
    zip.file(`${e.filename}.png`, e.bytes);
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

/** Kick a browser download for a blob. Cleans up the object URL
 *  after the click fires. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Timestamped zip filename — matches CSV export naming
 *  (see src/lib/csv.ts csvDateStamp). */
export function zipFilename(prefix: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `${prefix}-${stamp}.zip`;
}
