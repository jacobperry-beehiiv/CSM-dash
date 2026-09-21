import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";

export const dynamic = "force-dynamic";
// 1 hour on the CDN, 5 min on the browser — the underlying logo
// rarely changes and the proxy only exists to add CORS headers to
// what beehiiv's public CDN already serves.
export const revalidate = 3600;

/**
 * GET /api/qbr-charts/logo/[publication_id]
 *
 * Proxies a publication's logo through this origin so html-to-image
 * can inline it in exported QBR PNGs — beehiiv's media CDN doesn't
 * return Access-Control-Allow-Origin, which taints a canvas that
 * embeds the image and makes toDataURL throw.
 *
 * Auth: signed-in session. We do NOT scope by CSM here; any
 * signed-in user with a workspace_id can see the workspace's
 * publication logos, matching every other publication-scoped
 * QBR read in this file tree.
 *
 * Flow:
 *   1. Look up `publications.logo` for the given id (Postgres via
 *      Metabase).
 *   2. Fetch `https://media.beehiiv.com/uploads/publication/logo/<id>/<filename>`.
 *   3. Stream the response body back with the CDN's content-type
 *      + a cache header so repeat exports don't re-fetch.
 *
 * Returns 404 when the publication has no logo set or the CDN
 * couldn't find it (the caller should fall back to the beehiiv
 * badge already on the card).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEEHIIV_MEDIA_ROOT = "https://media.beehiiv.com/uploads/publication/logo";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ publication_id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const { publication_id } = await params;
  const id = publication_id.trim().toLowerCase();
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Bad publication_id" }, { status: 400 });
  }

  let filename: string | null;
  try {
    const rows = (await runNativeQuery(
      DB.POSTGRES,
      `SELECT logo AS filename FROM publications WHERE id = '${id}'::uuid LIMIT 1`
    )) as Array<{ filename: string | null }>;
    filename = rows[0]?.filename ?? null;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Metabase lookup failed" },
      { status: 502 }
    );
  }
  if (!filename) {
    return NextResponse.json({ error: "No logo set" }, { status: 404 });
  }

  const cdnUrl = `${BEEHIIV_MEDIA_ROOT}/${id}/${encodeURIComponent(filename)}`;
  const upstream = await fetch(cdnUrl, {
    // beehiiv media CDN is public — no auth needed.
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `CDN ${upstream.status}` },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }
  const contentType =
    upstream.headers.get("content-type") ?? "application/octet-stream";
  return new NextResponse(upstream.body, {
    headers: {
      "content-type": contentType,
      // 1h CDN cache + 5min browser cache — the underlying logo
      // rarely changes; if it does, a hard reload (or the export
      // flow which uses no-store) will pick up the new one.
      "cache-control": "public, max-age=300, s-maxage=3600",
    },
  });
}
