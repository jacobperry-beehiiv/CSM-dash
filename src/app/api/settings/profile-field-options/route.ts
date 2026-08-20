import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isProfileOptionsAdmin } from "@/lib/auth/admin";
import {
  loadProfileFieldOptions,
  saveProfileFieldOptions,
} from "@/lib/data/profile-field-options";

export const dynamic = "force-dynamic";

/** GET — the shared Prior ESP + Tech Stack option lists. Readable by
 *  any signed-in CSM so the account-profile pickers can populate. */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }
    const options = await loadProfileFieldOptions();
    return NextResponse.json(options);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/** PUT — replace one or both option lists. Admin-only (defense in depth
 *  on top of the UI gate). Send { priorEsp?, techStack? }. */
export async function PUT(req: Request) {
  try {
    const session = await auth();
    const email = session?.user?.email ?? null;
    if (!email) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }
    if (!isProfileOptionsAdmin(email)) {
      return NextResponse.json(
        { error: "Only profile-options admins can edit these lists." },
        { status: 403 }
      );
    }
    const body = (await req.json()) as {
      priorEsp?: unknown;
      techStack?: unknown;
    };
    const patch: { priorEsp?: string[]; techStack?: string[] } = {};
    if (Array.isArray(body.priorEsp)) patch.priorEsp = body.priorEsp as string[];
    if (Array.isArray(body.techStack)) {
      patch.techStack = body.techStack as string[];
    }
    const saved = await saveProfileFieldOptions(patch);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
