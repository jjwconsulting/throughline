// Compare recommendations across period types to confirm the engine actually
// adapts to the date window.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(__dirname, "..", ".env.local") });

import { queryFabric } from "../lib/fabric";
import { recommendCallGoalsForReps } from "../lib/goal-recommendations";

const FENNEC_TENANT_ID = "3b422d2b-d883-4d75-981d-5cd77c6c932d";

const PERIODS: { label: string; start: string; end: string }[] = [
  { label: "Q3 2026 (92d)", start: "2026-07-01", end: "2026-09-30" },
  { label: "Q2 2026 (91d)", start: "2026-04-01", end: "2026-06-30" },
  { label: "May 2026 (31d)", start: "2026-05-01", end: "2026-05-31" },
  { label: "2027 (365d)", start: "2027-01-01", end: "2027-12-31" },
];

async function main() {
  const reps = await queryFabric<{ user_key: string; name: string }>(
    FENNEC_TENANT_ID,
    `SELECT TOP 5 u.user_key, u.name
     FROM gold.fact_call f
     JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId AND u.user_type IN ('Sales', 'Medical')
     GROUP BY u.user_key, u.name
     ORDER BY COUNT(*) DESC`,
  );
  const userKeys = reps.map((r) => r.user_key);

  const results = await Promise.all(
    PERIODS.map(async (p) => ({
      period: p.label,
      recs: await recommendCallGoalsForReps(
        FENNEC_TENANT_ID,
        userKeys,
        p.start,
        p.end,
      ),
    })),
  );

  console.log(`${"Rep".padEnd(28)}  ${PERIODS.map((p) => p.label.padStart(18)).join(" ")}`);
  for (const rep of reps) {
    const cells = results.map((r) =>
      String(
        r.recs.find((x) => x.user_key === rep.user_key)?.recommendation.value ?? "—",
      ).padStart(18),
    );
    console.log(`${rep.name.padEnd(28)}  ${cells.join(" ")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
