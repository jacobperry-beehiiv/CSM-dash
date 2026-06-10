import { kvGet, kvSet } from "../storage/kv";
import type { FieldMappingsState } from "./field-mappings-types";

/**
 * HubSpot ↔ Dashboard field mapping store. The types + the canonical
 * MAPPABLE_DASHBOARD_FIELDS catalog live in field-mappings-types.ts
 * (client-safe — no Postgres imports). This file holds the KV
 * read/write helpers and re-exports the types so existing imports
 * from `@/lib/data/field-mappings` keep working.
 *
 * Direction semantics, KV layout, and behavior live in the types
 * file's header comment.
 */

export * from "./field-mappings-types";

const KEY = "csm:hubspot-field-mappings:v1";

export async function loadFieldMappings(): Promise<FieldMappingsState> {
  const stored = await kvGet<FieldMappingsState>(KEY);
  return { mappings: stored?.mappings ?? {} };
}

export async function saveFieldMappings(
  next: FieldMappingsState
): Promise<FieldMappingsState> {
  // Drop empty/garbage entries so a half-edited row doesn't poison
  // the file.
  const cleaned: FieldMappingsState = {
    mappings: Object.fromEntries(
      Object.entries(next.mappings ?? {}).filter(
        ([, m]) =>
          m &&
          typeof m.hubspot_property === "string" &&
          m.hubspot_property.trim().length > 0
      )
    ),
  };
  await kvSet(KEY, cleaned);
  return cleaned;
}
