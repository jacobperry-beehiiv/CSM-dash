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
 */
export function RowActions({ customer, onDraft }: Props) {
  const masquerade = masqueradeUrl(customer.owner_email);
  const hubspot = hubspotCompanyUrl(customer.hubspot_company_id);

  function stop(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <div className="flex items-center gap-1 justify-end" onClick={stop}>
      {masquerade ? (
        <a
          href={masquerade}
          target="_blank"
          rel="noopener noreferrer"
          title="Masquerade into workspace"
          className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas inline-flex items-center"
        >
          Masquerade
        </a>
      ) : null}
      {hubspot ? (
        <a
          href={hubspot}
          target="_blank"
          rel="noopener noreferrer"
          title="Open company in HubSpot"
          aria-label="HubSpot"
          className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas inline-flex items-center font-semibold text-[#ff7a59]"
        >
          {/* HubSpot wordmark uses #ff7a59. Mono "h." reads as the
              HubSpot icon at this size without needing an SVG dep. */}
          <span aria-hidden>h.</span>
        </a>
      ) : null}
      <button
        onClick={() => onDraft(customer)}
        title="Draft outreach (template picker)"
        className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
      >
        Draft
      </button>
    </div>
  );
}
