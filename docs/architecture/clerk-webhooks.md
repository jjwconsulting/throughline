# Clerk webhooks → tenant_user provisioning

The web app exposes `/api/webhooks/clerk` to auto-provision rows in
Postgres `tenant_user` when a Clerk user is created or updated. This
removes the hand-run SQL step from the invite flow.

This is the first piece of the broader user-access flow described in
`docs/product/user-access.md` and the admin/customization roadmap memory.

## The provisioning contract

Clerk passes per-user `public_metadata` through to the webhook payload.
The webhook expects three fields (one required, two optional):

| Field | Required? | Notes |
|---|---|---|
| `tenant_slug` | yes | Looked up against `tenant.slug` in Postgres. Webhook 422s if not found. |
| `role` | no | One of `admin`, `manager`, `rep`, `bypass`. Defaults to `rep`. |
| `veeva_user_key` | conditional | **Required** when `role='rep'` (DB check constraint). The `gold.dim_user.user_key` value. |

If `tenant_slug` is missing, the webhook accepts the event but skips
provisioning. The user lands on the "no access" page on first sign-in.

## Setting up the Clerk webhook

### 1. Generate the signing secret

In the Clerk dashboard:
1. **Webhooks → + Add Endpoint**
2. **Endpoint URL** = `https://<your-public-host>/api/webhooks/clerk`
3. **Subscribed events** = `user.created`, `user.updated`
4. After creation, click the endpoint and copy the **Signing Secret**
5. Set `CLERK_WEBHOOK_SECRET=whsec_...` in `apps/web/.env.local`

### 2. Local development

Clerk needs to reach your `localhost`. Two options:

**Option A — `cloudflared` (recommended; free, no account needed):**
```bash
cloudflared tunnel --url http://localhost:3000
```
Copy the printed `https://*.trycloudflare.com` URL. Use it as the
endpoint URL in step 1 above. Leave the tunnel running while you test.

**Option B — `ngrok`:**
```bash
ngrok http 3000
```
Same idea — paste the public URL into Clerk.

**Option C — Clerk's CLI** (if available in your Clerk plan): runs a
managed tunnel. Check Clerk docs for the latest command.

### 3. Inviting a user (the happy path)

In the Clerk dashboard:
1. **Users → + Invite** (or **+ Create user** for direct creation)
2. Enter the email
3. Expand **Public metadata** and paste:
   ```json
   {
     "tenant_slug": "fennecpharma",
     "role": "rep",
     "veeva_user_key": "<their gold.dim_user.user_key>"
   }
   ```
4. Send the invite

When the user signs up, Clerk fires `user.created` → our webhook reads
the metadata → inserts a `tenant_user` row with the right scope. No
manual SQL needed.

For an admin (no Veeva mapping required):
```json
{ "tenant_slug": "fennecpharma", "role": "admin" }
```

## Idempotency

The webhook uses `INSERT ... ON CONFLICT (tenant_id, user_email) DO UPDATE`
so retries from Clerk (or repeated metadata edits) are safe. Each call
also lands an updated `updatedAt` for audit.

## What the webhook does NOT do (yet)

- **No user.deleted handling.** Deactivating in Clerk doesn't remove the
  `tenant_user` row. Add when we want clean off-boarding.
- **No bulk provisioning.** One user per webhook event. For seeding a
  whole org, still hand-run SQL.
- **No invite email customization.** Clerk sends the default invite. When
  we want branded invites, do it via Clerk's email template settings or
  switch to a custom invite flow.
- **No admin UI for setting metadata.** Today admins paste JSON in the
  Clerk dashboard. Building an in-app admin invite form is the obvious
  next step (see the customization roadmap memory).
- **No audit log.** Webhook outcomes log to stdout only. Promote to a
  Postgres `audit.tenant_user_event` table when we have compliance
  conversations.

## Production deployment

When we deploy the web app:
1. Re-create the Clerk webhook endpoint pointing at the prod URL
2. Set `CLERK_WEBHOOK_SECRET` in the prod env
3. Don't reuse the dev signing secret in prod

## Diagnosing failed webhooks

Clerk dashboard → Webhooks → endpoint → **Message Attempts** shows the
HTTP status of every delivery. Common failures:

- `401 — Webhook signature verification failed` → wrong
  `CLERK_WEBHOOK_SECRET` or the body was modified in transit
- `422 — tenant_not_found` → `tenant_slug` in metadata doesn't match a
  row in `tenant.slug`
- `422 — rep_role_needs_veeva_user_key` → role='rep' set without
  `veeva_user_key`. Either set the user key or change role.
- `200 — { skipped: "no_tenant_slug" }` → metadata missing; user can
  sign in but won't have access until an admin sets it
