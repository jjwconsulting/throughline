// Consolidated "Account motion" panel for /dashboard. Replaces 3
// separately-rendered card sections (Top rising / Top declining,
// Watch list, New accounts) with a single tabbed panel.
//
// Tabs are URL-driven (`?motion=rising|declining|watch|new`) so views
// are bookmarkable and the page stays a server component. Each tab
// renders a different table shape because the underlying data has
// different columns.
//
// Tab counts in the badge let the user see at-a-glance which tabs
// have data. Empty tabs render the standard inline empty state per
// `docs/audit/ui-patterns.md`.
//
// Per audit 2026-04-29 punch list item #3.

import Link from "next/link";

export type RisingDecliningRow = {
  hco_key: string;
  name: string;
  city: string | null;
  state: string | null;
  units_period: number;
  units_prior: number;
  units_delta: number;
  units_delta_pct: number | null;
};

export type WatchListRow = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  last_sale_date: string | null;
  current_rep_user_key: string | null;
  current_rep_name: string | null;
  units_prior: number;
  dollars_prior: number;
};

export type NewAccountRow = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  first_sale_date: string;
  current_rep_user_key: string | null;
  current_rep_name: string | null;
  units_period: number;
  dollars_period: number;
};

type Tab = "rising" | "declining" | "watch" | "new";

const TABS: { id: Tab; label: string }[] = [
  { id: "rising", label: "Rising" },
  { id: "declining", label: "Declining" },
  { id: "watch", label: "Watch list" },
  { id: "new", label: "New accounts" },
];

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  rising: "Largest unit gains in {period} vs the prior equal-length window. Customers in both periods only.",
  declining: "Largest unit losses in {period} vs the prior equal-length window. Stop-outs (zero this period) appear in Watch list.",
  watch: "Accounts that bought in the prior {period} but have ZERO sales in the current window. Sorted by prior-period units (biggest stop-outs first).",
  new: "HCOs whose first-ever sale fell inside {period}. Sorted by units in the window so material wins surface first.",
};

const EMPTY_MESSAGES: Record<Tab, string> = {
  rising: "No rising accounts in this window.",
  declining: "No declining accounts in this window.",
  watch: "No accounts have stopped buying in this window.",
  new: "No new accounts in this window.",
};

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCompactDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export default function AccountMotionPanel({
  active,
  period,
  rising,
  declining,
  watch,
  newAccounts,
  searchParams,
  pathname = "/dashboard",
}: {
  active: Tab;
  period: string;
  rising: RisingDecliningRow[];
  declining: RisingDecliningRow[];
  watch: WatchListRow[];
  newAccounts: NewAccountRow[];
  // Current request's search params, used to preserve other filter
  // state (range, channel, callKind, territory, etc.) when building
  // tab links.
  searchParams: Record<string, string | string[] | undefined>;
  pathname?: string;
}) {
  // Hide the entire panel when none of the tabs have data — matches
  // the original behavior where these were conditional sections.
  // Account motion only applies to tenants with sales; an empty
  // tenant gets nothing.
  if (
    rising.length === 0 &&
    declining.length === 0 &&
    watch.length === 0 &&
    newAccounts.length === 0
  ) {
    return null;
  }

  const counts: Record<Tab, number> = {
    rising: rising.length,
    declining: declining.length,
    watch: watch.length,
    new: newAccounts.length,
  };

  function tabHref(tab: Tab): string {
    // Build a query string from the current searchParams, override
    // the `motion` key. Preserves range/channel/territory/etc.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value == null) continue;
      const v = Array.isArray(value) ? value[0] : value;
      if (v != null && v.length > 0) params.set(key, v);
    }
    params.set("motion", tab);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="font-display text-lg">Account motion</h2>
        <p className="text-xs text-[var(--color-ink-muted)]">
          {TAB_DESCRIPTIONS[active].replace("{period}", period)}
        </p>
      </div>

      {/* Tab strip — underline style with primary-green active indicator
          per design review §"AccountMotionPanel tab styling." Underline
          tabs read as "section navigation within a card" (correct
          semantic for this panel). Counts inline in parens so users
          see whether a tab is empty before clicking. */}
      <div
        role="tablist"
        className="flex border-b border-[var(--color-border)] gap-6 px-5 overflow-x-auto"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          const count = counts[tab.id];
          return (
            <Link
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              href={tabHref(tab.id)}
              scroll={false}
              className={
                "relative py-3 text-sm font-medium transition-colors whitespace-nowrap " +
                (isActive
                  ? "text-[var(--color-ink)]"
                  : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]")
              }
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-[var(--color-ink-muted)]">
                ({count})
              </span>
              <span
                aria-hidden="true"
                className={
                  "absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-full " +
                  (isActive ? "bg-[var(--color-primary)]" : "bg-transparent")
                }
              />
            </Link>
          );
        })}
      </div>

      {/* Active tab body */}
      {active === "rising" || active === "declining" ? (
        <RisingDecliningTable
          rows={active === "rising" ? rising : declining}
          direction={active}
          emptyMessage={EMPTY_MESSAGES[active]}
        />
      ) : active === "watch" ? (
        <WatchListTable rows={watch} emptyMessage={EMPTY_MESSAGES.watch} />
      ) : (
        <NewAccountsTable
          rows={newAccounts}
          emptyMessage={EMPTY_MESSAGES.new}
        />
      )}
    </div>
  );
}

function RisingDecliningTable({
  rows,
  direction,
  emptyMessage,
}: {
  rows: RisingDecliningRow[];
  direction: "rising" | "declining";
  emptyMessage: string;
}) {
  const deltaColor =
    direction === "rising"
      ? "text-[var(--color-positive-deep)]"
      : "text-[var(--color-negative-deep)]";
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-[var(--color-ink-muted)]">
        <tr>
          <th className="text-left font-normal px-5 py-2 w-8">#</th>
          <th className="text-left font-normal px-5 py-2">HCO</th>
          <th className="text-right font-normal px-5 py-2">Prior</th>
          <th className="text-right font-normal px-5 py-2">Period</th>
          <th className="text-right font-normal px-5 py-2">Δ Units</th>
          <th className="text-right font-normal px-5 py-2">Δ %</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={6}
              className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
            >
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((a, i) => (
            <tr
              key={a.hco_key}
              className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
            >
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {i + 1}
              </td>
              <td className="px-5 py-2">
                <Link
                  href={`/hcos/${encodeURIComponent(a.hco_key)}`}
                  className="text-[var(--color-primary)] hover:underline"
                >
                  {a.name}
                </Link>
                {a.city || a.state ? (
                  <div className="text-xs text-[var(--color-ink-muted)]">
                    {[a.city, a.state].filter(Boolean).join(", ")}
                  </div>
                ) : null}
              </td>
              <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                {formatNumber(Math.round(a.units_prior))}
              </td>
              <td className="px-5 py-2 text-right font-mono">
                {formatNumber(Math.round(a.units_period))}
              </td>
              <td className={`px-5 py-2 text-right font-mono ${deltaColor}`}>
                {direction === "rising" ? "+" : ""}
                {formatNumber(Math.round(a.units_delta))}
              </td>
              <td className={`px-5 py-2 text-right font-mono ${deltaColor}`}>
                {a.units_delta_pct != null
                  ? `${direction === "rising" ? "+" : ""}${a.units_delta_pct.toFixed(0)}%`
                  : "—"}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function WatchListTable({
  rows,
  emptyMessage,
}: {
  rows: WatchListRow[];
  emptyMessage: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-[var(--color-ink-muted)]">
        <tr>
          <th className="text-left font-normal px-5 py-2 w-8">#</th>
          <th className="text-left font-normal px-5 py-2">HCO</th>
          <th className="text-left font-normal px-5 py-2">Location</th>
          <th className="text-left font-normal px-5 py-2">Last sale</th>
          <th className="text-left font-normal px-5 py-2">Current rep</th>
          <th className="text-right font-normal px-5 py-2">Prior units</th>
          <th className="text-right font-normal px-5 py-2">Prior dollars</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={7}
              className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
            >
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((w, i) => (
            <tr
              key={w.hco_key}
              className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
            >
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {i + 1}
              </td>
              <td className="px-5 py-2">
                <Link
                  href={`/hcos/${encodeURIComponent(w.hco_key)}`}
                  className="text-[var(--color-primary)] hover:underline"
                >
                  {w.name}
                </Link>
                {w.hco_type ? (
                  <div className="text-xs text-[var(--color-ink-muted)]">
                    {w.hco_type}
                  </div>
                ) : null}
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {[w.city, w.state].filter(Boolean).join(", ") || "—"}
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {w.last_sale_date ?? "—"}
              </td>
              <td className="px-5 py-2">
                {w.current_rep_user_key ? (
                  <Link
                    href={`/reps/${encodeURIComponent(w.current_rep_user_key)}`}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {w.current_rep_name ?? "—"}
                  </Link>
                ) : (
                  <span className="text-[var(--color-ink-muted)] italic">
                    No rep
                  </span>
                )}
              </td>
              <td className="px-5 py-2 text-right font-mono">
                {formatNumber(Math.round(w.units_prior))}
              </td>
              <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                {formatCompactDollars(w.dollars_prior)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function NewAccountsTable({
  rows,
  emptyMessage,
}: {
  rows: NewAccountRow[];
  emptyMessage: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-[var(--color-ink-muted)]">
        <tr>
          <th className="text-left font-normal px-5 py-2 w-8">#</th>
          <th className="text-left font-normal px-5 py-2">HCO</th>
          <th className="text-left font-normal px-5 py-2">Location</th>
          <th className="text-left font-normal px-5 py-2">First sale</th>
          <th className="text-left font-normal px-5 py-2">Current rep</th>
          <th className="text-right font-normal px-5 py-2">Units</th>
          <th className="text-right font-normal px-5 py-2">Net dollars</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={7}
              className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
            >
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((n, i) => (
            <tr
              key={n.hco_key}
              className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
            >
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {i + 1}
              </td>
              <td className="px-5 py-2">
                <Link
                  href={`/hcos/${encodeURIComponent(n.hco_key)}`}
                  className="text-[var(--color-primary)] hover:underline"
                >
                  {n.name}
                </Link>
                {n.hco_type ? (
                  <div className="text-xs text-[var(--color-ink-muted)]">
                    {n.hco_type}
                  </div>
                ) : null}
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {[n.city, n.state].filter(Boolean).join(", ") || "—"}
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {n.first_sale_date}
              </td>
              <td className="px-5 py-2">
                {n.current_rep_user_key ? (
                  <Link
                    href={`/reps/${encodeURIComponent(n.current_rep_user_key)}`}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {n.current_rep_name ?? "—"}
                  </Link>
                ) : (
                  <span className="text-[var(--color-ink-muted)] italic">
                    No rep
                  </span>
                )}
              </td>
              <td className="px-5 py-2 text-right font-mono">
                {formatNumber(Math.round(n.units_period))}
              </td>
              <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                {formatCompactDollars(n.dollars_period)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
