import { loadOverrides, applyOverride } from "../src/lib/data/customer-overrides";
import { readSnapshot } from "../src/lib/data/snapshot-loader";
import { metabaseRowToCustomer } from "../src/lib/data/metabase-mapper";
import { loadCustomers } from "../src/lib/data/load-customers";

const DELTA_WID = "3be67da5-442c-4e95-b2d4-2e777a3576bd";

async function main() {
  // 1) Raw snapshot row for Delta Digital
  const snap = await readSnapshot();
  const raw = snap.rows.find(
    (r) => (r.workspace_id as string | null) === DELTA_WID
  );
  console.log("RAW SNAPSHOT row:");
  console.log(`  customer_success_manager: ${raw?.customer_success_manager}`);
  console.log(`  customer_success_manager_email: ${raw?.customer_success_manager_email}`);
  console.log(`  hubspot_company_id: ${raw?.hubspot_company_id}`);

  // 2) Override for this workspace
  const overrides = await loadOverrides();
  const ov = overrides[DELTA_WID];
  console.log("\nOVERRIDE for this workspace_id:");
  console.log(ov ? JSON.stringify(ov, null, 2) : "  (no override)");

  // 3) After applyOverride
  if (raw) {
    const mapped = metabaseRowToCustomer(raw);
    const withOv = ov ? applyOverride(mapped, { [DELTA_WID]: ov }) : mapped;
    console.log("\nAFTER applyOverride:");
    console.log(`  customer_success_manager: ${withOv.customer_success_manager}`);
    console.log(`  customer_success_manager_email: ${withOv.customer_success_manager_email}`);
  }

  // 4) loadCustomers (the actual dashboard path)
  const customers = await loadCustomers();
  const dashboard = customers.find((c) => c.workspace_id === DELTA_WID);
  console.log("\nloadCustomers() (what the dashboard sees):");
  console.log(`  customer_success_manager: ${dashboard?.customer_success_manager}`);
  console.log(`  customer_success_manager_email: ${dashboard?.customer_success_manager_email}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
