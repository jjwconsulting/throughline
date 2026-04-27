import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { getCurrentScope, scopeLabel } from "@/lib/scope";
import AdminSubNav from "./admin-sub-nav";
import { BrandMark } from "./brand-mark";
import NavLinks from "./nav-links";

export default async function AppNav() {
  const { resolution } = await getCurrentScope();
  const badge =
    resolution?.ok && resolution.scope.role !== "admin"
      ? scopeLabel(resolution.scope)
      : null;

  return (
    <header className="sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-xl text-[var(--color-ink)]"
        >
          <BrandMark />
          <span>Throughline</span>
        </Link>
        <div className="flex items-center gap-6">
          <NavLinks />
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
      <AdminSubNav />
    </header>
  );
}
