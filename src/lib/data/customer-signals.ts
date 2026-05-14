import { kvGet, kvSet } from "../storage/kv";

/**
 * Customer signals are append-only records of context a CSM (or a
 * Claude skill on their behalf) wants surfaced on the dashboard for a
 * given customer. Notes, action items, wins, risk-context, meeting
 * summaries — anything worth remembering against a workspace_id.
 *
 * Stored as an array per workspace at KV key `customer-signals/<id>`,
 * capped at MAX_PER_WORKSPACE most-recent records to keep payload sizes
 * sane.
 */

export type SignalKind =
  | "note"
  | "risk_signal"
  | "win"
  | "context"
  | "action_item"
  | "meeting";

export interface CustomerSignal {
  /** Stable random id so the UI can dedupe / reference / dismiss. */
  id: string;
  workspace_id: string;
  kind: SignalKind;
  text: string;
  source?: string;
  created_by?: string;
  created_at: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

const KEY_PREFIX = "customer-signals/";
const MAX_PER_WORKSPACE = 50;

export function keyFor(workspaceId: string): string {
  return KEY_PREFIX + workspaceId;
}

function randomId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
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
  workspace_id: string;
  kind: SignalKind;
  text: string;
  source?: string;
  created_by?: string;
  created_at?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export async function appendSignal(input: AppendInput): Promise<CustomerSignal> {
  const list = (await kvGet<CustomerSignal[]>(keyFor(input.workspace_id))) ?? [];
  const signal: CustomerSignal = {
    id: randomId(),
    workspace_id: input.workspace_id,
    kind: input.kind,
    text: input.text,
    source: input.source,
    created_by: input.created_by,
    created_at: input.created_at ?? new Date().toISOString(),
    expires_at: input.expires_at,
    metadata: input.metadata,
  };
  // Prepend so callers see newest-first; cap the list size.
  const next = [signal, ...list].slice(0, MAX_PER_WORKSPACE);
  await kvSet(keyFor(input.workspace_id), next);
  return signal;
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
