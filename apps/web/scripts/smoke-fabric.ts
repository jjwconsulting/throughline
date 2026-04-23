// Verify all three signal loaders execute and return sensible counts.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(__dirname, "..", ".env.local") });

import {
  loadHcpInactivitySignals,
  loadActivityDropSignals,
  loadOverTargetingSignals,
} from "../lib/signals";
import { NO_SCOPE } from "../lib/interactions";

const FENNEC_TENANT_ID = "3b422d2b-d883-4d75-981d-5cd77c6c932d";

async function main() {
  console.log("HCP inactivity (admin scope):");
  const inactive = await loadHcpInactivitySignals(FENNEC_TENANT_ID, NO_SCOPE);
  console.log(`  ${inactive.length} signals`);
  inactive.slice(0, 3).forEach((s) => console.log(`    - ${s.title} | ${s.detail}`));

  console.log("\nActivity drop WoW (admin scope):");
  const drop = await loadActivityDropSignals(FENNEC_TENANT_ID, NO_SCOPE);
  console.log(`  ${drop.length} signals`);
  drop.slice(0, 3).forEach((s) => console.log(`    - ${s.title} | ${s.detail}`));

  console.log("\nOver-targeting (admin scope):");
  const over = await loadOverTargetingSignals(FENNEC_TENANT_ID, NO_SCOPE);
  console.log(`  ${over.length} signals`);
  over.slice(0, 3).forEach((s) => console.log(`    - ${s.title} | ${s.detail}`));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
