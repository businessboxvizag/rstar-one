/**
 * Storage capacity & cost model. Pure functions so the forecast in
 * docs/storage-and-cost.md is reproducible and the storage dashboard can reuse it
 * with live usage numbers. All prices are inputs — verify current list prices
 * before purchasing; defaults are published list prices at time of writing (USD).
 */
export interface CostInputs {
  /** New raw footage per month, TB. */
  intakeTbPerMonth: number;
  months: number;
  /** Days raw footage stays in hot object storage before moving to archive. */
  hotDays: number;
  /** Finals + proxies + exports as a fraction of raw volume (kept hot). */
  derivedRatio: number;
  /** Fraction of raw footage that retention policy keeps forever (rest deleted after archiveYears). */
  prices: {
    hotPerTbMonth: number; // e.g. Cloudflare R2 Standard ~$15/TB-month
    archivePerTbMonth: number; // e.g. R2 Infrequent Access ~$10, Backblaze B2 ~$6
    backupPerTbMonth: number; // independent second provider/account
  };
  /** Back up hot data only (archive tier is itself the second copy of raw), or everything. */
  backupScope: "hot" | "all";
}

export interface MonthRow {
  month: number;
  hotTb: number;
  archiveTb: number;
  backupTb: number;
  totalStoredTb: number;
  costUsd: number;
}

export const DEFAULT_PRICES = { hotPerTbMonth: 15, archivePerTbMonth: 6, backupPerTbMonth: 6 } as const;

export function forecast(i: CostInputs): MonthRow[] {
  const rows: MonthRow[] = [];
  const hotMonths = i.hotDays / 30;
  for (let m = 1; m <= i.months; m++) {
    const rawTotal = i.intakeTbPerMonth * m;
    const rawHot = i.intakeTbPerMonth * Math.min(m, hotMonths);
    const rawArchive = Math.max(0, rawTotal - rawHot);
    const derived = rawTotal * i.derivedRatio;
    const hotTb = rawHot + derived;
    const archiveTb = rawArchive;
    const backupTb = i.backupScope === "all" ? hotTb + archiveTb : hotTb;
    const costUsd = hotTb * i.prices.hotPerTbMonth + archiveTb * i.prices.archivePerTbMonth + backupTb * i.prices.backupPerTbMonth;
    rows.push({ month: m, hotTb: round(hotTb), archiveTb: round(archiveTb), backupTb: round(backupTb), totalStoredTb: round(hotTb + archiveTb + backupTb), costUsd: round(costUsd) });
  }
  return rows;
}

export function cumulativeCost(rows: MonthRow[]): number {
  return round(rows.reduce((s, r) => s + r.costUsd, 0));
}

const round = (n: number) => Math.round(n * 100) / 100;
