import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { getCurrentScope, scopeLabel } from "@/lib/scope";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inbox", label: "Inbox" },
  { href: "/reports", label: "Reports" },
  { href: "/mappings", label: "Mappings" },
  { href: "/admin/tenants", label: "Admin" },
  { href: "/settings", label: "Settings" },
];

export default async function AppNav() {
  const { resolution } = await getCurrentScope();
  const badge =
    resolution?.ok && resolution.scope.role !== "admin"
      ? scopeLabel(resolution.scope)
      : null;

  return (
    <header className="sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="font-display text-xl">
          Throughline
        </Link>
        <div className="flex items-center gap-6">
          <nav className="flex gap-6 text-sm">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          {badge ? (
            <span
              title="Your data scope. Admins see all reps; managers see their team; reps see only themselves."
              className="text-xs rounded px-2 py-1 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]"
            >
              {badge}
            </span>
          ) : null}
          <UserButton afterSignOutUrl="/" />
        </div>
      </div>
    </header>
  );
}
