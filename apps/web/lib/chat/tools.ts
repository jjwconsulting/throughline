// Tool registry for the /ask conversational analytics surface.
//
// Each tool is a thin wrapper over an existing loader (loadTopHcosBySales,
// loadAccountMotion, etc.) so the chat surface inherits the same RLS,
// caching, and data semantics as the rest of the app. The LLM sees:
//   - tool name + description (drives picking)
//   - JSON-schema input (drives parameter parsing)
// The LLM never touches SQL directly. Tenant + role isolation is enforced
// at the loader layer (belt + suspenders per docs/product/llm-expansion.md).
//
// Adding a tool: append a new ToolDef to TOOLS. The handler receives
// validated input + a context with tenantId, userScope (role-aware) and
// sqlScope (SQL clauses for query-layer RLS). Return JSON-serializable
// data the LLM can narrate; include source / filter context fields so
// the LLM can cite ("based on top 5 HCOs by units in the last 12 weeks").

import {
  loadTopHcps,
  loadTopHcos,
  loadInteractionKpis,
  loadTierCoverage,
  loadTierCoverageByRep,
  loadTrend,
  hcpScope,
  repScope,
  type Scope,
} from "@/lib/interactions";
import {
  loadTopHcosBySales,
  loadAccountMotion,
  loadWatchListAccounts,
  loadAccessibleTerritories,
  loadHcoSalesKpis,
  loadHcoSalesTrend,
  loadSalesKpis,
} from "@/lib/sales";
import { combineScopes } from "@/lib/scope";
import { loadOverlappingGoalSum } from "@/lib/goal-lookup";
import { and, eq, gte, lte, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import { type UserScope, scopeLabel } from "@/lib/scope";
import {
  parseFilters,
  TIME_RANGES,
  rangeDates,
  type TimeRange,
  type DashboardFilters,
  DEFAULT_FILTERS,
} from "@/app/(app)/dashboard/filters";

export type ToolHandlerCtx = {
  tenantId: string;
  userScope: UserScope;
  sqlScope: Scope;
};

// Anthropic's Tool input_schema expects type: "object" literally — keep
// our local shape narrow so the API call typechecks.
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  handler: (input: unknown, ctx: ToolHandlerCtx) => Promise<unknown>;
};

// Helper — coerce a period string from the LLM into our TimeRange
// enum, defaulting to 12w if missing/invalid. Lets the LLM ask for
// "qtd" without us breaking when it picks something we don't support.
function periodToFilters(period: unknown): DashboardFilters {
  const candidate = typeof period === "string" ? period : "";
  const range: TimeRange = (TIME_RANGES as readonly string[]).includes(candidate)
    ? (candidate as TimeRange)
    : "12w";
  return { ...DEFAULT_FILTERS, range };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const queryTopAccounts: ToolDef = {
  name: "query_top_accounts",
  description:
    "List the top accounts (HCOs by sales OR HCPs/HCOs by call activity) within a time period. " +
    "Use this for questions like 'top 10 HCOs by sales last quarter', 'who are my best accounts', " +
    "'which HCPs am I calling most.' " +
    "Optionally pass territory_key (resolved via lookup_territory) to scope to one territory.",
  input_schema: {
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: ["units", "dollars", "calls"],
        description:
          "What to rank by. 'units' = signed pharma units (default for sales)." +
          " 'dollars' = signed gross dollars. 'calls' = call count.",
      },
      entity: {
        type: "string",
        enum: ["hco", "hcp"],
        description:
          "Account type to rank. Sales metrics (units/dollars) default to HCO" +
          " — HCPs rarely have meaningful direct sales. Calls work for either.",
      },
      period: {
        type: "string",
        enum: [...TIME_RANGES],
        description:
          "Time window. Defaults to '12w' (last 12 weeks).",
      },
      territory_key: {
        type: "string",
        description:
          "Optional. Surrogate ID from lookup_territory to narrow the result " +
          "to a single territory.",
      },
      limit: {
        type: "integer",
        description: "How many rows to return (1-25, default 10).",
      },
    },
    required: ["metric"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      metric?: string;
      entity?: string;
      period?: string;
      territory_key?: string;
      limit?: number;
    };
    const metric = i.metric ?? "units";
    const entity = i.entity ?? (metric === "calls" ? "hcp" : "hco");
    const filters = {
      ...periodToFilters(i.period),
      territory: i.territory_key ?? null,
    };
    const limit = Math.max(1, Math.min(25, i.limit ?? 10));

    if (metric === "units" || metric === "dollars") {
      const rows = await loadTopHcosBySales(
        ctx.tenantId,
        filters,
        limit,
        ctx.sqlScope,
      );
      return {
        source: "gold.fact_sale → dim_hco",
        filter: { metric, entity: "hco", period: filters.range, limit },
        scope: scopeLabel(ctx.userScope),
        rows: rows.map((r) => ({
          name: r.name,
          hco_key: r.hco_key,
          hco_type: r.hco_type,
          city: r.city,
          state: r.state,
          net_units: Math.round(r.net_units),
          net_dollars: Math.round(r.net_gross_dollars),
        })),
      };
    }

    // calls
    if (entity === "hco") {
      const rows = await loadTopHcos(ctx.tenantId, filters, ctx.sqlScope);
      return {
        source: "gold.fact_call → dim_hco",
        filter: { metric: "calls", entity: "hco", period: filters.range },
        scope: scopeLabel(ctx.userScope),
        rows: rows.slice(0, limit),
      };
    }
    const rows = await loadTopHcps(ctx.tenantId, filters, ctx.sqlScope);
    return {
      source: "gold.fact_call → dim_hcp",
      filter: { metric: "calls", entity: "hcp", period: filters.range },
      scope: scopeLabel(ctx.userScope),
      rows: rows.slice(0, limit),
    };
  },
};

const queryAccountMotion: ToolDef = {
  name: "query_account_motion",
  description:
    "Show accounts that are RISING (period-over-period unit growth), DECLINING " +
    "(period-over-period unit drop), or on the WATCH list (had sales in the prior " +
    "period, zero in the current one). Use this for 'who's rising/falling', " +
    "'what's on the watch list', 'who fell off this quarter.' " +
    "Optionally pass territory_key (resolved via lookup_territory) to scope to one territory.",
  input_schema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["rising", "declining", "watch_list"],
      },
      period: {
        type: "string",
        enum: [...TIME_RANGES],
        description: "Time window. Defaults to '12w'.",
      },
      territory_key: {
        type: "string",
        description:
          "Optional. Surrogate ID from lookup_territory to narrow to one territory.",
      },
      limit: {
        type: "integer",
        description: "1-20, default 10.",
      },
    },
    required: ["direction"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      direction?: string;
      period?: string;
      territory_key?: string;
      limit?: number;
    };
    const filters = {
      ...periodToFilters(i.period),
      territory: i.territory_key ?? null,
    };
    const limit = Math.max(1, Math.min(20, i.limit ?? 10));

    if (i.direction === "watch_list") {
      const rows = await loadWatchListAccounts(
        ctx.tenantId,
        filters,
        limit,
        ctx.sqlScope,
      );
      return {
        source: "gold.fact_sale → dim_hco (watch list = had-prior-zero-current)",
        filter: { direction: "watch_list", period: filters.range },
        scope: scopeLabel(ctx.userScope),
        rows: rows.map((r) => ({
          name: r.name,
          hco_key: r.hco_key,
          location: [r.city, r.state].filter(Boolean).join(", "),
          prior_units: Math.round(r.units_prior),
          last_sale_date: r.last_sale_date,
          current_rep: r.current_rep_name,
        })),
      };
    }

    const direction = i.direction === "declining" ? "declining" : "rising";
    const rows = await loadAccountMotion(
      ctx.tenantId,
      filters,
      direction,
      limit,
      ctx.sqlScope,
    );
    return {
      source: "gold.fact_sale → dim_hco (period vs prior comparison)",
      filter: { direction, period: filters.range },
      scope: scopeLabel(ctx.userScope),
      rows: rows.map((r) => ({
        name: r.name,
        hco_key: r.hco_key,
        location: [r.city, r.state].filter(Boolean).join(", "),
        units_period: Math.round(r.units_period),
        units_prior: Math.round(r.units_prior),
        delta_units: Math.round(r.units_delta),
        delta_pct: r.units_delta_pct,
      })),
    };
  },
};

const lookupEntity: ToolDef = {
  name: "lookup_entity",
  description:
    "Find an HCP or HCO by name (case-insensitive partial match). Returns up to 5 " +
    "best matches with location, type/specialty, tier. Use when the user mentions a " +
    "specific entity by name — 'tell me about Memorial Hospital', 'find Dr. Smith.'",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["hcp", "hco"] },
      query: {
        type: "string",
        description: "Partial name to match. Case-insensitive.",
      },
    },
    required: ["kind", "query"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { kind?: string; query?: string };
    const q = (i.query ?? "").trim();
    if (q.length < 2) {
      return { error: "Query must be at least 2 characters." };
    }
    const escQ = q.replace(/'/g, "''");
    if (i.kind === "hcp") {
      const rows = await queryFabric<{
        hcp_key: string;
        name: string;
        specialty: string | null;
        tier: string | null;
        city: string | null;
        state: string | null;
      }>(
        ctx.tenantId,
        `SELECT TOP 5
           hcp_key, name, specialty_primary AS specialty, tier, city, state
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId
           AND status = 'Active'
           AND name LIKE '%${escQ}%'
         ORDER BY
           CASE WHEN UPPER(name) = UPPER('${escQ}') THEN 0 ELSE 1 END,
           name`,
      );
      return {
        source: "gold.dim_hcp",
        filter: { kind: "hcp", query: q },
        rows,
      };
    }
    const rows = await queryFabric<{
      hco_key: string;
      name: string;
      hco_type: string | null;
      tier: string | null;
      city: string | null;
      state: string | null;
    }>(
      ctx.tenantId,
      `SELECT TOP 5
         hco_key, name, hco_type, tier, city, state
       FROM gold.dim_hco
       WHERE tenant_id = @tenantId
         AND COALESCE(status, 'Active') IN ('Active', 'active')
         AND name LIKE '%${escQ}%'
       ORDER BY
         CASE WHEN UPPER(name) = UPPER('${escQ}') THEN 0 ELSE 1 END,
         name`,
    );
    return {
      source: "gold.dim_hco",
      filter: { kind: "hco", query: q },
      rows,
    };
  },
};

const lookupTerritory: ToolDef = {
  name: "lookup_territory",
  description:
    "Find a territory by its geographic description (e.g. 'Los Angeles', 'San Diego') " +
    "or its Veeva code (e.g. 'C103', 'M201'). Returns up to 5 best matches with " +
    "territory_key (surrogate ID for downstream tool calls), description (human label), " +
    "name (Veeva code), team_role, and current_rep_name. " +
    "Use this BEFORE other tools when the user mentions a territory by name — " +
    "pass the resulting territory_key into query_top_accounts / query_account_motion / " +
    "query_tier_coverage to scope the result to that territory.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Partial territory description or code. Case-insensitive.",
      },
    },
    required: ["query"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { query?: string };
    const q = (i.query ?? "").trim();
    if (q.length < 2) {
      return { error: "Query must be at least 2 characters." };
    }
    const escQ = q.replace(/'/g, "''");
    const rows = await queryFabric<{
      territory_key: string;
      name: string;
      description: string | null;
      team_role: string | null;
      current_rep_name: string | null;
    }>(
      ctx.tenantId,
      // Match on description (geographic) OR name (Veeva code).
      // Per feedback_territory_display, description is the primary
      // recognition path for admins/managers — bias matches that way
      // by ordering description-matches first.
      `SELECT TOP 5
         territory_key,
         name,
         description,
         team_role,
         current_rep_name
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND COALESCE(status, '') IN ('', 'Active', 'active')
         AND (
           description LIKE '%${escQ}%'
           OR name LIKE '%${escQ}%'
         )
       ORDER BY
         CASE WHEN UPPER(description) = UPPER('${escQ}') THEN 0
              WHEN UPPER(name) = UPPER('${escQ}') THEN 1
              WHEN description LIKE '%${escQ}%' THEN 2
              ELSE 3
         END,
         COALESCE(description, name)`,
    );
    return {
      source: "gold.dim_territory",
      filter: { query: q },
      rows,
    };
  },
};

const queryRepSummary: ToolDef = {
  name: "query_rep_summary",
  description:
    "Get a rep's activity summary for a period: calls in window, last call date, " +
    "distinct HCPs/HCOs reached. Pass 'me' to refer to the signed-in user (rep-role only).",
  input_schema: {
    type: "object",
    properties: {
      rep_name: {
        type: "string",
        description:
          "Either a rep's name (partial match), their user_key, or 'me' for self.",
      },
      period: {
        type: "string",
        enum: [...TIME_RANGES],
        description: "Time window. Defaults to '12w'.",
      },
    },
    required: ["rep_name"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { rep_name?: string; period?: string };
    const arg = (i.rep_name ?? "").trim();
    if (!arg) return { error: "rep_name required." };

    let userKey: string | null = null;
    let resolvedName = "";
    if (arg.toLowerCase() === "me") {
      if (ctx.userScope.role !== "rep") {
        return {
          error:
            "'me' only works for rep-role users. Use the rep's name instead.",
        };
      }
      userKey = ctx.userScope.userKey;
    } else {
      const escArg = arg.replace(/'/g, "''");
      const matches = await queryFabric<{
        user_key: string;
        name: string;
        title: string | null;
      }>(
        ctx.tenantId,
        `SELECT TOP 5 user_key, name, title
         FROM gold.dim_user
         WHERE tenant_id = @tenantId
           AND status = 'Active'
           AND user_type IN ('Sales', 'Medical')
           AND (name LIKE '%${escArg}%' OR user_key = '${escArg}')
         ORDER BY name`,
      );
      if (matches.length === 0) {
        return { error: `No active rep matching '${arg}'.` };
      }
      if (matches.length > 1 && matches[0]!.name.toLowerCase() !== arg.toLowerCase()) {
        return {
          ambiguous: true,
          message: `Multiple reps matched '${arg}' — pick one and try again with the exact name or user_key.`,
          matches: matches.map((m) => ({
            name: m.name,
            user_key: m.user_key,
            title: m.title,
          })),
        };
      }
      userKey = matches[0]!.user_key;
      resolvedName = matches[0]!.name;
    }

    const filters = periodToFilters(i.period);
    // Build a rep-specific scope (overrides the chat user's RLS for
    // this lookup — we're explicitly asking for THIS rep's activity).
    const repSqlScope: Scope = {
      clauses: ["AND f.owner_user_key = @repUserKey"],
      params: { repUserKey: userKey },
    };
    const kpis = await loadInteractionKpis(ctx.tenantId, filters, repSqlScope);
    const trend = await loadTrend(ctx.tenantId, filters, repSqlScope);

    return {
      source: "gold.fact_call → dim_user",
      rep: { user_key: userKey, name: resolvedName || "(self)" },
      filter: { period: filters.range },
      kpis: {
        calls_in_window: kpis.calls_period,
        prior_calls_in_window: kpis.calls_prior,
        distinct_hcps: kpis.hcps,
        distinct_hcos: kpis.hcos,
        last_call_date: kpis.last_call,
      },
      trend: trend.map((b) => ({
        bucket: b.bucket_label,
        calls: b.calls,
      })),
    };
  },
};

const queryTierCoverage: ToolDef = {
  name: "query_tier_coverage",
  description:
    "Per-tier coverage: total HCPs in scope vs how many were contacted in a period. " +
    "Use for 'how is our Tier 1 coverage', 'what % of Tier 2 HCPs got touched.' " +
    "Default returns tenant-wide tier rollups. Set breakdown='by_rep' to break out " +
    "per-(rep, tier) — use this when the user asks 'which reps are driving the gap' " +
    "or wants to see who's behind on a specific tier. " +
    "Tier label conventions vary per tenant ('1' vs 'Tier 1' vs 'T1') so the caller " +
    "should match by inspecting the returned 'tier' values rather than assuming a format. " +
    "When breakdown='by_rep', use tier_label_filter (case-insensitive substring) to " +
    "narrow the response to a specific tier — important since 91 reps × 4 tiers = " +
    "many rows otherwise. " +
    "Optionally pass territory_key (resolved via lookup_territory) to narrow the " +
    "universe to a single territory.",
  input_schema: {
    type: "object",
    properties: {
      breakdown: {
        type: "string",
        enum: ["none", "by_rep"],
        description:
          "'none' (default): tenant-wide rollups by tier. 'by_rep': per-(rep, tier) breakdown.",
      },
      tier_label_filter: {
        type: "string",
        description:
          "Case-insensitive substring filter on tier labels. Only relevant when breakdown='by_rep'. " +
          "E.g. '1' matches 'Tier 1' / '1' / 'T1' rows. Omit to return all tiers.",
      },
      territory_key: {
        type: "string",
        description:
          "Optional. Surrogate ID from lookup_territory. Narrows the HCP universe " +
          "to that one territory.",
      },
      period: {
        type: "string",
        enum: [...TIME_RANGES],
        description: "Time window. Defaults to '12w'.",
      },
    },
    required: [],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      breakdown?: string;
      tier_label_filter?: string;
      territory_key?: string;
      period?: string;
    };
    const filters = periodToFilters(i.period);
    // When a specific territory is provided, scope to just that one;
    // otherwise use the user's full accessible set.
    let territoryKeys: string[];
    if (i.territory_key) {
      territoryKeys = [i.territory_key];
    } else {
      const territories = await loadAccessibleTerritories(
        ctx.tenantId,
        ctx.userScope,
      );
      territoryKeys = territories.map((t) => t.territory_key);
    }

    if (i.breakdown === "by_rep") {
      const all = await loadTierCoverageByRep(
        ctx.tenantId,
        filters,
        territoryKeys,
        ctx.userScope,
      );
      const filterStr = (i.tier_label_filter ?? "").toLowerCase().trim();
      const filtered = filterStr
        ? all.filter((r) => r.tier.toLowerCase().includes(filterStr))
        : all;
      // Sort: by tier ascending, then pct_contacted ascending (worst
      // coverage first within each tier — matches "who's driving the gap").
      filtered.sort((a, b) => {
        const t = a.tier.localeCompare(b.tier);
        if (t !== 0) return t;
        return a.pct_contacted - b.pct_contacted;
      });
      return {
        source:
          "gold.dim_hcp + gold.bridge_account_territory + silver.user_territory + gold.fact_call",
        filter: {
          breakdown: "by_rep",
          tier_label_filter: i.tier_label_filter ?? "all_tiers",
          period: filters.range,
          scope_territories: territoryKeys.length,
        },
        scope: scopeLabel(ctx.userScope),
        // Each row = one (rep, tier) cell. Universe per rep = HCPs
        // in any of the rep's coverage territories. Contacted per
        // rep = HCPs THIS REP called in window (other reps' calls
        // don't credit this rep).
        rows: filtered,
      };
    }

    // Default: tenant-wide tier rollup.
    const all = await loadTierCoverage(
      ctx.tenantId,
      filters,
      territoryKeys,
      ctx.sqlScope,
    );
    return {
      source:
        "gold.dim_hcp + gold.bridge_account_territory + gold.fact_call",
      filter: {
        breakdown: "none",
        period: filters.range,
        scope_territories: territoryKeys.length,
      },
      scope: scopeLabel(ctx.userScope),
      rows: all,
    };
  },
};

const queryEntityDetail: ToolDef = {
  name: "query_entity_detail",
  description:
    "Get a single HCO or HCP's detail view: KPIs over a period + a time-series " +
    "trend. For HCO: sales KPIs (units / dollars / last sale) + sales trend by " +
    "quarter. For HCP: call KPIs (calls / distinct HCPs reached / last call) + " +
    "call trend by week + parent HCO + last 5 calls (rep-scoped). " +
    "Use this AFTER lookup_entity has resolved a name to a key. Answers questions " +
    "like 'how is Memorial Hospital trending', 'what's Dr. Smith's recent activity'.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["hco", "hcp"] },
      key: {
        type: "string",
        description: "hco_key or hcp_key from lookup_entity.",
      },
      period: {
        type: "string",
        enum: [...TIME_RANGES],
        description: "Time window for KPIs + trend. Defaults to '12w'.",
      },
    },
    required: ["kind", "key"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { kind?: string; key?: string; period?: string };
    if (!i.key) return { error: "key required." };
    const filters = periodToFilters(i.period);

    if (i.kind === "hco") {
      // HCO detail: sales-focused. Trend at quarterly granularity to
      // give ~6 quarters of context (matches the recommendations
      // expand panel pattern). KPIs use the chat user's RLS scope —
      // a rep viewing an HCO they don't cover sees zeros, which is
      // the correct semantic.
      const hcoFilters = { ...filters, granularity: "quarter" as const };
      const [kpis, trend, hcoMeta] = await Promise.all([
        loadHcoSalesKpis(ctx.tenantId, i.key, filters),
        loadHcoSalesTrend(ctx.tenantId, i.key, hcoFilters),
        queryFabric<{
          name: string;
          hco_type: string | null;
          tier: string | null;
          city: string | null;
          state: string | null;
        }>(
          ctx.tenantId,
          `SELECT TOP 1 name, hco_type, tier, city, state
           FROM gold.dim_hco
           WHERE tenant_id = @tenantId AND hco_key = @hcoKey`,
          { hcoKey: i.key },
        ),
      ]);
      const meta = hcoMeta[0];
      if (!meta) {
        return { error: `No HCO found for key ${i.key}.` };
      }
      return {
        source: "gold.dim_hco + gold.fact_sale (HCO-scoped)",
        filter: { kind: "hco", key: i.key, period: filters.range },
        scope: scopeLabel(ctx.userScope),
        hco: {
          name: meta.name,
          hco_type: meta.hco_type,
          tier: meta.tier,
          location: [meta.city, meta.state].filter(Boolean).join(", "),
        },
        kpis: {
          net_units_period: Math.round(kpis.net_units_period),
          net_units_prior: Math.round(kpis.net_units_prior),
          net_dollars_period: Math.round(kpis.net_gross_dollars_period),
          net_dollars_prior: Math.round(kpis.net_gross_dollars_prior),
          last_sale_date: kpis.last_sale,
        },
        sales_trend_quarterly: trend.map((b) => ({
          bucket: b.bucket_label,
          net_units: Math.round(b.net_units),
          net_dollars: Math.round(b.net_dollars),
        })),
      };
    }

    // HCP detail: calls-focused. KPIs + weekly trend + parent HCO +
    // last 5 calls. Combines the chat user's RLS scope with hcpScope
    // so the result is "how has THIS user (or their team) interacted
    // with THIS HCP." For an admin, that's all calls; for a rep, only
    // their own calls to this HCP.
    const combined = combineScopes(hcpScope(i.key), ctx.sqlScope);
    const [kpis, trend, hcpMeta, recentCalls] = await Promise.all([
      loadInteractionKpis(ctx.tenantId, filters, combined),
      loadTrend(ctx.tenantId, filters, combined),
      queryFabric<{
        name: string;
        specialty: string | null;
        tier: string | null;
        city: string | null;
        state: string | null;
        primary_parent_hco_key: string | null;
        primary_parent_hco_name: string | null;
      }>(
        ctx.tenantId,
        `SELECT TOP 1
           name, specialty_primary AS specialty, tier, city, state,
           primary_parent_hco_key, primary_parent_hco_name
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId AND hcp_key = @hcpKey`,
        { hcpKey: i.key },
      ),
      queryFabric<{ call_date: string; channel: string | null }>(
        ctx.tenantId,
        // Last 5 calls under the chat user's scope. Mirrors the
        // recommendations-context recent_calls query.
        `SELECT TOP 5
           CONVERT(varchar(10), f.call_date, 23) AS call_date,
           f.call_channel AS channel
         FROM gold.fact_call f
         WHERE f.tenant_id = @tenantId
           AND f.hcp_key = @hcpKey
           ${ctx.sqlScope.clauses.join(" ")}
         ORDER BY f.call_date DESC`,
        { hcpKey: i.key, ...ctx.sqlScope.params },
      ),
    ]);
    const meta = hcpMeta[0];
    if (!meta) {
      return { error: `No HCP found for key ${i.key}.` };
    }
    return {
      source: "gold.dim_hcp + gold.fact_call (HCP-scoped)",
      filter: { kind: "hcp", key: i.key, period: filters.range },
      scope: scopeLabel(ctx.userScope),
      hcp: {
        name: meta.name,
        specialty: meta.specialty,
        tier: meta.tier,
        location: [meta.city, meta.state].filter(Boolean).join(", "),
        parent_hco_key: meta.primary_parent_hco_key,
        parent_hco_name: meta.primary_parent_hco_name,
      },
      kpis: {
        calls_in_window: kpis.calls_period,
        prior_calls_in_window: kpis.calls_prior,
        distinct_hcos_reached: kpis.hcos,
        last_call_date: kpis.last_call,
      },
      call_trend: trend.map((b) => ({
        bucket: b.bucket_label,
        calls: b.calls,
      })),
      recent_calls: recentCalls,
    };
  },
};

const queryGoalAttainment: ToolDef = {
  name: "query_goal_attainment",
  description:
    "Goal attainment for a specific entity OR a ranked list of all entities of a " +
    "type (sorted worst-first). Calls goals live at the REP entity (per-rep call " +
    "targets); units goals live at the TERRITORY entity (per-territory sales targets). " +
    "Use for 'how is Jane Doe doing on her call goal', 'which territories are behind on " +
    "units', 'what's our overall calls attainment.' " +
    "When entity_key is omitted, returns the worst-N entities (sorted by attainment % " +
    "ascending). When entity_key is set, returns just that one entity's attainment. " +
    "For specific entities, the LLM should resolve names via query_rep_summary " +
    "(returns user_key) or lookup_territory (returns territory_key) first.",
  input_schema: {
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: ["calls", "units"],
        description:
          "'calls' — entity_type defaults to 'rep'. 'units' — entity_type defaults to 'territory'.",
      },
      entity_type: {
        type: "string",
        enum: ["rep", "territory"],
        description:
          "Override the metric's default entity. Calls goals are usually at rep; units at territory.",
      },
      entity_key: {
        type: "string",
        description:
          "Optional. Specific entity's surrogate key (user_key for rep, territory_key for territory). " +
          "Omit to get the ranked list of worst-attainment entities.",
      },
      period: {
        type: "string",
        enum: [...TIME_RANGES],
        description:
          "Time window for actuals AND goal-overlap. Defaults to '12w'. " +
          "Use 'qtd' / 'mtd' / 'ytd' for period-aligned attainment.",
      },
      limit: {
        type: "integer",
        description:
          "When entity_key omitted: how many worst-attainment entities to return (1-30, default 15).",
      },
    },
    required: ["metric"],
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      metric?: string;
      entity_type?: string;
      entity_key?: string;
      period?: string;
      limit?: number;
    };
    const metric = i.metric === "units" ? "units" : "calls";
    const entityType =
      i.entity_type === "rep" || i.entity_type === "territory"
        ? i.entity_type
        : metric === "units"
          ? ("territory" as const)
          : ("rep" as const);
    const filters = periodToFilters(i.period);
    const dates = rangeDates(filters.range);
    if (!dates) {
      return {
        error: `Period '${filters.range}' has no date range; use a bounded period like '12w' or 'qtd'.`,
      };
    }
    const limit = Math.max(1, Math.min(30, i.limit ?? 15));

    // ---- SINGLE ENTITY PATH ----
    if (i.entity_key) {
      const goal = await loadOverlappingGoalSum({
        tenantId: ctx.tenantId,
        metric,
        entityType,
        entityFilter: { type: "single", id: i.entity_key },
        rangeStart: dates.start,
        rangeEnd: dates.end,
      });

      let actual = 0;
      let entityName = i.entity_key;
      if (entityType === "rep") {
        const kpis = await loadInteractionKpis(
          ctx.tenantId,
          filters,
          repScope(i.entity_key),
        );
        actual = kpis.calls_period;
        const meta = await queryFabric<{ name: string }>(
          ctx.tenantId,
          `SELECT TOP 1 name FROM gold.dim_user
           WHERE tenant_id = @tenantId AND user_key = @repUserKey`,
          { repUserKey: i.entity_key },
        );
        if (meta[0]) entityName = meta[0].name;
      } else {
        // territory: scope sales loaders to that one territory
        const tFilters = { ...filters, territory: i.entity_key };
        const kpis = await loadSalesKpis(ctx.tenantId, tFilters, ctx.sqlScope);
        actual = Math.round(kpis.net_units_period);
        const meta = await queryFabric<{
          description: string | null;
          name: string;
        }>(
          ctx.tenantId,
          `SELECT TOP 1 description, name FROM gold.dim_territory
           WHERE tenant_id = @tenantId AND territory_key = @terrKey`,
          { terrKey: i.entity_key },
        );
        if (meta[0]) entityName = meta[0].description ?? meta[0].name;
      }

      const pct =
        goal != null && goal > 0 ? Math.round((actual / goal) * 100) : null;
      return {
        source: "Postgres goal table + Fabric actuals",
        filter: {
          metric,
          entity_type: entityType,
          entity_key: i.entity_key,
          period: filters.range,
          period_dates: { start: dates.start, end: dates.end },
        },
        scope: scopeLabel(ctx.userScope),
        entity_name: entityName,
        actual,
        goal: goal == null ? null : Math.round(goal),
        attainment_pct: pct,
        note:
          goal == null
            ? "No goal set for this entity in the overlapping period."
            : null,
      };
    }

    // ---- RANKED LIST PATH ----
    // Pull all overlapping goals from Postgres for this metric × entity.
    const goals = await db
      .select({
        entityId: schema.goal.entityId,
        goalValue: schema.goal.goalValue,
        periodStart: schema.goal.periodStart,
        periodEnd: schema.goal.periodEnd,
      })
      .from(schema.goal)
      .where(
        and(
          eq(schema.goal.tenantId, ctx.tenantId),
          eq(schema.goal.metric, metric),
          eq(schema.goal.entityType, entityType),
          lte(schema.goal.periodStart, dates.end),
          gte(schema.goal.periodEnd, dates.start),
        ),
      );
    const validGoals = goals.filter(
      (g): g is typeof g & { entityId: string } => g.entityId != null,
    );
    if (validGoals.length === 0) {
      return {
        source: "Postgres goal table",
        filter: {
          metric,
          entity_type: entityType,
          period: filters.range,
        },
        scope: scopeLabel(ctx.userScope),
        items: [],
        note: `No ${entityType} ${metric} goals found overlapping ${filters.range}.`,
      };
    }

    // Aggregate goal portions per entity (overlap math).
    const goalByEntity = new Map<string, number>();
    for (const g of validGoals) {
      const portion = overlapPortion(
        {
          goalValue: g.goalValue,
          periodStart: g.periodStart,
          periodEnd: g.periodEnd,
        },
        dates,
      );
      goalByEntity.set(
        g.entityId,
        (goalByEntity.get(g.entityId) ?? 0) + portion,
      );
    }

    // Per-entity actuals — one Fabric query that joins a VALUES list of
    // entity keys to the appropriate fact table within the window.
    const keys = Array.from(goalByEntity.keys());
    const sanitized = keys
      .map((k) => `('${k.replace(/'/g, "''")}')`)
      .join(",");
    const periodParams = {
      attainPeriodStart: dates.start,
      attainPeriodEnd: dates.end,
    };

    let actuals: { entity_key: string; entity_name: string; actual: number }[];
    if (entityType === "rep") {
      actuals = await queryFabric<{
        entity_key: string;
        entity_name: string;
        actual: number;
      }>(
        ctx.tenantId,
        `WITH targets AS (
           SELECT entity_key
           FROM (VALUES ${sanitized}) AS t(entity_key)
         )
         SELECT
           t.entity_key,
           u.name AS entity_name,
           COALESCE(SUM(CASE WHEN f.call_date >= @attainPeriodStart AND f.call_date <= @attainPeriodEnd THEN 1 ELSE 0 END), 0) AS actual
         FROM targets t
         JOIN gold.dim_user u
           ON u.user_key = t.entity_key
           AND u.tenant_id = @tenantId
         LEFT JOIN gold.fact_call f
           ON f.tenant_id = @tenantId
           AND f.owner_user_key = t.entity_key
           AND f.call_date >= @attainPeriodStart
           AND f.call_date <= @attainPeriodEnd
         GROUP BY t.entity_key, u.name`,
        periodParams,
      );
    } else {
      // territory + units
      actuals = await queryFabric<{
        entity_key: string;
        entity_name: string;
        actual: number;
      }>(
        ctx.tenantId,
        `WITH targets AS (
           SELECT entity_key
           FROM (VALUES ${sanitized}) AS t(entity_key)
         )
         SELECT
           t.entity_key,
           COALESCE(NULLIF(terr.description, ''), terr.name) AS entity_name,
           ROUND(COALESCE(SUM(CASE WHEN f.transaction_date >= @attainPeriodStart AND f.transaction_date <= @attainPeriodEnd THEN f.signed_units ELSE 0 END), 0), 0) AS actual
         FROM targets t
         JOIN gold.dim_territory terr
           ON terr.territory_key = t.entity_key
           AND terr.tenant_id = @tenantId
         LEFT JOIN gold.fact_sale f
           ON f.tenant_id = @tenantId
           AND f.territory_key = t.entity_key
           AND f.transaction_date >= @attainPeriodStart
           AND f.transaction_date <= @attainPeriodEnd
         GROUP BY t.entity_key, COALESCE(NULLIF(terr.description, ''), terr.name)`,
        periodParams,
      );
    }

    const actualByKey = new Map(actuals.map((a) => [a.entity_key, a]));

    const items = Array.from(goalByEntity.entries())
      .map(([key, goal]) => {
        const a = actualByKey.get(key);
        const actual = a?.actual ?? 0;
        const pct =
          goal > 0 ? Math.round((Number(actual) / goal) * 100) : null;
        return {
          entity_key: key,
          entity_name: a?.entity_name ?? key,
          goal: Math.round(goal),
          actual: Math.round(Number(actual)),
          attainment_pct: pct,
        };
      })
      .filter((it) => it.attainment_pct != null)
      // Sort worst-first (lowest pct). Matches the question framing
      // "who's behind."
      .sort(
        (a, b) =>
          (a.attainment_pct ?? Infinity) - (b.attainment_pct ?? Infinity),
      )
      .slice(0, limit);

    return {
      source: "Postgres goal table + Fabric actuals",
      filter: {
        metric,
        entity_type: entityType,
        period: filters.range,
        period_dates: { start: dates.start, end: dates.end },
        sort: "attainment_pct ASC (worst first)",
        limit,
      },
      scope: scopeLabel(ctx.userScope),
      total_with_goals: validGoals.length,
      items,
    };
  },
};

// Helper: pro-rated overlap portion of a goal that spans a different
// period than the analysis window. Mirrors lib/goal-lookup.ts.
function overlapPortion(
  goal: { goalValue: string; periodStart: string; periodEnd: string },
  range: { start: string; end: string },
): number {
  const periodStartMs = new Date(goal.periodStart).getTime();
  const periodEndMs = new Date(goal.periodEnd).getTime();
  const rangeStartMs = new Date(range.start).getTime();
  const rangeEndMs = new Date(range.end).getTime();
  const overlapStartMs = Math.max(periodStartMs, rangeStartMs);
  const overlapEndMs = Math.min(periodEndMs, rangeEndMs);
  if (overlapEndMs < overlapStartMs) return 0;
  const msToDays = (ms: number) => Math.round(ms / (1000 * 60 * 60 * 24));
  const overlapDays = msToDays(overlapEndMs - overlapStartMs) + 1;
  const periodDays = msToDays(periodEndMs - periodStartMs) + 1;
  if (periodDays <= 0) return 0;
  return Number(goal.goalValue) * (overlapDays / periodDays);
}

export const TOOLS: ToolDef[] = [
  queryTopAccounts,
  queryAccountMotion,
  lookupEntity,
  lookupTerritory,
  queryRepSummary,
  queryTierCoverage,
  queryEntityDetail,
  queryGoalAttainment,
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Anthropic-format tool definitions for the messages.create API. Strips
// the handler so the SDK only sees what it needs.
export function toolsForApi(): {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}[] {
  return TOOLS.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}
