import type { HubSpotContactRef } from "@/lib/types";
import { fmtDate } from "./format";
import { CollapsibleSection } from "./collapsible-section";
import { HubSpotContactsEditableList } from "./hubspot-contacts-editable-list";

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
      {workspaceId ? (
        <HubSpotContactsEditableList
          contacts={contacts}
          workspaceId={workspaceId}
        />
      ) : (
        <ul className="divide-y divide-border/60">
          <ReadOnlyContactItems contacts={contacts} />
        </ul>
      )}
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
      {workspaceId ? (
        <HubSpotContactsEditableList
          contacts={contacts}
          workspaceId={workspaceId}
        />
      ) : (
        <ul className="divide-y divide-border">
          <ReadOnlyContactItems contacts={contacts} />
        </ul>
      )}
    </CollapsibleSection>
  );
}

/** Read-only contact rows for surfaces that didn't supply a
 *  workspaceId (e.g. the standalone /account page). Same chip shape
 *  as the editor minus interactivity. */
function ReadOnlyContactItems({ contacts }: { contacts: HubSpotContactRef[] }) {
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
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-surface-2 dark:bg-canvas/40 border-border text-muted"
                title="HubSpot system label: every contact shown here is associated as Primary Company in HubSpot"
              >
                Contact with primary company
              </span>
              {(c.labels ?? []).map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/40 text-indigo-900 dark:text-indigo-200"
                  title={`HubSpot association label: ${label}`}
                >
                  {label}
                </span>
              ))}
            </div>
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
