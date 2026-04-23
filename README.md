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
├── data/                     Fabric-owned. Git integration syncs notebooks, pipelines,
│                             and semantic models into this folder.
├── infra/                    Bicep/Terraform for Azure + Fabric
├── ARCHITECTURE.md           Multi-tenancy, Lakehouse, RLS, ingestion, capacity decisions
├── README.md                 This file
└── CLAUDE.md                 Context for future Claude sessions
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
- Goals structure — form-entry vs file-upload vs both; table shape; post-MVP. See [docs/product/goals.md](docs/product/goals.md)
- SFTP hosting for prod — dev uses lakehouse `Files/` as drop zone; prod TBD (VM with OpenSSH + BlobFuse vs Azure Storage SFTP)
- AI/ML surfaces — conversational analytics, targeting ML, forecasting, call-log NLP. Future-state, see [docs/product/ai-layer.md](docs/product/ai-layer.md)
- User access flow — invite vs self-signup, roles, tenant switcher, BypassTenant, deprovisioning. See [docs/product/user-access.md](docs/product/user-access.md)
- Tenant variability rules registry — currently hardcoded per fennec's quirks; refactor when tenant #2 lands. See [docs/architecture/tenant-variability.md](docs/architecture/tenant-variability.md)

## What not to repeat from fennec

Tracked in `ARCHITECTURE.md` §9. TL;DR: no hardcoded IDs, incremental-first ingest, retry on every pipeline activity, bridge tables instead of semicolon-delimited strings, tests before merge.
