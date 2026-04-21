import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/reports", label: "Reports" },
  { href: "/mappings", label: "Mappings" },
  { href: "/admin/tenants", label: "Admin" },
  { href: "/settings", label: "Settings" },
];

export default function AppNav() {
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
          <UserButton afterSignOutUrl="/" />
        </div>
      </div>
    </header>
  );
}
