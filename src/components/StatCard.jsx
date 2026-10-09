export default function StatCard({ label, value, icon, color = "cyan", delta }) {
  return (
    <div className="stat-card">
      <div className="icon-wrap" style={{ background: `var(--${color === "cyan" ? "cyan" : color})1A`, color: `var(--${color})` }}>
        {icon}
      </div>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && <div className="delta" style={{ color: "var(--green)" }}>{delta}</div>}
    </div>
  );
}
