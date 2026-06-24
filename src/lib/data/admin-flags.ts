import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULT_FLAGS,
  type AdminFlags,
  type FeatureId,
} from "./admin-flags-types";

/**
 * Server-only store for admin feature flags. Types + defaults live
 * in admin-flags-types.ts so client components can read the shape
 * without pulling in KV → postgres → Node deps.
 *
 * Single KV row at `csm:admin-flags:v1` so a flag flip is one tiny
 * write. We never expect this row to grow large — half a dozen
 * features × a handful of allow-listed emails each.
 */

const KEY = "csm:admin-flags:v1";

export async function loadAdminFlags(): Promise<AdminFlags> {
  const stored = await kvGet<Partial<AdminFlags>>(KEY);
  if (!stored?.features) return DEFAULT_FLAGS;
  // Merge stored values over defaults so a newly-added feature flag
  // automatically inherits the default state on the first read after
  // deploy (instead of returning undefined and breaking the gate
  // check downstream).
  const merged: AdminFlags = {
    features: { ...DEFAULT_FLAGS.features, ...stored.features },
  };
  return merged;
}

export async function saveAdminFlags(next: AdminFlags): Promise<AdminFlags> {
  // Defensive: normalize allow_emails — lowercase + dedupe + drop
  // empties. Prevents the picker from saving "" or duplicates that
  // would inflate the visible count without changing semantics.
  const sanitized: AdminFlags = {
    features: {} as AdminFlags["features"],
  };
  for (const [id, gate] of Object.entries(next.features)) {
    const emails = Array.from(
      new Set(
        (gate.allowed_emails ?? [])
          .map((e) => (e ?? "").trim().toLowerCase())
          .filter((e) => e.length > 0)
      )
    );
    sanitized.features[id as FeatureId] = {
      restricted: Boolean(gate.restricted),
      allowed_emails: emails,
    };
  }
  // Fill in defaults for any flags the client didn't include —
  // protects against partial writes that would otherwise drop
  // existing config.
  for (const [id, def] of Object.entries(DEFAULT_FLAGS.features)) {
    if (!sanitized.features[id as FeatureId]) {
      sanitized.features[id as FeatureId] = { ...def };
    }
  }
  await kvSet<AdminFlags>(KEY, sanitized);
  return sanitized;
}
