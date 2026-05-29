import type { RiskFlagCode } from "../types";
import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULTS,
  PAST_DUE_CHANNEL_ID,
  PROACTIVE_OUTREACH_CHANNEL_ID,
  type SettingsShape,
  type SlackChannel,
  type SlackSettings,
} from "./settings-types";

export type { FlagPeriod, SettingsShape } from "./settings-types";
export { DEFAULTS } from "./settings-types";

const KEY = "settings";

// In-memory cache was a small speedup but turned into a footgun: when
// the migration logic gets new fallbacks (e.g. a newly-seeded channel
// in DEFAULTS), warm isolates that hydrated before the deploy keep
// returning the pre-migration shape forever. Drop the cache and pay
// the KV round-trip on every read — settings JSON is tiny and reads
// are infrequent.
//
// (Earlier saves also overwrote the cache with the raw saved value
// rather than the migration-merged shape, which compounded the
// problem.)

/**
 * Upgrade the stored slack settings into the current shape. Stored
 * payloads from before the channels[] migration carry the now-deprecated
 * `past_due_channel` and `past_due_template` keys — we copy those into
 * a `past_due` channel entry the first time we hydrate, then leave the
 * old keys in place for back-compat with any in-flight readers.
 */
function migrateSlack(stored: Partial<SlackSettings> | undefined): SlackSettings {
  const merged: SlackSettings = {
    ...DEFAULTS.slack,
    ...(stored ?? {}),
    channels: Array.isArray(stored?.channels) ? [...stored.channels] : [],
    csm_user_ids: {
      ...DEFAULTS.slack.csm_user_ids,
      ...(stored?.csm_user_ids ?? {}),
    },
  };

  // Backfill the past-due channel from the deprecated single-channel
  // fields when channels[] is missing or empty. Run unconditionally so
  // newly-deployed envs get the seeded default template too.
  const hasPastDue = merged.channels.some((c) => c.id === PAST_DUE_CHANNEL_ID);
  if (!hasPastDue) {
    const seed: SlackChannel = {
      id: PAST_DUE_CHANNEL_ID,
      label: "Past-due alerts",
      channel_id: stored?.past_due_channel ?? "",
      template:
        stored?.past_due_template ??
        DEFAULTS.slack.channels.find((c) => c.id === PAST_DUE_CHANNEL_ID)
          ?.template ??
        "",
    };
    merged.channels = [seed, ...merged.channels];
  }
  // Same backfill for proactive_outreach — added to DEFAULTS in a
  // later commit, so KVs saved before that won't carry an entry.
  // Without this seed, the /settings/slack page can't surface the
  // entry to edit and admins end up creating a channel with the
  // wrong id via the "Add channel" flow (slugified from the label).
  const hasProactive = merged.channels.some(
    (c) => c.id === PROACTIVE_OUTREACH_CHANNEL_ID
  );
  if (!hasProactive) {
    const defaultProactive = DEFAULTS.slack.channels.find(
      (c) => c.id === PROACTIVE_OUTREACH_CHANNEL_ID
    );
    if (defaultProactive) {
      merged.channels.push({ ...defaultProactive });
    }
  }
  return merged;
}

function merge(partial: Partial<SettingsShape>): SettingsShape {
  return {
    flags: { ...DEFAULTS.flags, ...(partial.flags ?? {}) } as SettingsShape["flags"],
    thresholds: {
      ...DEFAULTS.thresholds,
      ...(partial.thresholds ?? {}),
    } as SettingsShape["thresholds"],
    slack: migrateSlack(partial.slack),
    am: { ...DEFAULTS.am, ...(partial.am ?? {}) },
  };
}

export async function loadSettings(): Promise<SettingsShape> {
  const stored = await kvGet<Partial<SettingsShape>>(KEY);
  return stored ? merge(stored) : DEFAULTS;
}

export async function saveSettings(
  next: SettingsShape
): Promise<SettingsShape> {
  await kvSet(KEY, next);
  return next;
}

export function reRaisePeriodMs(
  settings: SettingsShape,
  code: RiskFlagCode
): number {
  const days = settings.flags[code]?.re_raise_days ?? 14;
  return days * 86_400_000;
}
