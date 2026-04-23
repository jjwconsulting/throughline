# Tenant variability — patterns and current handling

Multi-tenant data products live or die on how they handle tenant-specific
quirks without forking the codebase per customer. This doc inventories the
kinds of variability we've observed (concretely, in fennec's Veeva data),
how they're handled today, and what the eventual config-driven shape looks
like.

Update this when you discover a new variability surface.

## The four categories

### 1. Field name mapping (column-level)

**Example.** `silver.hcp.tier` is sourced from `fen_hcp_tier__c` in fennec's
Veeva, but would be `acme_hcp_tier__c` in a different client's vault. Same
canonical silver column, different bronze field per tenant.

**Current handling.** Fully config-driven via `config.tenant_source_field_map`.
Per-tenant per-source rows say "for this silver column, read from this bronze
column." No code changes needed when a new tenant lands; just insert field-map
rows.

**Status.** Solved. Pattern proven across 8 silver entities.

---

### 2. Picklist value labels

**Example.** Veeva picklist code `ho__c` translates to "Hematology/Oncology"
in fennec's Vault, but a different client could customize the label to
"Hem/Onc" or even use a different code entirely.

**Current handling.** `silver.picklist` is built from each tenant's own
`bronze_<slug>.veeva_pl_picklist__sys` table. No per-tenant config — every
tenant ships their own picklist definitions inside their Direct Data export.
Silver builds JOIN to silver.picklist for code → label translation with
COALESCE fallback to raw code.

**Status.** Solved. Bronze-driven, no config layer needed.

---

### 3. Field semantics drift (which field carries the meaning)

**Example.** Fennec's `isactive__v` on `user__sys` is universally `'false'` —
they actually drive user lifecycle off `status__v` ('Active' / 'Inactive').
Other Veeva customers use `isactive__v` normally. Same field, different
semantic per org.

**Why it's gnarly.** Both fields exist in bronze. Both flow to silver. The
question is which one to *believe* for a given concept (active/inactive,
HCP-vs-HCO discriminator, primary territory, etc.). The answer varies per
tenant.

**Current handling.** Hardcoded in silver build notebooks with a comment
noting the tenant-specific assumption. Examples in current code:

- `silver_user_build.Notebook` — verification SQL filters on `LOWER(status) = 'active'` per fennec's convention; comment notes other tenants may use `isactive__v`
- `silver_hcp_build.Notebook` — `SOURCE_RULES["veeva"]["filter"] = "ispersonaccount__v = 'true'"` per Veeva CDM standard; works for all Veeva tenants but fragile for other source systems

**Future shape.** A `config.tenant_silver_rules` table:

```
tenant_id, source_system, silver_table, rule_type, rule_definition (JSON)
```

Rule types like `discriminator`, `active_flag_field`, `dedup_key`, `dedup_order`.
Notebooks read these and substitute into SQL generation. Code defaults apply when
no override exists.

**Status.** Deferred. See "Decision" section below.

---

### 4. Entity-level business rules (derived attributes)

**Example.** Fennec encodes team type (`SAM` / `KAD` / `ALL`) in territory
`description__v` text via substring patterns. Other clients might:

- Have a dedicated `team__v` field on territory
- Encode team in territory naming convention (e.g., prefix `SLS-` / `MED-`)
- Run separate territory hierarchies per team
- Not track team type at all

**Why it's gnarly.** This is computed *business logic* on the silver build,
not just a field lookup. Different tenants want different DAX/SQL. Hard to
config-drive without a real expression language.

**Current handling.** Hardcoded in `silver_territory_build.Notebook`:

```python
TEAM_ROLE_RULES: dict[str, list[tuple[str, str]]] = {
    "veeva": [
        ("%SAM%", "SAM"),
        ("%KAD%", "KAD"),
    ],
}
TEAM_ROLE_DEFAULT = "ALL"
```

A clear comment marks it as fennec-specific.

**Future shape.** Same `config.tenant_silver_rules` table from category 3.
`rule_type = 'derived_column'` with a definition like:

```json
{
  "target_silver_column": "team_role",
  "source_silver_column": "description",
  "rules": [
    {"pattern": "%SAM%", "value": "SAM"},
    {"pattern": "%KAD%", "value": "KAD"}
  ],
  "default": "ALL",
  "match_mode": "ilike"
}
```

Notebook walks the rule list and emits CASE WHEN SQL. Common patterns
(substring match, regex, lookup) handled declaratively. Anything more
complex stays in code with a comment.

**Status.** Deferred.

---

## Decision: deferred until tenant #2

We have one tenant. Building the rules registry now optimizes for imagined
needs of tenants #2 and #3 — and the patterns we'd guess at are likely wrong
because we don't know their actual quirks yet.

**The "right" abstraction emerges when you have two concrete cases that
conflict.** With one tenant, we'd ship abstractions that fit fennec's quirks
exactly and break for everyone else.

### Plan

1. **Keep current hardcoded approach** for fennec. Each spot has an inline
   comment marking it as tenant-specific.
2. **This document is the spec** for the future registry — when tenant #2
   lands, design the registry against fennec + tenant #2's actual rules.
3. **Resist refactoring** until that second tenant exists.

### Cost of deferral

When the registry lands, we'll have ~5-10 places to refactor (one per silver
build that has hardcoded rules). Each is a small, mechanical change. Total
refactor effort: ~half a day. Cheap insurance against wrong abstractions
today.

### Cost of premature abstraction

Building the registry now would take ~2-3 days. If we get it wrong, we waste
that work plus pay the refactor cost later. Not building it costs nothing
until tenant #2.

---

## Inventory of current hardcoded tenant assumptions

When the registry lands, refactor these:

| File | Variable / location | Tenant assumption |
|---|---|---|
| `data/silver_hcp_build.Notebook/notebook-content.py` | `SOURCE_RULES["veeva"]["filter"]` | HCP discriminator: `ispersonaccount__v = 'true'` |
| `data/silver_hco_build.Notebook/notebook-content.py` | `SOURCE_RULES["veeva"]["filter"]` | HCO discriminator: `ispersonaccount__v = 'false'` |
| `data/silver_user_build.Notebook/notebook-content.py` | Verification SQL | Active determined by `status` not `isactive__v` (fennec-specific) |
| `data/silver_territory_build.Notebook/notebook-content.py` | `TEAM_ROLE_RULES` dict | Team derivation by description substring (fennec-specific) |
| `data/silver_account_territory_build.Notebook/notebook-content.py` | `picklist__sys` object filter `'account_territory__v'` | Veeva-naming assumption |
| `data/silver_user_territory_build.Notebook/notebook-content.py` | `picklist__sys` object filter `'user_territory__v'` | Veeva-naming assumption |
| `data/silver_call_build.Notebook/notebook-content.py` | `PICKLIST_SILVER_COLUMNS` set | Which columns to attempt picklist translation for (Veeva-specific picklist usage) |

This is the surface area. ~7 places, all small scoped changes.

---

## Adding a new tenant today (without the registry)

Until the registry exists, new tenants follow this checklist:

1. **Create tenant** via web admin (`/admin/tenants`)
2. **Configure integration** — add row to `tenant_veeva` or `tenant_sftp`
3. **Run bronze ingest** — fills `bronze_<slug>.*`
4. **Inspect bronze schema** — DESCRIBE the relevant tables; identify which
   fields are populated, what naming conventions are used, what picklist
   values exist, what custom fields are present
5. **Seed field map** — write a `seed-<source>-<entity>-field-map.sql` script
   (one per silver entity), pointing this tenant's bronze columns at the
   canonical silver columns
6. **Verify hardcoded assumptions hold** — for each item in the inventory
   above, confirm the assumption applies. If not, edit the silver build
   notebook to handle the new tenant's variant.
7. **Run config_sync + silver builds + gold builds**

When the registry lands, steps 5 and 6 collapse into "insert rows into
`tenant_source_field_map` and `tenant_silver_rules`."
