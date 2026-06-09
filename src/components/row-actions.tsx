"use client";

import type { Customer } from "@/lib/types";
import { hubspotCompanyUrl, masqueradeUrl } from "@/lib/links";

interface Props {
  customer: Customer;
  onDraft: (c: Customer) => void;
}

/**
 * Per-row action cluster shown on every customer-table-style row.
 * Three slots — masquerade · HubSpot · Draft. The Draft button is the
 * full-fledged template picker (OutreachModal); HubSpot is a quick
 * jump to the company page when we have a `hubspot_company_id` from
 * the sync-time enrichment. The "quick email" envelope that used to
 * sit in the middle has been retired — Draft does the same thing
 * with template control.
 *
 * Buttons stack vertically so the table's actions column only needs
 * room for the widest button (Masquerade, ~90px) instead of all three
 * laid side-by-side (~176px). Frees significant horizontal real estate
 * for data columns; the cell's `align-top` row alignment keeps neighbour
 * cells anchored to the top so the stacked actions read cleanly.
 */
export function RowActions({ customer, onDraft }: Props) {
  const masquerade = masqueradeUrl(customer.owner_email);
  const hubspot = hubspotCompanyUrl(customer.hubspot_company_id);

  function stop(e: React.MouseEvent) {
    e.stopPropagation();
  }

  // Common button classes — full-width inside the flex column so all
  // three buttons line up flush right at the same width regardless of
  // their label length.
  const btn =
    "w-full px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas text-center";

  return (
    <div
      className="flex flex-col items-stretch gap-1 max-w-[110px] ml-auto"
      onClick={stop}
    >
      {masquerade ? (
        <a
          href={masquerade}
          target="_blank"
          rel="noopener noreferrer"
          title="Masquerade into workspace"
          className={btn}
        >
          Masq
        </a>
      ) : null}
      {hubspot ? (
        <a
          href={hubspot}
          target="_blank"
          rel="noopener noreferrer"
          title="Open company in HubSpot"
          aria-label="HubSpot"
          className={`${btn} font-semibold text-[#ff7a59]`}
        >
          {/* HubSpot wordmark uses #ff7a59. Mono "h." reads as the
              HubSpot icon at this size without needing an SVG dep. */}
          <span aria-hidden>HubSpot</span>
        </a>
      ) : null}
      <button onClick={() => onDraft(customer)} title="Draft outreach (template picker)" className={btn}>
        Draft
      </button>
    </div>
  );
}
