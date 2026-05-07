import { NextResponse } from "next/server";
import {
  loadSettings,
  saveSettings,
  type SettingsShape,
} from "@/lib/data/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await loadSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as SettingsShape;
    if (!body.flags || !body.thresholds) {
      return NextResponse.json(
        { error: "Body must include both `flags` and `thresholds`." },
        { status: 400 }
      );
    }
    return NextResponse.json(await saveSettings(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 }
    );
  }
}
