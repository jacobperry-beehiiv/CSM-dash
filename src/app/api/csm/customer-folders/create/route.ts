import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { getActiveEmail } from "@/lib/data/active-user";
import { loadCustomers } from "@/lib/data/load-customers";
import { patchHubspotCompanyProperties } from "@/lib/integrations/hubspot";
import {
  createDriveFolder,
  folderUrl,
  hasDriveAccess,
} from "@/lib/integrations/google-drive";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/csm/customer-folders/create
 *
 * Backfill counterpart to the folder-sweep. The sweep is folder-first
 * — it finds orphan Drive folders and links them back to customers.
 * This endpoint handles the inverse case: a customer in the book has
 * NO Drive folder at all (@bot assign was never run for them, or ran
 * and died before step 4), and we need to create one from scratch and
 * write the URL into HubSpot's `customer_folder` property.
 *
 * Mirrors what the @bot assign flow does for the Drive step, minus
 * the template seed — this backfill just makes sure the folder EXISTS
 * and is linked. If the CSM wants the onboarding template dropped in,
 * they can re-run @bot assign, which is idempotent post-#254 (todo
 * dedupe + HubSpot writes are set-not-append + `createDriveFolder`
 * itself reuses an existing folder rather than duplicating one).
 *
 * Body: { workspace_id, folder_name? }
 *   • `folder_name` overrides the auto-picked name; defaults to
 *     `company_name` (falls back to `workspace_name`, then
 *     `workspace_id`).
 *
 * Refuses to run when:
 *   • The workspace isn't in the book, or has no `hubspot_company_id`.
 *   • The customer's `customer_folder` property is already set
 *     (design decision: never overwrite — matches the sweep's own
 *     "backfill blanks only" rule).
 *   • The active browser has no Gmail connected / no drive.file scope.
 *
 * Response: { ok, folder_id, folder_url, created }
 *   • `created` is false when `createDriveFolder` reused an existing
 *     folder of the same name under the shared parent — a hint to
 *     the UI that the folder already existed in Drive; the HubSpot
 *     link write still ran.
 */

const DRIVE_PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

interface PostBody {
  workspace_id?: unknown;
  folder_name?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  const viewerEmail = session?.user?.email ?? null;
  if (!viewerEmail) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("customer-folders-sweep", viewerEmail))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }
  const activeEmail = await getActiveEmail();
  if (!activeEmail) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail — the create step needs your Drive token.",
      },
      { status: 401 }
    );
  }
  if (!(await hasDriveAccess(activeEmail))) {
    return NextResponse.json(
      {
        error:
          "Drive scope not granted yet — visit /settings/gmail and click Reconnect Google to enable the drive.file scope.",
        needs_reconsent: true,
      },
      { status: 401 }
    );
  }

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body" },
      { status: 400 }
    );
  }
  const workspaceId =
    typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id required" },
      { status: 400 }
    );
  }
  const folderNameOverride =
    typeof body.folder_name === "string" && body.folder_name.trim().length > 0
      ? body.folder_name.trim()
      : null;

  const customers = await loadCustomers();
  const customer = customers.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json(
      { error: `Customer with workspace_id ${workspaceId} not in the book.` },
      { status: 404 }
    );
  }
  if (!customer.hubspot_company_id) {
    return NextResponse.json(
      {
        error:
          "Customer has no HubSpot company link — can't write customer_folder back. Fix the HubSpot link first (see /settings → HubSpot resync).",
      },
      { status: 422 }
    );
  }
  if (
    typeof customer.property_customer_folder === "string" &&
    customer.property_customer_folder.trim().length > 0
  ) {
    return NextResponse.json(
      {
        error:
          "customer_folder is already set on this HubSpot company. The sweep never overwrites; edit the property directly on the customer detail panel if it's wrong.",
        existing_url: customer.property_customer_folder.trim(),
      },
      { status: 409 }
    );
  }

  const folderName =
    folderNameOverride ||
    customer.company_name?.trim() ||
    customer.workspace_name?.trim() ||
    workspaceId;

  let folder;
  try {
    folder = await createDriveFolder(
      activeEmail,
      DRIVE_PARENT_FOLDER_ID,
      folderName
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: `Drive folder create failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 502 }
    );
  }

  const webViewLink = folder.webViewLink ?? folderUrl(folder.id);
  let hubspotError: string | null = null;
  try {
    await patchHubspotCompanyProperties(customer.hubspot_company_id, {
      customer_folder: webViewLink,
    });
  } catch (e) {
    hubspotError = e instanceof Error ? e.message : String(e);
  }

  // Audit trail — best-effort. Same shape the sweep's apply endpoint
  // writes so both entry points show up under the same
  // action_kind on the customer's Notes surface.
  try {
    await appendActionLog([
      {
        workspace_id: workspaceId,
        text: `Customer Folder created + linked: ${folder.name}${
          hubspotError ? " (HubSpot PATCH failed — see error)" : ""
        }`,
        created_by: viewerEmail,
        action_kind: "customer_folder_sweep_applied",
        metadata: {
          folder_id: folder.id,
          folder_url: webViewLink,
          created: folder.created,
          via: "manual_backfill",
          ...(hubspotError ? { hubspot_error: hubspotError } : {}),
        },
      },
    ]);
  } catch (e) {
    console.warn("[customer-folders/create] action_log write failed", {
      error: e instanceof Error ? e.message : e,
    });
  }

  return NextResponse.json({
    ok: hubspotError === null,
    folder_id: folder.id,
    folder_url: webViewLink,
    folder_name: folder.name,
    created: folder.created,
    hubspot_error: hubspotError,
  });
}
