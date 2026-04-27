// Fixture data + the 6 screens composed with Primitives / Nav / Panels.
const TREND = [
  { label: "Jan 06", calls: 340 },
  { label: "Jan 13", calls: 388 },
  { label: "Jan 20", calls: 412 },
  { label: "Jan 27", calls: 366 },
  { label: "Feb 03", calls: 444 },
  { label: "Feb 10", calls: 502 },
  { label: "Feb 17", calls: 478 },
  { label: "Feb 24", calls: 520 },
  { label: "Mar 03", calls: 564 },
  { label: "Mar 10", calls: 601 },
  { label: "Mar 17", calls: 572 },
  { label: "Mar 24", calls: 632 },
];

const TOP_REPS = [
  { user_key: "u_riv", name: "Elena Rivera", calls: 312 },
  { user_key: "u_chn", name: "David Chen", calls: 284 },
  { user_key: "u_oko", name: "Nneka Okafor", calls: 261 },
  { user_key: "u_mor", name: "Sarah Morgan", calls: 234 },
  { user_key: "u_bks", name: "Liam Brooks", calls: 219 },
];

const TOP_HCPS = [
  { hcp_key: "h_tran",  name: "Dr. Alicia Tran",       specialty: "Cardiology",  calls: 48 },
  { hcp_key: "h_oye",   name: "Dr. Marcus Oyelaran",   specialty: "Hematology",  calls: 41 },
  { hcp_key: "h_nar",   name: "Dr. Priya Narayan",     specialty: "Oncology",    calls: 37 },
  { hcp_key: "h_kim",   name: "Dr. Jae-Won Kim",       specialty: "Rheumatology",calls: 33 },
  { hcp_key: "h_sil",   name: "Dr. Rafael Silva",      specialty: "Neurology",   calls: 29 },
];

const INACTIVITY = [
  { severity: "alert",   title: "Dr. Alicia Tran — 78 days since last call", detail: "Cardiology · Tier A · Boston, MA", onClick: null },
  { severity: "warning", title: "Dr. Marcus Oyelaran — 64 days since last call", detail: "Hematology · Tier B · Austin, TX" },
  { severity: "warning", title: "Dr. Rafael Silva — 61 days since last call", detail: "Neurology · Tier B · Philadelphia, PA" },
];

const COVERAGE_GAPS = [
  { severity: "info", title: "West Texas territory — 3 Tier-A HCPs unassigned", detail: "Was covered by K. Delgado (departed Feb 2)" },
];

// ---------------- Screens ----------------

function Landing({ go, brand = "Throughline" }) {
  return (
    <main style={{
      minHeight: "calc(100vh - 56px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "0 24px",
    }}>
      <div style={{ maxWidth: 640 }}>
        <p style={{
          fontSize: 14,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-accent)",
          marginBottom: 16,
          margin: 0,
        }}>{brand} &middot; working name</p>
        <h1 style={{
          fontFamily: "var(--font-display)",
          fontSize: 60,
          lineHeight: 1.1,
          margin: "16px 0 24px",
          fontWeight: 400,
        }}>Commercial analytics for life sciences.</h1>
        <p style={{
          fontSize: 18,
          color: "var(--color-ink-muted)",
          marginBottom: 32,
          margin: "0 0 32px",
          lineHeight: 1.5,
        }}>Unified field, sales, and engagement data — delivered through embedded Power BI, backed by Microsoft Fabric, configured in minutes.</p>
        <PrimaryButton onClick={() => go("dashboard")}>Enter demo</PrimaryButton>
      </div>
    </main>
  );
}

function Dashboard({ go, state, setState }) {
  const { range, channel, account } = state;
  const kpis = [
    { label: `${account === "hco" ? "HCO" : account === "hcp" ? "HCP" : ""} Interactions (last 30 days)`.trim(), value: "5,214", delta: "+12% vs prior period" },
    { label: account === "hco" ? "HCOs reached (last 30 days)" : "HCPs reached (last 30 days)", value: account === "hco" ? "412" : "1,246", delta: null },
    { label: "Active reps (last 30 days)", value: "68", delta: null },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Dashboard</h1>
          <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>Live from gold tables. Filters apply to all panels below.</p>
        </div>
        <FilterBar
          range={range} channel={channel}
          onRange={(v) => setState({ ...state, range: v })}
          onChannel={(v) => setState({ ...state, channel: v })}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <AccountToggle value={account} onChange={(v) => setState({ ...state, account: v })} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {kpis.map(k => <KpiCard key={k.label} {...k} />)}
        </div>
      </div>

      <Card>
        <CardHeader title="Calls per week" subtitle="12 most recent weeks" />
        <div style={{ padding: "16px 8px" }}>
          <TrendChart data={TREND} height={240} />
        </div>
      </Card>

      <SignalsPanel
        title="HCPs to re-engage"
        subtitle="Engaged previously, no contact in the last 60 days"
        signals={INACTIVITY.map(s => ({ ...s, onClick: () => go("hcp") }))}
        emptyHint="No lapsed HCPs in your scope."
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <CardHeader title="Top reps" subtitle="By calls in last 30 days" />
          <DataTable
            columns={[
              { key: "i", label: "#", width: 40, muted: true, render: (_, i) => i + 1 },
              { key: "name", label: "Rep", render: (r) => (
                <a onClick={() => go("rep")} style={{ color: "var(--color-primary)", cursor: "pointer" }}>{r.name}</a>
              )},
              { key: "calls", label: "Calls", align: "right", mono: true, render: (r) => r.calls.toLocaleString() },
            ]}
            rows={TOP_REPS}
          />
        </Card>
        <Card>
          <CardHeader title={account === "hco" ? "Top HCOs" : "Top HCPs"} subtitle="By calls in last 30 days" />
          <DataTable
            columns={[
              { key: "i", label: "#", width: 40, muted: true, render: (_, i) => i + 1 },
              { key: "name", label: "HCP", render: (r) => (
                <a onClick={() => go("hcp")} style={{ color: "var(--color-primary)", cursor: "pointer" }}>{r.name}</a>
              )},
              { key: "specialty", label: "Specialty", muted: true },
              { key: "calls", label: "Calls", align: "right", mono: true },
            ]}
            rows={TOP_HCPS}
          />
        </Card>
      </div>

      <Card style={{ padding: 16 }}>
        <div style={{
          height: 260, background: "var(--color-surface-alt)",
          border: "1px dashed var(--color-border)", borderRadius: 6,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--color-ink-muted)", fontSize: 13,
        }}>
          Power BI report embeds here · app-owns-data via service principal
        </div>
      </Card>
    </div>
  );
}

function Inbox({ go }) {
  const all = [
    { key: "inactive", title: "HCPs to re-engage", subtitle: "Engaged previously, no contact in 60+ days", signals: INACTIVITY.map(s => ({ ...s, onClick: () => go("hcp") })) },
    { key: "coverage", title: "Coverage gaps", subtitle: "Territories with unassigned or low-touch accounts", signals: COVERAGE_GAPS },
  ];
  const total = all.reduce((n, g) => n + g.signals.length, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Inbox</h1>
        <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>
          Signals across your scope. {total} items need attention.
        </p>
      </div>
      <Briefing text="Three HCPs in your Tier-A coverage have not been called in 60+ days, concentrated in the Northeast. Call volume is up 12% vs prior period; top performers are Rivera and Chen. One territory (West Texas) lost its rep in early February and has no coverage assignments." />
      {all.map(g => <SignalsPanel key={g.key} {...g} emptyHint="Nothing in this category." />)}
    </div>
  );
}

function HcpDetail({ go, state, setState }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <a onClick={() => go("dashboard")} style={{ fontSize: 12, color: "var(--color-ink-muted)", cursor: "pointer" }}>← Dashboard</a>
        <div style={{ marginTop: 8, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Dr. Alicia Tran</h1>
            <p style={{ color: "var(--color-ink-muted)", fontSize: 14, margin: "4px 0 0" }}>
              MD • Cardiology • Boston, MA • <span style={{ fontFamily: "var(--font-mono)" }}>NPI 1487693012</span>
            </p>
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Chip variant="accent">Tier A</Chip>
              <Chip>Prescriber</Chip>
              <Chip>KOL</Chip>
              <Chip>Speaker</Chip>
            </div>
          </div>
          <FilterBar
            range={state.range} channel={state.channel}
            onRange={(v) => setState({ ...state, range: v })}
            onChannel={(v) => setState({ ...state, channel: v })}
          />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        <KpiCard label="Interactions (last 30 days)" value="12" delta="-18% vs prior period" />
        <KpiCard label="Reps engaged (last 30 days)" value="3" />
        <KpiCard label="Last contact" value="78 days ago" delta="Feb 4, 2026" />
      </div>

      <Card>
        <CardHeader title="Calls per week" subtitle="12 most recent weeks for Dr. Alicia Tran" />
        <div style={{ padding: "16px 8px" }}>
          <TrendChart data={TREND.map((d, i) => ({ ...d, calls: Math.round(d.calls / 30) + (i % 3) }))} height={220} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Reps who've called" subtitle="By calls in last 30 days" />
        <DataTable
          columns={[
            { key: "i", label: "#", width: 40, muted: true, render: (_, i) => i + 1 },
            { key: "name", label: "Rep", render: (r) => (
              <a onClick={() => go("rep")} style={{ color: "var(--color-primary)", cursor: "pointer" }}>{r.name}</a>
            )},
            { key: "title", label: "Title", muted: true },
            { key: "last", label: "Last call", muted: true },
            { key: "calls", label: "Calls", align: "right", mono: true },
          ]}
          rows={[
            { name: "Elena Rivera", title: "Sr. Field Rep", last: "Feb 4, 2026", calls: 8 },
            { name: "David Chen",   title: "Field Rep",      last: "Jan 22, 2026", calls: 3 },
            { name: "Liam Brooks",  title: "Field Rep",      last: "Jan 9, 2026",  calls: 1 },
          ]}
        />
      </Card>
    </div>
  );
}

function RepDetail({ go, state, setState }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <a onClick={() => go("dashboard")} style={{ fontSize: 12, color: "var(--color-ink-muted)", cursor: "pointer" }}>← Dashboard</a>
        <div style={{ marginTop: 8, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Elena Rivera</h1>
            <p style={{ color: "var(--color-ink-muted)", fontSize: 14, margin: "4px 0 0" }}>
              Sr. Field Rep • Field Sales • Field
            </p>
          </div>
          <FilterBar
            range={state.range} channel={state.channel}
            onRange={(v) => setState({ ...state, range: v })}
            onChannel={(v) => setState({ ...state, channel: v })}
          />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <AccountToggle value={state.account} onChange={(v) => setState({ ...state, account: v })} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          <KpiCard label="Interactions (last 30 days)" value="312" delta="+8% vs prior period" />
          <KpiCard label="HCPs reached (last 30 days)" value="94" />
          <KpiCard label="Last call" value="Yesterday" delta="Apr 22, 2026" />
        </div>
      </div>

      <Card>
        <CardHeader title="Calls per week" subtitle="12 most recent weeks for Elena Rivera" />
        <div style={{ padding: "16px 8px" }}>
          <TrendChart data={TREND} height={220} />
        </div>
      </Card>

      <SignalsPanel
        title="HCPs to re-engage"
        subtitle="Elena's engaged HCPs with no contact in 60+ days"
        signals={[INACTIVITY[1]]}
        emptyHint="No lapsed HCPs in this rep's coverage."
      />

      <Card>
        <CardHeader title="Top HCPs called" subtitle="By calls in last 30 days" />
        <DataTable
          columns={[
            { key: "i", label: "#", width: 40, muted: true, render: (_, i) => i + 1 },
            { key: "name", label: "HCP", render: (r) => (
              <a onClick={() => go("hcp")} style={{ color: "var(--color-primary)", cursor: "pointer" }}>{r.name}</a>
            )},
            { key: "specialty", label: "Specialty", muted: true },
            { key: "calls", label: "Calls", align: "right", mono: true },
          ]}
          rows={TOP_HCPS}
        />
      </Card>
    </div>
  );
}

function AdminTenants() {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Tenants</h1>
        <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>
          Each tenant gets its own bronze schema in Fabric. Shared silver + gold filter by tenant_id.
        </p>
      </div>

      <Card style={{ padding: 24 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, margin: "0 0 16px", fontWeight: 400 }}>Create tenant</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <TextField label="Slug" value={slug} onChange={setSlug} placeholder="acme-pharma" mono />
          <TextField label="Name" value={name} onChange={setName} placeholder="Acme Pharma, Inc." />
        </div>
        <PrimaryButton>Create tenant</PrimaryButton>
      </Card>

      <Card style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse", fontFamily: "var(--font-body)" }}>
          <thead style={{ background: "var(--color-surface-alt)", color: "var(--color-ink-muted)" }}>
            <tr>
              <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 400 }}>Slug</th>
              <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 400 }}>Name</th>
              <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 400 }}>Status</th>
              <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 400 }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {[
              { slug: "fennec", name: "Fennec Biosciences", status: "active", created: "2025-11-14" },
              { slug: "acme-pharma", name: "Acme Pharma, Inc.", status: "onboarding", created: "2026-03-02" },
            ].map(t => (
              <tr key={t.slug} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "10px 16px", fontFamily: "var(--font-mono)" }}>{t.slug}</td>
                <td style={{ padding: "10px 16px" }}>{t.name}</td>
                <td style={{ padding: "10px 16px" }}><Chip variant={t.status === "active" ? "accent" : "neutral"}>{t.status}</Chip></td>
                <td style={{ padding: "10px 16px", color: "var(--color-ink-muted)" }}>{t.created}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------------- Admin sub-pages ----------------

function AdminUsers() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Users</h1>
        <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>
          Invite users with their tenant + role pre-set. Clerk sends the email; the webhook provisions a tenant_user row when they accept.
        </p>
      </div>

      <Card>
        <CardHeader title="Invite from Veeva" subtitle="Active field reps from gold.dim_user for Fennec Biosciences. 2 already provisioned, 4 to go." />
        <DataTable
          columns={[
            { key: "name", label: "Rep" },
            { key: "email", label: "Email", muted: true },
            { key: "status", label: "Status", render: (r) => (
              r.status === "provisioned"
                ? <Chip variant="accent">provisioned</Chip>
                : <Chip>not invited</Chip>
            )},
            { key: "action", label: "Action", render: (r) => (
              r.status === "provisioned"
                ? <span style={{ color: "var(--color-ink-muted)", fontSize: 13 }}>—</span>
                : <a style={{ color: "var(--color-primary)", cursor: "pointer", fontSize: 13 }}>Send invite</a>
            )},
          ]}
          rows={[
            { name: "Elena Rivera",   email: "elena.rivera@fennec.bio",  status: "provisioned" },
            { name: "David Chen",     email: "david.chen@fennec.bio",    status: "provisioned" },
            { name: "Nneka Okafor",   email: "nneka.okafor@fennec.bio",  status: "not invited" },
            { name: "Sarah Morgan",   email: "sarah.morgan@fennec.bio",  status: "not invited" },
            { name: "Liam Brooks",    email: "liam.brooks@fennec.bio",   status: "not invited" },
            { name: "Priya Nair",     email: "priya.nair@fennec.bio",    status: "not invited" },
          ]}
        />
      </Card>

      <Card style={{ padding: 20 }}>
        <details>
          <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>Manual invite</span>
            <span style={{ fontSize: 12, color: "var(--color-ink-muted)" }}>For admins, managers, or reps without a Veeva email</span>
          </summary>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, alignItems: "end" }}>
            <TextField label="Email" value="" onChange={() => {}} placeholder="someone@company.com" />
            <Select label="Role" value="manager" onChange={() => {}} options={[
              ["admin", "Admin"], ["manager", "Manager"], ["rep", "Rep"],
            ]} />
            <PrimaryButton>Send invite</PrimaryButton>
          </div>
        </details>
      </Card>

      <Card>
        <CardHeader title="Provisioned users" subtitle="Rows in tenant_user. Created by the webhook on user creation/update." />
        <DataTable
          columns={[
            { key: "email", label: "Email" },
            { key: "tenant", label: "Tenant", muted: true },
            { key: "role", label: "Role" },
            { key: "veeva", label: "Veeva user_key", mono: true, muted: true },
            { key: "updated", label: "Updated", muted: true },
          ]}
          rows={[
            { email: "jw@throughline.io",       tenant: "Fennec Biosciences", role: "admin",   veeva: "—",                  updated: "2026-04-22" },
            { email: "elena.rivera@fennec.bio", tenant: "Fennec Biosciences", role: "rep",     veeva: "v_user_4f81a",       updated: "2026-04-12" },
            { email: "david.chen@fennec.bio",   tenant: "Fennec Biosciences", role: "rep",     veeva: "v_user_9a02c",       updated: "2026-04-02" },
            { email: "anna.koh@fennec.bio",     tenant: "Fennec Biosciences", role: "manager", veeva: "—",                  updated: "2026-03-19" },
          ]}
        />
      </Card>
    </div>
  );
}

function AdminMappings() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Mappings</h1>
        <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>
          Map distributor account IDs to Veeva accounts so sales rows resolve to the right HCP/HCO and roll up by territory.
        </p>
      </div>

      <Card style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Bulk upload via CSV</p>
            <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: "2px 0 0" }}>
              distributor_account_id, veeva_account_key — header row required.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={ghostBtn}>Download template</button>
            <PrimaryButton>Upload CSV</PrimaryButton>
          </div>
        </div>
      </Card>

      <Card style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Propagate mappings</p>
            <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: "2px 0 0" }}>
              Last run: 2 hours ago · <span style={{ color: "var(--color-positive)" }}>succeeded</span> · 1,284 rows resolved
            </p>
          </div>
          <PrimaryButton>Run pipeline</PrimaryButton>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Needs mapping"
          subtitle="Distributor accounts in sales data without a Veeva mapping yet. Most-active first."
          right={<Chip variant="pill">24 unmapped</Chip>}
        />
        <DataTable
          columns={[
            { key: "id", label: "Distributor ID", mono: true },
            { key: "account", label: "Account" },
            { key: "rows", label: "Rows", align: "right", mono: true },
            { key: "net", label: "Net gross $", align: "right", mono: true },
            { key: "last", label: "Last seen", align: "right", muted: true },
            { key: "action", label: "Action", render: () => (
              <a style={{ color: "var(--color-primary)", cursor: "pointer", fontSize: 13 }}>Map →</a>
            )},
          ]}
          rows={[
            { id: "DST-48172", account: "Cleveland Clinic Heart & Vascular",     rows: "412", net: "188,420",  last: "Apr 22" },
            { id: "DST-39810", account: "Mass General Cardiology Associates",    rows: "318", net: "142,901",  last: "Apr 21" },
            { id: "DST-22045", account: "Hopkins Heme/Onc Clinic",                rows: "284", net: "118,440",  last: "Apr 20" },
            { id: "DST-10277", account: "Stanford Neurology Group",               rows: "201", net: "92,103",   last: "Apr 19" },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Saved mappings" subtitle="1,284 of 1,284 mappings shown" />
        <DataTable
          columns={[
            { key: "id", label: "Distributor ID", mono: true },
            { key: "account", label: "Veeva account" },
            { key: "type", label: "Type", muted: true },
            { key: "by", label: "Mapped by", muted: true },
            { key: "when", label: "When", muted: true },
          ]}
          rows={[
            { id: "DST-99001", account: "Dr. Alicia Tran",     type: "HCP", by: "jw@throughline.io",  when: "Apr 18" },
            { id: "DST-44120", account: "MD Anderson Center",  type: "HCO", by: "jw@throughline.io",  when: "Apr 14" },
            { id: "DST-20912", account: "Dr. Marcus Oyelaran", type: "HCP", by: "anna.koh@fennec.bio", when: "Apr 11" },
          ]}
        />
      </Card>
    </div>
  );
}

function AdminGoals() {
  const [period, setPeriod] = useState("Q2 2026");
  const [metric, setMetric] = useState("calls");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Goals</h1>
        <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>
          Recommendations are pre-filled from historical actuals + peer benchmarks. Adjust the handful you have conviction about, then save.
        </p>
      </div>

      <Card style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
          <Select label="Period type" value="quarter" onChange={() => {}} options={[
            ["quarter", "Quarter"], ["month", "Month"], ["custom", "Custom"],
          ]} />
          <Select label="Period" value={period} onChange={setPeriod} options={[
            ["Q2 2026", "Q2 2026 (Apr 1 – Jun 30)"],
            ["Q3 2026", "Q3 2026 (Jul 1 – Sep 30)"],
            ["Q1 2026", "Q1 2026 (Jan 1 – Mar 31)"],
          ]} />
          <Select label="Metric" value={metric} onChange={setMetric} options={[
            ["calls", "Calls"], ["units", "Units"], ["revenue", "Revenue"],
            ["reach_pct", "Reach %"], ["frequency", "Frequency"],
          ]} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={`${metric === "calls" ? "Call" : metric} goals · ${period}`}
          subtitle="Tab to next field. Save commits all dirty rows."
          right={<PrimaryButton>Save goals</PrimaryButton>}
        />
        <DataTable
          columns={[
            { key: "name", label: "Rep" },
            { key: "title", label: "Title", muted: true },
            { key: "rec", label: "Recommended", align: "right", mono: true },
            { key: "method", label: "Method", muted: true },
            { key: "goal", label: "Goal", align: "right", render: (r) => (
              <input
                defaultValue={r.rec}
                style={{
                  width: 80, textAlign: "right",
                  fontFamily: "var(--font-mono)", fontSize: 14,
                  padding: "4px 8px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                  borderRadius: 4, outline: "none",
                }}
              />
            )},
          ]}
          rows={[
            { name: "Elena Rivera", title: "Sr. Field Rep", rec: 340, method: "trend + peer floor" },
            { name: "David Chen",   title: "Field Rep",     rec: 305, method: "trend + peer floor" },
            { name: "Nneka Okafor", title: "Field Rep",     rec: 282, method: "historical avg" },
            { name: "Sarah Morgan", title: "Field Rep",     rec: 250, method: "peer avg" },
            { name: "Liam Brooks",  title: "Field Rep",     rec: 235, method: "trend + peer floor" },
          ]}
        />
      </Card>

      <Card style={{ padding: 20 }}>
        <p style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px" }}>Bulk edit via CSV</p>
        <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: 0 }}>
          Download current goals, edit in spreadsheet, re-upload. Periods are pinned in the file header.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={ghostBtn}>Download {period} goals</button>
          <button style={ghostBtn}>Upload CSV</button>
        </div>
      </Card>
    </div>
  );
}

function AdminPipelines() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: 0, fontWeight: 400 }}>Pipelines</h1>
        <p style={{ color: "var(--color-ink-muted)", margin: "4px 0 0" }}>
          Health of the data pipelines that keep your dashboards fresh. Global pipelines are managed by ops; tenant-scoped pipelines you trigger from the relevant admin pages.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
        {[
          { kind: "Incremental refresh",  scope: "GLOBAL", desc: "Pulls Veeva incremental updates + new SFTP files, rebuilds silver/gold.", last: "12 min ago", status: "succeeded", lastSuccess: "12 min ago" },
          { kind: "Weekly full refresh",  scope: "GLOBAL", desc: "Full Veeva re-pull + complete rebuild. Catches anything incremental missed.",  last: "3 days ago", status: "succeeded", lastSuccess: "3 days ago" },
          { kind: "Delta maintenance",    scope: "GLOBAL", desc: "Compacts small files (OPTIMIZE) and removes old file versions (VACUUM).",    last: "yesterday",  status: "succeeded", lastSuccess: "yesterday" },
          { kind: "Mapping propagate",    scope: "TENANT", desc: "Propagates Veeva mapping changes through silver_account_xref + gold.fact_sale.", last: "2 hours ago", status: "succeeded", lastSuccess: "2 hours ago" },
        ].map(p => <PipelineSummary key={p.kind} {...p} />)}
      </div>

      <Card>
        <CardHeader title="Recent runs" subtitle="Last 8 runs across all pipelines visible to you." />
        <DataTable
          columns={[
            { key: "kind", label: "Pipeline" },
            { key: "scope", label: "Scope", muted: true },
            { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { key: "started", label: "Started", muted: true },
            { key: "duration", label: "Duration", mono: true, muted: true },
            { key: "by", label: "By", mono: true, muted: true },
            { key: "detail", label: "Detail", muted: true },
          ]}
          rows={[
            { kind: "Incremental refresh", scope: "global", status: "succeeded", started: "12 min ago",  duration: "4m 12s", by: "scheduler",          detail: "1,284 rows" },
            { kind: "Mapping propagate",   scope: "tenant", status: "succeeded", started: "2 hours ago", duration: "1m 3s",  by: "jw@throughline.io",  detail: "—" },
            { kind: "Incremental refresh", scope: "global", status: "succeeded", started: "6 hours ago", duration: "3m 58s", by: "scheduler",          detail: "1,201 rows" },
            { kind: "Incremental refresh", scope: "global", status: "failed",    started: "12 hours ago",duration: "0m 18s", by: "scheduler",          detail: "Veeva API 503" },
            { kind: "Delta maintenance",   scope: "global", status: "succeeded", started: "yesterday",   duration: "12m 4s", by: "scheduler",          detail: "OPTIMIZE 24 tables" },
            { kind: "Weekly full refresh", scope: "global", status: "succeeded", started: "3 days ago",  duration: "47m 2s", by: "scheduler",          detail: "Full rebuild" },
          ]}
        />
      </Card>
    </div>
  );
}

function PipelineSummary({ kind, scope, desc, last, status, lastSuccess }) {
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, margin: 0, fontWeight: 400 }}>{kind}</h3>
          <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: "4px 0 0" }}>{desc}</p>
        </div>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-ink-muted)", whiteSpace: "nowrap" }}>{scope}</span>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--color-ink-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
        <div><span style={{ fontWeight: 500 }}>Last run:</span> {last} · <StatusBadge status={status} /></div>
        <div><span style={{ fontWeight: 500 }}>Last success:</span> {lastSuccess}</div>
      </div>
    </Card>
  );
}

function StatusBadge({ status }) {
  const map = {
    succeeded: { bg: "rgba(61,139,94,0.12)",  fg: "var(--color-positive)", border: "rgba(61,139,94,0.4)" },
    running:   { bg: "rgba(31,78,70,0.10)",   fg: "var(--color-primary)",  border: "rgba(31,78,70,0.4)" },
    queued:    { bg: "var(--color-surface-alt)", fg: "var(--color-ink-muted)", border: "var(--color-border)" },
    failed:    { bg: "rgba(178,69,69,0.12)",  fg: "var(--color-negative)", border: "rgba(178,69,69,0.4)" },
  };
  const s = map[status] || map.queued;
  return (
    <span style={{
      display: "inline-block",
      fontSize: 11, padding: "2px 8px", borderRadius: 4,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{status}</span>
  );
}

const ghostBtn = {
  padding: "8px 14px",
  background: "var(--color-surface)",
  color: "var(--color-ink)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  fontFamily: "var(--font-body)",
  fontSize: 13,
  cursor: "pointer",
};

function TextField({ label, value, onChange, placeholder, mono }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--color-ink-muted)" }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          fontFamily: mono ? "var(--font-mono)" : "var(--font-body)",
          fontSize: 14,
          padding: "8px 12px",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          color: "var(--color-ink)",
          borderRadius: 6,
          outline: "none",
        }}
      />
    </label>
  );
}

window.Landing = Landing;
window.Dashboard = Dashboard;
window.Inbox = Inbox;
window.HcpDetail = HcpDetail;
window.RepDetail = RepDetail;
window.AdminTenants = AdminTenants;
window.AdminUsers = AdminUsers;
window.AdminMappings = AdminMappings;
window.AdminGoals = AdminGoals;
window.AdminPipelines = AdminPipelines;
