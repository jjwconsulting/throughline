// Navigation, filter bar, and top-level chrome.
//
// Top-level main nav links (mappings now lives under Admin):
//   Dashboard · Inbox · Reports · Admin · Settings
//
// Sub-nav (rendered only on admin routes): Tenants · Users · Mappings · Goals · Pipelines

const MAIN_LINKS = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard" },
  { key: "inbox",     label: "Inbox",     icon: "inbox" },
  { key: "reports",   label: "Reports",   icon: "reports" },
  { key: "admin",     label: "Admin",     icon: "admin" },
  { key: "settings",  label: "Settings",  icon: "settings" },
];

const ADMIN_LINKS = [
  { key: "admin",           label: "Tenants",   icon: "tenants" },
  { key: "admin/users",     label: "Users",     icon: "users" },
  { key: "admin/mappings",  label: "Mappings",  icon: "mappings" },
  { key: "admin/goals",     label: "Goals",     icon: "goals" },
  { key: "admin/pipelines", label: "Pipelines", icon: "pipelines" },
];

function isAdminRoute(route) {
  return route === "admin" || (typeof route === "string" && route.startsWith("admin/"));
}

function Nav({ brand = "Throughline", route, go, scopeBadge }) {
  const onAdmin = isAdminRoute(route);

  return (
    <header style={{
      background: "var(--color-surface)",
      borderBottom: "1px solid var(--color-border)",
    }}>
      <div style={{
        maxWidth: 1152,
        margin: "0 auto",
        padding: "0 24px",
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <a
          onClick={() => go("landing")}
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 20,
            color: "var(--color-ink)",
            textDecoration: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <BrandMark />
          <span>{brand}</span>
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <nav style={{ display: "flex", gap: 4, fontSize: 14 }}>
            {MAIN_LINKS.map(l => {
              const active =
                l.key === route ||
                (l.key === "admin" && onAdmin) ||
                (l.key === "dashboard" && (route === "hcp" || route === "rep"));
              return <NavLink key={l.key} link={l} active={active} go={go} />;
            })}
          </nav>
          {scopeBadge ? <Chip>{scopeBadge}</Chip> : null}
          <div style={{
            width: 28, height: 28, borderRadius: 9999,
            background: "var(--color-primary)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 600,
          }}>JW</div>
        </div>
      </div>
      {onAdmin ? <AdminSubnav route={route} go={go} /> : null}
    </header>
  );
}

function NavLink({ link, active, go }) {
  const [hover, setHover] = React.useState(false);
  const color = active ? "var(--color-ink)" : "var(--color-ink-muted)";
  return (
    <a
      onClick={() => go(link.key)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 6,
        color: hover ? "var(--color-ink)" : color,
        background: active ? "var(--color-surface-alt)" : "transparent",
        textDecoration: "none",
        cursor: "pointer",
        transition: "color 120ms, background 120ms",
      }}
    >
      <Icon name={link.icon} size={14} />
      <span>{link.label}</span>
    </a>
  );
}

function AdminSubnav({ route, go }) {
  return (
    <div style={{
      borderTop: "1px solid var(--color-border)",
      background: "var(--color-surface-alt)",
    }}>
      <div style={{
        maxWidth: 1152,
        margin: "0 auto",
        padding: "0 24px",
        height: 40,
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 13,
      }}>
        {ADMIN_LINKS.map(l => {
          const active = l.key === route;
          return (
            <a
              key={l.key}
              onClick={() => go(l.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                borderRadius: 6,
                color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
                background: active ? "var(--color-surface)" : "transparent",
                border: active ? "1px solid var(--color-border)" : "1px solid transparent",
                textDecoration: "none",
                cursor: "pointer",
                transition: "color 120ms, background 120ms, border-color 120ms",
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--color-ink)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--color-ink-muted)"; }}
            >
              <Icon name={l.icon} size={13} />
              <span>{l.label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// Simple braided mark — three lines converging into one.
// Reads as "many sources, one throughline" without committing to wordmark detail.
function BrandMark({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-primary)"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5c4 0 6 5 9 5s5-5 9-5" />
      <path d="M3 12c4 0 6 5 9 5s5-5 9-5" />
      <line x1="3" y1="19" x2="21" y2="19" stroke="var(--color-accent)" />
    </svg>
  );
}

function AccountToggle({ value, onChange }) {
  const opts = [
    { key: "all", label: "All" },
    { key: "hcp", label: "HCP" },
    { key: "hco", label: "HCO" },
  ];
  return (
    <div style={{
      display: "inline-flex",
      border: "1px solid var(--color-border)",
      background: "var(--color-surface)",
      padding: 2,
      borderRadius: 6,
      fontFamily: "var(--font-body)",
      fontSize: 14,
    }}>
      {opts.map(o => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              padding: "4px 12px",
              borderRadius: 4,
              background: active ? "var(--color-primary)" : "transparent",
              color: active ? "#fff" : "var(--color-ink-muted)",
              border: 0,
              cursor: "pointer",
              transition: "background 120ms",
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function FilterBar({ range, channel, onRange, onChannel }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Select label="Range" value={range} onChange={onRange} options={[
        ["30d", "Last 30 days"],
        ["90d", "Last 90 days"],
        ["ytd", "Year to date"],
        ["all", "All time"],
      ]} />
      <Select label="Channel" value={channel} onChange={onChannel} options={[
        ["all", "All channels"],
        ["F2F", "F2F"],
        ["Virtual", "Virtual"],
        ["Phone", "Phone"],
      ]} />
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 12,
      color: "var(--color-ink-muted)",
      fontFamily: "var(--font-body)",
    }}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 14,
          padding: "6px 10px",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          color: "var(--color-ink)",
          borderRadius: 6,
          outline: "none",
        }}
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

window.Nav = Nav;
window.AccountToggle = AccountToggle;
window.FilterBar = FilterBar;
window.isAdminRoute = isAdminRoute;
