import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmWithGmail } from "@/lib/auth/csm-eligibility";
import {
  hasDriveAccess,
  listCustomerFolders,
} from "@/lib/integrations/google-drive";

export const dynamic = "force-dynamic";

/**
 * GET /api/csm/migration-warmup/folders
 *
 * Returns the subfolders under the shared customer-folders parent
 * (`DRIVE_ASSIGN_PARENT_FOLDER_ID`) so the migration-warmup form's
 * picker can render them. Each entry carries the folder id + name
 * + browsable URL; the form uses the id to target the generated
 * Sheet and the name to set the plan's `customer_name`.
 *
 * Failures we surface explicitly to the client:
 *  - 401: not signed in.
 *  - 403 + `ineligible`: viewer isn't a CSM with Gmail connected.
 *  - 200 + `scope_missing`: viewer hasn't granted drive.readonly,
 *    so we can't list a folder the app didn't create. The form
 *    falls back to the manual folder-URL field in this case.
 *  - 500 + `error`: the Drive API rejected the listing (bad
 *    parent id, token revoked, etc).
 */

const PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

export async function GET() {
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
  if (!(await hasDriveAccess(email, { requireReadonly: true }))) {
    // Picker can't run, but the form can still accept a manually
    // pasted folder URL — surface that as a 200 with a flag.
    return NextResponse.json({ folders: [], scope_missing: true });
  }
  try {
    const folders = await listCustomerFolders(email, PARENT_FOLDER_ID);
    return NextResponse.json({
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        webViewLink: f.webViewLink,
      })),
      empty_parent: folders.length === 0,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
