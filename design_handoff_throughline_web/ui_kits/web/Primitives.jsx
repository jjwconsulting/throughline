// Shared small components
const { useState } = React;

function Card({ children, className = "", style = {} }) {
  return (
    <div
      className={className}
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle, right }) {
  return (
    <div style={{
      padding: "14px 20px",
      borderBottom: "1px solid var(--color-border)",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 16,
    }}>
      <div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0, fontWeight: 400 }}>{title}</h2>
        {subtitle ? <p style={{ fontSize: 12, color: "var(--color-ink-muted)", margin: "2px 0 0" }}>{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "12px 20px",
        background: hover ? "var(--color-primary-hover)" : "var(--color-primary)",
        color: "#fff",
        border: 0,
        borderRadius: 6,
        fontFamily: "var(--font-body)",
        fontSize: 14,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 150ms",
      }}
    >{children}</button>
  );
}

function Chip({ children, variant = "neutral" }) {
  const styles = {
    neutral: {
      background: "var(--color-surface-alt)",
      color: "var(--color-ink-muted)",
      border: "1px solid var(--color-border)",
    },
    accent: {
      background: "rgba(200,155,74,0.15)",
      color: "var(--color-ink)",
      border: "0",
    },
    pill: {
      background: "var(--color-surface-alt)",
      color: "var(--color-ink-muted)",
      border: "1px solid var(--color-border)",
      borderRadius: 9999,
    },
  };
  const s = styles[variant];
  return (
    <span style={{
      fontSize: 12,
      borderRadius: 4,
      padding: "2px 8px",
      fontFamily: "var(--font-body)",
      display: "inline-block",
      ...s,
    }}>{children}</span>
  );
}

function SeverityDot({ severity }) {
  const bg = {
    alert: "var(--color-negative)",
    warning: "var(--color-accent)",
    info: "var(--color-primary)",
    positive: "var(--color-positive)",
  }[severity];
  return (
    <span
      title={severity}
      style={{
        display: "inline-block",
        height: 8,
        width: 8,
        borderRadius: 9999,
        background: bg,
        flexShrink: 0,
        marginTop: 6,
      }}
    />
  );
}

function SeverityIcon({ severity, size = 16 }) {
  const map = {
    alert:    { icon: "alertTri", color: "var(--color-negative)" },
    warning:  { icon: "clock",    color: "var(--color-accent)" },
    info:     { icon: "mapPin",   color: "var(--color-primary)" },
    positive: { icon: "alertTri", color: "var(--color-positive)" },
  };
  const m = map[severity] || map.info;
  return (
    <span
      title={severity}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 24,
        width: 24,
        borderRadius: 6,
        background: "var(--color-surface-alt)",
        color: m.color,
        flexShrink: 0,
        marginTop: 0,
      }}
    >
      <Icon name={m.icon} size={size - 2} strokeWidth={1.75} />
    </span>
  );
}

function Eyebrow({ children, muted, dot }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {dot ? <span style={{
        height: 8, width: 8, borderRadius: 9999, background: dot
      }} /> : null}
      <span style={{
        fontSize: 12,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        color: muted ? "var(--color-ink-muted)" : "var(--color-accent)",
        fontFamily: "var(--font-body)",
      }}>{children}</span>
    </div>
  );
}

window.Card = Card;
window.CardHeader = CardHeader;
window.PrimaryButton = PrimaryButton;
window.Chip = Chip;
window.SeverityDot = SeverityDot;
window.SeverityIcon = SeverityIcon;
window.Eyebrow = Eyebrow;
