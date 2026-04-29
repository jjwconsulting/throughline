// Insight panels for /hcps/[hcp_key] aimed at sales-rep tactical
// adoption. Two surfaces — both deterministic, no LLM:
//
// 1. loadSinceLastVisit: "what changed for this HCP since you (the
//    rep) last visited" — anchors the page to the rep's mental model.
//    Two modes:
//      - REP VIEWER with a prior call → window = since viewer's last
//        call. The original "since your last visit" framing.
//      - Otherwise (admin, manager, or rep who's never called this
//        HCP) → window = last 30 days, framed as "Recent activity."
//    Without this split, admin/manager views anchor on the tenant-wide
//    most-recent call (often hours/days ago), making the "since"
//    window too small to surface anything useful.
//
// 2. loadPeerCohort: "how does this HCP compare to peers like them"
//    — descriptive cohort comparison. Cohort = tenant HCPs in same
//    tier + specialty + composite-score band. Surfaces cohort
//    engagement baseline (calls, channel mix) + a rising-prescribing
//    subset breakdown. Strictly DESCRIPTIVE — never claims that
//    pattern X causes outcome Y. Reps use this to spot "am I
//    under-engaging this HCP relative to similar ones."
//
// Cross-references:
//   - Distinct from /hcos/[hco_key]'s "high-targeting affiliated
//     HCPs" panel (which ranks affiliated HCPs by score).
//   - Compounds with TargetScoreCard (composite score) + the rep
//     recommendations on /reps/[user_key].

import { queryFabric } from "@/lib/fabric";

// ---------------------------------------------------------------------------
// Since last visit
// ---------------------------------------------------------------------------

export type OtherRepSinceVisit = {
  user_key: string;
  name: string;
  calls: number;
  last_call: string;
};

export type SinceLastVisitData = {
  // Mode: 'viewer' = rep viewer with prior call; 'recent' = fallback
  // 30-day window for admin/manager/never-called-rep viewers.
  mode: "viewer" | "recent";
  // The data window's start date — viewer's last call when mode=
  // 'viewer'; today-30d when mode='recent'. All "since" stats compute
  // off this.
  window_start: string;
  window_days: number;
  // For mode='viewer': viewer called this HCP on this date.
  // For mode='recent': most recent call by ANYONE (display only —
  // not the window anchor). null when the HCP has never been called.
  most_recent_call_date: string | null;
  most_recent_call_rep_name: string | null;
  most_recent_call_days_ago: number | null;
  // Sales motion at the HCP's parent HCO over the window vs equivalent
  // prior window. Both null when there's no parent or no sales.
  parent_hco_name: string | null;
  parent_units_since: number | null;
  parent_units_prior_window: number | null;
  parent_units_delta_pct: number | null;
  // Calls by other reps to this HCP within the window (sorted by
  // recency). For mode='viewer', excludes the viewer; for mode=
  // 'recent', includes everyone.
  other_rep_calls: OtherRepSinceVisit[];
  // First-ever-sale at parent HCO if it falls in the data window —
  // strong "new customer" signal.
  first_ever_parent_sale_in_window: string | null;
};

const RECENT_FALLBACK_DAYS = 30;

export async function loadSinceLastVisit(args: {
  tenantId: string;
  hcpKey: string;
  // Viewer's user_key when viewer is a rep with a prior call to this
  // HCP, else null. Drives mode selection.
  viewerUserKey: string | null;
}): Promise<SinceLastVisitData | null> {
  const { tenantId, hcpKey, viewerUserKey } = args;

  // Step 1: figure out (a) viewer's last-call date if any, (b)
  // tenant-wide most recent call (for display + most_recent_call
  // metadata). One round-trip via UNION ALL.
  const callContextRows = await queryFabric<{
    kind: "viewer" | "tenant_most_recent";
    last_call: string | null;
    rep_name: string | null;
  }>(
    tenantId,
    `${
      viewerUserKey
        ? `SELECT 'viewer' AS kind,
             CONVERT(varchar(10), MAX(call_date), 23) AS last_call,
             CAST(NULL AS NVARCHAR(255)) AS rep_name
           FROM gold.fact_call
           WHERE tenant_id = @tenantId
             AND hcp_key = @hcpKey
             AND owner_user_key = @viewerUserKey
           UNION ALL`
        : ""
    }
     SELECT TOP 1 'tenant_most_recent' AS kind,
       CONVERT(varchar(10), f.call_date, 23) AS last_call,
       u.name AS rep_name
     FROM gold.fact_call f
     LEFT JOIN gold.dim_user u
       ON u.user_key = f.owner_user_key
       AND u.tenant_id = f.tenant_id
     WHERE f.tenant_id = @tenantId AND f.hcp_key = @hcpKey
     ORDER BY 2 DESC`,
    viewerUserKey ? { hcpKey, viewerUserKey } : { hcpKey },
  );

  const viewerRow = callContextRows.find((r) => r.kind === "viewer");
  const tenantRow = callContextRows.find((r) => r.kind === "tenant_most_recent");
  const viewerLast = viewerRow?.last_call ?? null;
  const tenantLast = tenantRow?.last_call ?? null;

  // Step 2: pick mode + window.
  //  - viewer mode: window = since viewer's last call. Window can be
  //    small (recent visit) — that's correct, the empty state will
  //    explain.
  //  - recent mode: window = last RECENT_FALLBACK_DAYS days. Used
  //    when viewer is admin/manager OR a rep who's never called this
  //    HCP. Always meaningful regardless of HCP touch history.
  const todayUtcMs = Date.now();
  const recentFallbackStart = new Date(
    todayUtcMs - RECENT_FALLBACK_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const mode: "viewer" | "recent" = viewerLast ? "viewer" : "recent";
  const windowStart = mode === "viewer" ? viewerLast! : recentFallbackStart;
  const windowDays = Math.max(
    1,
    Math.floor(
      (todayUtcMs - new Date(windowStart + "T00:00:00Z").getTime()) /
        (1000 * 60 * 60 * 24),
    ),
  );

  // most_recent_call display metadata is independent of window — show
  // tenant-wide most-recent call name + days-ago.
  const mostRecentCall = tenantLast;
  const mostRecentRepName = tenantRow?.rep_name ?? null;
  const mostRecentDaysAgo =
    mostRecentCall !== null
      ? Math.max(
          0,
          Math.floor(
            (todayUtcMs - new Date(mostRecentCall + "T00:00:00Z").getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        )
      : null;

  // Step 3: load deltas + collateral data in parallel against the
  // chosen window.
  const [parentRows, otherRepRows, firstEverRows] = await Promise.all([
    queryFabric<{
      parent_hco_name: string | null;
      units_since: number | null;
      units_prior_window: number | null;
    }>(
      tenantId,
      // Parent HCO sales motion: window-since vs equivalent prior
      // window of same length.
      `WITH this_hcp AS (
         SELECT primary_parent_hco_key, primary_parent_hco_name
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId AND hcp_key = @hcpKey
       )
       SELECT TOP 1
         (SELECT primary_parent_hco_name FROM this_hcp) AS parent_hco_name,
         COALESCE(SUM(CASE WHEN s.transaction_date > CAST(@windowStart AS DATE)
                           THEN s.signed_units ELSE 0 END), 0) AS units_since,
         COALESCE(SUM(CASE WHEN s.transaction_date <= CAST(@windowStart AS DATE)
                            AND s.transaction_date > DATEADD(day, -@windowDays, CAST(@windowStart AS DATE))
                           THEN s.signed_units ELSE 0 END), 0) AS units_prior_window
       FROM gold.fact_sale s
       JOIN this_hcp t ON s.account_key = t.primary_parent_hco_key
       WHERE s.tenant_id = @tenantId`,
      { hcpKey, windowStart, windowDays },
    ),
    queryFabric<{
      user_key: string;
      name: string;
      calls: number;
      last_call: string;
    }>(
      tenantId,
      // Other reps who called this HCP within the window.
      // viewer mode → exclude the viewer.
      // recent mode → include everyone (no viewer to exclude).
      `SELECT TOP 5
         u.user_key,
         u.name,
         COUNT(*) AS calls,
         CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call
       FROM gold.fact_call f
       JOIN gold.dim_user u
         ON u.user_key = f.owner_user_key
         AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = @tenantId
         AND f.hcp_key = @hcpKey
         AND f.call_date > CAST(@windowStart AS DATE)
         ${mode === "viewer" ? "AND f.owner_user_key <> @viewerUserKey" : ""}
       GROUP BY u.user_key, u.name
       ORDER BY MAX(f.call_date) DESC`,
      mode === "viewer"
        ? { hcpKey, windowStart, viewerUserKey }
        : { hcpKey, windowStart },
    ),
    queryFabric<{ first_sale_date: string | null }>(
      tenantId,
      // First-ever sale at parent HCO. We compare against window
      // start in JS (only show if first sale falls in window).
      `WITH parent AS (
         SELECT primary_parent_hco_key
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId AND hcp_key = @hcpKey
       )
       SELECT CONVERT(varchar(10), MIN(s.transaction_date), 23) AS first_sale_date
       FROM gold.fact_sale s
       JOIN parent p ON s.account_key = p.primary_parent_hco_key
       WHERE s.tenant_id = @tenantId`,
      { hcpKey },
    ),
  ]);

  const parent = parentRows[0] ?? null;
  const since = Number(parent?.units_since ?? 0);
  const prior = Number(parent?.units_prior_window ?? 0);
  const deltaPct =
    prior !== 0 ? Math.round(((since - prior) / Math.abs(prior)) * 100) : null;

  // Only flag first-ever-sale if it falls inside the data window.
  let firstEverInWindow: string | null = null;
  const firstSaleDate = firstEverRows[0]?.first_sale_date ?? null;
  if (firstSaleDate && firstSaleDate > windowStart) {
    firstEverInWindow = firstSaleDate;
  }

  return {
    mode,
    window_start: windowStart,
    window_days: windowDays,
    most_recent_call_date: mostRecentCall,
    most_recent_call_rep_name: mostRecentRepName,
    most_recent_call_days_ago: mostRecentDaysAgo,
    parent_hco_name: parent?.parent_hco_name ?? null,
    parent_units_since: parent?.parent_hco_name ? Math.round(since) : null,
    parent_units_prior_window: parent?.parent_hco_name ? Math.round(prior) : null,
    parent_units_delta_pct: deltaPct,
    other_rep_calls: otherRepRows.map((r) => ({
      user_key: r.user_key,
      name: r.name,
      calls: Number(r.calls),
      last_call: r.last_call,
    })),
    first_ever_parent_sale_in_window: firstEverInWindow,
  };
}

// ---------------------------------------------------------------------------
// Peer cohort
// ---------------------------------------------------------------------------

export type PeerCohortChannel = {
  channel: string;
  pct: number;
};

export type PeerCohortData = {
  // Human-readable cohort definition for the panel header
  // (e.g. "Tier 1 Oncologists, composite score 60-80").
  cohort_definition: string;
  cohort_n: number;
  // Median calls per HCP across the cohort in the last 90d (any rep).
  cohort_median_calls_90d: number;
  // This HCP's calls in last 90d (any rep) for direct comparison.
  this_hcp_calls_90d: number;
  // Channel mix for cohort calls in last 90d, top channels by volume.
  cohort_channel_mix: PeerCohortChannel[];
  // Subset of cohort whose parent HCO net units rose in last 90 vs
  // prior 90. Surfaces what engagement looks like in the rising group.
  rising_subset_n: number;
  rising_subset_avg_calls_90d: number | null;
};

export async function loadPeerCohort(args: {
  tenantId: string;
  hcpKey: string;
}): Promise<PeerCohortData | null> {
  const { tenantId, hcpKey } = args;

  try {
    // Step 1: this HCP's cohort dimensions (tier + specialty +
    // composite score band). We bucket score into 20-point bands
    // (0-20, 20-40, 40-60, 60-80, 80-100) so cohort sizes stay
    // useful instead of fragmenting into singletons.
    const thisHcpRows = await queryFabric<{
      tier: string | null;
      specialty: string | null;
      composite_score: number | null;
    }>(
      tenantId,
      `SELECT TOP 1
         h.tier,
         h.specialty_primary AS specialty,
         s.score_value AS composite_score
       FROM gold.dim_hcp h
       LEFT JOIN gold.hcp_target_score s
         ON s.tenant_id = h.tenant_id
         AND s.hcp_key = h.hcp_key
         AND s.scope_tag = '__all__'
       WHERE h.tenant_id = @tenantId AND h.hcp_key = @hcpKey`,
      { hcpKey },
    );
    const thisHcp = thisHcpRows[0];
    if (!thisHcp) return null;

    // Don't render a cohort when we don't have BOTH tier and
    // specialty — the cohort would be too loose to be interesting.
    if (!thisHcp.tier || !thisHcp.specialty) return null;

    // Composite score band — 20-point buckets. Null score → cohort
    // is everyone with same tier+specialty regardless of score.
    const scoreBandLow =
      thisHcp.composite_score != null
        ? Math.floor(thisHcp.composite_score / 20) * 20
        : null;
    const scoreBandHigh = scoreBandLow != null ? scoreBandLow + 20 : null;

    const tierLabel = thisHcp.tier;
    const cohortDefinition = `${tierLabel ? `Tier ${tierLabel} ` : ""}${thisHcp.specialty}${
      scoreBandLow != null
        ? `, composite score ${scoreBandLow}-${scoreBandHigh}`
        : ""
    }`;

    // Step 2: cohort stats. One CTE-heavy query to keep round-trips
    // down. Cohort = HCPs with same tier + specialty (+ optional
    // score band). Excludes the focal HCP from cohort calculations.
    const statsRows = await queryFabric<{
      cohort_n: number;
      cohort_median_calls_90d: number | null;
      this_hcp_calls_90d: number;
      rising_subset_n: number;
      rising_subset_avg_calls_90d: number | null;
    }>(
      tenantId,
      `WITH cohort_hcps AS (
         SELECT h.hcp_key, h.primary_parent_hco_key
         FROM gold.dim_hcp h
         ${
           scoreBandLow != null
             ? `JOIN gold.hcp_target_score s
                  ON s.tenant_id = h.tenant_id
                  AND s.hcp_key = h.hcp_key
                  AND s.scope_tag = '__all__'
                  AND s.score_value >= @scoreLow
                  AND s.score_value < @scoreHigh`
             : ""
         }
         WHERE h.tenant_id = @tenantId
           AND h.tier = @tier
           AND h.specialty_primary = @specialty
           AND h.hcp_key <> @hcpKey
       ),
       calls_90d AS (
         SELECT f.hcp_key, COUNT(*) AS calls
         FROM gold.fact_call f
         JOIN cohort_hcps c ON c.hcp_key = f.hcp_key
         WHERE f.tenant_id = @tenantId
           AND f.call_date >= DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
         GROUP BY f.hcp_key
       ),
       this_calls AS (
         SELECT COUNT(*) AS calls
         FROM gold.fact_call
         WHERE tenant_id = @tenantId
           AND hcp_key = @hcpKey
           AND call_date >= DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
       ),
       parent_motion AS (
         -- Per-cohort-HCP net units last 90 vs prior 90 (at parent HCO).
         SELECT
           c.hcp_key,
           COALESCE(SUM(CASE WHEN s.transaction_date >= DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
                             THEN s.signed_units ELSE 0 END), 0) AS units_recent,
           COALESCE(SUM(CASE WHEN s.transaction_date < DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
                              AND s.transaction_date >= DATEADD(day, -180, CAST(GETUTCDATE() AS DATE))
                             THEN s.signed_units ELSE 0 END), 0) AS units_prior
         FROM cohort_hcps c
         LEFT JOIN gold.fact_sale s
           ON s.tenant_id = @tenantId
           AND s.account_key = c.primary_parent_hco_key
         GROUP BY c.hcp_key
       ),
       rising AS (
         SELECT pm.hcp_key
         FROM parent_motion pm
         WHERE pm.units_recent > pm.units_prior
       ),
       rising_calls AS (
         SELECT AVG(CAST(COALESCE(c.calls, 0) AS FLOAT)) AS avg_calls
         FROM rising r
         LEFT JOIN calls_90d c ON c.hcp_key = r.hcp_key
       )
       SELECT
         (SELECT COUNT(*) FROM cohort_hcps) AS cohort_n,
         (SELECT
            -- Median via PERCENTILE_CONT on the per-HCP call counts.
            -- Treat HCPs with no calls as 0 (CROSS APPLY to expand
            -- cohort_hcps with COALESCE).
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(c.calls, 0))
              OVER ()
          FROM cohort_hcps ch
          LEFT JOIN calls_90d c ON c.hcp_key = ch.hcp_key
          OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY) AS cohort_median_calls_90d,
         (SELECT calls FROM this_calls) AS this_hcp_calls_90d,
         (SELECT COUNT(*) FROM rising) AS rising_subset_n,
         (SELECT avg_calls FROM rising_calls) AS rising_subset_avg_calls_90d`,
      {
        hcpKey,
        tier: thisHcp.tier,
        specialty: thisHcp.specialty,
        ...(scoreBandLow != null
          ? { scoreLow: scoreBandLow, scoreHigh: scoreBandHigh }
          : {}),
      },
    );

    const stats = statsRows[0];
    if (!stats || stats.cohort_n === 0) return null;

    // Step 3: channel mix for cohort calls in last 90d. Separate
    // query because we want per-channel rows, not folded into the
    // single-row stats above.
    const channelRows = await queryFabric<{
      channel: string | null;
      n: number;
    }>(
      tenantId,
      `WITH cohort_hcps AS (
         SELECT h.hcp_key
         FROM gold.dim_hcp h
         ${
           scoreBandLow != null
             ? `JOIN gold.hcp_target_score s
                  ON s.tenant_id = h.tenant_id
                  AND s.hcp_key = h.hcp_key
                  AND s.scope_tag = '__all__'
                  AND s.score_value >= @scoreLow
                  AND s.score_value < @scoreHigh`
             : ""
         }
         WHERE h.tenant_id = @tenantId
           AND h.tier = @tier
           AND h.specialty_primary = @specialty
           AND h.hcp_key <> @hcpKey
       )
       SELECT TOP 5
         COALESCE(NULLIF(LTRIM(RTRIM(f.call_channel)), ''), 'Unknown') AS channel,
         COUNT(*) AS n
       FROM gold.fact_call f
       JOIN cohort_hcps c ON c.hcp_key = f.hcp_key
       WHERE f.tenant_id = @tenantId
         AND f.call_date >= DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
       GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(f.call_channel)), ''), 'Unknown')
       ORDER BY n DESC`,
      {
        tier: thisHcp.tier,
        specialty: thisHcp.specialty,
        hcpKey,
        ...(scoreBandLow != null
          ? { scoreLow: scoreBandLow, scoreHigh: scoreBandHigh }
          : {}),
      },
    );

    const totalChannelCalls = channelRows.reduce((acc, r) => acc + Number(r.n), 0);
    const channelMix: PeerCohortChannel[] =
      totalChannelCalls === 0
        ? []
        : channelRows.map((r) => ({
            channel: r.channel ?? "Unknown",
            pct: Math.round((Number(r.n) / totalChannelCalls) * 100),
          }));

    return {
      cohort_definition: cohortDefinition,
      cohort_n: Number(stats.cohort_n),
      cohort_median_calls_90d: Math.round(
        Number(stats.cohort_median_calls_90d ?? 0),
      ),
      this_hcp_calls_90d: Number(stats.this_hcp_calls_90d ?? 0),
      cohort_channel_mix: channelMix,
      rising_subset_n: Number(stats.rising_subset_n),
      rising_subset_avg_calls_90d:
        stats.rising_subset_avg_calls_90d == null
          ? null
          : Math.round(Number(stats.rising_subset_avg_calls_90d) * 10) / 10,
    };
  } catch (err) {
    console.error("loadPeerCohort failed:", err);
    return null;
  }
}
