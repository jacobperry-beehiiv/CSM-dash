import type { HubSpotContactRef } from "@/lib/types";
import { fmtDate } from "./format";
import { CollapsibleSection } from "./collapsible-section";

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
}: {
  contacts: HubSpotContactRef[] | null | undefined;
}) {
  if (!contacts || contacts.length === 0) return null;

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <p className="text-xs uppercase tracking-wide font-medium text-muted mb-2">
        HubSpot contacts at this company ({contacts.length})
      </p>
      <ul className="divide-y divide-border/60">
        <HubSpotContactItems contacts={contacts} />
      </ul>
    </div>
  );
}

export function HubSpotContactsSection({
  contacts,
}: {
  contacts: HubSpotContactRef[] | null | undefined;
}) {
  if (!contacts || contacts.length === 0) return null;

  return (
    <CollapsibleSection
      title={`HubSpot contacts at this company (${contacts.length})`}
    >
      <ul className="divide-y divide-border">
        <HubSpotContactItems contacts={contacts} />
      </ul>
    </CollapsibleSection>
  );
}

function HubSpotContactItems({ contacts }: { contacts: HubSpotContactRef[] }) {
  return (
    <>
      {contacts.map((c) => (
        <li key={c.id} className="py-2.5 flex items-start gap-3 text-sm">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium text-fg truncate">
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
