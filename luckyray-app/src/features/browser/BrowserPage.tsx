import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  createEmbeddedPersonalBrowserClient,
  createPersonalBrowserLifecycleCoordinator,
  createPersonalBrowserClient,
  createPersonalBrowserTabsState,
  PERSONAL_BROWSER_MAX_TABS,
  reducePersonalBrowserTabsState,
  type PersonalBrowserLifecycleOwner,
  type PersonalBrowserStatus,
  type PersonalBrowserViewport,
} from "../../core/services/personalBrowser";
import "./browser.css";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "status.starting": { "zh-CN": "正在启动", "en-US": "Starting" },
  "status.idle": { "zh-CN": "新标签页", "en-US": "New tab" },
  "status.loading": { "zh-CN": "正在加载", "en-US": "Loading" },
  "status.loaded": { "zh-CN": "已加载", "en-US": "Loaded" },
  "status.error": { "zh-CN": "加载失败", "en-US": "Failed to load" },
  "status.closed": { "zh-CN": "已关闭", "en-US": "Closed" },
  "tabs.aria": { "zh-CN": "浏览器标签页", "en-US": "Browser tabs" },
  "tabs.newNumber": { "zh-CN": "新标签页 {number}", "en-US": "New tab {number}" },
  "tabs.close": { "zh-CN": "关闭标签页", "en-US": "Close tab" },
  "tabs.closeNamed": { "zh-CN": "关闭 {name}", "en-US": "Close {name}" },
  "tabs.limit": { "zh-CN": "已达到标签页上限", "en-US": "Tab limit reached" },
  "tabs.new": { "zh-CN": "新建标签页", "en-US": "New tab" },
  "header.eyebrow": { "zh-CN": "个人浏览器", "en-US": "PERSONAL BROWSER" },
  "header.title": { "zh-CN": "浏览器", "en-US": "Browser" },
  "header.description": { "zh-CN": "用户手动浏览。网页运行在独立 WebView2 窗口中，不共享 LuckyRay 主界面的浏览数据或应用权限。", "en-US": "Browse manually in an isolated WebView2 surface that does not share browsing data or app permissions with LuckyRay." },
  "toolbar.aria": { "zh-CN": "浏览器控制", "en-US": "Browser controls" },
  "action.back": { "zh-CN": "后退", "en-US": "Back" },
  "action.forward": { "zh-CN": "前进", "en-US": "Forward" },
  "action.reload": { "zh-CN": "刷新", "en-US": "Reload" },
  "action.stop": { "zh-CN": "停止", "en-US": "Stop" },
  "address.placeholder": { "zh-CN": "输入网址或域名", "en-US": "Enter a URL or domain" },
  "address.aria": { "zh-CN": "网址", "en-US": "URL" },
  "action.open": { "zh-CN": "打开", "en-US": "Open" },
  "notice.manual": { "zh-CN": "仅用户控制 · Agent 自动化不可用", "en-US": "User-controlled only · Agent automation unavailable" },
  "surface.aria": { "zh-CN": "嵌入式网页区域", "en-US": "Embedded web area" },
  "surface.start": { "zh-CN": "输入网址开始浏览", "en-US": "Enter a URL to start browsing" },
  "surface.window": { "zh-CN": "独立浏览窗口", "en-US": "Separate browser window" },
  "surface.windowHint": { "zh-CN": "本版本使用受控的独立原生窗口，仅允许用户控制。", "en-US": "This version uses a controlled native window available only to the user." },
  "surface.webPage": { "zh-CN": "网页", "en-US": "Web page" },
  "error.unavailable": { "zh-CN": "浏览器组件不可用，请重新安装 LuckyRay。", "en-US": "The browser component is unavailable. Reinstall LuckyRay." },
  "error.terminated": { "zh-CN": "浏览器标签页已意外关闭，请新建标签页重试。", "en-US": "The browser tab closed unexpectedly. Open a new tab and try again." },
  "error.invalid": { "zh-CN": "网址格式无效，只支持公开的 HTTP 或 HTTPS 页面。", "en-US": "The URL is invalid. Only public HTTP or HTTPS pages are supported." },
  "error.private": { "zh-CN": "为保护本机服务，不能打开本地或私有网络地址。", "en-US": "Local and private network addresses are blocked to protect services on this device." },
  "error.scheme": { "zh-CN": "该网址协议不受支持。", "en-US": "This URL scheme is not supported." },
  "error.viewport": { "zh-CN": "浏览器显示区域无效，请重新展开右侧功能栏。", "en-US": "The browser area is invalid. Reopen the right sidebar." },
  "error.embed": { "zh-CN": "浏览器暂时无法嵌入当前窗口，请稍后重试。", "en-US": "The browser cannot be embedded in this window right now. Try again later." },
  "error.capacity": { "zh-CN": "最多同时打开 {count} 个标签页。", "en-US": "You can open up to {count} tabs." },
  "error.generic": { "zh-CN": "浏览器操作失败，请稍后重试。", "en-US": "The browser action failed. Try again." },
});

const standaloneClient = createPersonalBrowserClient();
const standaloneLifecycle = createPersonalBrowserLifecycleCoordinator(standaloneClient);
let browserTabSequence = 0;

function nextBrowserTabId() {
  browserTabSequence += 1;
  return `browser-tab-${browserTabSequence}`;
}

type BrowserTabMeta = {
  label: string;
  status: PersonalBrowserStatus["status"];
};

type BrowserT = ReturnType<typeof useMessages<typeof COPY>>["t"];

function statusLabel(status: PersonalBrowserStatus["status"], t: BrowserT): string {
  return t(`status.${status}` as "status.starting" | "status.idle" | "status.loading" | "status.loaded" | "status.error" | "status.closed");
}

export default function BrowserPage({
  embedded = false,
  visible = true,
}: {
  embedded?: boolean;
  visible?: boolean;
}) {
  if (!embedded) {
    return (
      <section className="browser-page">
        <BrowserSession embedded={false} visible={visible} selected />
      </section>
    );
  }
  return <EmbeddedBrowserTabs visible={visible} />;
}

function EmbeddedBrowserTabs({ visible }: { visible: boolean }) {
  const { t } = useMessages(COPY);
  const initialIdRef = useRef(nextBrowserTabId());
  const [tabs, dispatchTabs] = useReducer(
    reducePersonalBrowserTabsState,
    initialIdRef.current,
    createPersonalBrowserTabsState,
  );
  const [tabMeta, setTabMeta] = useState<Record<string, BrowserTabMeta>>({});

  const updateTabMeta = useCallback((id: string, status: PersonalBrowserStatus) => {
    const label = browserTabLabel(status, t);
    setTabMeta((current) => {
      const previous = current[id];
      if (previous?.label === label && previous.status === status.status) return current;
      return { ...current, [id]: { label, status: status.status } };
    });
  }, [t]);

  const addTab = useCallback(() => {
    if (tabs.ids.length >= PERSONAL_BROWSER_MAX_TABS) return;
    dispatchTabs({ type: "add", id: nextBrowserTabId() });
  }, [tabs.ids.length]);

  const closeTab = useCallback((id: string) => {
    dispatchTabs({
      type: "close",
      id,
      replacementId: tabs.ids.length === 1 ? nextBrowserTabId() : undefined,
    });
    setTabMeta((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, [tabs.ids.length]);

  return (
    <section className="browser-page browser-page-embedded">
      <div className="browser-tab-strip" role="tablist" aria-label={t("tabs.aria")}>
        <div className="browser-tab-scroll">
          {tabs.ids.map((id, index) => {
            const meta = tabMeta[id];
            const active = id === tabs.activeId;
            return (
              <div key={id} className={`browser-tab${active ? " active" : ""}`}>
                <button
                  role="tab"
                  aria-selected={active}
                  title={meta?.label || t("tabs.newNumber", { number: index + 1 })}
                  onClick={() => dispatchTabs({ type: "select", id })}
                >
                  <span className={`browser-tab-state status-${meta?.status || "starting"}`} />
                  <span>{meta?.label || t("status.idle")}</span>
                </button>
                <button
                  className="browser-tab-close"
                  title={t("tabs.close")}
                  aria-label={t("tabs.closeNamed", { name: meta?.label || t("status.idle") })}
                  onClick={() => closeTab(id)}
                >×</button>
              </div>
            );
          })}
        </div>
        <button
          className="browser-tab-add"
          title={tabs.ids.length >= PERSONAL_BROWSER_MAX_TABS ? t("tabs.limit") : t("tabs.new")}
          aria-label={t("tabs.new")}
          disabled={tabs.ids.length >= PERSONAL_BROWSER_MAX_TABS}
          onClick={addTab}
        >+</button>
      </div>

      <div className="browser-tab-stack">
        {tabs.ids.length === 0 && (
          <button className="browser-tabs-empty" onClick={addTab}>
            <span>+</span>
            {t("tabs.new")}
          </button>
        )}
        {tabs.ids.map((id) => (
          <BrowserSession
            key={id}
            embedded
            selected={id === tabs.activeId}
            visible={visible && id === tabs.activeId}
            onStatusChange={(status) => updateTabMeta(id, status)}
          />
        ))}
      </div>
    </section>
  );
}

function BrowserSession({
  embedded,
  selected,
  visible,
  onStatusChange,
}: {
  embedded: boolean;
  selected: boolean;
  visible: boolean;
  onStatusChange?: (status: PersonalBrowserStatus) => void;
}) {
  const { t } = useMessages(COPY);
  const [status, setStatus] = useState<PersonalBrowserStatus | null>(null);
  const statusRef = useRef<PersonalBrowserStatus | null>(null);
  const viewportRef = useRef<PersonalBrowserViewport | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const ownerRef = useRef<PersonalBrowserLifecycleOwner | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const embeddedClient = useMemo(
    () => createEmbeddedPersonalBrowserClient(() => viewportRef.current),
    [],
  );
  const client = embedded ? embeddedClient : standaloneClient;
  const lifecycle = useMemo(
    () => embedded ? createPersonalBrowserLifecycleCoordinator(client) : standaloneLifecycle,
    [client, embedded],
  );
  const nativeSurfaceVisible = visible
    && status !== null
    && status.status !== "starting"
    && status.status !== "idle"
    && status.status !== "closed";

  const publishStatus = useCallback((next: PersonalBrowserStatus) => {
    statusRef.current = next;
    setStatus(next);
    onStatusChange?.(next);
  }, [onStatusChange]);

  const run = useCallback(async (
    action: (current: PersonalBrowserStatus) => Promise<PersonalBrowserStatus>,
  ) => {
    const current = statusRef.current;
    const owner = ownerRef.current;
    if (!current || !owner || busy) return;
    setBusy(true);
    setError("");
    try {
      owner.publish(await action(current));
    } catch (reason) {
      owner.fail(reason);
    } finally {
      if (owner.isActive()) setBusy(false);
    }
  }, [busy]);

  useLayoutEffect(() => {
    if (!embedded) return;
    let animationFrame = 0;
    const syncViewport = () => {
      animationFrame = 0;
      const surface = surfaceRef.current;
      const previous = viewportRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const hasBounds = rect.width >= 1 && rect.height >= 1;
      const next = hasBounds
        ? {
            x: Math.max(0, Math.round(rect.left * scale)),
            y: Math.max(0, Math.round(rect.top * scale)),
            width: Math.max(1, Math.round(rect.width * scale)),
            height: Math.max(1, Math.round(rect.height * scale)),
            visible: nativeSurfaceVisible,
          }
        : previous
          ? { ...previous, visible: false }
          : null;
      if (!next) return;
      viewportRef.current = next;
      const current = statusRef.current;
      const owner = ownerRef.current;
      if (current && owner?.isActive()) {
        void embeddedClient
          .setViewport(current, next)
          .then((nextStatus) => owner.publish(nextStatus))
          .catch((reason) => owner.fail(reason));
      }
    };
    const scheduleSync = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(syncViewport);
    };
    const surface = surfaceRef.current;
    if (!surface) return;
    syncViewport();
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(surface);
    window.addEventListener("resize", scheduleSync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      const current = statusRef.current;
      const owner = ownerRef.current;
      const previous = viewportRef.current;
      if (current && owner?.isActive() && previous?.visible) {
        const hidden = { ...previous, visible: false };
        viewportRef.current = hidden;
        void embeddedClient.setViewport(current, hidden).catch(() => undefined);
      }
    };
  }, [embedded, embeddedClient, nativeSurfaceVisible]);

  useEffect(() => {
    const owner = lifecycle.acquire({
      onStatus(next) {
        publishStatus(next);
        setBusy(false);
      },
      onError(reason) {
        setError(formatBrowserError(reason, t));
        setBusy(false);
      },
    });
    ownerRef.current = owner;
    return () => {
      if (ownerRef.current === owner) ownerRef.current = null;
      owner.release();
    };
  }, [lifecycle, publishStatus, t]);

  useEffect(() => {
    if (!status || status.status !== "loading" || busy) return;
    const timer = window.setTimeout(() => {
      const current = statusRef.current;
      const owner = ownerRef.current;
      if (!current || !owner || current.status !== "loading") return;
      void client.status(current).then((next) => owner.publish(next)).catch((reason) => owner.fail(reason));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [busy, client, status]);

  const openAddress = useCallback(() => {
    void run((current) => client.navigate(current, address));
  }, [address, client, run]);

  return (
    <div className={`browser-tab-session${selected ? " active" : ""}`}>
      {!embedded && (
        <header className="browser-page-header">
          <div>
            <p className="browser-page-eyebrow">{t("header.eyebrow")}</p>
            <h1>{t("header.title")}</h1>
            <p>{t("header.description")}</p>
          </div>
          <span className={`browser-status browser-status-${status?.status || "starting"}`}>
            {statusLabel(status?.status || "starting", t)}
          </span>
        </header>
      )}

      <div className="browser-toolbar" role="toolbar" aria-label={t("toolbar.aria")}>
        <button aria-label={t("action.back")} disabled={busy || !status?.canGoBack} onClick={() => void run(client.back)}>←</button>
        <button aria-label={t("action.forward")} disabled={busy || !status?.canGoForward} onClick={() => void run(client.forward)}>→</button>
        <button aria-label={t("action.reload")} disabled={busy || !status} onClick={() => void run(client.reload)}>↻</button>
        <button aria-label={t("action.stop")} disabled={!status || status.status !== "loading"} onClick={() => void run(client.stop)}>×</button>
        <form className="browser-address" onSubmit={(event) => { event.preventDefault(); openAddress(); }}>
          <span aria-hidden="true">◎</span>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={t("address.placeholder")}
            aria-label={t("address.aria")}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !address.trim()}>{t("action.open")}</button>
        </form>
      </div>

      <div className="browser-surface-card">
        <div className="browser-origin-row">
          <strong>{status?.origin || statusLabel(status?.status || "starting", t)}</strong>
          <span>{t("notice.manual")}</span>
        </div>
        {embedded ? (
          <div ref={surfaceRef} className="browser-native-surface" aria-label={t("surface.aria")}>
            {!status || status.status === "starting" || status.status === "idle" ? (
              <div className="browser-native-placeholder">
                <div className="browser-window-icon" aria-hidden="true">▣</div>
                <h2>{t("surface.start")}</h2>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="browser-window-note">
            <div className="browser-window-icon" aria-hidden="true">▣</div>
            <div>
              <h2>{status?.title || t("surface.window")}</h2>
              <p>{t("surface.windowHint")}</p>
            </div>
          </div>
        )}
        {error && <div className="browser-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

function browserTabLabel(status: PersonalBrowserStatus, t: BrowserT): string {
  const title = status.title?.trim();
  if (title) return title.slice(0, 42);
  if (status.origin) {
    try {
      return new URL(status.origin).hostname.slice(0, 42) || t("surface.webPage");
    } catch {
      return t("surface.webPage");
    }
  }
  return statusLabel(status.status, t);
}

function formatBrowserError(reason: unknown, t: BrowserT) {
  const code = reason instanceof Error ? reason.message : String(reason || "");
  const messages: Record<string, string> = {
    "browser-host-unavailable": t("error.unavailable"),
    "browser-host-terminated": t("error.terminated"),
    "browser-navigation-invalid": t("error.invalid"),
    "browser-navigation-private-target": t("error.private"),
    "browser-navigation-scheme-denied": t("error.scheme"),
    "browser-viewport-invalid": t("error.viewport"),
    "browser-viewport-unavailable": t("error.embed"),
    "browser-tab-capacity": t("error.capacity", { count: PERSONAL_BROWSER_MAX_TABS }),
  };
  return messages[code] || t("error.generic");
}
