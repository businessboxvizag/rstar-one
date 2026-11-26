import { DEFAULT_PRICES, cumulativeCost, forecast } from "../src/storage-cost.js";

const scenarios = {
  "A: everything in hot storage, full backup": { hotDays: 100000, derivedRatio: 0.08, backupScope: "all" as const },
  "B: 90 days hot, then archive tier; back up hot only": { hotDays: 90, derivedRatio: 0.08, backupScope: "hot" as const },
};
for (const [name, s] of Object.entries(scenarios)) {
  console.log(`\n${name}`);
  console.log("| Intake/month | Month 12 stored (TB) | Month 12 bill (USD/mo) | Year 1 total (USD) | Month 24 stored (TB) | Month 24 bill (USD/mo) | Years 1-2 total (USD) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const tb of [3, 4, 5]) {
    const rows = forecast({ intakeTbPerMonth: tb, months: 24, ...s, prices: DEFAULT_PRICES });
    const m12 = rows[11]!, m24 = rows[23]!;
    console.log(`| ${tb} TB | ${m12.totalStoredTb} | ${m12.costUsd} | ${cumulativeCost(rows.slice(0, 12))} | ${m24.totalStoredTb} | ${m24.costUsd} | ${cumulativeCost(rows)} |`);
  }
}
