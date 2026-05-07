import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runSavedQuestion } from "@/lib/metabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const QUESTION_ID = 10600;

export async function POST() {
  try {
    const started = Date.now();
    const rows = await runSavedQuestion(QUESTION_ID);
    const elapsedMs = Date.now() - started;

    const outPath =
      process.env.SNAPSHOT_PATH ?? path.join(process.cwd(), "data/snapshot.json");
    await mkdir(path.dirname(outPath), { recursive: true });
    const payload = {
      generated_at: new Date().toISOString(),
      question_id: QUESTION_ID,
      row_count: rows.length,
      rows,
    };
    await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

    return NextResponse.json({
      ok: true,
      row_count: rows.length,
      elapsed_ms: elapsedMs,
      generated_at: payload.generated_at,
    });
  } catch (error) {
    console.error("sync failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
