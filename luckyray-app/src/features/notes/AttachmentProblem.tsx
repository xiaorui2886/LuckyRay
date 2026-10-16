/** Used inside the existing attachment sidebar; never overlays the editor. */
export function AttachmentProblem({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="note-attachment-message" role="alert">
    {error}<button type="button" onClick={onRetry}>重新检查</button>
  </div>;
}
