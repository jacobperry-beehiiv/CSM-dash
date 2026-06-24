import { auth } from "@/auth";
import { isCsmWithGmail } from "@/lib/auth/csm-eligibility";
import { MigrationWarmupForm } from "@/components/migration-warmup-form";

export const dynamic = "force-dynamic";

/**
 * /csm/migration-warmup — generate a list-by-list warm-up schedule
 * for an Enterprise migration and write it directly into a Google
 * Sheet inside the customer's Drive folder.
 *
 * Gated to CSMs with Gmail connected (we need the requester's Drive
 * token to create + populate the sheet). Ineligible viewers get the
 * standard explainer pointing at /settings/gmail.
 */
export default async function MigrationWarmupPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  const eligible = email ? await isCsmWithGmail(email) : false;

  if (!eligible) {
    return (
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 max-w-prose">
        <h2 className="text-lg font-semibold text-fg">
          Migration warm-up generator
        </h2>
        <p className="text-sm text-muted mt-2">
          This tool is for CSMs with a Gmail account connected. Connect
          at{" "}
          <a
            href="/settings/gmail"
            className="text-accent hover:underline font-medium"
          >
            /settings/gmail
          </a>
          , then come back here to generate a list-by-list warm-up
          schedule and have it land as a Google Sheet inside the
          customer&rsquo;s Drive folder.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="bg-surface rounded-xl border border-border shadow-card p-5">
        <h2 className="text-lg font-semibold text-fg">
          Migration warm-up generator
        </h2>
        <p className="text-xs text-muted mt-1 max-w-prose">
          Generates a deterministic, batched migration plan for one or
          more lists and writes it into a fresh Google Sheet inside the
          customer&rsquo;s Drive folder. Same algorithm as the
          standalone Python tool — picking the same inputs here will
          produce a byte-identical schedule.
        </p>
      </section>
      <MigrationWarmupForm />
    </div>
  );
}
