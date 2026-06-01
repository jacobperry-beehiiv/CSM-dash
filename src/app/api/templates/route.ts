import { NextResponse } from "next/server";
import {
  deleteTemplate,
  listTemplates,
  upsertTemplate,
} from "@/lib/templates/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const list = await listTemplates();
    return NextResponse.json(list);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface UpsertBody {
  id?: string;
  label: string;
  blurb?: string;
  tags?: string[];
  /** Lowercased CSM emails the template should be visible to.
   *  Universal when empty / undefined. */
  csm_tags?: string[];
  subject: string;
  body_html: string;
  /** Optional default Gmail send-as alias for drafts built from this
   *  template. Empty string clears any existing value. */
  send_as_email?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as UpsertBody;
    if (!body.label || !body.subject || !body.body_html) {
      return NextResponse.json(
        { error: "label, subject, and body_html are required" },
        { status: 400 }
      );
    }
    const tpl = await upsertTemplate(body);
    return NextResponse.json(tpl);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const ok = await deleteTemplate(id);
    return NextResponse.json({ ok });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
