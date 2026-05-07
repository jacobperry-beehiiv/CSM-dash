import { DB, runNativeQuery } from "../metabase";

/**
 * Batched "last web-only published post" lookup — one ClickHouse query
 * returns the most recent post published with a web destination per
 * organization. Used by the at-risk table so CSMs can spot accounts that
 * are sending email but never publishing to the web (or vice versa).
 *
 * Web-only posts are detected via posts.audience or posts.platform — the
 * exact column name varies by deployment, so we filter on `web_published_at`
 * being non-null which is the most reliable signal across the swarm
 * clickhouse mirror.
 */

export interface LastPostRow {
  organization_id: string;
  last_post_at: string | null;
  last_post_title: string | null;
}

function quoteList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

const cache = new Map<string, { expires: number; data: LastPostRow }>();
const TTL_MS = 10 * 60 * 1000;

export async function rollupLastWebPosts(
  organizationIds: string[]
): Promise<Map<string, LastPostRow>> {
  const result = new Map<string, LastPostRow>();
  const now = Date.now();
  const stale: string[] = [];

  for (const id of organizationIds) {
    const hit = cache.get(id);
    if (hit && hit.expires > now) {
      result.set(id, hit.data);
    } else {
      stale.push(id);
    }
  }

  if (stale.length === 0) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < stale.length; i += 500) {
    chunks.push(stale.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    const sql = `
      SELECT
        toString(o.id) AS organization_id,
        toString(argMax(p.web_title, p.web_published_at)) AS last_post_title,
        toString(MAX(p.web_published_at)) AS last_post_at
      FROM swarm_clickpipes.organizations o
      JOIN swarm_clickpipes.publications pub
        ON pub.organization_id = o.id
        AND pub.deleted_at IS NULL
      LEFT JOIN swarm_clickpipes.posts p
        ON p.publication_id = pub.id
        AND p.web_published_at IS NOT NULL
        AND p.deleted_at IS NULL
      WHERE o.id IN (${quoteList(chunk)})
      GROUP BY o.id
    `;
    try {
      const rows = (await runNativeQuery(
        DB.CLICKHOUSE_ADHOC,
        sql
      )) as unknown as Array<Record<string, unknown>>;
      for (const row of rows) {
        const orgId = String(row.organization_id);
        const r: LastPostRow = {
          organization_id: orgId,
          last_post_at: row.last_post_at ? String(row.last_post_at) : null,
          last_post_title: row.last_post_title
            ? String(row.last_post_title)
            : null,
        };
        cache.set(orgId, { expires: now + TTL_MS, data: r });
        result.set(orgId, r);
      }
      // Orgs not in result row → cache as null
      for (const id of chunk) {
        if (!result.has(id)) {
          const r: LastPostRow = {
            organization_id: id,
            last_post_at: null,
            last_post_title: null,
          };
          cache.set(id, { expires: now + TTL_MS, data: r });
          result.set(id, r);
        }
      }
    } catch (e) {
      // ClickHouse outages shouldn't kill the at-risk view — mark missing
      // rows as null and move on. The UI already handles missing data.
      console.error(
        "[last-post-batch] query failed:",
        e instanceof Error ? e.message : e
      );
      for (const id of chunk) {
        if (!result.has(id)) {
          result.set(id, {
            organization_id: id,
            last_post_at: null,
            last_post_title: null,
          });
        }
      }
    }
  }

  return result;
}
