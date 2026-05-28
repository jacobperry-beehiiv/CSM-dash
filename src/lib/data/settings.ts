import type { RiskFlagCode } from "../types";
import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULTS,
  PAST_DUE_CHANNEL_ID,
  type SettingsShape,
  type SlackChannel,
  type SlackSettings,
} from "./settings-types";

export type { FlagPeriod, SettingsShape } from "./settings-types";
export { DEFAULTS } from "./settings-types";

const KEY = "settings";

let cache: SettingsShape | null = null;

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
  if (cache) return cache;
  const stored = await kvGet<Partial<SettingsShape>>(KEY);
  cache = stored ? merge(stored) : DEFAULTS;
  return cache;
}

export async function saveSettings(
  next: SettingsShape
): Promise<SettingsShape> {
  await kvSet(KEY, next);
  cache = next;
  return next;
}

export function reRaisePeriodMs(
  settings: SettingsShape,
  code: RiskFlagCode
): number {
  const days = settings.flags[code]?.re_raise_days ?? 14;
  return days * 86_400_000;
}
