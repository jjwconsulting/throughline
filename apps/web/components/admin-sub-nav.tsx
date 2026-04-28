"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icon";

const ADMIN_LINKS: { href: string; label: string; icon: IconName }[] = [
  { href: "/admin/tenants", label: "Tenants", icon: "tenants" },
  { href: "/admin/users", label: "Users", icon: "users" },
  { href: "/admin/mappings", label: "Mappings", icon: "mappings" },
  { href: "/admin/attributes", label: "Attributes", icon: "sparkles" },
  { href: "/admin/goals", label: "Goals", icon: "goals" },
  { href: "/admin/pipelines", label: "Pipelines", icon: "pipelines" },
];

export default function AdminSubNav() {
  const pathname = usePathname();
  if (!pathname.startsWith("/admin")) return null;

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]">
      <div className="max-w-6xl mx-auto px-6 h-10 flex items-center gap-1 text-[13px]">
        {ADMIN_LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={
                active
                  ? "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink)]"
                  : "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
              }
            >
              <Icon name={l.icon} size={13} />
              <span>{l.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
