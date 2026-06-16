import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  runCard,
  MissingParamsError,
  type RunCardOutput,
} from "@/lib/metabase";
import { heuristicSpec, tagMatch } from "@/lib/qbr-charts/heuristic";
import { getPreset } from "@/lib/qbr-charts/qbr-presets";
import type { ChartType } from "@/lib/qbr-charts/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/qbr-charts/chart-spec
 *
 * Generates a ChartSpec for a QBR (or arbitrary) Metabase question.
 *
 * Body:
 *   - prompt?: string         — free-text query (mapped via tagMatch
 *                               in PR A, via Claude in PR B). Used
 *                               when no questionId is provided.
 *   - questionId?: number     — explicit question id; bypasses the
 *                               prompt matcher.
 *   - chartType?: ChartType | "auto"  — override the preset default.
 *   - organizationId: string  — required. Workspace UUID.
 *   - publicationId?: string  — present → publication mode.
 *   - startMonth?, endMonth?  — optional date range bounds.
 *   - extras?: Record<string, string>  — non-standard param values
 *                                        (PR C).
 *
 * Errors:
 *   400 — missing organizationId or both prompt+questionId.
 *   422 MISSING_REQUIRED_PARAMS — question needs a non-standard
 *       param we don't have. Body includes `missingParams[]`.
 *   422 NO_PRESET_MATCH — prompt didn't match any preset's tags
 *       (PR A: heuristic-only; PR B will degrade more gracefully).
 *   500 — Metabase failure or unexpected error.
 */

interface PostBody {
  prompt?: string;
  questionId?: number;
  chartType?: ChartType | "auto";
  organizationId?: string;
  publicationId?: string;
  startMonth?: string;
  endMonth?: string;
  extras?: Record<string, string>;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.organizationId) {
    return NextResponse.json(
      { error: "organizationId is required" },
      { status: 400 }
    );
  }
  if (!body.prompt && !body.questionId) {
    return NextResponse.json(
      { error: "Provide either `prompt` or `questionId`" },
      { status: 400 }
    );
  }

  // Resolve to a questionId.
  let questionId = body.questionId;
  if (!questionId && body.prompt) {
    const matched = tagMatch(body.prompt);
    if (!matched) {
      return NextResponse.json(
        {
          error: "NO_PRESET_MATCH",
          message:
            "Couldn't match that prompt to a preset. Try wording closer to what the chart measures (e.g. \"open rate\", \"unsubscribe rate\", \"boost earnings\"), or pick a preset tile directly.",
        },
        { status: 422 }
      );
    }
    questionId = matched.questionId;
  }
  if (!questionId) {
    return NextResponse.json(
      { error: "Couldn't resolve a question id" },
      { status: 400 }
    );
  }

  // Run the card.
  let result: RunCardOutput;
  try {
    result = await runCard(questionId, {
      organizationId: body.organizationId,
      publicationId: body.publicationId,
      startMonth: body.startMonth,
      endMonth: body.endMonth,
      extras: body.extras,
    });
  } catch (e) {
    if (e instanceof MissingParamsError) {
      return NextResponse.json(
        {
          error: "MISSING_REQUIRED_PARAMS",
          missingParams: e.missingParams,
        },
        { status: 422 }
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[qbr-charts] runCard failed", { questionId, error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Heuristic spec for now (Claude integration lands in PR B).
  const spec = heuristicSpec({
    preferredChartType: body.chartType ?? "auto",
    questionId,
    questionName: result.questionName,
    columns: result.columns,
    rows: result.rows,
  });

  const preset = getPreset(questionId);
  return NextResponse.json({
    spec,
    matchedQuestionId: questionId,
    matchedPreset: preset ?? null,
  });
}
