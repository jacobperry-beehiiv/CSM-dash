import { getValidAccessTokenFor } from "../data/gmail-token";
import type {
  ListSchedule,
  MigrationPlan,
  Week,
} from "../engines/migration-warmup/types";

/**
 * Populate a fresh Google Sheet with a migration warm-up plan.
 *
 * Mirrors the layout the Python reference `build_workbook()`
 * produces with openpyxl — same info block, header row colors,
 * Import Size / Total in Publication rows, Yes/No checkboxes,
 * grey total rows, column widths. The Sheets API takes structured
 * requests rather than per-cell mutations, so we batch every cell
 * write + every formatting rule into one `batchUpdate` call per
 * sheet.
 *
 * Sheets that get created here always start with one default
 * "Sheet1" — we rename it for the first list (Option A) or the
 * first week (Option B), and add additional sheets as needed.
 */

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// Sheets API Color objects use `red`/`green`/`blue` (0..1 floats) —
// the short `r`/`g`/`b` keys 400 the batchUpdate with
// "Unknown name 'r'". Both backgroundColor and border.color expect
// this same shape.
const WEEK_HEADER_COLORS: Array<{ red: number; green: number; blue: number }> = [
  { red: 0.851, green: 0.824, blue: 0.914 }, // D9D2E9
  { red: 0.812, green: 0.886, blue: 0.953 }, // CFE2F3
  { red: 0.851, green: 0.918, blue: 0.827 }, // D9EAD3
  { red: 0.988, green: 0.898, blue: 0.804 }, // FCE5CD
  { red: 0.918, green: 0.82, blue: 0.863 }, // EAD1DC
  { red: 0.992, green: 0.949, blue: 0.8 }, // FDF2CC
];
const TOTAL_ROW_FILL = { red: 0.937, green: 0.937, blue: 0.937 }; // EFEFEF

interface SheetsRequest {
  // The Sheets API request shape is enormous; we only use a few
  // request types, so the `any` here is bounded to what we
  // generate locally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface SheetMeta {
  /** Numeric sheet id within the spreadsheet (0 = the default
   *  "Sheet1" that comes free on create). Required for every
   *  formatting request. */
  sheetId: number;
  title: string;
}

/** Top-level entry point. Reads the spreadsheet's current sheet
 *  list (Google created one default), then issues a single
 *  batchUpdate that:
 *   1. Renames the default sheet for the first tab.
 *   2. Adds extra sheets for the remaining tabs.
 *   3. Writes every cell value + formatting rule.
 */
export async function populateMigrationSheet(
  requesterEmail: string,
  sheetId: string,
  plan: MigrationPlan
): Promise<void> {
  const token = await getValidAccessTokenFor(requesterEmail);

  // Step 1 — read existing sheets so we can rename the default
  // before adding more.
  const initial = await fetch(`${SHEETS_BASE}/${encodeURIComponent(sheetId)}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!initial.ok) {
    throw new Error(
      `Sheets GET failed: ${initial.status} ${(await initial.text()).slice(0, 300)}`
    );
  }
  const initialJson = (await initial.json()) as {
    sheets?: Array<{ properties?: { sheetId: number; title: string } }>;
  };
  const existingSheets =
    initialJson.sheets
      ?.map((s) => s.properties)
      .filter((p): p is { sheetId: number; title: string } => !!p) ?? [];

  // Step 2 — compute the tab structure.
  const tabs: Array<{
    title: string;
    /** Function that produces the row data + formatting requests
     *  once a sheetId has been assigned. */
    build: (meta: SheetMeta) => SheetsRequest[];
  }> =
    plan.structure === "nls" ? buildOptionBTabs(plan) : buildOptionATabs(plan);

  // Step 3 — first batchUpdate: rename the default sheet + add
  // the rest. We need the response so we know the assigned
  // sheetIds for the new sheets.
  const tabPrep: SheetsRequest[] = [];
  const tabMetas: SheetMeta[] = [];
  const defaultSheet = existingSheets[0];
  if (!defaultSheet) {
    throw new Error("Spreadsheet had no default sheet — unexpected.");
  }
  tabPrep.push({
    updateSheetProperties: {
      properties: {
        sheetId: defaultSheet.sheetId,
        title: safeTitle(tabs[0].title),
      },
      fields: "title",
    },
  });
  tabMetas.push({ sheetId: defaultSheet.sheetId, title: safeTitle(tabs[0].title) });
  for (let i = 1; i < tabs.length; i++) {
    tabPrep.push({
      addSheet: {
        properties: { title: safeTitle(tabs[i].title) },
      },
    });
  }
  const prepResponse = await batchUpdate(token, sheetId, tabPrep);
  // Pick up the sheetIds of the just-added sheets from the response.
  const replies = (prepResponse.replies ?? []) as Array<{
    addSheet?: { properties: SheetMeta };
  }>;
  for (let i = 1; i < tabs.length; i++) {
    const reply = replies[i];
    const props = reply?.addSheet?.properties;
    if (!props) {
      throw new Error(`Sheets batchUpdate missing addSheet reply for tab ${i}`);
    }
    tabMetas.push({ sheetId: props.sheetId, title: props.title });
  }

  // Step 4 — second batchUpdate: every cell write + every format
  // rule, generated per tab now that we know the sheetIds.
  const populateRequests: SheetsRequest[] = [];
  for (let i = 0; i < tabs.length; i++) {
    populateRequests.push(...tabs[i].build(tabMetas[i]));
  }
  // Sheets refuses an empty batchUpdate, so a no-op plan (no
  // schedules) shouldn't reach here — but guard anyway.
  if (populateRequests.length > 0) {
    await batchUpdate(token, sheetId, populateRequests);
  }
}

async function batchUpdate(
  token: string,
  sheetId: string,
  requests: SheetsRequest[]
): Promise<{ replies?: SheetsRequest[] }> {
  const res = await fetch(
    `${SHEETS_BASE}/${encodeURIComponent(sheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `Sheets batchUpdate failed: ${res.status} ${(await res.text()).slice(0, 400)}`
    );
  }
  return (await res.json()) as { replies?: SheetsRequest[] };
}

// --------------------------------------------------------------------- //
// Option A — one tab per list (mirrors Python _build_option_a)
// --------------------------------------------------------------------- //

function buildOptionATabs(plan: MigrationPlan) {
  return plan.schedules.map((s) => ({
    title: s.name,
    build: (meta: SheetMeta) => buildListTab(meta, s),
  }));
}

function buildListTab(meta: SheetMeta, s: ListSchedule): SheetsRequest[] {
  const requests: SheetsRequest[] = [];

  // Info block — five rows in columns A/B.
  const infoRows: Array<[string, string | number]> = [
    ["Newsletter", s.name],
    ["List Size", s.subscribers],
    ["Cadence", s.cadence],
    ["Average Open Rate", s.open_rate === null ? "unknown" : `${Math.round(s.open_rate * 100)}%`],
    ["ETA to complete", s.eta],
  ];
  for (let i = 0; i < infoRows.length; i++) {
    const [k, v] = infoRows[i];
    requests.push(...writeRow(meta.sheetId, i, [{ text: k, bold: true }, valueCell(v, k === "List Size")]));
  }

  // Row index after the info block + 1 blank row.
  let row = infoRows.length + 1;

  const totalBatches = s.weeks.reduce((acc, w) => acc + w.batches.length, 0);
  let globalBatchNo = 0;

  for (const w of s.weeks) {
    if (w.batches.length === 0) continue;

    const headerRow = row;
    const cells: CellSpec[] = [{ text: w.label, bold: true }];
    for (let bi = 0; bi < w.batches.length; bi++) {
      globalBatchNo += 1;
      const isLast = globalBatchNo === totalBatches;
      cells.push({ text: `Batch ${bi + 1}`, bold: true });
      cells.push({
        text: isLast ? "Migration Complete?" : "Emailed 1-2 times?",
        bold: true,
      });
    }
    requests.push(...writeRow(meta.sheetId, headerRow, cells));
    requests.push(rowFormatRequest(meta.sheetId, headerRow, weekColor(w.number), true));

    // Import Size row.
    const impRow = headerRow + 1;
    const impCells: CellSpec[] = [{ text: "Import Size", bold: true }];
    for (const b of w.batches) {
      impCells.push({ number: b.size });
      impCells.push({ text: "No" });
    }
    requests.push(...writeRow(meta.sheetId, impRow, impCells));
    // Yes/No data validation on every other cell starting at col 2 (C).
    for (let bi = 0; bi < w.batches.length; bi++) {
      const col = 2 + bi * 2;
      requests.push(yesNoValidation(meta.sheetId, impRow, col));
    }

    // Total in Publication row.
    const totRow = impRow + 1;
    const totCells: CellSpec[] = [{ text: "Total in Publication", bold: true }];
    for (const b of w.batches) {
      totCells.push({ number: b.cumulative });
      totCells.push({ text: "" });
    }
    requests.push(...writeRow(meta.sheetId, totRow, totCells));
    requests.push(rowFormatRequest(meta.sheetId, totRow, TOTAL_ROW_FILL, false));

    row = totRow + 2; // total row + one blank spacer
  }

  // Column widths — A=28ch, B/D/F/...=14ch (batches), C/E/G/...=18ch (checkbox).
  requests.push(...standardColumnWidths(meta.sheetId));

  return requests;
}

// --------------------------------------------------------------------- //
// Option B — one tab per week (mirrors Python _build_option_b)
// --------------------------------------------------------------------- //

function buildOptionBTabs(plan: MigrationPlan) {
  const nWeeks = Math.max(...plan.schedules.map((s) => s.total_weeks));
  return Array.from({ length: nWeeks }, (_, idx) => {
    const wk = idx + 1;
    return {
      title: `NLs W${wk}`,
      build: (meta: SheetMeta) => buildWeekTab(meta, plan, wk),
    };
  });
}

function buildWeekTab(meta: SheetMeta, plan: MigrationPlan, wk: number): SheetsRequest[] {
  const requests: SheetsRequest[] = [];
  // Summary header.
  requests.push(
    ...writeRow(meta.sheetId, 0, [
      { text: "List", bold: true },
      { text: "Size", bold: true },
      { text: "Cadence", bold: true },
      { text: "Complete this week?", bold: true },
    ])
  );
  requests.push(rowFormatRequest(meta.sheetId, 0, weekColor(wk), true));

  let row = 1;
  for (const s of plan.schedules) {
    const w = s.weeks.find((w) => w.number === wk);
    const complete = w && w.cumulative === s.subscribers ? "Yes" : "No";
    requests.push(
      ...writeRow(meta.sheetId, row, [
        { text: s.name },
        { number: s.subscribers },
        { text: s.cadence },
        { text: complete },
      ])
    );
    row += 1;
  }
  row += 1; // blank

  for (const s of plan.schedules) {
    const w = s.weeks.find((w) => w.number === wk);
    if (!w || w.batches.length === 0) continue;
    const endsThisWeek = w.cumulative === s.subscribers;

    const headerRow = row;
    const cells: CellSpec[] = [{ text: s.name, bold: true }];
    for (let bi = 0; bi < w.batches.length; bi++) {
      const lastBatch = endsThisWeek && bi === w.batches.length - 1;
      cells.push({ text: `Batch ${bi + 1}`, bold: true });
      cells.push({
        text: lastBatch ? "Migration Complete?" : "Emailed 1-2 times?",
        bold: true,
      });
    }
    requests.push(...writeRow(meta.sheetId, headerRow, cells));
    requests.push(rowFormatRequest(meta.sheetId, headerRow, weekColor(wk), true));

    const impRow = headerRow + 1;
    const impCells: CellSpec[] = [{ text: "Import Size", bold: true }];
    for (const b of w.batches) {
      impCells.push({ number: b.size });
      impCells.push({ text: "No" });
    }
    requests.push(...writeRow(meta.sheetId, impRow, impCells));
    for (let bi = 0; bi < w.batches.length; bi++) {
      const col = 2 + bi * 2;
      requests.push(yesNoValidation(meta.sheetId, impRow, col));
    }

    const totRow = impRow + 1;
    const totCells: CellSpec[] = [{ text: "Total on List", bold: true }];
    for (const b of w.batches) {
      totCells.push({ number: b.cumulative });
      totCells.push({ text: "" });
    }
    requests.push(...writeRow(meta.sheetId, totRow, totCells));
    requests.push(rowFormatRequest(meta.sheetId, totRow, TOTAL_ROW_FILL, false));
    row = totRow + 1;
  }

  requests.push(...standardColumnWidths(meta.sheetId));
  return requests;
}

// --------------------------------------------------------------------- //
// Sheets-API request builders
// --------------------------------------------------------------------- //

interface CellSpec {
  text?: string;
  number?: number;
  bold?: boolean;
}

function valueCell(v: string | number, isNumber: boolean): CellSpec {
  if (isNumber && typeof v === "number") return { number: v };
  if (typeof v === "number") return { number: v };
  return { text: v };
}

function writeRow(
  sheetId: number,
  rowIndex: number,
  cells: CellSpec[]
): SheetsRequest[] {
  const values = cells.map((c) => {
    if (c.number !== undefined) {
      return {
        userEnteredValue: { numberValue: c.number },
        userEnteredFormat: {
          numberFormat: { type: "NUMBER", pattern: "#,##0" },
          textFormat: { bold: c.bold === true, fontFamily: "Arial", fontSize: 10 },
        },
      };
    }
    return {
      userEnteredValue: { stringValue: c.text ?? "" },
      userEnteredFormat: {
        textFormat: { bold: c.bold === true, fontFamily: "Arial", fontSize: 10 },
      },
    };
  });
  return [
    {
      updateCells: {
        rows: [{ values }],
        fields:
          "userEnteredValue,userEnteredFormat.numberFormat,userEnteredFormat.textFormat",
        start: { sheetId, rowIndex, columnIndex: 0 },
      },
    },
  ];
}

function rowFormatRequest(
  sheetId: number,
  rowIndex: number,
  fill: { red: number; green: number; blue: number },
  topBorder: boolean
): SheetsRequest {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: 26,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: fill,
          ...(topBorder
            ? {
                borders: {
                  top: {
                    style: "SOLID_MEDIUM",
                    color: { red: 0, green: 0, blue: 0 },
                  },
                },
              }
            : {}),
        },
      },
      fields: topBorder
        ? "userEnteredFormat(backgroundColor,borders)"
        : "userEnteredFormat.backgroundColor",
    },
  };
}

function yesNoValidation(
  sheetId: number,
  rowIndex: number,
  columnIndex: number
): SheetsRequest {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: [{ userEnteredValue: "Yes" }, { userEnteredValue: "No" }],
        },
        showCustomUi: true,
        strict: true,
      },
    },
  };
}

function standardColumnWidths(sheetId: number): SheetsRequest[] {
  // A=label (28ch ≈ 200px), then alternating batch (14ch ≈ 100px) /
  // checkbox (18ch ≈ 130px). 1ch ≈ ~7px at the default Sheets font.
  const reqs: SheetsRequest[] = [];
  reqs.push(widthRequest(sheetId, 0, 1, 200));
  for (let col = 1; col < 26; col += 2) {
    reqs.push(widthRequest(sheetId, col, col + 1, 100));
    reqs.push(widthRequest(sheetId, col + 1, col + 2, 130));
  }
  return reqs;
}

function widthRequest(
  sheetId: number,
  startCol: number,
  endCol: number,
  px: number
): SheetsRequest {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: startCol, endIndex: endCol },
      properties: { pixelSize: px },
      fields: "pixelSize",
    },
  };
}

function weekColor(weekNumber: number) {
  const idx = ((weekNumber - 1) % WEEK_HEADER_COLORS.length + WEEK_HEADER_COLORS.length) %
    WEEK_HEADER_COLORS.length;
  return WEEK_HEADER_COLORS[idx];
}

function safeTitle(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, "");
  return clean.slice(0, 100) || "Sheet";
}

// Silence the lint for the unused Week import — re-export keeps the
// type accessible from this module without dragging clients to types.ts.
export type { Week };
