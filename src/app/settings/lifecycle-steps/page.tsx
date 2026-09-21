import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadSettings } from "@/lib/data/settings";
import { resolveLifecycleStepStages } from "@/lib/lifecycle/step-stage-config";
import { LifecycleStepStagesEditor } from "@/components/lifecycle-step-stages-editor";

export const dynamic = "force-dynamic";

/**
 * /settings/lifecycle-steps — reassign which board column each
 * onboarding/live playbook step shows its checklist item under (see
 * src/lib/lifecycle/step-stage-config.ts for the canonical step list
 * + defaults, and the Lifecycle tab's Onboarding/Live boards for
 * where this actually renders).
 *
 * Deliberately a standalone page, not a section under /settings/slack
 * — the settings-configurable *column list* that used to live there
 * was removed (columns are fixed constants now, see ONBOARDING_STAGES
 * in onboarding.ts / LIVE_ASSIGNABLE_STAGES in live-quarter.ts); this
 * page only reassigns which of those fixed columns a step belongs to.
 *
 * Gated by the lifecycle-board feature flag. Non-allowlist users land
 * on the 404, matching the wins / sybill / gmail-labels pattern.
 */
export default async function LifecycleStepStagesPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("lifecycle-board", email))) {
    notFound();
  }

  const settings = await loadSettings();
  const stepStages = resolveLifecycleStepStages(settings.lifecycle_step_stages);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Lifecycle board — step columns
      </h1>
      <p className="text-sm text-muted mb-4 max-w-2xl">
        Reassign which column on the Lifecycle tab&rsquo;s{" "}
        <strong>Onboarding</strong> and <strong>Live</strong> boards each
        playbook step&rsquo;s checklist item shows under — including moving a
        step from one board to the other. Changes apply the next time a
        board loads — nothing here is retroactive to how a card was already
        placed. Any step Normbot&rsquo;s playbook grows that hasn&rsquo;t been
        placed yet shows up under <strong>Unassigned</strong> below until
        you pick a column for it.
      </p>
      <p className="text-xs text-subtle mb-6 max-w-2xl">
        Renewal-stage steps (First Outreach Sent, Follow Up Sent, Call
        Scheduled, Renewal Confirmed, Renewal Lost) aren&rsquo;t configured
        here — those live under{" "}
        <Link href="/settings/slack" className="text-accent hover:underline">
          Slack settings
        </Link>
        , alongside the Renewals lifecycle stages the AM team already edits.
      </p>
      <LifecycleStepStagesEditor initial={stepStages} />
    </div>
  );
}
