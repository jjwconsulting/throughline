# Goals — design sketch

Status: **open**. Not built. Sketched here so the thinking isn't lost.

## Why this is its own design problem

Goals don't come from a source system. They're authored by humans — usually a
VP Sales or Commercial Ops in a spreadsheet, adjusted mid-period when
territories realign or new products launch. Both fennec and TriSalus got a
"client goals file" that was structurally different each time and often
internally inconsistent.

That means goals behave more like our `mapping` tables than like `call` or
`demand`: small, human-authored, audit-trailed, edited often, relatively
static per period. They do **not** go through the bronze → silver → gold
ingestion path meant for source-system feeds.

## Sketch

### Storage

A `goal` table with a flexible grain — NULLs let goals sit at any level:

| column | notes |
|---|---|
| `tenant_id` | required |
| `period_start`, `period_end` | usually month or quarter bounds |
| `territory_id` | nullable — NULL = "across all territories" |
| `rep_user_id` | nullable — NULL = "across all reps" |
| `product_id` | nullable — NULL = "across all products" |
| `hco_id` | nullable — NULL = "across all HCOs" |
| `metric` | enum: `calls`, `trx`, `nrx`, `new_starts`, `revenue`, … |
| `goal_value` | numeric |
| `stretch_value` | nullable |
| `updated_by`, `updated_at` | audit |

Lives in Postgres (like `mapping`), synced to Fabric. Same pattern we used
for config: human writes go to Postgres, Fabric mirror stays read-only.

### Input paths (both, not either)

1. **Form editor in the web app** — a grid UI (TanStack Table + React Hook
   Form + Zod) with spreadsheet-like paste support. Good for ongoing edits
   and targeted overrides. Auditable — every cell change logged.
2. **File upload** — user uploads their goals Excel/CSV, we show a mapping
   UI ("which column is the rep? which is the goal value?"), parse rows into
   the canonical shape above. Reuses the same `tenant_source_field_map`
   infrastructure already in place.

Both feed the same Postgres table. Whichever way the rows got there, the
downstream join to facts is identical.

### Why both

- **Form-only:** breaks down fast at bulk volume (imagine typing 500 rep ×
  product × month cells).
- **Upload-only:** friction every time someone needs to bump a single goal.
  Clients reject "edit the file and re-upload" as a workflow.

### What "good" looks like from the user side

- Territory manager opens the goals page, sees their reps' goals for the
  current quarter, edits one cell, saves. Audit log shows the change.
- Commercial Ops uploads next year's goal plan from their annual planning
  deck, resolves the column mapping once, rows land.
- Brand lead sees brand-total goals rolled up from rep-level, and can drill
  down to see who's behind.

### Scope notes

- Not MVP. First paying customer will accept a Postgres write + manual
  reload workflow for a quarter.
- Form UX is the expensive part — the table + auditing + "good enough for
  VPs to actually use" bar is real work, not a single sprint.
- The `tenant_source_field_map` infrastructure we already built handles the
  upload path for free, which is the nicer of the two to delay.
