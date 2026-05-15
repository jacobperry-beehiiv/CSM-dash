import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-CSM run state for the customer-signals batch endpoint. Lets the
 * Claude skill answer "when did I last successfully run for this CSM?"
 * without scanning the signals array.
 *
 * On a happy POST we persist the run_metadata.completed_at and
 * run_metadata.run_id. The skill can fetch it via GET /state on cold
 * starts (working dir wiped, first install) to pick a sensible
 * lookback start.
 */

const KEY_PREFIX = "customer-signals-state/";

export interface RunState {
  csm_email: string;
  /** ISO 8601 — completed_at of the last successful run. */
  last_successful_run: string;
  /** Caller-supplied run id (ULID, UUID, whatever). */
  last_run_id: string;
}

function keyFor(csmEmail: string): string {
  return KEY_PREFIX + csmEmail.toLowerCase();
}

export async function getRunState(csmEmail: string): Promise<RunState | null> {
  if (!csmEmail) return null;
  return (await kvGet<RunState>(keyFor(csmEmail))) ?? null;
}

export async function setRunState(state: RunState): Promise<void> {
  if (!state.csm_email) {
    throw new Error("csm_email is required to persist run state.");
  }
  // Normalize the stored email — keys are case-insensitive, the payload
  // we return keeps the original casing for display.
  await kvSet(keyFor(state.csm_email), {
    ...state,
    csm_email: state.csm_email,
  });
}
