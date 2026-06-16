import { readSnapshot } from "../src/lib/data/snapshot-loader";

const NEEDLE = (process.argv[2] ?? "front office sports").toLowerCase();

async function main() {
  const snap = await readSnapshot();
  console.log(`Snapshot row_count=${snap.row_count}, generated_at=${snap.generated_at}`);
  const matches = snap.rows.filter((r) => {
    const w = String(r.workspace_name ?? "").toLowerCase();
    const c = String(r.company_name ?? "").toLowerCase();
    const id = String(r.workspace_id ?? "").toLowerCase();
    return w.includes(NEEDLE) || c.includes(NEEDLE) || id === NEEDLE;
  });
  console.log(`Matches for "${NEEDLE}": ${matches.length}`);
  for (const m of matches) {
    console.log("---");
    console.log(JSON.stringify({
      workspace_id: m.workspace_id,
      workspace_name: m.workspace_name,
      company_name: m.company_name,
      owner_email: m.owner_email,
      customer_success_manager: m.customer_success_manager,
      customer_success_manager_email: m.customer_success_manager_email,
      stripe_plan: m.stripe_plan,
      stripe_customer_id: m.stripe_customer_id,
      hubspot_company_id: m.hubspot_company_id,
      property_company_status: m.property_company_status,
      arr: m.arr,
      mrr: m.mrr,
    }, null, 2));
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
