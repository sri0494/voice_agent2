// Standard loading / error / empty state block used across every API-driven page.
export function LoadingState({ label = "Loading..." }) {
  return (
    <div className="state-block">
      <div className="spinner" />
      <div>{label}</div>
    </div>
  );
}

export function ErrorState({ message = "Something went wrong.", onRetry }) {
  return (
    <div className="state-block">
      <div style={{ fontSize: 28 }}>⚠️</div>
      <div>{message}</div>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function EmptyState({ message = "Nothing here yet.", action }) {
  return (
    <div className="state-block">
      <div style={{ fontSize: 28 }}>🗂️</div>
      <div>{message}</div>
      {action}
    </div>
  );
}
