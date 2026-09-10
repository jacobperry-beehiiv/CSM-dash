import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { loadSettings } from "@/lib/data/settings";
import { AccessAllowlistEditor } from "@/components/access-allowlist-editor";

export const dynamic = "force-dynamic";

/**
 * /settings/access — admin-only editor for the CSM-team access
 * allowlist.
 *
 * Adds emails that should be treated as CSM team members even when
 * they have no assigned customers in the book — CS managers, sales
 * engineers, or a lead who acts across other CSMs' books. Layered
 * on top of the customer-book check inside isCsmTeamMember; admins
 * bypass both regardless.
 */
export default async function AccessSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!isAdmin(email)) {
    notFound();
  }

  const settings = await loadSettings();
  const emails = settings.access?.extra_csm_emails ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Access allowlist
      </h1>
      <p className="text-sm text-muted mb-4 max-w-2xl">
        Emails listed here are treated as CSM team members inside the
        dashboard — same access every assigned CSM has. Use this for
        people who need full CSM tooling but aren&rsquo;t assigned to
        specific customers (CS leads, managers, sales engineers).
        Admins are always CSM team regardless.
      </p>
      <AccessAllowlistEditor initial={emails} />
    </div>
  );
}
