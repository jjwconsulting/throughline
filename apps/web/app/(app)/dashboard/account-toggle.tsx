"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  DEFAULT_FILTERS,
  type AccountType,
} from "./filters";

export default function AccountToggle({ value }: { value: AccountType }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function set(next: AccountType) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_FILTERS.account) params.delete("account");
    else params.set("account", next);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Account type"
      className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-sm"
    >
      {ACCOUNT_TYPES.map((t) => {
        const active = t === value;
        return (
          <button
            key={t}
            role="tab"
            aria-selected={active}
            disabled={pending}
            onClick={() => set(t)}
            className={
              "px-3 py-1 rounded transition-colors disabled:opacity-50 " +
              (active
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]")
            }
          >
            {ACCOUNT_TYPE_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}
