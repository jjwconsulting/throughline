# User access & tenant assignment — design sketch

Status: **open**. Today's behavior is "manual seed in `tenant_user`, log in,
see your tenant; if not in the table, see a 'no tenant access' message."
Fine for dev; not viable for a real customer.

## Decisions to make

### Signup model

- **Invite-only** — operator (JJW / Sentero CSM) creates the tenant, invites
  users by email via Clerk; on first sign-in, user is auto-mapped to that
  tenant. Probably right for the enterprise pharma audience — IT teams
  expect provisioning, not self-signup.
- **Self-signup with approval** — anyone can sign up, lands in a "pending"
  state, admin approves and assigns to a tenant. Good for marketing-driven
  growth; less appropriate here.
- **Domain-based auto-assign** — sign up with `@acme.com`, get
  auto-mapped to the acme tenant. Fast onboarding for the user, but requires
  the tenant to have claimed the domain (something operator must do during
  onboarding) and falls apart for HCO contractors who use personal email.

Likely answer: **invite-only**, with a domain-based auto-assign as a
nice-to-have for tenants that want it.

### Roles within a tenant

The `tenant_user.role` column on the architecture table was deferred (see
`tenant-user.ts` shared schema). When this work happens, we need at least:

- **Admin** — manages other users in the tenant, edits all config (mappings,
  field-map, integration configs), sees all data
- **Editor** — edits mappings, sees all data
- **Viewer** — sees all data, no edits
- (Maybe later) **Field-scoped** — sees only their territory's data,
  driven by `effective_territory_ids`

PBI RLS in our model currently filters to the tenant boundary only. Territory
scoping inside a tenant is a follow-up — adds another `customData` field
(territory IDs as a delimited string) and a more complex DAX role.

### Multi-tenant users

JJW/Sentero operator admins need to see across multiple tenants for support.
Two patterns:

- **Tenant switcher** — top-bar dropdown of tenants this user can access.
  Each switch re-mints embed token with new `customData`. Most flexible.
- **BypassTenant role** — single embed token bypasses the filter; user sees
  all data globally. Simpler but doesn't give "view as this tenant" semantics
  that's useful for support.

Likely answer: **both**. Tenant switcher for the typical workflow, BypassTenant
for whole-system queries (audit, debugging).

### Multi-tenant data model

Today: `tenant_user` is one row per (tenant, user). A user belonging to two
tenants gets two rows. Works as-is.

Need to add when this work lands:
- `tenant_user.role` — once roles are decided
- `tenant_user.invited_by`, `tenant_user.invited_at`, `tenant_user.activated_at`
  for the invite flow
- A separate `user` table? Or treat Clerk as the user master? Probably the
  latter — Clerk owns identity; Postgres owns "what tenants/roles does this
  identity have."

### Onboarding flow

When operator stands up a new tenant, sequence is:

1. Operator UI creates the tenant row in Postgres
2. Operator UI invites the first admin user (Clerk invite)
3. User accepts, signs in, gets auto-mapped via the invite metadata
4. Admin user invites the rest of their team

Each step needs UI + API endpoints we haven't built. Clerk's invite system
+ webhook on `user.created` (to create the `tenant_user` row) is probably
the right plumbing.

### Deprovisioning

- **Remove user from tenant** — delete `tenant_user` row; their next sign-in
  shows "no access" page
- **Archive a tenant** — `tenant.status = 'archived'`; admin queries hide it;
  embed routes refuse it; data stays for compliance retention
- **Hard-delete a tenant** — `DELETE FROM tenant WHERE ...` cascades through
  all `tenant_user`, `tenant_source_field_map`, integration configs. Bronze
  data in Fabric (`bronze_<slug>.*`) needs a separate cleanup notebook.

### Audit

Who saw what, when. Store in Postgres `audit_log` initially (cheap, simple);
promote to Event Grid → blob if a customer demands proper compliance audit.
Already in the architecture's "open items" — see ARCHITECTURE.md §9.

## What's wired today vs. what's not

Wired:
- Clerk auth (sign-in/up, session, middleware on `/admin/*` and `/dashboard`)
- Manual `tenant_user` seeding via SQL
- Dashboard shows "no tenant access" message for unmapped users
- RLS via `customData` keyed off `tenant_user.tenant_id` lookup

Not wired:
- Roles (admin/editor/viewer)
- Tenant switcher
- BypassTenant
- Invite flow (Clerk → webhook → `tenant_user` row)
- Self-signup or domain-based auto-assign
- Deprovisioning UI (admin removes a user from tenant)
- Audit log

## Trigger for building

Earliest priority: **invite flow** (Clerk webhook → `tenant_user`). Without it,
adding a real customer means hand-running SQL in Supabase. Anything beyond a
demo client should not require that.

After that: roles + tenant switcher when the first multi-tenant user
materializes (likely during JJW/Sentero internal onboarding).
