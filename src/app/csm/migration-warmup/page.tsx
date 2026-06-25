import { auth } from "@/auth";
import { isCsmWithGmail } from "@/lib/auth/csm-eligibility";
import { isAdmin } from "@/lib/auth/admin";
import { MigrationWarmupForm } from "@/components/migration-warmup-form";
import { loadMigrationOverrides } from "@/lib/data/migration-overrides";
import {
  DEFAULTS,
  type MigrationOverrides,
} from "@/lib/engines/migration-warmup/overrides";

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

  // Read overrides server-side so the form can show the active
  // values without an extra fetch. Falls back to the bundled
  // defaults for anything unset.
  const overrides = await loadMigrationOverrides();
  const viewerIsAdmin = isAdmin(email);

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
      <ActiveSettingsCard
        overrides={overrides}
        viewerIsAdmin={viewerIsAdmin}
      />
      <MigrationWarmupForm />
    </div>
  );
}

/** Compact "what numbers is the engine using right now?" card.
 *  Surfaces the three knobs the admin can tune at
 *  /admin/migration-warmup. Each value falls back to the bundled
 *  default when no override is set; we mark overridden values so
 *  it's visible at a glance which ones the team has changed. */
function ActiveSettingsCard({
  overrides,
  viewerIsAdmin,
}: {
  overrides: MigrationOverrides;
  viewerIsAdmin: boolean;
}) {
  const orT =
    overrides.open_rate_conservative_threshold ??
    DEFAULTS.open_rate_conservative_threshold;
  const orOverridden =
    overrides.open_rate_conservative_threshold !== undefined &&
    overrides.open_rate_conservative_threshold !==
      DEFAULTS.open_rate_conservative_threshold;
  const m = overrides.approach_multipliers ?? {};
  const mStd =
    m.standard ?? DEFAULTS.approach_multipliers.standard;
  const mCon =
    m.conservative ?? DEFAULTS.approach_multipliers.conservative;
  const mAgg =
    m.aggressive ?? DEFAULTS.approach_multipliers.aggressive;
  const mw = overrides.max_weeks ?? DEFAULTS.max_weeks;
  const mwc = overrides.max_weeks_conservative ?? mw;
  const mwcOverridden =
    overrides.max_weeks_conservative !== undefined &&
    overrides.max_weeks_conservative !== mw;
  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-4 text-xs">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold text-fg">
          Algorithm settings
        </h3>
        {viewerIsAdmin ? (
          <a
            href="/settings/migration-warmup"
            className="text-[11px] text-accent hover:underline"
          >
            Edit ↗
          </a>
        ) : (
          <a
            href="/settings/migration-warmup"
            className="text-[11px] text-accent hover:underline"
            title="View-only — only super-admins can change these"
          >
            View ↗
          </a>
        )}
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 text-muted">
        <li>
          Conservative if open rate &lt;{" "}
          <span className="font-mono text-fg">
            {Math.round(orT * 100)}%
          </span>
          {orOverridden ? <Overridden /> : null}
        </li>
        <li>
          Max weeks (global):{" "}
          <span className="font-mono text-fg">{mw}</span>
          {overrides.max_weeks !== undefined &&
          overrides.max_weeks !== DEFAULTS.max_weeks ? (
            <Overridden />
          ) : null}
        </li>
        <li>
          Max weeks (conservative):{" "}
          <span className="font-mono text-fg">{mwc}</span>
          {mwcOverridden ? <Overridden /> : null}
        </li>
        <li className="md:col-span-2">
          Batch size %:{" "}
          <span className="font-mono text-fg">
            standard {Math.round(mStd * 100)}%
          </span>{" "}
          ·{" "}
          <span className="font-mono text-fg">
            conservative {Math.round(mCon * 100)}%
          </span>{" "}
          ·{" "}
          <span className="font-mono text-fg">
            aggressive {Math.round(mAgg * 100)}%
          </span>
        </li>
      </ul>
    </section>
  );
}

function Overridden() {
  return (
    <span className="ml-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
      (overridden)
    </span>
  );
}
