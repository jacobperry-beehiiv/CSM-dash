import type { HubSpotContactRef } from "@/lib/types";
import { fmtDate } from "./format";
import { CollapsibleSection } from "./collapsible-section";
import { HubSpotContactLabelEditor } from "./hubspot-contact-label-editor";

/**
 * Renders the list of contacts whose HubSpot "Contact with Primary Company"
 * association points at this customer's company. Populated at sync time by
 * the HubSpot enrichment step; shows nothing when the field is empty / not
 * yet populated.
 *
 * Sort order: most-recently-active first (notes_last_activity_date), then
 * alphabetical by name/email.
 *
 * `HubSpotContactsList` is the content-only variant for nesting inside
 * another section (e.g. CustomerDetailPanel's Contact block). The
 * `HubSpotContactsSection` wrapper keeps the standalone collapsible card
 * used on the /account page.
 */
export function HubSpotContactsList({
  contacts,
  workspaceId,
}: {
  contacts: HubSpotContactRef[] | null | undefined;
  /** When provided, each contact row renders an inline label
   *  editor that PUTs to the workspace's labels endpoint. Omit to
   *  render read-only (e.g. on the standalone /account page where
   *  we don't have a workspace_id route param). */
  workspaceId?: string | null;
}) {
  if (!contacts || contacts.length === 0) return null;

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <p className="text-xs uppercase tracking-wide font-medium text-muted mb-2">
        HubSpot contacts at this company ({contacts.length})
      </p>
      <ul className="divide-y divide-border/60">
        <HubSpotContactItems contacts={contacts} workspaceId={workspaceId} />
      </ul>
    </div>
  );
}

export function HubSpotContactsSection({
  contacts,
  workspaceId,
}: {
  contacts: HubSpotContactRef[] | null | undefined;
  workspaceId?: string | null;
}) {
  if (!contacts || contacts.length === 0) return null;

  return (
    <CollapsibleSection
      title={`HubSpot contacts at this company (${contacts.length})`}
    >
      <ul className="divide-y divide-border">
        <HubSpotContactItems contacts={contacts} workspaceId={workspaceId} />
      </ul>
    </CollapsibleSection>
  );
}

function HubSpotContactItems({
  contacts,
  workspaceId,
}: {
  contacts: HubSpotContactRef[];
  workspaceId?: string | null;
}) {
  return (
    <>
      {contacts.map((c) => (
        <li key={c.id} className="py-2.5 flex items-start gap-3 text-sm">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium text-fg break-words">
                {c.name ?? c.email ?? "(no name)"}
              </span>
              {c.job_title ? (
                <span className="text-[11px] text-subtle">{c.job_title}</span>
              ) : null}
            </div>
            {c.email ? (
              <a
                href={`mailto:${c.email}`}
                className="text-xs text-muted hover:text-fg break-all"
              >
                {c.email}
              </a>
            ) : null}
            {workspaceId ? (
              <HubSpotContactLabelEditor
                workspaceId={workspaceId}
                contactId={c.id}
                contactName={c.name ?? c.email ?? `contact ${c.id}`}
                initialLabels={c.labels ?? []}
              />
            ) : (c.labels ?? []).length > 0 ? (
              // Read-only fallback for callers that didn't supply a
              // workspaceId — render the chips without the editor.
              <div className="flex flex-wrap gap-1 mt-1">
                {(c.labels ?? []).map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border bg-canvas border-border text-fg"
                    title={`HubSpot association label: ${label}`}
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          {c.last_activity_at ? (
            <div
              className="text-[11px] text-muted whitespace-nowrap"
              title="HubSpot contact-level notes_last_activity_date"
            >
              Last activity {fmtDate(c.last_activity_at)}
            </div>
          ) : null}
        </li>
      ))}
    </>
  );
}
