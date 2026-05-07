import type { RiskFlagCode } from "../types";
import { kvGet, kvSet } from "../storage/kv";
import { DEFAULTS, type SettingsShape } from "./settings-types";

export type { FlagPeriod, SettingsShape } from "./settings-types";
export { DEFAULTS } from "./settings-types";

const KEY = "settings";

let cache: SettingsShape | null = null;

function merge(partial: Partial<SettingsShape>): SettingsShape {
  return {
    flags: { ...DEFAULTS.flags, ...(partial.flags ?? {}) } as SettingsShape["flags"],
    thresholds: {
      ...DEFAULTS.thresholds,
      ...(partial.thresholds ?? {}),
    } as SettingsShape["thresholds"],
    slack: {
      ...DEFAULTS.slack,
      ...(partial.slack ?? {}),
      csm_user_ids: {
        ...DEFAULTS.slack.csm_user_ids,
        ...(partial.slack?.csm_user_ids ?? {}),
      },
    },
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
