"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icon";

const MAIN_LINKS: { href: string; label: string; icon: IconName }[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/inbox", label: "Inbox", icon: "inbox" },
  { href: "/explore", label: "Explore", icon: "explore" },
  { href: "/ask", label: "Ask", icon: "sparkles" },
  { href: "/reports", label: "Reports", icon: "reports" },
  { href: "/admin/tenants", label: "Admin", icon: "admin" },
  // /settings is a "Coming soon" placeholder — hidden from nav until
  // it has real content, otherwise looks broken to first-time users.
  // Re-add this entry when settings has shippable surfaces (profile,
  // notification preferences, etc.). Per audit 2026-04-29 §1.
  // { href: "/settings", label: "Settings", icon: "settings" },
];

// Admin link is active for any /admin/* route. Dashboard is active for HCP/Rep
// detail pages too — those are scoped views of the same dashboard concept.
function isActive(href: string, pathname: string) {
  if (href === "/admin/tenants") return pathname.startsWith("/admin");
  if (href === "/dashboard") {
    return (
      pathname === "/dashboard" ||
      pathname.startsWith("/hcps") ||
      pathname.startsWith("/hcos") ||
      pathname.startsWith("/reps")
    );
  }
  if (href === "/explore") return pathname.startsWith("/explore");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {MAIN_LINKS.map((l) => {
        const active = isActive(l.href, pathname);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={
              active
                ? "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--color-surface-alt)] text-[var(--color-ink)]"
                : "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
            }
          >
            <Icon name={l.icon} size={14} />
            <span>{l.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
