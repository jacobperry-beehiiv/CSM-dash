import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createHubspotCompanyNote } from "@/lib/integrations/hubspot";
import {
  listSignals,
  mergeSignalMetadata,
} from "@/lib/data/customer-signals";
import { loadCustomers } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/customer-signals/post-to-hubspot
 *
 * Mirror a dashboard "note" signal into the corresponding HubSpot
 * company's timeline. Idempotent — if the signal already carries a
 * `hubspot_note_id` in its metadata we short-circuit so a stuck-clicker
 * doesn't create duplicate notes on the HubSpot side.
 *
 *   body: { workspace_id: string, signal_id: string }
 *
 * Returns: { hubspot_note_id, hubspot_company_id }
 *
 * Required HubSpot scope on the Private App backing this dashboard:
 *   `crm.objects.notes.write`
 *
 * Auth: NextAuth session (the dashboard is the only legitimate caller).
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: "Sign in required" },
      { status: 401 }
    );
  }

  let body: { workspace_id?: string; signal_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspaceId = (body.workspace_id ?? "").trim();
  const signalId = (body.signal_id ?? "").trim();
  if (!workspaceId || !signalId) {
    return NextResponse.json(
      { error: "workspace_id and signal_id are both required" },
      { status: 400 }
    );
  }

  // Pull the signal from the workspace's bag, then validate it's a
  // note (the only kind we mirror to HubSpot — touchpoints / goals /
  // risk_signals are dashboard-internal structured signals, not
  // free-form notes a CSM would publish to the HubSpot timeline).
  const signals = await listSignals(workspaceId);
  const signal = signals.find((s) => s.id === signalId);
  if (!signal) {
    return NextResponse.json(
      { error: `Signal ${signalId} not found for workspace ${workspaceId}` },
      { status: 404 }
    );
  }
  if (signal.kind !== "note") {
    return NextResponse.json(
      {
        error: `Signal kind is "${signal.kind}" — only notes can be mirrored to HubSpot.`,
      },
      { status: 400 }
    );
  }

  // Idempotency: if we already posted this note, return the existing
  // id rather than creating a second one. The UI shows the button as
  // "✓ Posted" once metadata.hubspot_note_id is set, so this only
  // happens when someone POSTs the endpoint directly.
  const existingHubspotId =
    (signal.metadata?.hubspot_note_id as string | undefined) ?? null;
  if (existingHubspotId) {
    return NextResponse.json({
      ok: true,
      already_posted: true,
      hubspot_note_id: existingHubspotId,
    });
  }

  // Look up the customer to find hubspot_company_id. Same pattern as
  // the /update-csm Slack modal — go through the customer book so we
  // don't accept arbitrary HubSpot ids from the UI.
  let customers;
  try {
    customers = await loadCustomers();
  } catch (e) {
    return NextResponse.json(
      {
        error: `Couldn't load customer book: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 502 }
    );
  }
  const customer =
    customers.find(
      (c) =>
        c.workspace_id === workspaceId ||
        c.workspace_id?.toLowerCase() === workspaceId.toLowerCase()
    ) ?? null;
  if (!customer?.hubspot_company_id) {
    return NextResponse.json(
      {
        error: `No HubSpot company id on file for workspace ${workspaceId}. Click "Refresh CSM from HubSpot" on the row first, or confirm the company is linked.`,
      },
      { status: 422 }
    );
  }

  // Compose the HubSpot note body. Prefix with a small "via CSM
  // Mission Control" attribution so when HubSpot timeline readers see
  // it they know the provenance — useful for distinguishing
  // dashboard-mirrored notes from notes written natively in HubSpot.
  const author =
    signal.created_by ?? session.user.email ?? "CSM Mission Control";
  const noteBody =
    `<p>${escapeHtml(signal.text)}</p>` +
    `<p><em>— posted from CSM Mission Control by ${escapeHtml(author)}` +
    (signal.event_at
      ? ` on ${escapeHtml(new Date(signal.event_at).toLocaleString())}`
      : "") +
    `</em></p>`;

  let hubspotNoteId: string;
  try {
    const r = await createHubspotCompanyNote(
      customer.hubspot_company_id,
      noteBody,
      { timestamp: signal.event_at ?? signal.created_at }
    );
    hubspotNoteId = r.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[post-to-hubspot] HubSpot create failed", {
      workspaceId,
      signalId,
      hubspot_company_id: customer.hubspot_company_id,
      error: msg,
    });
    return NextResponse.json(
      { error: `HubSpot note create failed: ${msg}` },
      { status: 502 }
    );
  }

  // Stamp the new HubSpot id back onto the signal so the UI can show
  // "Posted ✓" on the next reload (and future calls short-circuit).
  await mergeSignalMetadata(workspaceId, signalId, {
    hubspot_note_id: hubspotNoteId,
    hubspot_note_posted_at: new Date().toISOString(),
    hubspot_note_posted_by: session.user.email,
  });

  console.log("[post-to-hubspot] Note posted", {
    workspaceId,
    signalId,
    hubspot_note_id: hubspotNoteId,
    hubspot_company_id: customer.hubspot_company_id,
  });

  return NextResponse.json({
    ok: true,
    hubspot_note_id: hubspotNoteId,
    hubspot_company_id: customer.hubspot_company_id,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
