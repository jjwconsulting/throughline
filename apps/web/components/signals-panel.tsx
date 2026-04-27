import Link from "next/link";
import type { Signal, SignalSeverity } from "@/lib/signals";
import { Icon, type IconName } from "./icon";

const severityStyles: Record<
  SignalSeverity,
  { icon: IconName; color: string; label: string }
> = {
  alert: {
    icon: "alertTri",
    color: "var(--color-negative)",
    label: "Alert",
  },
  warning: {
    icon: "clock",
    color: "var(--color-accent)",
    label: "Warning",
  },
  info: {
    icon: "mapPin",
    color: "var(--color-primary)",
    label: "Info",
  },
};

export default function SignalsPanel({
  title,
  subtitle,
  signals,
  emptyHint,
}: {
  title: string;
  subtitle?: string;
  signals: Signal[];
  emptyHint?: string;
}) {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg">{title}</h2>
          {subtitle ? (
            <p className="text-xs text-[var(--color-ink-muted)]">{subtitle}</p>
          ) : null}
        </div>
        {signals.length > 0 ? (
          <span className="text-xs rounded-full px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
            {signals.length}
          </span>
        ) : null}
      </div>
      {signals.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)]">
          {emptyHint ?? "Nothing to surface right now. "}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {signals.map((s, i) => {
            const sev = severityStyles[s.severity];
            return (
              <li key={`${s.type}-${i}`}>
                <Link
                  href={s.href}
                  className="block px-5 py-3 hover:bg-[var(--color-surface-alt)] transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-label={sev.label}
                      title={sev.label}
                      className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-[var(--color-surface-alt)] shrink-0"
                      style={{ color: sev.color }}
                    >
                      <Icon name={sev.icon} size={14} strokeWidth={1.75} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-ink)] truncate">
                        {s.title}
                      </p>
                      {s.detail ? (
                        <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                          {s.detail}
                        </p>
                      ) : null}
                    </div>
                    <Icon
                      name="arrowRight"
                      size={14}
                      className="text-[var(--color-ink-muted)] mt-1 shrink-0"
                    />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
