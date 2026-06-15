import { getValidAccessTokenFor, loadTokenFor } from "../data/gmail-token";

/**
 * Google Drive client — small wrapper around drive/v3/files for the
 * @bot assign flow. Reuses the existing Gmail OAuth token store
 * (src/lib/data/gmail-token.ts); the only delta is that callers must
 * have re-consented after we added the drive.file scope to the OAuth
 * start route.
 *
 * Why drive.file (and not drive): drive.file only grants the app
 * access to files it itself creates. We don't browse the user's whole
 * Drive — we just need to drop a folder into a known parent and link
 * to it. drive.file is the smallest scope that lets us do that.
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** True if the stored token includes the drive.file scope. Used to
 *  short-circuit Drive calls when the user hasn't reconsented yet —
 *  the call would fail with a generic 403 otherwise. */
export async function hasDriveAccess(
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;
  const token = await loadTokenFor(email);
  if (!token?.scope) return false;
  // Google stores scopes as a space-separated string.
  return token.scope.split(/\s+/).includes(DRIVE_SCOPE);
}

export interface DriveFolderRef {
  id: string;
  name: string;
  webViewLink: string;
}

/**
 * Create a folder under `parentId` owned by `requesterEmail`. The
 * caller is responsible for having reconsented with the drive.file
 * scope; if they haven't, this throws a clear error so the caller can
 * point them at /settings/gmail.
 *
 * Returns the new folder's id + browsable URL. If a folder with the
 * same name already exists under the parent AND the caller created
 * it (drive.file scope makes that "files I made"), we return the
 * existing one rather than creating a duplicate.
 */
export async function createDriveFolder(
  requesterEmail: string,
  parentId: string,
  name: string
): Promise<DriveFolderRef> {
  if (!(await hasDriveAccess(requesterEmail))) {
    throw new Error(
      `${requesterEmail} hasn't granted Drive access. Visit /settings/gmail and reconnect Google to grant the drive.file scope.`
    );
  }
  const token = await getValidAccessTokenFor(requesterEmail);

  // First — see if a folder by this name already exists under the
  // parent. drive.file restricts the query to files this app
  // created, which is exactly what we want; collisions across users'
  // unrelated Drives won't show up here.
  const existing = await findFolderByName(token, parentId, name);
  if (existing) return existing;

  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Drive folder create failed: ${res.status} ${body.slice(0, 400)}`
    );
  }

  const json = (await res.json()) as {
    id: string;
    name: string;
    webViewLink?: string;
  };
  return {
    id: json.id,
    name: json.name,
    webViewLink: json.webViewLink ?? folderUrl(json.id),
  };
}

/** Direct URL to a folder by ID — used as a fallback when Drive's
 *  webViewLink isn't returned (rare, but the field is technically
 *  optional in the API response). */
export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

async function findFolderByName(
  accessToken: string,
  parentId: string,
  name: string
): Promise<DriveFolderRef | null> {
  // q syntax: parent + name + mimeType + not-trashed.
  // single-quotes inside the name need to be escaped per Drive's
  // query grammar (backslash escape).
  const safeName = name.replace(/'/g, "\\'");
  const q = `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name,webViewLink)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    files?: Array<{ id: string; name: string; webViewLink?: string }>;
  };
  const hit = json.files?.[0];
  if (!hit) return null;
  return {
    id: hit.id,
    name: hit.name,
    webViewLink: hit.webViewLink ?? folderUrl(hit.id),
  };
}
