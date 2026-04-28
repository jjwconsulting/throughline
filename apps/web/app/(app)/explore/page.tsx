import Link from "next/link";
import { loadGenericMatrix } from "@/lib/explore";
import { loadAccessibleTerritories } from "@/lib/sales";
import { getCurrentScope, scopeToSql } from "@/lib/scope";
import {
  ROW_DIMS,
  METRICS,
  dimById,
  metricById,
  type MetricId,
} from "@/lib/explore-registry";
import MatrixTable, { type MatrixSection } from "@/components/matrix-table";
import NoAccess from "../dashboard/no-access";
import FilterBar from "../dashboard/filter-bar";
import {
  parseFilters,
  periodLabel,
  GRANULARITY_LABELS,
} from "../dashboard/filters";
import MatrixPickers from "./matrix-pickers";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);

  const rowDimIdRaw = pickStr(sp.row) ?? "hco";
  const metricIdRaw = pickStr(sp.metric) ?? "units";
  const groupDimIdRaw = pickStr(sp.group); // undefined = single-dim
  const includeFirstSale = pickStr(sp.firstSale) === "1";

  const rowDim = dimById(rowDimIdRaw) ?? ROW_DIMS[0]!;
  const metric = metricById(metricIdRaw) ?? METRICS["units"];
  const metricId = metric.id as MetricId;
  // Group dim: ignore if it equals the row dim (collapse to single-dim)
  // and ignore if not found.
  const groupDim =
    groupDimIdRaw && groupDimIdRaw !== rowDimIdRaw
      ? (dimById(groupDimIdRaw) ?? null)
      : null;

  const { userEmail, resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return <NoAccess email={userEmail} reason={resolution?.reason} />;
  }
  const { scope } = resolution;
  const tenantId = scope.tenantId;
  const rlsScope = scopeToSql(scope);

  const [matrix, accessibleTerritories] = await Promise.all([
    loadGenericMatrix({
      tenantId,
      rowDim,
      groupDim,
      metricId,
      filters,
      includeFirstSale,
      scope: rlsScope,
    }),
    loadAccessibleTerritories(tenantId, scope),
  ]);

  const showFirstSaleColumn =
    includeFirstSale && rowDim.id === "hco" && metricId !== "calls";

  // Map loader's groups → MatrixTable's sections shape (same fields,
  // different name + presetCells injection for first-sale column).
  const sections: MatrixSection[] = matrix.groups.map((g) => ({
    key: g.key,
    label: g.label,
    subtitle: g.subtitle,
    subtotalCells: g.subtotalCells,
    subtotalTotal: g.subtotalTotal,
    leaves: g.leaves.map((leaf) => ({
      key: leaf.key,
      label: leaf.label,
      href: leaf.href,
      subtitle: leaf.subtitle,
      metadata: leaf.metadata,
      presetCells: showFirstSaleColumn ? [leaf.first_sale_date ?? null] : [],
      cells: leaf.cells,
      total: leaf.total,
    })),
  }));

  const totalLeafCount = sections.reduce(
    (sum, s) => sum + s.leaves.length,
    0,
  );

  const exportFilename = `throughline-${rowDim.id}${groupDim ? `-by-${groupDim.id}` : ""}-${metricId}-${filters.range}-${filters.granularity}`;

  // Subtitle text — distinguishes single-dim vs multi-dim copy.
  const subtitle = matrix.unsupported
    ? `${rowDim.label}${groupDim ? ` × ${groupDim.label}` : ""} isn't supported with ${metric.label} — pick a different combination.`
    : `${totalLeafCount} row${totalLeafCount === 1 ? "" : "s"}` +
      (groupDim
        ? ` across ${matrix.groups.length} ${groupDim.label.toLowerCase()} group${matrix.groups.length === 1 ? "" : "s"}`
        : "") +
      ` with activity in ${periodLabel(filters.range)}` +
      (matrix.buckets.length > 0
        ? ` · ${matrix.buckets.length} ${filters.granularity} bucket${matrix.buckets.length === 1 ? "" : "s"}`
        : "");

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Dashboard
        </Link>
        <div className="mt-2 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-3xl">Explore</h1>
            <p className="text-[var(--color-ink-muted)]">
              Pivot any dimension against any metric across time.
              FilterBar narrows the universe; pickers below choose the
              row dim, optional group dim, and metric.
            </p>
          </div>
          <FilterBar filters={filters} territories={accessibleTerritories} />
        </div>
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-display text-lg">
              {groupDim ? `${groupDim.label} → ` : ""}
              {rowDim.label} ×{" "}
              {GRANULARITY_LABELS[filters.granularity]} × {metric.label}
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">{subtitle}</p>
          </div>
          <MatrixPickers
            rowDimId={rowDim.id}
            groupDimId={groupDim?.id ?? null}
            metricId={metricId}
            includeFirstSale={includeFirstSale}
          />
        </div>
        {matrix.unsupported ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)]">
            This combination isn&apos;t available. Try switching the
            metric or row / group dimension.
          </div>
        ) : (
          <MatrixTable
            sections={sections}
            rowLabelHeader={rowDim.label}
            groupHeader={groupDim?.label}
            metadataHeaders={matrix.metadataHeaders}
            presetHeaders={showFirstSaleColumn ? ["First sale"] : []}
            bucketHeaders={matrix.buckets.map((b) => b.label)}
            cellMin={matrix.cellMin}
            cellMax={matrix.cellMax}
            format={metric.format}
            exportFilename={exportFilename}
          />
        )}
      </div>

      <div className="text-center text-xs text-[var(--color-ink-muted)] pt-2">
        Need a custom slice not in the picker? Open the Power BI report →{" "}
        <Link
          href="/reports"
          className="text-[var(--color-primary)] hover:underline"
        >
          /reports
        </Link>
      </div>
    </div>
  );
}
