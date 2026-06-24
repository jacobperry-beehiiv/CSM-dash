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
/** Required by the template-folder seeding path: drive.file alone
 *  only grants access to files the app itself created, so it can't
 *  read a template folder admins set up out of band. */
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** True if the stored token includes the drive.file scope. Used to
 *  short-circuit Drive calls when the user hasn't reconsented yet —
 *  the call would fail with a generic 403 otherwise. Pass
 *  `{ requireReadonly: true }` to additionally require drive.readonly
 *  (the template-seeding path needs that to list + copy from a folder
 *  the app didn't create). */
export async function hasDriveAccess(
  email: string | null | undefined,
  opts?: { requireReadonly?: boolean }
): Promise<boolean> {
  if (!email) return false;
  const token = await loadTokenFor(email);
  if (!token?.scope) return false;
  // Google stores scopes as a space-separated string.
  const granted = new Set(token.scope.split(/\s+/));
  if (!granted.has(DRIVE_SCOPE)) return false;
  if (opts?.requireReadonly && !granted.has(DRIVE_READONLY_SCOPE)) {
    return false;
  }
  return true;
}

export interface DriveFolderRef {
  id: string;
  name: string;
  webViewLink: string;
  /** True when `createDriveFolder` just created this folder via the
   *  Drive API; false when an existing folder with the same name
   *  was returned from the idempotent short-circuit. Lets the
   *  Slack-assign caller skip the template-seeding pass on re-runs
   *  so we don't duplicate every template file on every re-assign. */
  created: boolean;
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
  if (existing) return { ...existing, created: false };

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
    created: true,
  };
}

/** Direct URL to a folder by ID — used as a fallback when Drive's
 *  webViewLink isn't returned (rare, but the field is technically
 *  optional in the API response). */
export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

/** Outcome of the template-seeding pass. `skipped` lists the
 *  per-file failures so the assign-flow Slack thread can mention
 *  how many didn't make it without dumping the raw API error. */
export interface SeedResult {
  copied: number;
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Clone every top-level file from `sourceFolderId` into
 * `destFolderId`. Folders inside the template are NOT recursed in
 * v1 — they get skipped with a `subfolder (not recursed)` reason.
 * Each file copy is soft-failed: one un-copyable doc doesn't kill
 * the whole pass.
 *
 * Optional `companyName` — when set, the literal `[insert customer
 * name]` token in each source filename is replaced with the actual
 * company name on copy. Lets the template hold a file called
 * `[insert customer name] | Newsletter Breakdown` and have it
 * land in the new folder as `{ActualCompany} | Newsletter Breakdown`.
 * When unset, names are copied as-is.
 *
 * Requires the requester to have re-consented with drive.readonly
 * — the source folder isn't one the app itself created, so the
 * default drive.file scope can't read it. Caller should gate on
 * `hasDriveAccess(email, { requireReadonly: true })` and surface a
 * "reconnect Google" hint when it returns false.
 */
export async function copyDriveFolderContents(
  requesterEmail: string,
  sourceFolderId: string,
  destFolderId: string,
  opts?: { companyName?: string }
): Promise<SeedResult> {
  const token = await getValidAccessTokenFor(requesterEmail);
  const companyName = opts?.companyName?.trim() ?? "";

  // Paginate so a template with >100 files doesn't silently
  // truncate. Drive caps pageSize at 1000; we set 100 to keep
  // each round-trip light. trashed = false drops anything the
  // template owner moved to trash.
  const safeSource = sourceFolderId.replace(/'/g, "\\'");
  const q = `'${safeSource}' in parents and trashed = false`;
  const files: Array<{ id: string; name: string; mimeType: string }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Drive template list failed: ${res.status} ${body.slice(0, 400)}`
      );
    }
    const json = (await res.json()) as {
      files?: Array<{ id: string; name: string; mimeType: string }>;
      nextPageToken?: string;
    };
    if (json.files) files.push(...json.files);
    pageToken = json.nextPageToken;
  } while (pageToken);

  let copied = 0;
  const skipped: SeedResult["skipped"] = [];

  for (const f of files) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      skipped.push({ name: f.name, reason: "subfolder (not recursed)" });
      continue;
    }
    // Filename token substitution — only fires when the caller
    // supplied a non-empty companyName. Case-insensitive match so
    // [Insert Customer Name] / [insert customer name] both work.
    const renamedName = companyName
      ? f.name.replace(/\[insert customer name\]/gi, companyName)
      : f.name;
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          f.id
        )}/copy?fields=id,name&supportsAllDrives=true`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: renamedName,
            parents: [destFolderId],
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        skipped.push({
          name: f.name,
          reason: `${res.status} ${body.slice(0, 200)}`,
        });
        continue;
      }
      copied++;
    } catch (e) {
      skipped.push({
        name: f.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { copied, skipped };
}

async function findFolderByName(
  accessToken: string,
  parentId: string,
  name: string
): Promise<Omit<DriveFolderRef, "created"> | null> {
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
