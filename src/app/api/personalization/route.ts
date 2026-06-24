import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmWithGmail } from "@/lib/auth/csm-eligibility";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  loadPersonalization,
  savePersonalization,
} from "@/lib/data/personalization";
import type { Personalization } from "@/lib/data/personalization-types";

/** Combined gate: eligibility (CSM with Gmail) AND the
 *  admin-configured feature flag (which may restrict to an
 *  allow-list). Both must pass. Returns the reason for the failure
 *  so the route can return a UX-friendly error body. */
async function checkAccess(
  email: string
): Promise<{ ok: true } | { ok: false; reason: "ineligible" | "disabled" }> {
  if (!(await isCsmWithGmail(email))) return { ok: false, reason: "ineligible" };
  if (!(await isFeatureEnabledFor("personalization", email))) {
    return { ok: false, reason: "disabled" };
  }
  return { ok: true };
}

export const dynamic = "force-dynamic";

/**
 * GET  /api/personalization
 *   → current viewer's saved personalization, or `null` when none.
 *
 * PUT  /api/personalization
 *   { dashboard_name?, accent_color?, font_key?, logo_url? }
 *   → save the viewer's personalization. Returns the sanitized
 *     stored value (the store strips invalid hex, drops non-curated
 *     fonts, length-caps the name, whitelists http(s) on the logo URL).
 *
 * Auth: signed-in session AND the viewer must qualify as a CSM with
 * Gmail connected. Anything else gets 403 with a clear message so
 * the settings page can render its ineligibility explainer.
 */

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const access = await checkAccess(email);
  if (!access.ok) {
    return NextResponse.json(
      access.reason === "disabled"
        ? {
            error:
              "Personalization is currently restricted. Ask your super-admin to add your email to the allow list at /admin/flags.",
            disabled: true,
          }
        : {
            error:
              "Personalization is only available to CSMs with a Gmail account connected. Connect at /settings/gmail.",
            ineligible: true,
          },
      { status: 403 }
    );
  }
  const entry = await loadPersonalization(email);
  return NextResponse.json(entry ?? {});
}

export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const access = await checkAccess(email);
  if (!access.ok) {
    return NextResponse.json(
      access.reason === "disabled"
        ? {
            error:
              "Personalization is currently restricted. Ask your super-admin to add your email to the allow list at /admin/flags.",
            disabled: true,
          }
        : {
            error:
              "Personalization is only available to CSMs with a Gmail account connected. Connect at /settings/gmail.",
            ineligible: true,
          },
      { status: 403 }
    );
  }
  let body: Personalization;
  try {
    body = (await req.json()) as Personalization;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const saved = await savePersonalization(email, body);
    return NextResponse.json(saved);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
