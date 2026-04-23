// Per-user RLS scope resolution. See docs/architecture/rls.md.
//
// Pulls the logged-in user's role + Veeva user_key mapping from
// Postgres tenant_user, then for managers expands to the set of reps
// reporting to them via gold.dim_user.manager_id.

import { currentUser } from "@clerk/nextjs/server";
import { eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import type { Scope as SqlScope } from "@/lib/interactions";

export type UserScope =
  | { tenantId: string; role: "admin" }
  | { tenantId: string; role: "bypass" }
  | { tenantId: string; role: "manager"; userKeys: string[] }
  | { tenantId: string; role: "rep"; userKey: string };

export type ScopeResolution =
  | { ok: true; scope: UserScope }
  | { ok: false; reason: "no_tenant_user" | "rep_missing_user_key" | "manager_no_team" };

export async function resolveUserScope(
  userEmail: string,
): Promise<ScopeResolution> {
  const rows = await db
    .select({
      tenantId: schema.tenantUser.tenantId,
      role: schema.tenantUser.role,
      veevaUserKey: schema.tenantUser.veevaUserKey,
    })
    .from(schema.tenantUser)
    .where(eq(schema.tenantUser.userEmail, userEmail))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "no_tenant_user" };

  switch (row.role) {
    case "admin":
    case "bypass":
      return {
        ok: true,
        scope: { tenantId: row.tenantId, role: row.role },
      };
    case "rep": {
      if (!row.veevaUserKey) {
        return { ok: false, reason: "rep_missing_user_key" };
      }
      return {
        ok: true,
        scope: {
          tenantId: row.tenantId,
          role: "rep",
          userKey: row.veevaUserKey,
        },
      };
    }
    case "manager": {
      if (!row.veevaUserKey) {
        // Manager with no veeva mapping means we can't resolve their team —
        // fall back to admin-style "see everything in tenant" rather than
        // empty scope. Better to surface in the UI as "Manager (no team set)"
        // and let admin fix the mapping.
        return { ok: false, reason: "manager_no_team" };
      }
      const userKeys = await loadManagerTeam(
        row.tenantId,
        row.veevaUserKey,
      );
      return {
        ok: true,
        scope: {
          tenantId: row.tenantId,
          role: "manager",
          userKeys,
        },
      };
    }
  }
}

// Recursive walk through gold.dim_user.manager_id. Capped at 5 levels deep
// to prevent runaway recursion if data has cycles.
async function loadManagerTeam(
  tenantId: string,
  managerUserKey: string,
): Promise<string[]> {
  const rows = await queryFabric<{ user_key: string }>(
    tenantId,
    `WITH team AS (
       SELECT user_key, manager_id, 0 AS depth
       FROM gold.dim_user
       WHERE tenant_id = @tenantId AND user_key = @managerUserKey
       UNION ALL
       SELECT u.user_key, u.manager_id, t.depth + 1
       FROM gold.dim_user u
       JOIN team t ON u.manager_id = t.user_key
       WHERE u.tenant_id = @tenantId AND t.depth < 5
     )
     SELECT user_key FROM team WHERE user_key <> @managerUserKey`,
    { managerUserKey },
  );
  return rows.map((r) => r.user_key);
}

// Convert a UserScope into the SQL clause shape that interactions.ts expects.
// Empty clauses for admin/bypass = no extra filtering.
export function scopeToSql(scope: UserScope): SqlScope {
  switch (scope.role) {
    case "admin":
    case "bypass":
      return { clauses: [], params: {} };
    case "rep":
      return {
        clauses: ["AND f.owner_user_key = @rlsUserKey"],
        params: { rlsUserKey: scope.userKey },
      };
    case "manager": {
      // Inline the user_keys as a literal IN list. Each is a UUID-ish
      // string from gold.dim_user.user_key — we sanitize defensively.
      // Empty team = match nothing (rep with no reports sees nothing).
      if (scope.userKeys.length === 0) {
        return { clauses: ["AND 1 = 0"], params: {} };
      }
      const sanitized = scope.userKeys.map((k) =>
        `'${k.replace(/'/g, "''")}'`,
      );
      return {
        clauses: [`AND f.owner_user_key IN (${sanitized.join(",")})`],
        params: {},
      };
    }
  }
}

// Used in admin UI to show what a non-admin sees. Friendly description.
export function scopeLabel(scope: UserScope): string {
  switch (scope.role) {
    case "admin":
      return "Admin · all reps";
    case "bypass":
      return "Internal · all reps";
    case "rep":
      return "Rep · self only";
    case "manager":
      return `Manager · ${scope.userKeys.length} report${scope.userKeys.length === 1 ? "" : "s"}`;
  }
}

export function combineScopes(...scopes: SqlScope[]): SqlScope {
  return {
    clauses: scopes.flatMap((s) => s.clauses),
    params: Object.assign({}, ...scopes.map((s) => s.params)),
  };
}

// Convenience: resolves the logged-in Clerk user's email and looks up
// their tenant + RLS scope. Returns null email if not signed in (middleware
// should already have caught this for routes under (app)). Returns the
// resolution shape so callers can render appropriate "no access" UI.
export async function getCurrentScope(): Promise<{
  userEmail: string | null;
  resolution: ScopeResolution | null;
}> {
  const user = await currentUser();
  const userEmail =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    null;
  if (!userEmail) return { userEmail: null, resolution: null };
  const resolution = await resolveUserScope(userEmail);
  return { userEmail, resolution };
}

// Page-level guard: returns true if a rep with the given user_key is
// visible under this scope.
export function canSeeRep(scope: UserScope, userKey: string): boolean {
  switch (scope.role) {
    case "admin":
    case "bypass":
      return true;
    case "rep":
      return scope.userKey === userKey;
    case "manager":
      return scope.userKeys.includes(userKey);
  }
}
