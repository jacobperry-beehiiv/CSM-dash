/**
 * Shared CSV export plumbing for the dashboard tables.
 *
 * Both the "All assigned" table (customer-table.tsx) and the at-risk
 * table hand a CSM the same thing: whatever is currently on screen,
 * as a file they can paste into a spreadsheet or join against another
 * export. Those two lived as independent copies of the same twenty
 * lines until the at-risk export was added, and they had already
 * drifted (one quoted every cell, the other didn't) — so the escaping
 * and the download mechanics live here now and both tables call in.
 *
 * Two deliberate choices, both load-bearing for Excel:
 *
 *  - **Every cell is quoted**, unconditionally. Cheaper to reason
 *    about than conditional quoting, and it keeps commas inside
 *    recommended-action sentences and risk details from splitting a
 *    row. Embedded quotes are doubled per RFC 4180.
 *  - **A UTF-8 BOM is prepended.** Without it Excel on Windows opens
 *    the file as Latin-1 and mangles every non-ASCII company name.
 *    Google Sheets and Numbers both ignore the BOM, so it costs
 *    nothing elsewhere.
 *
 * Client-only: `downloadCsv` touches Blob/URL/document, so don't
 * import this from a server component.
 */

/** Quote a single cell. `null`/`undefined` become an empty field. */
export function csvEscape(v: unknown): string {
  if (v == null) return "";
  return `"${String(v).replace(/"/g, '""')}"`;
}

/**
 * Column spec for `buildCsv`. `pick` pulls the raw value off a row —
 * return dates as the underlying ISO string rather than a formatted
 * one so the file stays sortable and joinable downstream.
 */
export interface CsvColumn<T> {
  header: string;
  pick: (row: T) => unknown;
}

/** Render rows + columns to a CSV string (no BOM — `downloadCsv` adds it). */
export function buildCsv<T>(rows: readonly T[], columns: ReadonlyArray<CsvColumn<T>>): string {
  const header = columns.map((col) => csvEscape(col.header)).join(",");
  const lines = rows.map((row) =>
    columns.map((col) => csvEscape(col.pick(row))).join(",")
  );
  return [header, ...lines].join("\n");
}

/** Today as `YYYY-MM-DD`, for the `<name>-<date>.csv` filename convention. */
export function csvDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
