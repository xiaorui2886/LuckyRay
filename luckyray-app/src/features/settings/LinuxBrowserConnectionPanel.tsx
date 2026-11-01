import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useI18n } from "../../core/i18n";
import { createLinuxBrowserConnectionClient, type BrowserConnectionSnapshot } from "../../core/services/linuxBrowserConnection";
import "./linuxBrowserConnection.css";

export function supportsLinuxBrowserConnection() {
  return typeof window !== "undefined" && typeof navigator !== "undefined"
    && /Linux/.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent) && isTauri();
}

const messages = {
  "zh-CN": {
    title: "浏览器扩展连接", refresh: "刷新", loading: "正在读取连接授权…",
    scope: "批准后，该扩展可通过 LuckyRay 的本地服务读取、修改或删除应用数据。各功能的独立授权仍按原规则检查。请核对扩展来源后决定。",
    next: "在浏览器扩展中点击重新连接，随后在这里批准请求。",
    pending: "请求连接", approved: "已授权连接", denied: "已拒绝", revoked: "已撤销", "not-requested": "尚未收到请求",
    approve: "允许连接", reject: "拒绝", revoke: "撤销授权", retry: "允许再次请求",
    approvedHint: "回到扩展点击重新连接。撤销授权后，已有凭据将失效。",
    retryHint: "允许再次请求后，仍需在扩展中重试并批准一个新请求。",
    error: "无法读取或保存连接授权。请刷新核对当前状态；尚未确认操作成功。",
    stale: "请求或授权已变化，请刷新后重新选择。",
    empty: "此版本尚未配置可连接的浏览器扩展。",
  },
  "en-US": {
    title: "Browser extension connection", refresh: "Refresh", loading: "Reading connection permissions…",
    scope: "Approval lets this extension use LuckyRay's local APIs to read, change or delete app data. Existing feature permissions still apply. Check the extension origin before deciding.",
    next: "Click reconnect in the browser extension, then approve its request here.",
    pending: "Connection requested", approved: "Connection approved", denied: "Denied", revoked: "Revoked", "not-requested": "No request received",
    approve: "Allow connection", reject: "Deny", revoke: "Revoke access", retry: "Allow a new request",
    approvedHint: "Reconnect from the extension. Revoking access invalidates its existing credential.",
    retryHint: "The extension must retry and receive approval for a new request.",
    error: "Could not read or save permissions. Refresh to check the current state; the operation has not been confirmed.",
    stale: "The request or grant changed. Refresh and select it again.",
    empty: "This build has no configured browser extensions.",
  },
} as const;

export default function LinuxBrowserConnectionPanel() {
  return supportsLinuxBrowserConnection() ? <ConnectionPanel /> : null;
}

function ConnectionPanel() {
  const { locale } = useI18n();
  const text = messages[locale === "en-US" ? "en-US" : "zh-CN"];
  const client = useMemo(() => createLinuxBrowserConnectionClient(), []);
  const [snapshot, setSnapshot] = useState<BrowserConnectionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = useRef({ mounted: false, epoch: 0, busy: false });
  const publish = useCallback((next: BrowserConnectionSnapshot) => {
    setSnapshot(previous => previous?.session === next.session && previous.revision > next.revision ? previous : next);
    setError("");
  }, []);
  const refresh = useCallback(async () => {
    if (owner.current.busy) return;
    const epoch = ++owner.current.epoch;
    try {
      const next = await client.snapshot();
      if (owner.current.mounted && owner.current.epoch === epoch) publish(next);
    } catch (failure) {
      if (owner.current.mounted && owner.current.epoch === epoch) setError(String(failure));
    }
  }, [client, publish]);
  useEffect(() => {
    owner.current.mounted = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { owner.current.mounted = false; owner.current.epoch += 1; window.clearInterval(timer); };
  }, [refresh]);
  const act = async (operation: () => Promise<BrowserConnectionSnapshot>) => {
    if (owner.current.busy) return;
    owner.current.busy = true;
    const epoch = ++owner.current.epoch;
    setBusy(true);
    try {
      const next = await operation();
      if (owner.current.mounted && owner.current.epoch === epoch) publish(next);
    } catch (failure) {
      if (owner.current.mounted && owner.current.epoch === epoch) setError(String(failure));
    } finally {
      owner.current.busy = false;
      if (owner.current.mounted) setBusy(false);
    }
  };
  return <section className="setting-group linux-browser-connection" aria-label={text.title} data-linux-browser-connection>
    <div className="linux-browser-connection-heading"><h3>{text.title}</h3><button type="button" disabled={busy} onClick={() => void refresh()}>{text.refresh}</button></div>
    <p>{text.scope}</p><p>{text.next}</p>
    {error && <p role="alert">{/browser-connection-(request|grant)-stale/.test(error) ? text.stale : text.error}</p>}
    {!snapshot && !error && <p role="status">{text.loading}</p>}
    {snapshot?.extensions.length === 0 && <p>{text.empty}</p>}
    {snapshot?.extensions.map(extension => <div className="linux-browser-connection-entry" key={extension.origin} data-browser-origin={extension.origin}>
      <code>{extension.origin}</code><span role="status">{text[extension.status]}</span>
      {extension.status === "approved" && <p>{text.approvedHint}</p>}
      {(extension.status === "denied" || extension.status === "revoked") && <p>{text.retryHint}</p>}
      <div className="linux-browser-connection-actions">
        {extension.status === "pending" && <>
          <button type="button" disabled={busy || !extension.configured} data-browser-decision="approve" onClick={() => void act(() => client.decide(extension.requestId!, "approve"))}>{text.approve}</button>
          <button type="button" disabled={busy} data-browser-decision="reject" onClick={() => void act(() => client.decide(extension.requestId!, "reject"))}>{text.reject}</button>
        </>}
        {extension.status === "approved" && <button type="button" disabled={busy} data-browser-decision="revoke" onClick={() => void act(() => client.revoke(extension.origin, extension.grantId!))}>{text.revoke}</button>}
        {(extension.status === "denied" || extension.status === "revoked") && <button type="button" disabled={busy} data-browser-decision="retry" onClick={() => void act(() => client.decide(extension.requestId!, "retry"))}>{text.retry}</button>}
      </div>
    </div>)}
  </section>;
}
