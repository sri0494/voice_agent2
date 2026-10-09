const COLOR_MAP = {
  ACTIVE: "green", Running: "green", Connected: "green", Completed: "green", CONNECTED: "green",
  READY: "green", Positive: "green",
  PAUSED: "amber", Paused: "amber", PENDING: "amber", Scheduled: "amber", Neutral: "amber",
  PROCESSING: "cyan", Live: "cyan", Ringing: "cyan", Transferred: "purple", QUEUED: "cyan",
  DRAFT: "muted", Draft: "muted", DISABLED: "muted", DISCONNECTED: "muted", Closed: "muted",
  FAILED: "red", Failed: "red", Missed: "red", Cancelled: "red", Negative: "red", ERROR: "red",
  New: "cyan", "In Progress": "amber", Resolved: "green",
};

export default function StatusBadge({ status }) {
  const color = COLOR_MAP[status] || "muted";
  return <span className={`badge badge-${color}`}>{status}</span>;
}
