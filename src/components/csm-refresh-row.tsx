import type { Customer } from "@/lib/types";

/**
 * Static CSM cell for the customer detail panel's Contact section.
 *
 * Renders the customer's `customer_success_manager` (humanized
 * snake_case → spaces) + the optional `customer_success_manager_email`
 * subtitle. No live refresh affordance — the previous per-row
 * "🔄 HubSpot" button was removed because the underlying
 * /api/customer-overrides/refresh-csm endpoint started returning 410
 * (HubSpot's owner-resolution API changed shape). The daily sync
 * keeps the field fresh; if a fix is needed urgently, the manual
 * sync-data GitHub Action handles it.
 *
 * Kept as its own component (instead of being inlined into the
 * detail panel) so future writes — e.g. a confirm-and-override flow
 * — can drop into one spot.
 */
interface Props {
  customer: Customer;
}

export function CsmRefreshRow({ customer }: Props) {
  const displayName = customer.customer_success_manager?.replace(/_/g, " ") ?? "—";
  const displayEmail = customer.customer_success_manager_email ?? null;

  return (
    <div className="space-y-1">
      <div className="text-fg break-words">{displayName}</div>
      {displayEmail ? (
        <div className="text-[11px] text-subtle truncate" title={displayEmail}>
          {displayEmail}
        </div>
      ) : null}
    </div>
  );
}
