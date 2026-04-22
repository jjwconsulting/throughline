import { currentUser } from "@clerk/nextjs/server";
import { eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { getReportEmbedConfig } from "@/lib/powerbi";
import EmbeddedReport from "./embed";

export const dynamic = "force-dynamic";

const stats = [
  { label: "HCP reach (30d)", value: "—" },
  { label: "Call attainment", value: "—" },
  { label: "Ex-factory demand (QTD)", value: "—" },
];

async function tenantIdForUser(email: string | null): Promise<string | null> {
  if (!email) return null;
  const rows = await db
    .select({ tenantId: schema.tenantUser.tenantId })
    .from(schema.tenantUser)
    .where(eq(schema.tenantUser.userEmail, email))
    .limit(1);
  return rows[0]?.tenantId ?? null;
}

export default async function Dashboard() {
  const user = await currentUser();
  const userEmail =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    null;

  const tenantId = await tenantIdForUser(userEmail);

  const embed = await getReportEmbedConfig(tenantId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Dashboard</h1>
        <p className="text-[var(--color-ink-muted)]">
          Embedded Power BI report from Fabric.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5"
          >
            <p className="text-sm text-[var(--color-ink-muted)]">{s.label}</p>
            <p className="font-display text-3xl mt-2">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 overflow-hidden">
        <EmbeddedReport
          reportId={embed.reportId}
          embedUrl={embed.embedUrl}
          embedToken={embed.embedToken}
        />
      </div>
    </div>
  );
}
