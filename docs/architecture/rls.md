# RLS in the native-query path

Since we pivoted to native React rendering as the dashboard default
(`docs/product/web-display-philosophy.md`), per-user RLS is no longer
"handled by Power BI." This doc covers what is and isn't enforced today,
what fennec/TriSalus did, and the staged plan to replicate that enforcement
without going back to PBI everywhere.

`ARCHITECTURE.md §5` covers the PBI/customData RLS pattern; this doc is
about the **non-PBI surfaces** (everything served by `apps/web/lib/fabric.ts`
queryFabric).

---

## Today's state — what's enforced and what isn't

### Tenant-level isolation: ENFORCED

- Every `queryFabric` call requires a `tenantId` argument and binds it as
  `@tenantId`.
- Every gold table has a `tenant_id` column. By convention, every SQL we
  write filters `WHERE f.tenant_id = @tenantId`.
- Discipline-dependent (no SQL-layer policy enforces this), but it's a
  one-line pattern that's easy to grep for at review time.

A logged-in user from tenant A cannot see tenant B's data because the
web app resolves their `tenant_id` from Postgres `tenant_user` before
any query runs.

### Per-user / per-territory scope: NOT ENFORCED

This is the gap.

A logged-in Clerk user from tenant X can see **all of tenant X's data**
via our queries: every rep's calls, every HCP, every territory. The
Direct Lake semantic model's role (`[tenant_id] = CUSTOMDATA()`) is
*only* enforced via the PBI embed flow — bypassed entirely when we hit
the SQL endpoint with the service principal.

This is fine while the only humans using the app are JJW + Sentero
employees. It is **not** fine before any external customer touches it.

---

## How fennec / TriSalus enforced it

Standard pharma BI pattern, both of them:

- **Rep** sees only their own territory's data.
- **Manager** sees their team's territories (rolling up all reps under them).
- **Admin / corporate** sees everything for their company.
- **Bypass identities** for support/dev — analytics consultants see all
  tenants for debugging.

In fennec, this was enforced via PBI EffectiveIdentity tied to the user's
`USERPRINCIPALNAME()` and a DAX role joining `Territory[id]` on a user→
territory bridge. The SAM and KAD teams have parallel hierarchies; users
with both roles see both.

Throughline needs the same conceptual model, but enforced in the **web
application layer** (since we're not using PBI's role machinery for
native queries).

---

## The model: roles + scopes

Two orthogonal concepts:

- **Role** (what kind of user): `admin` | `manager` | `rep` | `bypass`
- **Scope** (what data they see): the SQL `IN (...)` set of `user_key`
  values they're authorized to see

Mapping:

| Role | Scope shape |
|---|---|
| `admin` | All `user_key`s within tenant (no extra filter) |
| `manager` | `user_key`s of reps reporting to them, recursively |
| `rep` | Just their own `user_key` |
| `bypass` | Special — can access any tenant; resolves to admin scope per-tenant |

`scope` is computed from `role` + the user→user_key + manager hierarchy
data. The web app caches it per request.

---

## Implementation plan, in order

### Phase 1 — Data model (Postgres + a Fabric lookup)

**Postgres `tenant_user` extensions** (Drizzle migration):

```ts
// schema.ts
export const tenantUser = pgTable("tenant_user", {
  // existing: id, tenant_id, user_email, ...
  role: tenantUserRole("role").notNull().default("rep"),
  // The Veeva user_key in gold.dim_user this Clerk user maps to.
  // Null for admin/bypass users who don't correspond to a single Veeva rep.
  veeva_user_key: text("veeva_user_key"),
});

export const tenantUserRole = pgEnum("tenant_user_role", [
  "admin",
  "manager",
  "rep",
  "bypass",
]);
```

**Fabric lookup** for manager scope: a query against `gold.dim_user`
walking `manager_id` recursively, returning all reports under a manager.
Cached per request.

### Phase 2 — Web app helpers

`apps/web/lib/scope.ts`:

```ts
export type UserScope =
  | { role: "admin" | "bypass" }
  | { role: "manager"; userKeys: string[] }
  | { role: "rep"; userKey: string };

export async function getCurrentUserScope(
  tenantId: string,
  clerkUserEmail: string,
): Promise<UserScope> { ... }
```

Returns the scope object for the current request. Reads `tenant_user`
from Postgres; for managers, joins to `gold.dim_user` for the team
list. Cached at the request level (Next.js `cache()` or simple memo).

### Phase 3 — Query enforcement

Wrap or extend `queryFabric` so it injects the user scope filter
automatically. Two options:

**A. Explicit scope arg on `queryFabric`** (recommended for safety):

```ts
const rows = await queryFabric({
  tenantId,
  scope,                                    // mandatory
  on: "f.owner_user_key",                   // which column to scope on
  query: `SELECT ... FROM gold.fact_call f WHERE f.tenant_id = @tenantId ${SCOPE}`,
});
```

The wrapper substitutes `${SCOPE}` with the appropriate clause:
- admin/bypass → empty
- rep → `AND f.owner_user_key = @scopeUserKey`
- manager → `AND f.owner_user_key IN @scopeUserKeys` (table-valued param or
  comma-list with care)

**B. Query helpers that bake scope in** (e.g. `queryScopedFacts`):

Less flexible but harder to forget. Probably the right destination after we
have a few queries to look at.

For v1 pick A — explicit, ugly, hard to forget.

### Phase 4 — UI implications

- **No banner / scope indicator for reps.** They just see their data;
  pretending the rest exists is noise.
- **Scope indicator for managers + admin.** A small badge in the header:
  "Viewing as Manager: 12 reps" or "Viewing as Admin: all reps." For
  bypass users, "Viewing tenant: fennecpharma" with a tenant switcher.
- **Filters compose with scope, not override it.** A rep cannot click
  themselves out of their scope.
- **Drilldown links must respect scope.** A rep clicking "Top reps" on
  the dashboard should only see themselves; if they somehow land on
  `/reps/<other_user_key>` (URL hand-edited), the page returns 404,
  not "permission denied" (don't leak existence).

### Phase 5 — Bypass + multi-tenant access

JJW/Sentero employees need cross-tenant access for support. Two paths:

- **Clerk metadata flag** `is_throughline_internal: true` — when set, the
  user can access any tenant. A tenant switcher dropdown lets them pick.
- **Per-action audit log** — every bypass-user query logs `(clerk_user, tenant_id, query_hash, timestamp)` to Postgres. Required for compliance
  conversations later.

---

## What we're explicitly punting on (for now)

- **Database-layer RLS.** Fabric SQL endpoint with SP auth doesn't expose
  row-level policy enforcement. We'd need OBO (on-behalf-of) auth flow
  with per-user Fabric workspace permissions. Heavy and probably not
  worth it unless a customer demands it. Application-layer enforcement
  is the industry norm for SaaS multi-tenant.
- **Field-level RLS.** Pharma data sometimes has fields like rep
  compensation that even managers shouldn't see. Defer until a customer
  asks.
- **Clerk webhook → tenant_user provisioning.** Currently hand-run SQL.
  This needs to land before the user invite flow becomes self-serve.
- **Territory-based scope** (manager sees "all reps in my territories",
  not "all reps reporting to me"). Requires `gold.bridge_user_territory`,
  which is on the gold cleanup memory. Phase 3 starts with simple
  manager_id hierarchy; switch to territory-based when the bridge lands.

---

## Open questions

- **Is "rep" scope by `owner_user_key` enough, or also `attributed_user_key`?**
  Fennec uses `credit_user_key = COALESCE(attributed, owner)` — so a rep
  whose call was attributed to a specialist still sees it. Probably yes,
  but design after Phase 1.
- **Manager hierarchy depth.** Fennec is 2 levels (rep → manager → director). Cap at some depth (5?) to avoid runaway recursion.
- **Caching scope across requests.** Currently per-request memoization;
  could move to Redis/Postgres cache if scope resolution becomes a
  hotspot. Premature.
- **Audit trail for prod.** When a customer demands "who saw what when",
  we need query-level logging. Postgres table `audit.query_log` keyed by
  `(clerk_user, tenant_id, scope_hash, query_hash, timestamp)`.

---

## Minimum viable RLS — what to build first

Before any external customer touches the app:

1. Add `role` + `veeva_user_key` to `tenant_user` (Phase 1, partial).
2. Build `getCurrentUserScope()` for the three non-bypass roles
   (Phase 2).
3. Add explicit scope arg to `queryFabric` and wire it through every
   gold-querying surface (Phase 3, option A).
4. Header scope indicator (Phase 4 partial).
5. Internal-employee bypass via Clerk metadata + tenant switcher
   (Phase 5).

That's the floor. Audit log + manager-via-territory + cross-product
field RLS all defer.
