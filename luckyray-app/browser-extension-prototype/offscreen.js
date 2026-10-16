// LuckyRay offscreen — D45a-R1
// 在 chrome.offscreen document 里跑 MediaRecorder（Service Worker 跑不了 MediaRecorder）
// 接收 background 的 start/stop 消息，把录制的 webm 转 base64 回传给 background

let recorder = null;
let chunks = [];
let stream = null;
let recordingBudget = null;
let recordingFailureCode = null;
let durationTimer = null;
let recordingId = "";
let recordingTabId = null;

const RECORDING_MAX_BYTES = 64 * 1024 * 1024;
const RECORDING_MAX_DURATION_MS = 20 * 60_000;
const RECORDING_STATUS_KEY = "luckyray-video-recording-status-v1";

const SAFE_RECORDING_MESSAGES = Object.freeze({
  "recording-size-limit": "录制内容已达到 64 MB 上限，已安全停止。",
  "recording-duration-limit": "录制已达到 20 分钟上限，已安全停止。",
  "recording-media-error": "浏览器录制失败。",
  "recording-stream-unavailable": "当前标签页无法开始录制。",
  "recording-recorder-unavailable": "当前浏览器不支持视频录制。",
});

function safeRecordingMessage(code) {
  return SAFE_RECORDING_MESSAGES[code] || "录制失败。";
}

function storeSafeStatus(value) {
  try {
    return Promise.resolve(chrome.storage?.session?.set?.({ [RECORDING_STATUS_KEY]: value })).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

function stopStreamTracks() {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch (_) {}
  }
}

function clearState() {
  if (durationTimer !== null) clearTimeout(durationTimer);
  durationTimer = null;
  stopStreamTracks();
  recorder = null;
  chunks = [];
  stream = null;
  recordingBudget = null;
  recordingFailureCode = null;
  recordingId = "";
  recordingTabId = null;
}

function failRecording(code) {
  if (recordingFailureCode) return;
  recordingFailureCode = code;
  chunks = [];
  storeSafeStatus({ active: false, code, recordingId, tabId: recordingTabId });
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch (_) {}
  stopStreamTracks();
  try {
    chrome.runtime.sendMessage({ type: "luckyray-record-fail", code, recordingId });
  } catch (_) {}
}

// 选 mimeType：优先 webm，浏览器不支持则兜底
function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const t of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
    } catch (_) {}
  }
  return "";
}

// Blob -> base64 字符串（无 base64 库；分块避免极大字符串）
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.onload = () => {
      const dataUrl = reader.result || "";
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "luckyray-offscreen-record-start") {
    (async () => {
      try {
        if (recorder && recorder.state !== "inactive") {
          sendResponse({ ok: false, code: "recording-busy", error: "已在录制中。" });
          return;
        }
        if (typeof MediaRecorder === "undefined") {
          sendResponse({ ok: false, code: "recording-recorder-unavailable", error: safeRecordingMessage("recording-recorder-unavailable") });
          return;
        }
        const streamId = message.streamId;
        const requestedRecordingId = String(message.recordingId || "");
        const requestedTabId = Number(message.tabId);
        if (!streamId || !/^[a-zA-Z0-9_-]{8,96}$/.test(requestedRecordingId) || !Number.isInteger(requestedTabId)) {
          sendResponse({ ok: false, code: "recording-request-invalid", error: "录制请求无效。" });
          return;
        }
        // background 用 chrome.tabCapture.getMediaStreamId 取 streamId；
        // offscreen 在 DOM 环境里兑换成 MediaStream，再交给 MediaRecorder。
        const constraints = {
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId,
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId,
            },
          },
        };
        let userStream;
        try {
          userStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (_) {
          sendResponse({ ok: false, code: "recording-stream-unavailable", error: safeRecordingMessage("recording-stream-unavailable") });
          return;
        }
        stream = userStream;
        chunks = [];
        recordingId = requestedRecordingId;
        recordingTabId = requestedTabId;
        recordingFailureCode = null;
        recordingBudget = LuckyRayExtensionProtocol.createRecordingBudget({
          maxBytes: RECORDING_MAX_BYTES,
          maxDurationMs: RECORDING_MAX_DURATION_MS,
        });
        const mimeType = pickMimeType();
        try {
          recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (_) {
          clearState();
          sendResponse({ ok: false, code: "recording-recorder-unavailable", error: safeRecordingMessage("recording-recorder-unavailable") });
          return;
        }
        recorder.ondataavailable = (ev) => {
          if (!ev.data || ev.data.size <= 0 || recordingFailureCode) return;
          const result = recordingBudget.addChunk(ev.data.size);
          if (!result.ok) {
            failRecording(result.code);
            return;
          }
          chunks.push(ev.data);
        };
        recorder.onerror = () => failRecording("recording-media-error");
        recorder.onstop = () => {
          // 不在这里处理，stop 由 background 触发后由 background 主动询问
        };
        recorder.start(1000);
        durationTimer = setTimeout(() => failRecording("recording-duration-limit"), RECORDING_MAX_DURATION_MS + 1);
        await storeSafeStatus({
          active: true,
          recordingId,
          tabId: recordingTabId,
          maxBytes: RECORDING_MAX_BYTES,
          maxDurationMs: RECORDING_MAX_DURATION_MS,
        });
        sendResponse({ ok: true });
      } catch (_) {
        clearState();
        sendResponse({ ok: false, code: "recording-media-error", error: safeRecordingMessage("recording-media-error") });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-offscreen-record-stop") {
    (async () => {
      try {
        if (message.recordingId && recordingId && message.recordingId !== recordingId) {
          sendResponse({ ok: false, code: "recording-session-stale", error: "录制会话已失效。" });
          return;
        }
        if (!recorder) {
          sendResponse({ ok: false, code: "recording-not-active", error: "未在录制。" });
          return;
        }
        const activeRecorder = recorder;
        // 等待最后 chunk
        const stopped = activeRecorder.state === "inactive" ? Promise.resolve() : new Promise((resolve) => {
          const old = activeRecorder.onstop;
          activeRecorder.onstop = (ev) => {
            if (typeof old === "function") {
              try { old(ev); } catch (_) {}
            }
            resolve();
          };
        });
        if (activeRecorder.state !== "inactive") {
          activeRecorder.stop();
        }
        await stopped;
        stopStreamTracks();
        if (recordingFailureCode) {
          const code = recordingFailureCode;
          clearState();
          await storeSafeStatus({ active: false, code });
          sendResponse({ ok: false, code, error: safeRecordingMessage(code) });
          return;
        }
        // 拼 blob
        const type = activeRecorder.mimeType || "video/webm";
        const blob = new Blob(chunks, { type });
        if (blob.size < 32 * 1024) {
          // 极端：低于最小校验，由后端决定 reason
        }
        const base64 = await blobToBase64(blob);
        const sizeBytes = blob.size;
        clearState();
        await storeSafeStatus({ active: false, code: "recording-stopped" });
        sendResponse({ ok: true, base64, sizeBytes, mimeType: type });
      } catch (_) {
        clearState();
        await storeSafeStatus({ active: false, code: "recording-media-error" });
        sendResponse({ ok: false, code: "recording-media-error", error: safeRecordingMessage("recording-media-error") });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-offscreen-record-cancel") {
    if (message.recordingId && recordingId && message.recordingId !== recordingId) {
      sendResponse({ ok: false, code: "recording-session-stale", error: "录制会话已失效。" });
      return;
    }
    try {
      chunks = [];
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch (_) {}
    const cancelledId = recordingId;
    clearState();
    void storeSafeStatus({ active: false, code: "recording-cancelled", recordingId: cancelledId });
    sendResponse({ ok: true, code: "recording-cancelled" });
    return;
  }
  if (message.type === "luckyray-offscreen-record-status") {
    const snapshot = recordingBudget?.snapshot?.() || { bytes: 0, maxBytes: RECORDING_MAX_BYTES, maxDurationMs: RECORDING_MAX_DURATION_MS };
    sendResponse({
      ok: true,
      active: Boolean(recorder && recorder.state !== "inactive" && !recordingFailureCode),
      code: recordingFailureCode || null,
      recordingId,
      tabId: recordingTabId,
      bytes: snapshot.bytes,
      maxBytes: snapshot.maxBytes,
      maxDurationMs: snapshot.maxDurationMs,
    });
  }
});
