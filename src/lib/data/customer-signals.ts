import { kvGet, kvSet } from "../storage/kv";

/**
 * Customer signals are append-or-upsert records of context the dashboard
 * surfaces per workspace. Notes, action items, risk signals, touchpoints,
 * goals, contact updates, feature requests/adoption, periodic customer
 * snapshots — anything the Claude skill (or a CSM on their own) wants
 * remembered against a workspace_id.
 *
 * Stored as an array per workspace at KV key `customer-signals/<id>`,
 * capped at MAX_PER_WORKSPACE most-recent records to keep payload sizes
 * sane.
 *
 * Idempotency contract:
 *   • Callers may supply a deterministic `signal_id`. When present and
 *     it matches an existing entry in the workspace's list, we upsert
 *     (replace in place); otherwise we append.
 *   • When `signal_id` is absent we generate a random `id` and always
 *     append (the legacy single-signal path).
 */

/**
 * Kind taxonomy. The full set covers everything the Claude enterprise-
 * customer-context skill produces; the first half (note / win / context /
 * meeting) is grandfathered from the original single-signal endpoint so
 * pre-existing callers keep working.
 */
export type SignalKind =
  // Original taxonomy (kept for back-compat with the v1 skill scaffold).
  | "note"
  | "win"
  | "context"
  | "meeting"
  // Skill v1.0 taxonomy.
  | "touchpoint"
  | "goal"
  | "use_case"
  | "feature_request"
  | "feature_adoption"
  | "contact_update"
  | "action_item"
  | "risk_signal"
  | "customer_overview"
  // Auto-emitted by mutation endpoints when a CSM takes a bulk OR
  // per-row action against the workspace. Short, dated entries like
  // "Past-due email sent" / "Marked Skip" / "Pinged on Slack
  // (renewals)" — see appendActionLog() below. Renders in the
  // CompanyNotes panel alongside hand-typed notes, but visually
  // distinct (muted style, system icon, no edit affordances).
  | "action_log";

export const VALID_SIGNAL_KINDS: SignalKind[] = [
  "note",
  "win",
  "context",
  "meeting",
  "touchpoint",
  "goal",
  "use_case",
  "feature_request",
  "feature_adoption",
  "contact_update",
  "action_item",
  "risk_signal",
  "customer_overview",
  "action_log",
];

export interface CustomerSignal {
  /**
   * Primary key within a workspace. Set to the caller-supplied
   * `signal_id` when present (deterministic — re-runs upsert in place),
   * otherwise a random fallback for the legacy append-only path.
   */
  id: string;
  workspace_id: string;
  kind: SignalKind;
  text: string;
  source?: string;
  created_by?: string;
  /** When this record was first persisted server-side (ISO 8601). */
  created_at: string;
  /** When the underlying event actually happened in the real world (ISO
   *  8601). Distinct from created_at — a touchpoint posted later might
   *  describe an email sent yesterday. Falls back to created_at when the
   *  caller didn't supply one. */
  event_at?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

const KEY_PREFIX = "customer-signals/";
const MAX_PER_WORKSPACE = 500;

export function keyFor(workspaceId: string): string {
  return KEY_PREFIX + workspaceId;
}

function randomId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Cap the per-workspace array. Sorted newest-first by `event_at`
 * (falling back to `created_at`) so when we truncate we keep the most
 * recent slice.
 */
function trim(list: CustomerSignal[]): CustomerSignal[] {
  const sorted = [...list].sort((a, b) => {
    const ad = Date.parse(a.event_at ?? a.created_at) || 0;
    const bd = Date.parse(b.event_at ?? b.created_at) || 0;
    return bd - ad;
  });
  return sorted.slice(0, MAX_PER_WORKSPACE);
}

export async function listSignals(
  workspaceId: string
): Promise<CustomerSignal[]> {
  const list = (await kvGet<CustomerSignal[]>(keyFor(workspaceId))) ?? [];
  const now = Date.now();
  // Filter out expired entries on read — keeps the visible set clean
  // without needing a sweeper.
  return list.filter((s) => {
    if (!s.expires_at) return true;
    const exp = new Date(s.expires_at).getTime();
    return Number.isFinite(exp) && exp > now;
  });
}

export interface AppendInput {
  /** Deterministic id from the caller. When present, upsert by this key. */
  signal_id?: string;
  workspace_id: string;
  kind: SignalKind;
  text: string;
  source?: string;
  created_by?: string;
  created_at?: string;
  event_at?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export type UpsertAction = "created" | "updated";

export interface AppendResult {
  signal: CustomerSignal;
  action: UpsertAction;
}

/**
 * Single-signal append/upsert. Kept as the building block for both the
 * legacy single-signal POST and the new batch path. Pass `signal_id` to
 * upsert; omit it for the append-with-random-id behaviour.
 */
export async function appendSignal(input: AppendInput): Promise<CustomerSignal> {
  const { signal } = await upsertSignal(input);
  return signal;
}

export async function upsertSignal(input: AppendInput): Promise<AppendResult> {
  const list =
    (await kvGet<CustomerSignal[]>(keyFor(input.workspace_id))) ?? [];
  const now = new Date().toISOString();
  const id = input.signal_id ?? randomId();
  const existing = input.signal_id
    ? list.find((s) => s.id === id) ?? null
    : null;
  const merged: CustomerSignal = {
    id,
    workspace_id: input.workspace_id,
    kind: input.kind,
    text: input.text,
    source: input.source,
    created_by: input.created_by,
    // Preserve original created_at on update; use new one on create.
    created_at: existing?.created_at ?? input.created_at ?? now,
    event_at: input.event_at,
    expires_at: input.expires_at,
    metadata: input.metadata,
  };
  const without = existing ? list.filter((s) => s.id !== id) : list;
  const next = trim([merged, ...without]);
  await kvSet(keyFor(input.workspace_id), next);
  return { signal: merged, action: existing ? "updated" : "created" };
}

/**
 * Apply a batch of signals to a single workspace's KV row. Cuts down on
 * KV round-trips when a single POST carries many signals against the
 * same customer — one read-modify-write per workspace instead of one
 * per signal.
 */
export async function upsertSignalsForWorkspace(
  workspaceId: string,
  inputs: AppendInput[]
): Promise<AppendResult[]> {
  if (inputs.length === 0) return [];
  const list = (await kvGet<CustomerSignal[]>(keyFor(workspaceId))) ?? [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const results: AppendResult[] = [];
  const now = new Date().toISOString();
  for (const input of inputs) {
    const id = input.signal_id ?? randomId();
    const existing = input.signal_id ? byId.get(id) ?? null : null;
    const merged: CustomerSignal = {
      id,
      workspace_id: workspaceId,
      kind: input.kind,
      text: input.text,
      source: input.source,
      created_by: input.created_by,
      created_at: existing?.created_at ?? input.created_at ?? now,
      event_at: input.event_at,
      expires_at: input.expires_at,
      metadata: input.metadata,
    };
    byId.set(id, merged);
    results.push({ signal: merged, action: existing ? "updated" : "created" });
  }
  const next = trim([...byId.values()]);
  await kvSet(keyFor(workspaceId), next);
  return results;
}

export async function deleteSignal(
  workspaceId: string,
  signalId: string
): Promise<boolean> {
  const list = (await kvGet<CustomerSignal[]>(keyFor(workspaceId))) ?? [];
  const next = list.filter((s) => s.id !== signalId);
  if (next.length === list.length) return false;
  await kvSet(keyFor(workspaceId), next);
  return true;
}

/** Input shape for the batched action-log writer. One entry per
 *  workspace_id; multiple entries for the same workspace_id are
 *  fine (each appears as its own signal row, but they share one KV
 *  write per workspace). */
export interface ActionLogInput {
  workspace_id: string;
  /** Short human-readable text — "Past-due email sent" / "Marked
   *  Reach out approved" / "Pinged on Slack (renewals)". Kept short
   *  on purpose so the CompanyNotes feed stays scannable. */
  text: string;
  /** Session email of the CSM who triggered the action. Stamped onto
   *  the signal so the panel can render `— Jacob` next to the entry. */
  created_by?: string;
  /** Free-form discriminator for future filtering (e.g. "show only
   *  email-sent events"). Conventional values match the endpoint
   *  table in the plan: "past_due_email", "ping_slack",
   *  "review_state_change", etc. */
  action_kind?: string;
  /** Anything else the endpoint wants to surface — template id,
   *  state value, channel destination, etc. Merged into metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Append one auto-event per workspace to the customer-signals feed.
 *
 * Used by every mutation endpoint that wants to leave an audit trail
 * on the affected customers — bulk email sends, bulk review-state
 * changes, Slack pings, etc. Each event is a CustomerSignal with
 * `kind: "action_log"`, distinguishing it from hand-typed CSM notes
 * (`kind: "note"`) in the same feed.
 *
 * Failure semantics: never throws. An action-log write failure must
 * not abort the underlying mutation — the user already saw a success
 * toast from the primary action, and a failed audit line is a logging
 * problem, not a data correctness problem. Failures are console.warn'd
 * with the workspace + text for forensics.
 *
 * Cost: one KV write per workspace (each workspace is its own KV
 * row), regardless of how many events target the same workspace in
 * one call. Events for distinct workspaces are independent writes.
 */
export async function appendActionLog(
  events: ActionLogInput[]
): Promise<void> {
  if (events.length === 0) return;
  // Group by workspace so multiple events for the same workspace in
  // one call still cost a single KV write.
  const byWorkspace = new Map<string, ActionLogInput[]>();
  for (const e of events) {
    if (!e.workspace_id) continue;
    const arr = byWorkspace.get(e.workspace_id) ?? [];
    arr.push(e);
    byWorkspace.set(e.workspace_id, arr);
  }
  for (const [workspaceId, batch] of byWorkspace.entries()) {
    try {
      const inputs: AppendInput[] = batch.map((e) => ({
        workspace_id: workspaceId,
        kind: "action_log",
        text: e.text,
        source: "action_log",
        created_by: e.created_by,
        metadata: {
          action_kind: e.action_kind ?? "unspecified",
          ...(e.metadata ?? {}),
        },
      }));
      await upsertSignalsForWorkspace(workspaceId, inputs);
    } catch (e) {
      console.warn("[customer-signals] action_log write failed", {
        workspace_id: workspaceId,
        count: batch.length,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }
}

/**
 * Merge new fields into an existing signal's `metadata` bag. Used when
 * we need to stamp a side-effect onto an already-persisted signal (e.g.
 * the HubSpot note id returned after the user clicks "Post to HubSpot"
 * on a dashboard note). Leaves the rest of the signal untouched —
 * including `text`, `kind`, and the timestamps — so audit-style fields
 * stay stable.
 *
 * Returns the updated signal, or null when no signal with that id
 * exists in the workspace's row.
 */
export async function mergeSignalMetadata(
  workspaceId: string,
  signalId: string,
  patch: Record<string, unknown>
): Promise<CustomerSignal | null> {
  const list = (await kvGet<CustomerSignal[]>(keyFor(workspaceId))) ?? [];
  let updated: CustomerSignal | null = null;
  const next = list.map((s) => {
    if (s.id !== signalId) return s;
    const merged: CustomerSignal = {
      ...s,
      metadata: { ...(s.metadata ?? {}), ...patch },
    };
    updated = merged;
    return merged;
  });
  if (!updated) return null;
  await kvSet(keyFor(workspaceId), next);
  return updated;
}
