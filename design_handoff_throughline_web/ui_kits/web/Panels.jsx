// SignalsPanel + KpiCard + TrendChart + Briefing + DataTable

function KpiCard({ label, value, delta }) {
  return (
    <Card style={{ padding: 20 }}>
      <p style={{ fontSize: 14, color: "var(--color-ink-muted)", margin: 0 }}>{label}</p>
      <p style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "8px 0 0", fontWeight: 400, lineHeight: 1.1 }}>{value}</p>
      {delta ? <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: "4px 0 0" }}>{delta}</p> : null}
    </Card>
  );
}

function SignalsPanel({ title, subtitle, signals, emptyHint }) {
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        right={signals.length > 0 ? <Chip variant="pill">{signals.length}</Chip> : null}
      />
      {signals.length === 0 ? (
        <div style={{ padding: "32px 20px", textAlign: "center", fontSize: 14, color: "var(--color-ink-muted)" }}>
          {emptyHint || "Nothing to surface right now."}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {signals.map((s, i) => (
            <li key={i} style={{ borderTop: i === 0 ? 0 : "1px solid var(--color-border)" }}>
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); s.onClick && s.onClick(); }}
                style={{
                  display: "block",
                  padding: "12px 20px",
                  textDecoration: "none",
                  color: "inherit",
                  transition: "background 120ms",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-surface-alt)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <SeverityIcon severity={s.severity} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 500, margin: 0, color: "var(--color-ink)" }}>{s.title}</p>
                    {s.detail ? <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: "2px 0 0" }}>{s.detail}</p> : null}
                  </div>
                  <Icon name="arrowRight" size={14} style={{ color: "var(--color-ink-muted)", marginTop: 4 }} />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Briefing({ text, loading }) {
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, color: "var(--color-accent)" }}>
        <Icon name="sparkles" size={14} />
        <span style={{
          fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em",
          fontFamily: "var(--font-body)",
        }}>Briefing</span>
      </div>
      <p style={{
        fontFamily: "var(--font-body)",
        fontSize: 14,
        lineHeight: 1.6,
        color: loading ? "var(--color-ink-muted)" : "var(--color-ink)",
        fontStyle: loading ? "italic" : "normal",
        margin: 0,
      }}>{loading ? "Reading your signals…" : text}</p>
    </Card>
  );
}

function TrendChart({ data, height = 220 }) {
  const w = 800;
  const h = height;
  const pad = { l: 40, r: 16, t: 10, b: 24 };
  const ys = data.map(d => d.calls);
  const yMax = Math.max(...ys) * 1.15;
  const xStep = (w - pad.l - pad.r) / (data.length - 1);
  const sx = (i) => pad.l + i * xStep;
  const sy = (v) => pad.t + (1 - v / yMax) * (h - pad.t - pad.b);

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${sx(i)},${sy(d.calls)}`).join(" ");
  const area = `${line} L${sx(data.length - 1)},${h - pad.b} L${sx(0)},${h - pad.b} Z`;

  const gridY = [0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      <defs>
        <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridY.map((g, i) => (
        <line key={i}
          x1={pad.l} x2={w - pad.r}
          y1={pad.t + g * (h - pad.t - pad.b)}
          y2={pad.t + g * (h - pad.t - pad.b)}
          stroke="var(--color-border)" strokeDasharray="3 3"
        />
      ))}
      {gridY.map((g, i) => {
        const v = Math.round(yMax * (1 - g));
        return (
          <text key={i}
            x={pad.l - 8}
            y={pad.t + g * (h - pad.t - pad.b) + 4}
            textAnchor="end"
            fontSize="11"
            fill="var(--color-ink-muted)"
            fontFamily="var(--font-body)"
          >{v}</text>
        );
      })}
      {data.map((d, i) => i % Math.ceil(data.length / 6) === 0 ? (
        <text key={i}
          x={sx(i)} y={h - 6}
          textAnchor="middle"
          fontSize="11"
          fill="var(--color-ink-muted)"
          fontFamily="var(--font-body)"
        >{d.label}</text>
      ) : null)}
      <path d={area} fill="url(#callsFill)" />
      <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
    </svg>
  );
}

function DataTable({ columns, rows, emptyText }) {
  return (
    <div style={{ overflow: "hidden" }}>
      <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse", fontFamily: "var(--font-body)" }}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{
                textAlign: c.align || "left",
                fontWeight: 400,
                padding: "8px 20px",
                fontSize: 12,
                color: "var(--color-ink-muted)",
                width: c.width,
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{
                padding: "28px 20px", textAlign: "center", color: "var(--color-ink-muted)"
              }}>{emptyText || "No data."}</td>
            </tr>
          ) : rows.map((r, i) => (
            <tr key={i}
              style={{ borderTop: "1px solid var(--color-border)", transition: "background 100ms" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-surface-alt)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
            >
              {columns.map((c, j) => (
                <td key={j} style={{
                  padding: "8px 20px",
                  textAlign: c.align || "left",
                  color: c.muted ? "var(--color-ink-muted)" : "var(--color-ink)",
                  fontFamily: c.mono ? "var(--font-mono)" : "var(--font-body)",
                  fontVariantNumeric: c.mono ? "tabular-nums" : "normal",
                }}>{c.render ? c.render(r, i) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

window.KpiCard = KpiCard;
window.SignalsPanel = SignalsPanel;
window.Briefing = Briefing;
window.TrendChart = TrendChart;
window.DataTable = DataTable;
