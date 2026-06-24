import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmWithGmail } from "@/lib/auth/csm-eligibility";
import {
  createGoogleSheet,
  hasDriveAccess,
} from "@/lib/integrations/google-drive";
import { populateMigrationSheet } from "@/lib/integrations/google-sheets-migration";
import { buildPlan } from "@/lib/engines/migration-warmup/engine";
import type {
  ListInput,
  MigrationPlan,
  PlanInput,
} from "@/lib/engines/migration-warmup/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/csm/migration-warmup
 *
 * Body:
 * {
 *   folder: { id: string, name: string } | null,
 *   manual_folder_url?: string,
 *   structure: "separate" | "nls",
 *   lists: ListInput[]
 * }
 *
 * Either `folder` (picked from the customer-folder list) or
 * `manual_folder_url` must be present. The latter accepts a full
 * Drive folder URL or a bare folder id, so a CSM whose token
 * lacks drive.readonly can still target a folder they have direct
 * write access to.
 *
 * Returns: { sheet: { id, name, webViewLink }, plan: MigrationPlan }
 */

const FOLDER_URL_RE = /(?:\/folders\/|^)([a-zA-Z0-9_-]{10,})/;

interface RequestBody {
  folder?: { id: string; name: string } | null;
  manual_folder_url?: string | null;
  manual_customer_name?: string | null;
  structure?: "separate" | "nls";
  lists?: ListInput[];
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmWithGmail(email))) {
    return NextResponse.json(
      {
        error:
          "Migration warm-up is only available to CSMs with Gmail connected. Connect at /settings/gmail.",
        ineligible: true,
      },
      { status: 403 }
    );
  }
  if (!(await hasDriveAccess(email))) {
    return NextResponse.json(
      {
        error:
          "Drive access required. Visit /settings/gmail and reconnect Google.",
        scope_missing: true,
      },
      { status: 403 }
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Resolve target folder + customer name. Folder picker wins; the
  // manual URL is the fallback.
  let folderId: string | null = body.folder?.id ?? null;
  let customerName = body.folder?.name ?? "";
  if (!folderId && body.manual_folder_url) {
    const match = body.manual_folder_url.match(FOLDER_URL_RE);
    if (match) folderId = match[1];
    customerName = body.manual_customer_name?.trim() || "Migration Plan";
  }
  if (!folderId) {
    return NextResponse.json(
      {
        error:
          "Pick a customer folder, or paste a Drive folder URL into the manual field.",
      },
      { status: 400 }
    );
  }

  const lists = Array.isArray(body.lists) ? body.lists : [];
  if (lists.length === 0) {
    return NextResponse.json(
      { error: "At least one list is required." },
      { status: 400 }
    );
  }

  const planInput: PlanInput = {
    customer_name: customerName || "Migration Plan",
    lists,
    structure: body.structure === "nls" ? "nls" : "separate",
  };

  let plan: MigrationPlan;
  try {
    plan = buildPlan(planInput);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Plan failed" },
      { status: 400 }
    );
  }

  const sheetName = `${planInput.customer_name} — Migration Schedule`;
  try {
    const sheet = await createGoogleSheet(email, folderId, sheetName);
    await populateMigrationSheet(email, sheet.id, plan);
    return NextResponse.json({ sheet, plan });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sheet creation failed" },
      { status: 500 }
    );
  }
}
