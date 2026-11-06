import { useState } from "react";
import { saveGenerationConcurrencyPolicy, useGenerationConcurrencyPolicy } from "../../core/services/generationConcurrencySettings";

export function GenerationConcurrencySettings({ en }: { en: boolean }) {
  const policy = useGenerationConcurrencyPolicy();
  const [error, setError] = useState("");
  return <details className="canvas-media-profile-section canvas-generation-concurrency">
    <summary>{en ? "Parallel generation" : "并行生成"}</summary>
    <div className="canvas-media-profile-actions">
      {([
        ["global", "总并发", "Global"], ["text", "文本", "Text"],
        ["image", "图片", "Image"], ["video", "视频", "Video"],
        ["perConnection", "每个连接", "Per connection"],
      ] as const).map(([key, zh, label]) => <label key={key}>
        <span>{en ? label : zh}</span>
        <input type="number" min={1} max={8} step={1} value={policy[key]} onChange={event => {
          try { saveGenerationConcurrencyPolicy({ ...policy, [key]: Number(event.target.value) }); setError(""); }
          catch { setError(en ? "Could not save settings" : "未能保存设置"); }
        }} />
      </label>)}
    </div>
    <p className="canvas-media-profile-hint">{en ? "Applies to API connections. Changes affect new tasks only." : "适用于 API 连接，修改仅影响后续调度。"}</p>
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
