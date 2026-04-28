// Generic matrix loader powering /explore. Composes a pivot query
// from a row dimension + an optional outer GROUP dimension + a metric
// (all from explore-registry.ts) + the usual DashboardFilters
// (range, granularity, channel, territory) + RLS scope.
//
// SINGLE-DIM mode (groupDim = null): one pivot SELECT, rows ORDER BY
// total DESC, cap at rowLimit (default 100). Result has one virtual
// group containing all rows so the UI / CSV path is uniform.
//
// MULTI-DIM mode (groupDim set): TWO parallel queries —
//   1. group-level subtotals query: GROUP BY groupDim only, returns
//      accurate bucket subtotals + total per group (not affected by
//      the per-group leaf cap)
//   2. leaf-level query: GROUP BY both dims with per-group ROW_NUMBER
//      cap so each group shows up to leafLimit (default 20) leaves
// Stitched in JS by group_key.

import { queryFabric } from "@/lib/fabric";
import {
  rangeDates,
  chartBuckets,
  filtersToParams,
  territorySalesFilter,
  type DashboardFilters,
  type Granularity,
} from "@/app/(app)/dashboard/filters";
import { type Scope, NO_SCOPE } from "@/lib/interactions";
import {
  METRICS,
  type RowDim,
  type Metric,
  type MetricId,
  isCombinationSupported,
} from "@/lib/explore-registry";

function scopeSql(scope: Scope): string {
  return scope.clauses.join(" ");
}

export type Bucket = {
  start: string;
  end: string;
  label: string;
};

export type GenericMatrixLeaf = {
  key: string;
  label: string;
  subtitle: string | null;
  metadata: (string | null)[];
  cells: (number | null)[];
  total: number;
  first_sale_date: string | null;
  href: string | null;
  // The group key this leaf belongs to. Always set; in single-dim
  // mode it's the sentinel "__all__".
  groupKey: string;
};

export type GenericMatrixGroup = {
  key: string;
  // Display label. Null in single-dim mode (UI hides the header row).
  label: string | null;
  subtitle: string | null;
  // Accurate bucket subtotals from the group-level query (correct even
  // when leaves are capped). Null in single-dim mode.
  subtotalCells: (number | null)[] | null;
  subtotalTotal: number | null;
  leaves: GenericMatrixLeaf[];
};

export type GenericMatrix = {
  buckets: Bucket[];
  groups: GenericMatrixGroup[];
  cellMin: number;
  cellMax: number;
  rowDim: RowDim;
  groupDim: RowDim | null;
  metric: Metric;
  metadataHeaders: string[];
  unsupported: boolean;
};

// ---------------------------------------------------------------------------
// Bucket generation
// ---------------------------------------------------------------------------

function startOfBucket(d: Date, g: Granularity): Date {
  const utc = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  if (g === "week") {
    const epoch = new Date(Date.UTC(1900, 0, 1));
    const days = Math.round(
      (utc.getTime() - epoch.getTime()) / (1000 * 60 * 60 * 24),
    );
    const offset = ((days % 7) + 7) % 7;
    utc.setUTCDate(utc.getUTCDate() - offset);
    return utc;
  }
  if (g === "month") {
    return new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), 1));
  }
  const qStart = Math.floor(utc.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(utc.getUTCFullYear(), qStart, 1));
}

function addBuckets(d: Date, g: Granularity, n: number): Date {
  const next = new Date(d);
  if (g === "week") next.setUTCDate(next.getUTCDate() + 7 * n);
  else if (g === "month") next.setUTCMonth(next.getUTCMonth() + n);
  else next.setUTCMonth(next.getUTCMonth() + 3 * n);
  return next;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function bucketLabel(start: Date, g: Granularity): string {
  if (g === "week") {
    return start.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  if (g === "month") {
    return start.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
  }
  const q = Math.floor(start.getUTCMonth() / 3) + 1;
  return `Q${q} ${String(start.getUTCFullYear()).slice(-2)}`;
}

function buildBuckets(filters: DashboardFilters): Bucket[] {
  const today = new Date();
  const anchorStart = startOfBucket(today, filters.granularity);
  const n = chartBuckets(filters);
  const buckets: Bucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addBuckets(anchorStart, filters.granularity, -i);
    const nextStart = addBuckets(start, filters.granularity, 1);
    const end = new Date(nextStart);
    end.setUTCDate(end.getUTCDate() - 1);
    buckets.push({
      start: isoDate(start),
      end: isoDate(end),
      label: bucketLabel(start, filters.granularity),
    });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// SQL composition helpers
// ---------------------------------------------------------------------------

// Builds the per-bucket conditional aggregation column list for the
// chosen metric. Inline ISO dates (system-generated, no injection
// risk) keep the column count parameter-free.
function bucketColumnsSql(metric: Metric, buckets: Bucket[]): string {
  return buckets
    .map((b, i) => {
      const pred = `f.${metric.dateColumn} >= '${b.start}' AND f.${metric.dateColumn} <= '${b.end}'`;
      return `${metric.cellAgg(pred)} AS bucket_${i}`;
    })
    .join(",\n           ");
}

// Dedupes JOINs by exact-string match. Two dims that need the same
// JOIN (e.g. HCO type group + HCO leaf both join dim_hco) collapse to
// one alias. Different aliases keep their JOINs separate.
function dedupedJoins(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const j of list) {
      if (!seen.has(j)) {
        seen.add(j);
        out.push(j);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generic matrix loader
// ---------------------------------------------------------------------------

export async function loadGenericMatrix(args: {
  tenantId: string;
  rowDim: RowDim;
  groupDim?: RowDim | null;
  metricId: MetricId;
  filters: DashboardFilters;
  includeFirstSale?: boolean;
  scope?: Scope;
  rowLimit?: number;
  // Cap on leaves PER GROUP (multi-dim mode only). Single-dim uses
  // rowLimit as the overall cap.
  leafLimitPerGroup?: number;
  groupLimit?: number;
}): Promise<GenericMatrix> {
  const {
    tenantId,
    rowDim,
    groupDim = null,
    metricId,
    filters,
    includeFirstSale = false,
    scope = NO_SCOPE,
    rowLimit = 100,
    leafLimitPerGroup = 20,
    groupLimit = 30,
  } = args;

  const metric: Metric = METRICS[metricId];
  const buckets = buildBuckets(filters);
  const empty: GenericMatrix = {
    buckets,
    groups: [],
    cellMin: 0,
    cellMax: 0,
    rowDim,
    groupDim,
    metric,
    metadataHeaders: [],
    unsupported: false,
  };

  if (!isCombinationSupported(rowDim, metricId)) {
    return { ...empty, unsupported: true };
  }
  // Group dim must also support the metric. If not, surface as
  // unsupported so the page renders an empty state with the picker
  // reachable to fix the combo.
  if (groupDim && !isCombinationSupported(groupDim, metricId)) {
    return { ...empty, unsupported: true };
  }
  if (buckets.length === 0) return empty;

  try {
    const rangeStart = buckets[0]!.start;
    const rangeEnd = buckets[buckets.length - 1]!.end;
    const leafSql = rowDim.buildSql(metricId);
    const groupSqlSpec = groupDim?.buildSql(metricId) ?? null;
    const effectiveScope = metric.rewriteScope(scope);
    const params: Record<string, string | number | null | Date | boolean> = {
      ...filtersToParams(filters),
      ...effectiveScope.params,
      matrixRangeStart: rangeStart,
      matrixRangeEnd: rangeEnd,
    };

    // Combined JOIN list, extra-WHERE list, and bucket columns are
    // shared between single-dim and multi-dim queries.
    const allJoins = dedupedJoins(
      groupSqlSpec?.joins ?? [],
      leafSql.joins,
    );
    const allExtraWhere = Array.from(
      new Set([...(groupSqlSpec?.extraWhere ?? []), ...leafSql.extraWhere]),
    );
    const extraWhereClause =
      allExtraWhere.length > 0
        ? `AND ${allExtraWhere.join("\n           AND ")}`
        : "";
    const bucketCols = bucketColumnsSql(metric, buckets);
    const territoryClause =
      metric.id === "calls" ? "" : territorySalesFilter(filters);

    const metadataHeaders = leafSql.metadataExprs.map((m) => m.header);

    const wantsFirstSale =
      includeFirstSale && rowDim.id === "hco" && metric.id !== "calls";
    const firstSaleCte = wantsFirstSale
      ? `,
        first_sales AS (
          SELECT account_key, MIN(transaction_date) AS first_sale_date
          FROM gold.fact_sale
          WHERE tenant_id = @tenantId
            AND account_type = 'HCO'
            AND account_key IS NOT NULL
            ${scopeSql(effectiveScope)}
            ${territoryClause}
          GROUP BY account_key
        )`
      : "";
    const firstSaleSelect = wantsFirstSale
      ? `, CONVERT(varchar(10), fs.first_sale_date, 23) AS first_sale_date`
      : `, NULL AS first_sale_date`;
    const firstSaleJoin = wantsFirstSale
      ? `LEFT JOIN first_sales fs ON fs.account_key = a.row_key`
      : "";

    if (groupDim == null || groupSqlSpec == null) {
      // ---------------- SINGLE-DIM MODE ----------------
      return await runSingleDim({
        tenantId,
        params,
        rowDim,
        leafSql,
        metric,
        buckets,
        bucketCols,
        allJoins,
        extraWhereClause,
        scopeSql: scopeSql(effectiveScope),
        territoryClause,
        firstSaleCte,
        firstSaleSelect,
        firstSaleJoin,
        rowLimit,
        metadataHeaders,
      });
    }

    // ---------------- MULTI-DIM MODE ----------------
    const groupLeafSql = groupSqlSpec;

    // Group-level query: subtotals per group. Same pattern as single-
    // dim but with the GROUP dim as the row dim (no leaf metadata).
    const groupQuerySql = `
      SELECT TOP ${groupLimit}
        ${groupLeafSql.keyExpr} AS group_key,
        ${groupLeafSql.labelExpr} AS group_label,
        ${groupLeafSql.subtitleExpr ? groupLeafSql.subtitleExpr : "NULL"} AS group_subtitle,
        ${bucketCols},
        ${metric.totalAgg} AS total_value
      FROM ${metric.factTable} f
      ${allJoins.join("\n      ")}
      WHERE f.tenant_id = @tenantId
        AND f.${metric.dateColumn} >= @matrixRangeStart
        AND f.${metric.dateColumn} <= @matrixRangeEnd
        ${extraWhereClause}
        ${scopeSql(effectiveScope)}
        ${territoryClause}
      GROUP BY ${groupLeafSql.groupBy.join(", ")}${groupLeafSql.subtitleExpr ? `, ${groupLeafSql.subtitleExpr}` : ""}
      HAVING ${metric.totalAgg} <> 0
      ORDER BY ${metric.totalAgg} DESC
    `;

    // Leaf-level query: leaves bucketed per group with per-group cap.
    const leafMetadataSelect = leafSql.metadataExprs
      .map((m, i) => `${m.expr} AS meta_${i}`)
      .join(",\n           ");
    const leafMetadataSelectClause = leafMetadataSelect
      ? `${leafMetadataSelect},`
      : "";
    const combinedGroupBy = Array.from(
      new Set([
        ...groupLeafSql.groupBy,
        ...leafSql.groupBy,
        ...(leafSql.subtitleExpr ? [leafSql.subtitleExpr] : []),
        ...(groupLeafSql.subtitleExpr ? [groupLeafSql.subtitleExpr] : []),
      ]),
    );

    const leafQuerySql = `WITH leaf_agg AS (
         SELECT
           ${groupLeafSql.keyExpr} AS group_key,
           ${leafSql.keyExpr} AS row_key,
           ${leafSql.labelExpr} AS row_label,
           ${leafSql.subtitleExpr ? leafSql.subtitleExpr : "NULL"} AS subtitle,
           ${leafMetadataSelectClause}
           ${bucketCols},
           ${metric.totalAgg} AS total_value
         FROM ${metric.factTable} f
         ${allJoins.join("\n         ")}
         WHERE f.tenant_id = @tenantId
           AND f.${metric.dateColumn} >= @matrixRangeStart
           AND f.${metric.dateColumn} <= @matrixRangeEnd
           ${extraWhereClause}
           ${scopeSql(effectiveScope)}
           ${territoryClause}
         GROUP BY ${combinedGroupBy.join(", ")}
         HAVING ${metric.totalAgg} <> 0
       ),
       ranked AS (
         SELECT *,
           ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY total_value DESC) AS rn
         FROM leaf_agg
       )
       ${firstSaleCte}
       SELECT
         a.group_key,
         a.row_key,
         a.row_label,
         a.subtitle,
         ${leafSql.metadataExprs.map((_, i) => `a.meta_${i}`).join(", ")}${leafSql.metadataExprs.length > 0 ? "," : ""}
         ${buckets.map((_, i) => `a.bucket_${i}`).join(", ")},
         a.total_value
         ${firstSaleSelect}
       FROM ranked a
       ${firstSaleJoin}
       WHERE a.rn <= ${leafLimitPerGroup}
       ORDER BY a.total_value DESC`;

    type GroupSqlRow = {
      group_key: string;
      group_label: string;
      group_subtitle: string | null;
      total_value: number;
    } & Record<`bucket_${number}`, number | null>;

    type LeafSqlRow = {
      group_key: string;
      row_key: string;
      row_label: string;
      subtitle: string | null;
      total_value: number;
      first_sale_date: string | null;
    } & Record<`bucket_${number}`, number | null> &
      Record<`meta_${number}`, string | null>;

    const [groupRows, leafRows] = await Promise.all([
      queryFabric<GroupSqlRow>(tenantId, groupQuerySql, params),
      queryFabric<LeafSqlRow>(tenantId, leafQuerySql, params),
    ]);

    // Stitch leaves into groups. Track global heatmap bounds across
    // BOTH group subtotals and leaf cells so the shading scale is
    // consistent everywhere on screen.
    let cellMin = Infinity;
    let cellMax = -Infinity;

    const groupsByKey = new Map<string, GenericMatrixGroup>();
    for (const g of groupRows) {
      const subtotalCells: (number | null)[] = buckets.map((_, i) => {
        const raw = g[`bucket_${i}` as `bucket_${number}`];
        const v = raw == null ? null : Number(raw);
        if (v != null && v !== 0) {
          if (v < cellMin) cellMin = v;
          if (v > cellMax) cellMax = v;
          return v;
        }
        return null;
      });
      groupsByKey.set(g.group_key, {
        key: g.group_key,
        label: g.group_label,
        subtitle: g.group_subtitle,
        subtotalCells,
        subtotalTotal: Number(g.total_value) || 0,
        leaves: [],
      });
    }

    for (const r of leafRows) {
      const group = groupsByKey.get(r.group_key);
      if (!group) continue; // group exceeded groupLimit
      const cells: (number | null)[] = buckets.map((_, i) => {
        const raw = r[`bucket_${i}` as `bucket_${number}`];
        const v = raw == null ? null : Number(raw);
        if (v != null && v !== 0) {
          if (v < cellMin) cellMin = v;
          if (v > cellMax) cellMax = v;
          return v;
        }
        return null;
      });
      const metadata = leafSql.metadataExprs.map(
        (_, i) => r[`meta_${i}` as `meta_${number}`] ?? null,
      );
      const href =
        leafSql.hrefTemplate != null
          ? leafSql.hrefTemplate.replace("{key}", encodeURIComponent(r.row_key))
          : null;
      group.leaves.push({
        key: r.row_key,
        label: r.row_label,
        subtitle: r.subtitle,
        metadata,
        cells,
        total: Number(r.total_value) || 0,
        first_sale_date: r.first_sale_date,
        href,
        groupKey: r.group_key,
      });
    }

    if (cellMin === Infinity) cellMin = 0;
    if (cellMax === -Infinity) cellMax = 0;

    return {
      buckets,
      groups: Array.from(groupsByKey.values()),
      cellMin,
      cellMax,
      rowDim,
      groupDim,
      metric,
      metadataHeaders,
      unsupported: false,
    };
  } catch (err) {
    console.error("loadGenericMatrix failed:", err);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Single-dim path (extracted for clarity)
// ---------------------------------------------------------------------------

async function runSingleDim(args: {
  tenantId: string;
  params: Record<string, string | number | null | Date | boolean>;
  rowDim: RowDim;
  leafSql: ReturnType<RowDim["buildSql"]>;
  metric: Metric;
  buckets: Bucket[];
  bucketCols: string;
  allJoins: string[];
  extraWhereClause: string;
  scopeSql: string;
  territoryClause: string;
  firstSaleCte: string;
  firstSaleSelect: string;
  firstSaleJoin: string;
  rowLimit: number;
  metadataHeaders: string[];
}): Promise<GenericMatrix> {
  const {
    tenantId,
    params,
    rowDim,
    leafSql,
    metric,
    buckets,
    bucketCols,
    allJoins,
    extraWhereClause,
    scopeSql,
    territoryClause,
    firstSaleCte,
    firstSaleSelect,
    firstSaleJoin,
    rowLimit,
    metadataHeaders,
  } = args;

  const metadataSelect = leafSql.metadataExprs
    .map((m, i) => `${m.expr} AS meta_${i}`)
    .join(",\n           ");
  const metadataSelectClause = metadataSelect ? `${metadataSelect},` : "";
  const subtitleClause = leafSql.subtitleExpr
    ? `${leafSql.subtitleExpr} AS subtitle,`
    : "NULL AS subtitle,";

  const sql = `WITH agg AS (
         SELECT
           ${leafSql.keyExpr} AS row_key,
           ${leafSql.labelExpr} AS row_label,
           ${subtitleClause}
           ${metadataSelectClause}
           ${bucketCols},
           ${metric.totalAgg} AS total_value
         FROM ${metric.factTable} f
         ${allJoins.join("\n         ")}
         WHERE f.tenant_id = @tenantId
           AND f.${metric.dateColumn} >= @matrixRangeStart
           AND f.${metric.dateColumn} <= @matrixRangeEnd
           ${extraWhereClause}
           ${scopeSql}
           ${territoryClause}
         GROUP BY ${leafSql.groupBy.join(", ")}${leafSql.subtitleExpr ? `, ${leafSql.subtitleExpr}` : ""}
         HAVING ${metric.totalAgg} <> 0
       )
       ${firstSaleCte}
       SELECT TOP ${rowLimit}
         a.row_key,
         a.row_label,
         a.subtitle,
         ${leafSql.metadataExprs.map((_, i) => `a.meta_${i}`).join(", ")}${leafSql.metadataExprs.length > 0 ? "," : ""}
         ${buckets.map((_, i) => `a.bucket_${i}`).join(", ")},
         a.total_value
         ${firstSaleSelect}
       FROM agg a
       ${firstSaleJoin}
       ORDER BY a.total_value DESC`;

  type SqlRow = {
    row_key: string;
    row_label: string;
    subtitle: string | null;
    total_value: number;
    first_sale_date: string | null;
  } & Record<`bucket_${number}`, number | null> &
    Record<`meta_${number}`, string | null>;

  const rows = await queryFabric<SqlRow>(tenantId, sql, params);

  let cellMin = Infinity;
  let cellMax = -Infinity;
  const leaves: GenericMatrixLeaf[] = rows.map((r) => {
    const cells: (number | null)[] = buckets.map((_, i) => {
      const raw = r[`bucket_${i}` as `bucket_${number}`];
      const v = raw == null ? null : Number(raw);
      if (v != null && v !== 0) {
        if (v < cellMin) cellMin = v;
        if (v > cellMax) cellMax = v;
        return v;
      }
      return null;
    });
    const metadata = leafSql.metadataExprs.map(
      (_, i) => r[`meta_${i}` as `meta_${number}`] ?? null,
    );
    const href =
      leafSql.hrefTemplate != null
        ? leafSql.hrefTemplate.replace("{key}", encodeURIComponent(r.row_key))
        : null;
    return {
      key: r.row_key,
      label: r.row_label,
      subtitle: r.subtitle,
      metadata,
      cells,
      total: Number(r.total_value) || 0,
      first_sale_date: r.first_sale_date,
      href,
      groupKey: "__all__",
    };
  });

  if (cellMin === Infinity) cellMin = 0;
  if (cellMax === -Infinity) cellMax = 0;

  return {
    buckets,
    // Wrap leaves in one virtual group so the UI / CSV path is uniform.
    groups: [
      {
        key: "__all__",
        label: null,
        subtitle: null,
        subtotalCells: null,
        subtotalTotal: null,
        leaves,
      },
    ],
    cellMin,
    cellMax,
    rowDim,
    groupDim: null,
    metric,
    metadataHeaders,
    unsupported: false,
  };
}
