import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import {
  addTeamMascot,
  loadTeamMascots,
  removeTeamMascot,
  type TeamMascot,
} from "@/lib/data/team-mascots";

export const dynamic = "force-dynamic";
// 4.5 MB cap on the request body so a CSM can't accidentally
// upload a 50 MB camera-raw of Sherlock and OOM the function.
export const runtime = "nodejs";

/**
 * Team-mascot CRUD.
 *
 * GET    /api/team-mascots
 *   → { mascots: TeamMascot[], blobConfigured: boolean }
 *
 * POST   /api/team-mascots
 *   multipart/form-data with `file` (image/*) + `label` (string).
 *   Uploads to Vercel Blob, then records the URL + metadata in KV.
 *   → { mascot: TeamMascot }
 *
 * DELETE /api/team-mascots?id=<mascot_id>
 *   Removes from Vercel Blob + KV.
 *   → { ok: true }
 *
 * Auth: CSM team members only. Non-CSMs (admins on demo shares,
 * sales) shouldn't be uploading pet photos.
 */

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const mascots = await loadTeamMascots();
  return NextResponse.json({ mascots, blobConfigured: blobConfigured() });
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json({ error: "CSM team only" }, { status: 403 });
  }
  if (!blobConfigured()) {
    return NextResponse.json(
      {
        error:
          "Image storage isn't configured yet — Vercel Blob needs to be enabled on this project. Ask an admin to flip it on in the Vercel dashboard (Storage → Blob).",
      },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }
  const file = form.get("file");
  const label = String(form.get("label") ?? "").trim().slice(0, 120);
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "No file uploaded — pick an image" },
      { status: 400 }
    );
  }
  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json(
      {
        error: `Unsupported image type ${file.type || "(unknown)"} — png, jpg, webp, or gif only.`,
      },
      { status: 400 }
    );
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `File size ${file.size} bytes; must be 1..${MAX_BYTES} bytes (≤ 4 MB).`,
      },
      { status: 400 }
    );
  }

  // Build a stable blob pathname. Vercel Blob auto-randomizes if a
  // collision occurs (when addRandomSuffix is true, the default) —
  // we keep that on so two uploads named "max.png" coexist cleanly.
  const ext = (file.name?.split(".").pop() ?? "png").toLowerCase().slice(0, 6);
  const safeBase =
    (file.name ?? "mascot")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .slice(0, 40) || "mascot";
  const pathname = `team-mascots/${safeBase}.${ext}`;

  let putResult;
  try {
    putResult = await put(pathname, file, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: true,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: `Upload to Vercel Blob failed: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      },
      { status: 500 }
    );
  }

  const mascot: TeamMascot = {
    id: crypto.randomUUID(),
    url: putResult.url,
    label: label || safeBase,
    blob_pathname: putResult.pathname,
    size_bytes: file.size,
    added_by: email,
    added_at: new Date().toISOString(),
  };
  await addTeamMascot(mascot);
  return NextResponse.json({ mascot });
}

export async function DELETE(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json({ error: "CSM team only" }, { status: 403 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const { removed } = await removeTeamMascot(id);
  if (removed && blobConfigured()) {
    // Best-effort blob delete — if it fails (already gone, perm
    // mismatch), the KV entry is already gone so the cycle won't
    // surface it again. Don't fail the response on this.
    try {
      await del(removed.url);
    } catch (e) {
      console.warn("[team-mascots] blob delete failed", {
        id,
        url: removed.url,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return NextResponse.json({ ok: true });
}
