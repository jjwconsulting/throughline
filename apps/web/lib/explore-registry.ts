// Registry for the /explore matrix picker. Defines the allowed row
// dimensions + metrics + the SQL fragments needed to build a generic
// pivot query.
//
// Each row dim's buildSql uses a DISTINCT table alias (`hco`, `hcp`,
// `terr`) so multi-dim grouping can JOIN to multiple dim tables in
// the same query without alias collisions. The dedupe step in the
// generic loader keeps the FROM clean when the same JOIN is requested
// by both group + leaf dims (e.g. HCO type group + HCO leaf).
//
// Adding a new row dimension: add an entry to ROW_DIMS with the
// supportsCalls / supportsSales flags + buildSql returning the JOINs,
// GROUP BY exprs, and metadata column exprs. Pick a unique alias if
// you're joining a new dim table.
//
// Adding a new metric: add an entry to METRICS with the fact table,
// date column, cell + total aggregations, and RLS-scope rewrite.

import type { Scope } from "@/lib/interactions";

export type RowDimId =
  | "hco"
  | "hcp"
  | "hco_type"
  | "hco_affiliation"
  | "hcp_tier"
  | "hcp_specialty"
  | "channel"
  | "territory";

export type MetricId = "calls" | "units" | "dollars";

export type RowDimSql = {
  joins: string[];
  keyExpr: string;
  labelExpr: string;
  subtitleExpr: string | null;
  metadataExprs: { header: string; expr: string }[];
  extraWhere: string[];
  groupBy: string[];
  hrefTemplate: string | null;
};

export type RowDim = {
  id: RowDimId;
  label: string;
  supportsCalls: boolean;
  supportsSales: boolean;
  buildSql: (metric: MetricId) => RowDimSql;
};

function hcoFactKey(metric: MetricId): string {
  return metric === "calls" ? "f.hco_key" : "f.account_key";
}

export const ROW_DIMS: RowDim[] = [
  {
    id: "hco",
    label: "HCO",
    supportsCalls: true,
    supportsSales: true,
    buildSql: (metric) => ({
      joins: [
        `JOIN gold.dim_hco hco ON hco.hco_key = ${hcoFactKey(metric)} AND hco.tenant_id = @tenantId`,
      ],
      keyExpr: "hco.hco_key",
      labelExpr: "hco.name",
      subtitleExpr: "hco.hco_type",
      metadataExprs: [
        {
          header: "Location",
          expr: `CONCAT_WS(', ', NULLIF(hco.city, ''), NULLIF(hco.state, ''))`,
        },
      ],
      extraWhere:
        metric === "units" || metric === "dollars"
          ? [`f.account_type = 'HCO'`, `${hcoFactKey(metric)} IS NOT NULL`]
          : [`${hcoFactKey(metric)} IS NOT NULL`],
      groupBy: ["hco.hco_key", "hco.name", "hco.hco_type", "hco.city", "hco.state"],
      hrefTemplate: "/hcos/{key}",
    }),
  },
  {
    id: "hcp",
    label: "HCP",
    supportsCalls: true,
    supportsSales: true,
    buildSql: (metric) => ({
      joins: [
        `JOIN gold.dim_hcp hcp ON hcp.hcp_key = ${metric === "calls" ? "f.hcp_key" : "f.account_key"} AND hcp.tenant_id = @tenantId`,
      ],
      keyExpr: "hcp.hcp_key",
      labelExpr: "hcp.name",
      subtitleExpr: "hcp.specialty_primary",
      metadataExprs: [
        { header: "Tier", expr: `COALESCE(NULLIF(hcp.tier, ''), '—')` },
        {
          header: "Location",
          expr: `CONCAT_WS(', ', NULLIF(hcp.city, ''), NULLIF(hcp.state, ''))`,
        },
      ],
      extraWhere:
        metric === "calls"
          ? [`f.hcp_key IS NOT NULL`]
          : [`f.account_type = 'HCP'`, `f.account_key IS NOT NULL`],
      groupBy: [
        "hcp.hcp_key",
        "hcp.name",
        "hcp.specialty_primary",
        "hcp.tier",
        "hcp.city",
        "hcp.state",
      ],
      hrefTemplate: "/hcps/{key}",
    }),
  },
  {
    id: "hco_affiliation",
    label: "HCO affiliation",
    // HCP's primary parent HCO (Veeva primary_parent__v, surfaced as
    // primary_parent_hco_key/name on dim_hcp). Calls flow through the
    // HCP → parent HCO link; sales same when account_type='HCP'
    // (sparse — most 867 sales attribute to HCO accounts directly,
    // not HCPs).
    supportsCalls: true,
    supportsSales: true,
    buildSql: (metric) => ({
      joins: [
        `JOIN gold.dim_hcp hcp ON hcp.hcp_key = ${metric === "calls" ? "f.hcp_key" : "f.account_key"} AND hcp.tenant_id = @tenantId`,
      ],
      keyExpr: `COALESCE(hcp.primary_parent_hco_key, 'no_affiliation')`,
      labelExpr: `COALESCE(NULLIF(hcp.primary_parent_hco_name, ''), 'No affiliation')`,
      subtitleExpr: null,
      metadataExprs: [],
      extraWhere:
        metric === "calls"
          ? [`f.hcp_key IS NOT NULL`]
          : [`f.account_type = 'HCP'`, `f.account_key IS NOT NULL`],
      groupBy: [
        `COALESCE(hcp.primary_parent_hco_key, 'no_affiliation')`,
        `COALESCE(NULLIF(hcp.primary_parent_hco_name, ''), 'No affiliation')`,
      ],
      // No href — the affiliation key uses the sentinel "no_affiliation"
      // for unaffiliated HCPs, which would 404 on /hcos. Real parent
      // HCO keys could route to /hcos/{key} but mixing routable + non-
      // routable rows in one column is confusing; keep it static.
      hrefTemplate: null,
    }),
  },
  {
    id: "hco_type",
    label: "HCO type",
    supportsCalls: false,
    supportsSales: true,
    buildSql: () => ({
      joins: [
        `JOIN gold.dim_hco hco ON hco.hco_key = f.account_key AND hco.tenant_id = @tenantId`,
      ],
      keyExpr: `COALESCE(NULLIF(hco.hco_type, ''), 'Unknown')`,
      labelExpr: `COALESCE(NULLIF(hco.hco_type, ''), 'Unknown')`,
      subtitleExpr: null,
      metadataExprs: [],
      extraWhere: [`f.account_type = 'HCO'`, `f.account_key IS NOT NULL`],
      groupBy: [`COALESCE(NULLIF(hco.hco_type, ''), 'Unknown')`],
      hrefTemplate: null,
    }),
  },
  {
    id: "hcp_tier",
    label: "HCP tier",
    supportsCalls: true,
    supportsSales: false,
    buildSql: () => ({
      joins: [
        `JOIN gold.dim_hcp hcp ON hcp.hcp_key = f.hcp_key AND hcp.tenant_id = @tenantId`,
      ],
      keyExpr: `COALESCE(NULLIF(hcp.tier, ''), 'Unknown')`,
      labelExpr: `CASE WHEN COALESCE(NULLIF(hcp.tier, ''), 'Unknown') = 'Unknown' THEN 'Unknown' ELSE 'Tier ' + hcp.tier END`,
      subtitleExpr: null,
      metadataExprs: [],
      extraWhere: [`f.hcp_key IS NOT NULL`],
      groupBy: [`COALESCE(NULLIF(hcp.tier, ''), 'Unknown')`, `hcp.tier`],
      hrefTemplate: null,
    }),
  },
  {
    id: "hcp_specialty",
    label: "HCP specialty",
    supportsCalls: true,
    supportsSales: false,
    buildSql: () => ({
      joins: [
        `JOIN gold.dim_hcp hcp ON hcp.hcp_key = f.hcp_key AND hcp.tenant_id = @tenantId`,
      ],
      keyExpr: `COALESCE(NULLIF(hcp.specialty_primary, ''), 'Unknown')`,
      labelExpr: `COALESCE(NULLIF(hcp.specialty_primary, ''), 'Unknown')`,
      subtitleExpr: null,
      metadataExprs: [],
      extraWhere: [`f.hcp_key IS NOT NULL`],
      groupBy: [`COALESCE(NULLIF(hcp.specialty_primary, ''), 'Unknown')`],
      hrefTemplate: null,
    }),
  },
  {
    id: "channel",
    label: "Channel",
    supportsCalls: true,
    supportsSales: false,
    buildSql: () => ({
      joins: [],
      keyExpr: `COALESCE(NULLIF(f.call_channel, ''), 'Unknown')`,
      labelExpr: `COALESCE(NULLIF(f.call_channel, ''), 'Unknown')`,
      subtitleExpr: null,
      metadataExprs: [],
      extraWhere: [],
      groupBy: [`COALESCE(NULLIF(f.call_channel, ''), 'Unknown')`],
      hrefTemplate: null,
    }),
  },
  {
    id: "territory",
    label: "Territory",
    supportsCalls: true,
    supportsSales: true,
    buildSql: (metric) => {
      // Calls: no fact_call.territory_key → join via HCP→territory
      // bridge. Sales: use fact_sale.territory_key directly.
      if (metric === "calls") {
        return {
          joins: [
            `JOIN gold.bridge_account_territory bridge ON bridge.account_key = f.hcp_key AND bridge.tenant_id = @tenantId`,
            `JOIN gold.dim_territory terr ON terr.territory_key = bridge.territory_key AND terr.tenant_id = @tenantId`,
          ],
          keyExpr: "terr.territory_key",
          labelExpr: `COALESCE(NULLIF(terr.description, ''), terr.name)`,
          subtitleExpr: `CASE WHEN terr.description IS NOT NULL AND terr.description <> '' THEN terr.name ELSE NULL END`,
          metadataExprs: [
            {
              header: "Current rep",
              expr: `COALESCE(terr.current_rep_name, '—')`,
            },
          ],
          extraWhere: [`f.hcp_key IS NOT NULL`],
          groupBy: [
            "terr.territory_key",
            "terr.description",
            "terr.name",
            "terr.current_rep_name",
          ],
          hrefTemplate: null,
        };
      }
      return {
        joins: [
          `JOIN gold.dim_territory terr ON terr.territory_key = f.territory_key AND terr.tenant_id = @tenantId`,
        ],
        keyExpr: "terr.territory_key",
        labelExpr: `COALESCE(NULLIF(terr.description, ''), terr.name)`,
        subtitleExpr: `CASE WHEN terr.description IS NOT NULL AND terr.description <> '' THEN terr.name ELSE NULL END`,
        metadataExprs: [
          {
            header: "Current rep",
            expr: `COALESCE(terr.current_rep_name, '—')`,
          },
        ],
        extraWhere: [`f.territory_key IS NOT NULL`],
        groupBy: [
          "terr.territory_key",
          "terr.description",
          "terr.name",
          "terr.current_rep_name",
        ],
        hrefTemplate: null,
      };
    },
  },
];

export type Metric = {
  id: MetricId;
  label: string;
  format: "number" | "dollars";
  factTable: string;
  dateColumn: string;
  cellAgg: (predicate: string) => string;
  totalAgg: string;
  rewriteScope: (s: Scope) => Scope;
};

function rewriteScopeForSales(scope: Scope): Scope {
  return {
    clauses: scope.clauses.map((c) =>
      c.replaceAll("owner_user_key", "rep_user_key"),
    ),
    params: scope.params,
  };
}

export const METRICS: Record<MetricId, Metric> = {
  calls: {
    id: "calls",
    label: "Calls",
    format: "number",
    factTable: "gold.fact_call",
    dateColumn: "call_date",
    cellAgg: (pred) => `SUM(CASE WHEN ${pred} THEN 1 ELSE 0 END)`,
    totalAgg: "COUNT(*)",
    rewriteScope: (s) => s,
  },
  units: {
    id: "units",
    label: "Net units",
    format: "number",
    factTable: "gold.fact_sale",
    dateColumn: "transaction_date",
    cellAgg: (pred) =>
      `ROUND(SUM(CASE WHEN ${pred} THEN f.signed_units ELSE 0 END), 0)`,
    totalAgg: `ROUND(SUM(f.signed_units), 0)`,
    rewriteScope: rewriteScopeForSales,
  },
  dollars: {
    id: "dollars",
    label: "Net dollars",
    format: "dollars",
    factTable: "gold.fact_sale",
    dateColumn: "transaction_date",
    cellAgg: (pred) =>
      `ROUND(SUM(CASE WHEN ${pred} THEN f.signed_gross_dollars ELSE 0 END), 0)`,
    totalAgg: `ROUND(SUM(f.signed_gross_dollars), 0)`,
    rewriteScope: rewriteScopeForSales,
  },
};

export function dimById(id: string): RowDim | undefined {
  return ROW_DIMS.find((d) => d.id === id);
}

export function metricById(id: string): Metric | undefined {
  return id in METRICS ? METRICS[id as MetricId] : undefined;
}

export function isCombinationSupported(
  dim: RowDim,
  metricId: MetricId,
): boolean {
  if (metricId === "calls") return dim.supportsCalls;
  return dim.supportsSales;
}
