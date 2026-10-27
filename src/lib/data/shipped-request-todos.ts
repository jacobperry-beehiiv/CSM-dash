import { applyTodoOps, getTodosForUser } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import { getConfigForSource, applyTemplate } from "./todo-source-configs";
import { resolveTodoTiming } from "./todo-source-configs-types";

/**
 * Create the "close the loop" to-do for a shipped request, unless one
 * is already open for that (workspace, issue).
 *
 * ─── Why this is shared ───────────────────────────────────────────
 * The weekly digest creates these in a batch per CSM. Confirming a
 * ship by hand needs the SAME to-do — a CSM who vouches for a ship
 * shouldn't have to wait until Monday for the follow-up to appear,
 * which is the whole point of confirming it.
 *
 * Both paths therefore go through this, so the phrasing, the timing
 * config and the dedupe rule can't drift apart. The dedupe is the
 * important half: it keys on `workspace_id:linear_issue_id` across the
 * CSM's OPEN `enterprise_request_shipped` to-dos, which is exactly
 * what the digest checks. Create one here and the digest skips it;
 * let the digest create it first and this is a no-op.
 *
 * Returns whether a to-do was actually created, so callers can report
 * honestly rather than implying one appeared when it was already there.
 */
export async function ensureShippedRequestTodo(args: {
  csmEmail: string;
  csmHandle?: string | null;
  row: {
    workspace_id: string;
    workspace_name?: string | null;
    linear_issue_id: string;
    linear_identifier: string;
    title: string;
    url: string;
    ship_url?: string | null;
    promoted_at?: string | null;
  };
}): Promise<{ created: boolean; reason?: string }> {
  const { csmEmail, row } = args;
  if (!csmEmail) return { created: false, reason: "no CSM email" };

  const userKey = userKeyFromEmail(csmEmail);
  const existing = await getTodosForUser(userKey);
  const key = `${row.workspace_id}:${row.linear_issue_id}`;
  const alreadyOpen = existing.some(
    (t) =>
      t.source === "enterprise_request_shipped" &&
      t.completed_at === null &&
      `${t.source_meta?.workspace_id ?? ""}:${t.source_meta?.linear_issue_id ?? ""}` ===
        key
  );
  if (alreadyOpen) return { created: false, reason: "already open" };

  const cfg = await getConfigForSource("enterprise_request_shipped");
  const timing = resolveTodoTiming(cfg, null);
  const nowIso = new Date().toISOString();
  const title = applyTemplate(cfg.phrasing_template, {
    company_name: row.workspace_name ?? row.workspace_id,
    workspace_name: row.workspace_name ?? null,
    csm_name: (args.csmHandle ?? "").replace(/_/g, " "),
    request_title: row.title,
    request_identifier: row.linear_identifier,
  }).trim();

  const shippedOn = (row.promoted_at ?? nowIso).slice(0, 10);
  const todo: PersonalTodo = {
    id: newTodoId(),
    title: title || `Close the loop on ${row.linear_identifier}`,
    details:
      `${row.linear_identifier}: ${row.title}\n` +
      `Linear: ${row.url}\n` +
      (row.ship_url ? `Ship post: ${row.ship_url}\n` : "") +
      `\nShipped ${shippedOn} — draft the close-the-loop note from the ` +
      `Feature requests tab, then tick Notified there so it drops off ` +
      `the weekly digest.`,
    due_date: shiftYmd(nowIso.slice(0, 10), timing.due_offset_days ?? 3),
    surface_at:
      timing.surface_offset_days != null && timing.surface_offset_days > 0
        ? shiftYmd(nowIso.slice(0, 10), timing.surface_offset_days)
        : null,
    priority: null,
    source: "enterprise_request_shipped",
    source_meta: {
      workspace_id: row.workspace_id,
      linear_issue_id: row.linear_issue_id,
      linear_identifier: row.linear_identifier,
    },
    completed_at: null,
    remind_via_slack: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
  await applyTodoOps(userKey, [{ type: "add", todo }]);
  return { created: true };
}

/** Shift a YYYY-MM-DD string by whole days. Mirrors the digest's own
 *  helper — kept local so this module has no engine import. */
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
