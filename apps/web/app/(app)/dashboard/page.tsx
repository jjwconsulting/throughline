const stats = [
  { label: "HCP reach (30d)", value: "—" },
  { label: "Call attainment", value: "—" },
  { label: "Ex-factory demand (QTD)", value: "—" },
];

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Dashboard</h1>
        <p className="text-[var(--color-ink-muted)]">
          Embedded Power BI reports render here once Fabric is wired up.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5"
          >
            <p className="text-sm text-[var(--color-ink-muted)]">{s.label}</p>
            <p className="font-display text-3xl mt-2">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-6 min-h-96 flex items-center justify-center">
        <p className="text-sm text-[var(--color-ink-muted)]">
          Power BI embed placeholder
        </p>
      </div>
    </div>
  );
}
