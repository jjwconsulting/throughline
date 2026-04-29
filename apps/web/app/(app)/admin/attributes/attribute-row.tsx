"use client";

import { useTransition } from "react";
import {
  toggleAttributeActiveAction,
  deleteAttributeMappingAction,
} from "./actions";

// Per-row actions on the attributes admin table. Activate/deactivate
// toggle + delete. Inline edit deferred — admins re-submit the form
// at the top with the same bronze location to update (ON CONFLICT
// upsert).

export default function AttributeRow({
  id,
  active,
}: {
  id: string;
  active: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("next", active ? "false" : "true");
      await toggleAttributeActiveAction(fd);
    });
  }

  function remove() {
    if (
      !confirm(
        "Delete this attribute mapping? Existing silver/gold rows for this column won't be removed until the next rebuild.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", id);
      await deleteAttributeMappingAction(fd);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={
          "text-xs rounded px-2 py-0.5 " +
          (active
            ? "bg-[var(--color-positive)]/15 text-[var(--color-positive-deep)] hover:bg-[var(--color-positive)]/25"
            : "bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)] hover:text-[var(--color-ink)]") +
          " disabled:opacity-50"
        }
      >
        {active ? "Active" : "Inactive"}
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        className="text-xs text-[var(--color-negative-deep)] hover:underline disabled:opacity-50"
      >
        Delete
      </button>
    </div>
  );
}
