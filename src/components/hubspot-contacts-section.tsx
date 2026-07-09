import type { HubSpotContactRef } from "@/lib/types";
import { fmtDate } from "./format";
import { CollapsibleSection } from "./collapsible-section";
import { HubSpotContactsEditableList } from "./hubspot-contacts-editable-list";

/**
 * Renders the contact list for a customer profile — HubSpot contacts
 * associated with the company plus the account owner (owner_email
 * from q10600), who is typically also a point of contact even when
 * they aren't a HubSpot contact.
 *
 * The account owner renders as a distinct row at the top of the
 * list with an "Account owner" chip. If the owner's email already
 * appears in the HubSpot contacts, the chip is applied to that row
 * inline instead of duplicating.
 *
 * Sort order: primary HubSpot contact first, then most-recently-
 * active (notes_last_activity_date), then alphabetical by name/email.
 * The account owner slot always renders above the sorted HubSpot
 * rows when it's a synthetic (non-HubSpot) entry.
 *
 * `HubSpotContactsList` is the content-only variant for nesting inside
 * another section (e.g. CustomerDetailPanel's Contact block). The
 * `HubSpotContactsSection` wrapper keeps the standalone collapsible card
 * used on the /account page.
 */
interface ContactsProps {
  contacts: HubSpotContactRef[] | null | undefined;
  /** When provided, each contact row renders an inline label
   *  editor that PUTs to the workspace's labels endpoint. Omit to
   *  render read-only (e.g. on the standalone /account page where
   *  we don't have a workspace_id route param). */
  workspaceId?: string | null;
  /** Account owner's email — surfaced as its own row above the
   *  HubSpot contacts. Falls through gracefully when null/absent
   *  (e.g. a synthesized customer with no owner). */
  ownerEmail?: string | null;
  /** Account owner's display name — usually property_main_contact
   *  in HubSpot. Falls back to the email local part when absent. */
  ownerName?: string | null;
}

export function HubSpotContactsList({
  contacts,
  workspaceId,
  ownerEmail,
  ownerName,
}: ContactsProps) {
  const ownerRow = maybeOwnerRow(contacts, ownerEmail, ownerName);
  const hubspotContacts = contacts ?? [];
  if (hubspotContacts.length === 0 && !ownerRow) return null;

  const totalCount = hubspotContacts.length + (ownerRow ? 1 : 0);

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <p className="text-xs uppercase tracking-wide font-medium text-muted mb-2">
        Company contacts ({totalCount})
      </p>
      {ownerRow ? (
        <ul className="divide-y divide-border/60 mb-2">
          <OwnerContactRow owner={ownerRow} />
        </ul>
      ) : null}
      {hubspotContacts.length > 0 ? (
        workspaceId ? (
          <HubSpotContactsEditableList
            contacts={hubspotContacts}
            workspaceId={workspaceId}
            ownerEmail={ownerEmail}
          />
        ) : (
          <ul className="divide-y divide-border/60">
            <ReadOnlyContactItems
              contacts={hubspotContacts}
              ownerEmail={ownerEmail}
            />
          </ul>
        )
      ) : null}
    </div>
  );
}

export function HubSpotContactsSection({
  contacts,
  workspaceId,
  ownerEmail,
  ownerName,
}: ContactsProps) {
  const ownerRow = maybeOwnerRow(contacts, ownerEmail, ownerName);
  const hubspotContacts = contacts ?? [];
  if (hubspotContacts.length === 0 && !ownerRow) return null;

  const totalCount = hubspotContacts.length + (ownerRow ? 1 : 0);

  return (
    <CollapsibleSection title={`Company contacts (${totalCount})`}>
      {ownerRow ? (
        <ul className="divide-y divide-border mb-2">
          <OwnerContactRow owner={ownerRow} />
        </ul>
      ) : null}
      {hubspotContacts.length > 0 ? (
        workspaceId ? (
          <HubSpotContactsEditableList
            contacts={hubspotContacts}
            workspaceId={workspaceId}
            ownerEmail={ownerEmail}
          />
        ) : (
          <ul className="divide-y divide-border">
            <ReadOnlyContactItems
              contacts={hubspotContacts}
              ownerEmail={ownerEmail}
            />
          </ul>
        )
      ) : null}
    </CollapsibleSection>
  );
}

interface OwnerRow {
  email: string;
  name: string | null;
}

/** Return an OwnerRow to render iff we have an owner_email AND the
 *  owner isn't already in the HubSpot contact list (case-insensitive
 *  email match). When the owner IS already a HubSpot contact, the
 *  chip renders inline on that row instead and this returns null. */
function maybeOwnerRow(
  contacts: HubSpotContactRef[] | null | undefined,
  ownerEmail: string | null | undefined,
  ownerName: string | null | undefined
): OwnerRow | null {
  if (!ownerEmail) return null;
  const emailLower = ownerEmail.trim().toLowerCase();
  if (!emailLower) return null;
  const alreadyInList = (contacts ?? []).some(
    (c) => (c.email ?? "").trim().toLowerCase() === emailLower
  );
  if (alreadyInList) return null;
  return { email: ownerEmail, name: ownerName?.trim() || null };
}

function OwnerContactRow({ owner }: { owner: OwnerRow }) {
  const displayName = owner.name ?? owner.email.split("@")[0];
  return (
    <li className="py-2.5 flex items-start gap-3 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-fg break-words">{displayName}</span>
        </div>
        <a
          href={`mailto:${owner.email}`}
          className="text-xs text-muted hover:text-fg break-all"
        >
          {owner.email}
        </a>
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          <OwnerChip />
        </div>
      </div>
    </li>
  );
}

function OwnerChip() {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/40 text-blue-900 dark:text-blue-200"
      title="q10600 owner_email — the workspace's Stripe billing contact / beehiiv owner. Often overlaps with HubSpot's Main Contact but not always."
    >
      Account owner
    </span>
  );
}

/** Read-only contact rows for surfaces that didn't supply a
 *  workspaceId (e.g. the standalone /account page). Same chip shape
 *  as the editor minus interactivity. */
function ReadOnlyContactItems({
  contacts,
  ownerEmail,
}: {
  contacts: HubSpotContactRef[];
  ownerEmail?: string | null;
}) {
  const ownerLower = (ownerEmail ?? "").trim().toLowerCase();
  return (
    <>
      {contacts.map((c) => {
        const isOwner =
          Boolean(ownerLower) &&
          (c.email ?? "").trim().toLowerCase() === ownerLower;
        return (
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
                {isOwner ? <OwnerChip /> : null}
                {c.is_primary ? (
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/40 text-emerald-900 dark:text-emerald-200"
                    title="HubSpot association type = Contact with Primary Company"
                  >
                    Primary
                  </span>
                ) : null}
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
        );
      })}
    </>
  );
}
