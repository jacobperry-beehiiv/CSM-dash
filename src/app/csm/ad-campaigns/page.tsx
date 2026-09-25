import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { runAdCampaigns } from "@/lib/engines/ad-campaigns";
import { AdCampaignsView } from "@/components/ad-campaigns-view";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * /csm/ad-campaigns — every ad network campaign currently running,
 * with its categorisation, advertiser tier, payout terms and goal.
 *
 * A reference view rather than a book view: it isn't scoped to a
 * CSM's customers, so it lives as its own page alongside
 * /csm/migration-warmup instead of as a tab on /csm. A CSM opens it
 * to answer "what could this publication run?", which has nothing to
 * do with which accounts they own.
 *
 * Data is fetched server-side and handed to the client whole — ~51
 * rows, so filtering and facet counts happen in the browser with no
 * round-trip. See the engine header for why that's the right call at
 * this size.
 */
export default async function AdCampaignsPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/api/auth/signin");

  let report;
  try {
    report = await runAdCampaigns();
  } catch (e) {
    return (
      <section className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-xl p-4 text-sm text-red-800 dark:text-red-300">
        <h2 className="font-semibold mb-1">
          Couldn&rsquo;t load ad network campaigns
        </h2>
        <p>{e instanceof Error ? e.message : "Unknown error"}</p>
        <p className="mt-2 text-xs">
          This view reads the Swarm production replica through Metabase.
          A failure here is usually a Metabase auth problem — check
          METABASE_API_KEY.
        </p>
      </section>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Live ad network campaigns
      </h1>
      <p className="text-sm text-muted mb-4 max-w-prose">
        Every campaign currently running in the ad network, with the
        advertiser&rsquo;s content and targeting categories, tier, payout
        terms and goal. Filter to find campaigns that fit a
        publication&rsquo;s audience. Content tags are set on nearly every
        advertiser; targeting tags and industry are sparse, so an empty
        result under those usually means untagged rather than no match.
      </p>
      <AdCampaignsView rows={report.rows} fetchedAt={report.fetched_at} />
    </div>
  );
}
