# Throughline *(placeholder name — rename before launch)*

Commercial analytics SaaS for life sciences. A JJW Consulting + Sentero Pharma joint venture.

> **Name note:** "Throughline" is a working codename. The real brand hasn't been chosen. To rename: global find/replace `throughline` → `<newname>` (and `@throughline/` → `@<newname>/`) across the repo, then rename the root directory.

## What this is

A multi-tenant SaaS that ingests life-sciences commercial data (Veeva Vault + SFTP/email file drops + eventually HubSpot and others), transforms it in **Microsoft Fabric**, and surfaces it through embedded Power BI reports and a Next.js app. The app also hosts user-editable mapping tables, custom groupings, and admin.

## Layout

```
throughline/
├── apps/
│   └── web/                  Next.js 16 app (marketing + auth'd app shell + Power BI embed)
├── packages/
│   └── shared/               TS types + Zod schemas shared across apps
├── data/
│   ├── fabric/
│   │   ├── notebooks/        PySpark notebooks (ingest, transforms)
│   │   └── pipelines/        Fabric pipeline JSON definitions
│   ├── semantic/             Power BI semantic models (.tmdl)
│   └── accelerators/         Source connectors
│       ├── veeva/            Veeva Vault Direct Data (hardened from fennec)
│       ├── sftp/             SFTP drop ingest
│       ├── email/            Email attachment ingest
│       └── hubspot/          (future)
└── infra/                    Bicep/Terraform for Azure + Fabric
```

## Getting started

```bash
pnpm install
pnpm dev              # starts apps/web on :3000
```

Requires Node 20+ and pnpm 9+.

## Architecture decisions (locked in)

- **Data plane:** Microsoft Fabric, single workspace, multi-tenant via `tenant_id` column + Power BI RLS
- **Web:** Next.js 16 + TypeScript + Tailwind v4
- **Auth:** Clerk for MVP → Entra/Azure AD B2B when first enterprise pharma asks
- **App DB:** Postgres (Supabase or Azure Postgres Flex) — app state only, analytics stays in Fabric
- **Power BI embed:** app-owns-data via service principal, RLS per user via `EffectiveIdentity`
- **Billing:** Stripe (self-serve tiers); enterprise = annual MSA separate

## Still open

- Product name (current placeholder: Throughline)
- Fabric SKU sizing (depends on first-customer data volume + embed concurrency)
- Mapping-table UI framework (TanStack Table + React Hook Form + Zod is the likely stack)
- CI provider (GitHub Actions assumed)

## What not to repeat from fennec

Tracked in `CLAUDE.md`. TL;DR: no hardcoded workspace/lakehouse/territory IDs, no single-tenant shortcuts, enable incremental ingest from day one, add CI/CD, write tests.
