// Forward-looking insight signals over gold.fact_call. Each loader returns
// rows in the same shape so the UI can render them uniformly.
//
// v1: rule-based, computed on each request (no materialization). When a
// signal becomes a hotspot or we need consistent generated_at timestamps
// across surfaces, promote to gold.signal table built by a notebook.
//
// All loaders accept the standard RLS Scope so signals respect per-user
// visibility — a rep sees signals about THEIR HCPs, a manager sees their
// team's, an admin sees the whole tenant.

import { queryFabric } from "@/lib/fabric";
import { type Scope } from "@/lib/interactions";

export type SignalSeverity = "info" | "warning" | "alert";

export type Signal = {
  // Stable identifier for the signal type (used as React key + future routing).
  type: string;
  severity: SignalSeverity;
  // Headline rendered in the panel; should be self-contained.
  title: string;
  // Optional secondary line — what to do, or context.
  detail?: string;
  // Linked entity for drill-through; clicking the signal goes here.
  href: string;
  // Sortable rank within a panel (higher = more urgent / more recent activity).
  rank: number;
};

// ---------------------------------------------------------------------------
// HCP inactivity: HCPs the user has engaged before but hasn't contacted
// in the last 60 days. Sorted by most-recently-active first (fresh lapse
// matters more than ancient lapse).
// ---------------------------------------------------------------------------

const INACTIVITY_THRESHOLD_DAYS = 60;
const MAX_SIGNALS = 10;

type InactiveHcpRow = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  tier: string | null;
  last_call_date: string;
  days_since: number;
};

export async function loadHcpInactivitySignals(
  tenantId: string,
  scope: Scope,
): Promise<Signal[]> {
  const rows = await queryFabric<InactiveHcpRow>(
    tenantId,
    `WITH last_contact AS (
       SELECT
         f.hcp_key,
         MAX(f.call_date) AS last_call_date
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId
         AND f.hcp_key IS NOT NULL
         ${scope.clauses.join(" ")}
       GROUP BY f.hcp_key
     )
     SELECT TOP ${MAX_SIGNALS}
       h.hcp_key,
       h.name,
       h.specialty_primary AS specialty,
       h.tier,
       CONVERT(varchar(10), lc.last_call_date, 23) AS last_call_date,
       DATEDIFF(DAY, lc.last_call_date, CAST(GETDATE() AS date)) AS days_since
     FROM last_contact lc
     JOIN gold.dim_hcp h ON h.hcp_key = lc.hcp_key AND h.tenant_id = @tenantId
     WHERE lc.last_call_date < DATEADD(DAY, -${INACTIVITY_THRESHOLD_DAYS}, CAST(GETDATE() AS date))
     ORDER BY lc.last_call_date DESC`,
    scope.params,
  );

  return rows.map((r) => ({
    type: "hcp_inactive_60d",
    severity: severityFromTier(r.tier, r.days_since),
    title: `${r.name}${r.specialty ? ` (${r.specialty})` : ""}`,
    detail: `${r.days_since} days since last contact${r.tier ? ` · Tier ${r.tier}` : ""}`,
    href: `/hcps/${encodeURIComponent(r.hcp_key)}`,
    rank: -r.days_since, // less negative = sorts higher (most recent lapse first)
  }));
}

// Tier 1 inactive is more urgent than Tier 4 inactive. Without tier info we
// fall back to recency: longer-lapsed = more urgent (warning vs info).
function severityFromTier(
  tier: string | null,
  daysSince: number,
): SignalSeverity {
  if (tier === "1" || tier?.toLowerCase() === "tier 1") return "alert";
  if (daysSince > 120) return "warning";
  return "info";
}

// ---------------------------------------------------------------------------
// Activity drop: reps whose last-7-day call count is meaningfully lower than
// their prior-7-day count. "Meaningful" = drop >= 25% AND prior baseline >= 5
// calls (avoids noise from low-volume reps).
// ---------------------------------------------------------------------------

const ACTIVITY_DROP_PCT = 0.25;
const ACTIVITY_MIN_BASELINE = 5;

type ActivityDropRow = {
  user_key: string;
  name: string;
  recent_calls: number;
  prior_calls: number;
};

export async function loadActivityDropSignals(
  tenantId: string,
  scope: Scope,
): Promise<Signal[]> {
  // Rolling 7-day comparison (apples-to-apples in window length):
  //   recent = (today-6) through today  (7 days inclusive)
  //   prior  = (today-13) through (today-7)  (7 days inclusive, immediately before recent)
  // This avoids partial-week bias that calendar-week math would introduce.
  const rows = await queryFabric<ActivityDropRow>(
    tenantId,
    `WITH bounds AS (
       SELECT
         CAST(GETDATE() AS date) AS today,
         DATEADD(DAY, -6, CAST(GETDATE() AS date)) AS recent_start,
         DATEADD(DAY, -7, CAST(GETDATE() AS date)) AS prior_end,
         DATEADD(DAY, -13, CAST(GETDATE() AS date)) AS prior_start
     ),
     rep_counts AS (
       SELECT
         u.user_key,
         u.name,
         SUM(CASE WHEN f.call_date >= b.recent_start AND f.call_date <= b.today THEN 1 ELSE 0 END) AS recent_calls,
         SUM(CASE WHEN f.call_date >= b.prior_start AND f.call_date <= b.prior_end THEN 1 ELSE 0 END) AS prior_calls
       FROM gold.fact_call f
       CROSS JOIN bounds b
       JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
       WHERE f.tenant_id = @tenantId
         AND f.call_date >= b.prior_start
         AND f.call_date <= b.today
         AND u.user_type IN ('Sales', 'Medical')
         ${scope.clauses.join(" ")}
       GROUP BY u.user_key, u.name
     )
     SELECT user_key, name, recent_calls, prior_calls
     FROM rep_counts
     WHERE prior_calls >= ${ACTIVITY_MIN_BASELINE}
       AND CAST(recent_calls AS float) / NULLIF(prior_calls, 0) <= ${1 - ACTIVITY_DROP_PCT}
     ORDER BY (prior_calls - recent_calls) DESC`,
    scope.params,
  );

  return rows.slice(0, MAX_SIGNALS).map((r) => {
    const dropPct = Math.round(((r.prior_calls - r.recent_calls) / r.prior_calls) * 100);
    return {
      type: "activity_drop_7d",
      severity: dropPct >= 50 ? "warning" : "info",
      title: `${r.name} — ${dropPct}% drop in calls (7d)`,
      detail: `${r.recent_calls} in the last 7 days vs ${r.prior_calls} in the 7 days before`,
      href: `/reps/${encodeURIComponent(r.user_key)}`,
      rank: r.prior_calls - r.recent_calls,
    };
  });
}

// ---------------------------------------------------------------------------
// Over-targeting: HCPs called more than N times in the last 30 days. Often
// a sign of diminishing returns or that a rep is leaning on a comfortable
// account at the expense of broader coverage.
// ---------------------------------------------------------------------------

const OVER_TARGETING_THRESHOLD = 6;
const OVER_TARGETING_WINDOW_DAYS = 30;

type OverTargetedRow = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  call_count: number;
};

export async function loadOverTargetingSignals(
  tenantId: string,
  scope: Scope,
): Promise<Signal[]> {
  const rows = await queryFabric<OverTargetedRow>(
    tenantId,
    `SELECT TOP ${MAX_SIGNALS}
       h.hcp_key,
       h.name,
       h.specialty_primary AS specialty,
       COUNT(*) AS call_count
     FROM gold.fact_call f
     JOIN gold.dim_hcp h ON h.hcp_key = f.hcp_key AND h.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       AND f.call_date >= DATEADD(DAY, -${OVER_TARGETING_WINDOW_DAYS}, CAST(GETDATE() AS date))
       AND f.call_date <= CAST(GETDATE() AS date)
       ${scope.clauses.join(" ")}
     GROUP BY h.hcp_key, h.name, h.specialty_primary
     HAVING COUNT(*) > ${OVER_TARGETING_THRESHOLD}
     ORDER BY COUNT(*) DESC`,
    scope.params,
  );

  return rows.map((r) => ({
    type: "hcp_over_targeted",
    severity: r.call_count >= 12 ? "warning" : "info",
    title: `${r.name}${r.specialty ? ` (${r.specialty})` : ""}`,
    detail: `${r.call_count} calls in the last ${OVER_TARGETING_WINDOW_DAYS} days — possible diminishing returns`,
    href: `/hcps/${encodeURIComponent(r.hcp_key)}`,
    rank: r.call_count,
  }));
}

// ---------------------------------------------------------------------------
// Combined loader for the inbox page.
// ---------------------------------------------------------------------------

export type SignalGroup = {
  key: string;
  title: string;
  subtitle: string;
  signals: Signal[];
};

export async function loadAllSignals(
  tenantId: string,
  scope: Scope,
): Promise<SignalGroup[]> {
  const [inactive, drop, overTargeted] = await Promise.all([
    loadHcpInactivitySignals(tenantId, scope),
    loadActivityDropSignals(tenantId, scope),
    loadOverTargetingSignals(tenantId, scope),
  ]);
  return [
    {
      key: "hcp_inactive_60d",
      title: "HCPs to re-engage",
      subtitle: `Engaged previously, no contact in the last ${INACTIVITY_THRESHOLD_DAYS} days`,
      signals: inactive,
    },
    {
      key: "activity_drop_7d",
      title: "Activity drop",
      subtitle: `Reps whose call count fell ≥${Math.round(ACTIVITY_DROP_PCT * 100)}% over the last 7 days vs the 7 days before`,
      signals: drop,
    },
    {
      key: "hcp_over_targeted",
      title: "Possibly over-targeted",
      subtitle: `HCPs called more than ${OVER_TARGETING_THRESHOLD} times in the last ${OVER_TARGETING_WINDOW_DAYS} days`,
      signals: overTargeted,
    },
  ];
}
