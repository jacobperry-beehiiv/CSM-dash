import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadOverrides, setOverride } from "@/lib/data/customer-overrides";
import { loadProfileFieldOptions } from "@/lib/data/profile-field-options";
import { invalidateCustomerCache } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

/** GET — current overrides map keyed by workspace_id. Lets the
 *  Renewals panel pull just the lifecycle_stage values + audit
 *  metadata without re-running loadCustomers. */
export async function GET() {
  try {
    const map = await loadOverrides();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id: string;
  interval?: "annual" | "month" | null;
  /** Update the user-facing lifecycle stage (renewals dropdown). Pass
   *  null or empty string to clear. Audit fields are stamped from the
   *  session viewer's email. */
  lifecycle_stage?: string | null;
  /** Manual expected send cadence in days. Feeds Flag A's threshold in
   *  place of the ClickHouse-inferred cadence. Pass null / 0 / empty
   *  to clear the override and fall back to inferred. Audit fields
   *  are stamped from the session viewer's email. */
  expected_send_cadence_days?: number | null;
  /** CSM-set "Prior ESP" (multi-select). Send the full desired set; an
   *  empty array clears it. Each value is normalized to the
   *  admin-managed list's casing (values not in the list are kept as-is
   *  so previously-selected options survive an admin removing them). */
  prior_esp?: string[] | null;
  /** CSM-set "Tech Stack" (multi-select). Send the full desired set;
   *  an empty array clears it. Each value is normalized to the
   *  admin-managed list's casing (values not in the list are kept as-is
   *  so previously-selected options survive an admin removing them). */
  tech_stack?: string[] | null;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const body = (await req.json()) as PostBody;
    if (!body.workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }

    const patch: Parameters<typeof setOverride>[1] = {};
    if ("interval" in body) {
      patch.interval = body.interval === null ? undefined : body.interval;
    }
    if ("lifecycle_stage" in body) {
      const trimmed = body.lifecycle_stage?.trim() || "";
      patch.lifecycle_stage = trimmed || undefined;
      patch.lifecycle_stage_updated_at = trimmed
        ? new Date().toISOString()
        : undefined;
      patch.lifecycle_stage_updated_by = trimmed
        ? session?.user?.email?.toLowerCase() ?? undefined
        : undefined;
    }
    if ("expected_send_cadence_days" in body) {
      const raw = body.expected_send_cadence_days;
      const value =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0
          ? Math.floor(raw)
          : null;
      patch.expected_send_cadence_days = value ?? undefined;
      patch.expected_send_cadence_updated_at = value
        ? new Date().toISOString()
        : undefined;
      patch.expected_send_cadence_updated_by = value
        ? session?.user?.email?.toLowerCase() ?? undefined
        : undefined;
    }

    // Profile fields (Prior ESP + Tech Stack). Normalize each value to
    // the canonical casing from the shared admin-managed option lists;
    // values not in the list are preserved as-typed so a customer keeps
    // an option even after an admin removes it from the list (orphaned
    // values are intentionally not stripped). Commas are removed — the
    // /csm Tech Stack filter round-trips through a comma-joined URL param.
    if ("prior_esp" in body || "tech_stack" in body) {
      const options = await loadProfileFieldOptions();
      const stamp = session?.user?.email?.toLowerCase() ?? undefined;
      const clean = (v: string) =>
        v.replace(/,/g, " ").trim().replace(/\s+/g, " ");
      const canon = (v: string, list: string[]) =>
        list.find((o) => o.toLowerCase() === v.toLowerCase()) ?? v;
      // Clean + canonicalize a submitted multi-select array: drop
      // non-strings/empties, snap known values to the list's casing,
      // dedupe case-insensitively.
      const canonList = (raw: unknown, optionList: string[]) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const item of Array.isArray(raw) ? raw : []) {
          if (typeof item !== "string") continue;
          const t = clean(item);
          if (!t) continue;
          const c = canon(t, optionList);
          const key = c.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(c);
        }
        return out;
      };

      if ("prior_esp" in body) {
        const list = canonList(body.prior_esp, options.priorEsp);
        patch.prior_esp = list.length ? list : undefined;
        patch.prior_esp_updated_at = list.length ? new Date().toISOString() : undefined;
        patch.prior_esp_updated_by = list.length ? stamp : undefined;
      }
      if ("tech_stack" in body) {
        const list = canonList(body.tech_stack, options.techStack);
        patch.tech_stack = list.length ? list : undefined;
        patch.tech_stack_updated_at = list.length ? new Date().toISOString() : undefined;
        patch.tech_stack_updated_by = list.length ? stamp : undefined;
      }
    }

    const map = await setOverride(body.workspace_id, patch);
    invalidateCustomerCache();
    return NextResponse.json(map);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
