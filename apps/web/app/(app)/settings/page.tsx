export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">Settings</h1>
        <p className="text-[var(--color-ink-muted)]">
          Account, notifications, and tenant preferences.
        </p>
      </div>
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-12 text-center">
        <p className="font-medium">Coming soon</p>
        <p className="text-sm text-[var(--color-ink-muted)] mt-2 max-w-md mx-auto">
          User-level preferences (email digest cadence, default filters,
          theme) and tenant-level settings (branding, SSO) live here once
          they ship.
        </p>
      </div>
    </div>
  );
}
