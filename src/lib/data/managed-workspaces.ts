import { kvGet, kvSet } from "../storage/kv";

/**
 * Parent → managed workspace links.
 *
 * ─── Why this exists ──────────────────────────────────────────────
 * The customer book is assembled HubSpot-first: q10600 selects
 * `from hubspot_csm_companies`, which is filtered to companies that
 * have a CSM assigned. Beehiiv org data is then LEFT JOINed on
 * `stripe_customer_id`. That shape works for accounts that ARE the
 * commercial relationship, and it cannot represent a workspace that
 * isn't one — an enterprise customer running a second, non-enterprise
 * workspace on the side has no HubSpot company of its own, so it has
 * no CSM, so it never enters the book. No amount of dashboard
 * filtering surfaces it, because it was never in the result set.
 *
 * So the link is declared HERE rather than upstream: a CSM says "this
 * workspace belongs to that account", and the child's metrics are read
 * live from ClickHouse by workspace_id (see child-workspace-metrics.ts)
 * with no HubSpot or Metabase-snapshot dependency. A link therefore
 * takes effect on the next render rather than waiting on the twice-
 * daily sync — or on the Redshift replica, which has been observed
 * running days behind.
 *
 * ─── Deliberately NOT a rollup ────────────────────────────────────
 * Child figures are displayed nested under the parent and are not
 * aggregated into the parent's ARR, subscriber utilization or at-risk
 * scoring. Rolling them up would silently change numbers CSMs already
 * work from, and would mean every engine had to learn about this
 * relationship. Display first; rollup is a separate decision.
 *
 * ─── Storage ──────────────────────────────────────────────────────
 * Single KV row keyed `csm:child-workspaces:v1`, value
 * Record<parent_workspace_id, ManagedWorkspaceLink[]>. Read-modify-write
 * with no locking, like every other blob here — the list is small and
 * edits are rare and human-paced, so the clobber window is academic.
 */

// Storage key keeps the original name on purpose. The feature was
// renamed to "Managed workspaces" after shipping; renaming the key
// would orphan any links already written under the old one for no
// user-visible benefit.
const KEY = "csm:child-workspaces:v1";

export interface ManagedWorkspaceLink {
  /** beehiiv organization id of the managed workspace. */
  workspace_id: string;
  /** Name captured at link time, so the UI has something to show
   *  before live metrics land (and if the child is later deleted in
   *  beehiiv, so the row doesn't render as a bare UUID). */
  workspace_name: string | null;
  linked_by: string;
  linked_at: string;
  /** Optional free-text from the CSM — "their sponsor-facing brand",
   *  "test workspace", etc. */
  note?: string | null;
}

export type ManagedWorkspaceMap = Record<string, ManagedWorkspaceLink[]>;

export async function loadManagedWorkspaces(): Promise<ManagedWorkspaceMap> {
  return (await kvGet<ManagedWorkspaceMap>(KEY)) ?? {};
}

export async function getManagedWorkspaces(
  parentWorkspaceId: string | null | undefined
): Promise<ManagedWorkspaceLink[]> {
  if (!parentWorkspaceId) return [];
  const map = await loadManagedWorkspaces();
  return map[parentWorkspaceId] ?? [];
}

/**
 * Link a child to a parent. Idempotent on `workspace_id` — re-linking
 * an existing child updates its captured name/note rather than
 * creating a duplicate row.
 *
 * Refuses to link a workspace to itself, which is the one input
 * mistake that would render an infinite-looking nest.
 */
export async function addManagedWorkspace(
  parentWorkspaceId: string,
  link: ManagedWorkspaceLink
): Promise<ManagedWorkspaceLink[]> {
  if (!parentWorkspaceId || !link.workspace_id) {
    throw new Error("parent and managed workspace ids are both required");
  }
  if (parentWorkspaceId === link.workspace_id) {
    throw new Error("a workspace can't be its own child");
  }
  const map = { ...(await loadManagedWorkspaces()) };
  const current = [...(map[parentWorkspaceId] ?? [])];
  const existing = current.findIndex(
    (c) => c.workspace_id === link.workspace_id
  );
  if (existing >= 0) current[existing] = { ...current[existing], ...link };
  else current.push(link);
  map[parentWorkspaceId] = current;
  await kvSet(KEY, map);
  return current;
}

export async function removeManagedWorkspace(
  parentWorkspaceId: string,
  childWorkspaceId: string
): Promise<ManagedWorkspaceLink[]> {
  const map = { ...(await loadManagedWorkspaces()) };
  const next = (map[parentWorkspaceId] ?? []).filter(
    (c) => c.workspace_id !== childWorkspaceId
  );
  if (next.length === 0) delete map[parentWorkspaceId];
  else map[parentWorkspaceId] = next;
  await kvSet(KEY, map);
  return next;
}

/**
 * Every workspace currently linked as a child, across all parents.
 *
 * Used to stop a workspace being claimed by two different accounts —
 * which would be a data-entry error rather than a real relationship,
 * and would show the same subscriber numbers under two customers.
 */
export async function findExistingParent(
  childWorkspaceId: string
): Promise<string | null> {
  const map = await loadManagedWorkspaces();
  for (const [parentId, links] of Object.entries(map)) {
    if (links.some((l) => l.workspace_id === childWorkspaceId)) return parentId;
  }
  return null;
}
