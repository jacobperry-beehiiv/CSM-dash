import { readDeliverabilitySnapshot } from "../src/lib/data/deliverability-snapshot";

const NEEDLE = (process.argv[2] ?? "").toLowerCase();

async function main() {
  const snap = await readDeliverabilitySnapshot();
  if (!snap) {
    console.log("No deliverability snapshot on disk.");
    process.exit(0);
  }
  console.log(
    `Snapshot generated_at=${snap.generated_at}, row_count=${snap.row_count}, lookback_days=${snap.lookback_days}`
  );
  console.log(`spam_dates: ${JSON.stringify(snap.spam_dates)}`);
  const matches = snap.posts.filter((p) => {
    const w = (p.workspace_name ?? "").toLowerCase();
    const n = (p.newsletter ?? "").toLowerCase();
    const id = (p.post_id ?? "").toLowerCase();
    return w.includes(NEEDLE) || n.includes(NEEDLE) || id.includes(NEEDLE);
  });
  console.log(`Matches for "${NEEDLE}": ${matches.length}`);
  for (const m of matches) {
    console.log("---");
    console.log(
      JSON.stringify(
        {
          post_id: m.post_id,
          publication_id: m.publication_id,
          newsletter: m.newsletter,
          workspace_name: m.workspace_name,
          organization_id: m.organization_id,
          sent_date: m.sent_date,
          subject: m.subject,
          sent: m.sent,
          delivered: m.delivered,
          delivery_rate: m.delivery_rate,
          open_rate: m.open_rate,
          hard_bounce_rate: m.hard_bounce_rate,
          soft_bounce_rate: m.soft_bounce_rate,
        },
        null,
        2
      )
    );
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
