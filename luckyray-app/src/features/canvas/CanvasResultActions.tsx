import type { CanvasGenerationTask } from "../../core/canvas/generationTasks";
import "./canvasResultActions.css";
export function CanvasResultActions({
  task,
  english,
  onRetry,
  placement = "footer",
}: {
  task?: CanvasGenerationTask;
  english: boolean;
  onRetry: () => void;
  placement?: "card" | "footer";
}) {
  const failed = task?.status === "failed" || task?.status === "cancelled";
  if (!failed) return null;
  return (
    <div
      className={`canvas-result-actions nodrag nopan nowheel${placement === "card" ? " is-card-status" : ""}`}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      aria-label={english ? "Generation status" : "生成状态"}
    >
      {failed ? (
        <>
          <span role={task.status === "cancelled" ? "status" : "alert"} className="is-error" title={task.error?.message}>
            {task.status === "cancelled"
              ? english
                ? "Cancelled"
                : "已取消"
              : task.error?.message ||
                (english ? "Generation failed" : "生成失败")}
          </span>
          {task.error?.retryable !== false && (
            <button type="button" onClick={event => { event.stopPropagation(); onRetry(); }} title={english ? "Retry with the same parameters" : "使用原参数重试"}>
              {placement === "card" ? (english ? "Retry" : "重试") : (english ? "Retry unchanged" : "原参数重试")}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
