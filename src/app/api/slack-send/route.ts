import { NextResponse } from "next/server";
import { postSlackMessage } from "@/lib/integrations/slack";

export const dynamic = "force-dynamic";

interface PostBody {
  channel: string;
  text: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PostBody;
    if (!body.channel || !body.text) {
      return NextResponse.json(
        { error: "channel and text are required" },
        { status: 400 }
      );
    }
    const ok = await postSlackMessage(body);
    return NextResponse.json(ok);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
