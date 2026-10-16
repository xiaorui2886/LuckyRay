import { useEffect, useRef, useState } from "react";
import { createDefaultDshHostClient } from "../../core/services/dshHost";
import {
  claimDshNativeSurfaceVisibility,
  createDefaultDshNativeSurfaceClient,
  deliverDshOpenIntent,
  watchDshNativeSurfaceFailure,
  watchDshNativeSurfaceScaleChanges,
  runDshNativeSurfaceInitialOpenSingleFlight,
  settleDshNativeSurfaceRestartProjection,
} from "../../core/services/dshNativeSurface";
import {
  prepareDshNativeSurfaceForAttach,
  resetDshBackgroundPreload,
  retryDshBackgroundPreload,
} from "../../core/services/dshBackgroundPreload";
import {
  createDefaultDshPluginCompatClient,
  dshPluginCompatActionFailure,
  dshPluginCompatReasonToken,
  type DshPluginCompatStatus,
} from "../../core/services/dshPluginCompat";
import {
  allowNewOpenInLightSeekActionAfterReview,
  completeOpenInLightSeekIntent,
  failOpenInLightSeekIntent,
  peekOpenInLightSeekIntent,
  peekUncertainOpenInLightSeekIntentId,
  subscribeOpenInLightSeekIntent,
} from "../../core/services/openInLightSeek";
import BrowserPage from "../browser/BrowserPage";
import LightSeekContentBrowser from "./LightSeekContentBrowser";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "error.intent": { "zh-CN": "内容尚未投递。请返回原入口重试。", "en-US": "The content was not staged. Return to the original entry and try again." },
  "error.intentUncertain": { "zh-CN": "投递结果未确认。请先检查 LightSeek 草稿；不会自动重复添加。", "en-US": "Delivery outcome is uncertain. Check the LightSeek draft first; it will not be added again automatically." },
  "error.intentReviewed": { "zh-CN": "已确认草稿未入框后，请返回原入口重新点击添加。", "en-US": "If you confirmed the draft did not receive it, return to the original entry and add it again." },
  "action.intentReviewed": { "zh-CN": "我已确认未入框，允许重新添加", "en-US": "I confirmed it was not added; allow a new action" },
  "error.open": { "zh-CN": "AI 助手界面打开失败，请重试。", "en-US": "Could not open the AI assistant. Try again." },
  "error.startup": { "zh-CN": "AI 助手启动失败，请重试。", "en-US": "Could not start the AI assistant. Try again." },
  "status.restarting": { "zh-CN": "LightSeek 重启中…", "en-US": "Restarting LightSeek…" },
  "status.opening": { "zh-CN": "正在打开 AI 助手…", "en-US": "Opening the AI assistant…" },
  "action.retry": { "zh-CN": "重试", "en-US": "Retry" },
  "browser.aria": { "zh-CN": "个人浏览器侧栏", "en-US": "Personal Browser sidebar" },
  "compat.title": { "zh-CN": "扩展兼容与恢复", "en-US": "Extension compatibility & recovery" },
  "compat.intro": { "zh-CN": "以下为当前 LightSeek 扩展组合的检查结果。以兼容模式启动会暂停未通过检查的扩展；你的设置与会话数据保持不变。", "en-US": "Compatibility results for the current LightSeek extension set. Starting in compatibility mode suspends extensions that did not pass; your settings and sessions are unchanged." },
  "compat.modeOn": { "zh-CN": "当前正在以兼容模式运行。", "en-US": "Currently running in compatibility mode." },
  "compat.start": { "zh-CN": "以兼容模式启动", "en-US": "Start in compatibility mode" },
  "compat.starting": { "zh-CN": "正在以兼容模式启动…", "en-US": "Starting in compatibility mode…" },
  "compat.recheck": { "zh-CN": "重新检查扩展", "en-US": "Recheck extensions" },
  "compat.rechecking": { "zh-CN": "正在检查…", "en-US": "Checking…" },
  "compat.restore": { "zh-CN": "恢复此扩展", "en-US": "Restore this extension" },
  "compat.none": { "zh-CN": "未发现第三方扩展，问题可能来自核心组件；可尝试重试或重新检查。", "en-US": "No third-party extensions found; the issue may be in the core. Retry or recheck." },
  "compat.limited": { "zh-CN": "本环境未执行第三方扩展的动态试运行（标记为受限），静态检查与恢复机制仍然生效。", "en-US": "Dynamic trial runs of third-party extensions are not executed in this environment (marked limited); static checks and recovery still apply." },
  "compat.reason.pass": { "zh-CN": "检查通过", "en-US": "Checks passed" },
  "compat.reason.failed": { "zh-CN": "不兼容：缺少依赖或导入项（已可自动隔离）", "en-US": "Incompatible: missing dependency or import (auto-quarantine available)" },
  "compat.reason.quarantined": { "zh-CN": "已暂停加载（可通过重新检查后恢复）", "en-US": "Suspended from loading (restore after rechecking)" },
  "compat.reason.limited": { "zh-CN": "未能完全检查", "en-US": "Not fully verified" },
  "compat.reason.unknown": { "zh-CN": "未确认", "en-US": "Unverified" },
  "compat.reason.unchecked": { "zh-CN": "尚未检查", "en-US": "Not checked yet" },
  "compat.error": { "zh-CN": "操作未完成，请重试。", "en-US": "The action did not complete. Try again." },
  "compat.partial": { "zh-CN": "有扩展的挂载项无法定位，未能全部暂停；如仍失败请从设置中移除该扩展。", "en-US": "Some mounts could not be located and were not suspended; if it still fails, remove that extension in Settings." },
});

const COMPAT_REASON_COPY = {
  pass: "compat.reason.pass",
  failed: "compat.reason.failed",
  quarantined: "compat.reason.quarantined",
  limited: "compat.reason.limited",
  unknown: "compat.reason.unknown",
  unchecked: "compat.reason.unchecked",
} as const;

function boundsOf(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

// Module-scoped availability client for the service-layer status watch; the
// page itself stays timer-free by contract.
const availabilityWatchClient = {
  status: () => createDefaultDshNativeSurfaceClient().then((surface) => surface.status()),
};

export default function DshNativeSurfacePage({
  personalBrowserOpen = false,
  contentBrowserOpen = false,
  nativeSurfacesVisible = true,
  restartRequest = 0,
  restarting = false,
  onRestartAccepted,
  onRestartSettled,
}: {
  personalBrowserOpen?: boolean;
  contentBrowserOpen?: boolean;
  nativeSurfacesVisible?: boolean;
  restartRequest?: number;
  restarting?: boolean;
  onRestartAccepted?: (request: number) => void;
  onRestartSettled?: (request: number) => void;
}) {
  const { t } = useMessages(COPY);
  const mountRef = useRef<HTMLDivElement>(null);
  const syncVisibilityRef = useRef<((visible: boolean, allowInitialOpenFallback?: boolean) => void) | null>(null);
  const deliverOpenIntentRef = useRef<(() => void) | null>(null);
  const restartingRef = useRef(restarting);
  const restartSucceededRef = useRef(false);
  const restartWasInFlightRef = useRef(restarting);
  const nativeSurfacesVisibleRef = useRef(nativeSurfacesVisible);
  const handledRestartRequestRef = useRef(0);
  const routeMountedRef = useRef(false);
  const [error, setError] = useState("");
  const [intentError, setIntentError] = useState(() => peekUncertainOpenInLightSeekIntentId()
    ? t("error.intentUncertain") : "");
  const [uncertainIntentId, setUncertainIntentId] = useState<string | null>(peekUncertainOpenInLightSeekIntentId);
  const [attempt, setAttempt] = useState(0);
  const [attachedAttempt, setAttachedAttempt] = useState<number | null>(null);
  // Outer recovery panel: loads only when the DSH page itself failed or never
  // became ready, so it stays usable exactly when the LSH UI is not.
  const [compat, setCompat] = useState<DshPluginCompatStatus | null>(null);
  const [compatBusy, setCompatBusy] = useState(false);
  const [compatError, setCompatError] = useState("");
  const retryInFlightRef = useRef(false);

  const retrySurface = () => {
    if (retryInFlightRef.current || compatBusy) return;
    retryInFlightRef.current = true;
    setCompatBusy(true);
    setCompatError("");
    void retryDshBackgroundPreload(async () => {
      const compat = await createDefaultDshPluginCompatClient();
      await compat.reclaimFailedSurface();
    }).then(() => {
      if (routeMountedRef.current) setAttempt((value) => value + 1);
    }).catch(() => {
      if (routeMountedRef.current) setCompatError(t("compat.error"));
    }).finally(() => {
      retryInFlightRef.current = false;
      if (routeMountedRef.current) setCompatBusy(false);
    });
  };

  useEffect(() => {
    if (!error) return;
    let active = true;
    void createDefaultDshPluginCompatClient()
      .then((compat) => compat.status())
      .then((status) => {
        if (active) setCompat(status);
      })
      .catch(() => {
        if (active) setCompat(null);
      });
    return () => {
      active = false;
    };
  }, [error, attempt]);

  const runCompatAction = (action: () => Promise<unknown>, reopen: boolean) => {
    if (compatBusy) return;
    setCompatBusy(true);
    setCompatError("");
    void action()
      .then((result) => {
        // Failures arrive as structured results; they must never read as a
        // successful reopen. Which mounts could not be isolated is the more
        // actionable message, so it wins over the generic error text.
        const failure = dshPluginCompatActionFailure(result);
        const failureMessage = failure === "partial"
          ? t("compat.partial")
          : failure === "failed" ? t("compat.error") : null;
        if (failureMessage) {
          // Stop BEFORE any reopen; still refresh the panel so whatever the
          // action did change (e.g. partial quarantines) is visible.
          return createDefaultDshPluginCompatClient()
            .then((compat) => compat.status())
            .then((status) => {
              if (routeMountedRef.current) {
                setCompat(status);
                setCompatError(failureMessage);
              }
              return null;
            })
            .catch(() => {
              if (routeMountedRef.current) setCompatError(failureMessage);
              return null;
            });
        }
        return createDefaultDshPluginCompatClient();
      })
      .then((compat) => (compat ? compat.status() : null))
      .then(async (status) => {
        if (!status) return null;
        if (!routeMountedRef.current) return status;
        setCompat(status);
        if (reopen) {
          await retryDshBackgroundPreload(async () => {
            const client = await createDefaultDshPluginCompatClient();
            await client.reclaimFailedSurface();
          });
          if (routeMountedRef.current) {
            setError("");
            setAttempt((value) => value + 1);
          }
        }
        return status;
      })
      .catch(() => {
        if (routeMountedRef.current) setCompatError(t("compat.error"));
      })
      .finally(() => setCompatBusy(false));
  };

  useEffect(() => {
    routeMountedRef.current = true;
    return () => {
      routeMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let active = true;
    let observer: ResizeObserver | null = null;
    let stopScaleWatch: (() => void) | null = null;
    let activeVisibility: ReturnType<typeof claimDshNativeSurfaceVisibility> | null = null;
    let hasAttached = false;
    let intentDelivery: Promise<void> | null = null;
    let intentDeliveryTrailing = false;
    const clientPromise = createDefaultDshNativeSurfaceClient();
    const hostClientPromise = createDefaultDshHostClient();
    setAttachedAttempt(null);
    setError("");
    const readyClient = async () => {
      const [hostClient, client] = await Promise.all([hostClientPromise, clientPromise]);
      return prepareDshNativeSurfaceForAttach(hostClient, client, attempt === 0 ? "probe" : "retry");
    };
    const ensureObserver = () => {
      if (observer) return;
      const syncBounds = () => {
        if (active && !restartingRef.current && activeVisibility?.isCurrentVisible()) {
          void clientPromise
            .then((client) => client.setBounds(boundsOf(mount)))
            .catch(() => undefined);
        }
      };
      observer = new ResizeObserver(syncBounds);
      observer.observe(mount);
      stopScaleWatch = watchDshNativeSurfaceScaleChanges(syncBounds);
    };
    const deliverOpenIntent = () => {
      if (!active || !hasAttached || restartingRef.current
        || !activeVisibility?.isCurrentVisible() || !nativeSurfacesVisibleRef.current) return;
      if (intentDelivery) {
        intentDeliveryTrailing = true;
        return;
      }
      const intent = peekOpenInLightSeekIntent();
      if (!intent) return;
      setIntentError("");
      setUncertainIntentId(null);
      intentDelivery = clientPromise
        .then(async (client) => {
          // Client loading may cross a modal/route hide. Never stage content
          // into a hidden prepared surface; retain the pending intent instead.
          if (!active || restartingRef.current || !activeVisibility?.isCurrentVisible()
            || !nativeSurfacesVisibleRef.current) return false;
          const { recoveryOnly, ...deliveryIntent } = intent;
          await deliverDshOpenIntent(client, deliveryIntent, recoveryOnly, () => (
            active && !restartingRef.current && !!activeVisibility?.isCurrentVisible()
              && nativeSurfacesVisibleRef.current
          ));
          return true;
        })
        .then((delivered) => {
          if (delivered) completeOpenInLightSeekIntent(intent.intentId);
        })
        .catch((error) => {
          const notStaged = String(error).includes("dsh-open-intent-not-staged");
          failOpenInLightSeekIntent(intent.intentId, notStaged ? "not-staged" : "uncertain");
          if (active) {
            setUncertainIntentId(notStaged ? null : intent.intentId);
            setIntentError(t(notStaged ? "error.intent" : "error.intentUncertain"));
          }
        })
        .finally(() => {
          intentDelivery = null;
          const shouldRunAgain = intentDeliveryTrailing;
          intentDeliveryTrailing = false;
          if (shouldRunAgain || peekOpenInLightSeekIntent()?.intentId !== intent.intentId) {
            deliverOpenIntent();
          }
        });
    };
    deliverOpenIntentRef.current = deliverOpenIntent;
    const unsubscribeOpenIntent = subscribeOpenInLightSeekIntent(deliverOpenIntent);
    const syncVisibility = (shouldShow: boolean, allowInitialOpenFallback = true) => {
      void (async () => {
        if (!active || restartingRef.current) return;
        if (!shouldShow) {
          const visibility = activeVisibility ?? claimDshNativeSurfaceVisibility();
          activeVisibility = visibility;
          await visibility.hide(clientPromise);
          return;
        }
        const visibility = claimDshNativeSurfaceVisibility();
        activeVisibility = visibility;
        const client = await readyClient();
        if (!active || restartingRef.current || !visibility.isCurrentVisible()) return;
        // Route return and modal close show the same child. Only the initial
        // page attachment may use the existing one-shot open fallback.
        const attach = async () => {
          try {
            return await visibility.show(client, boundsOf(mount));
          } catch (showError) {
            if (!String(showError).includes("not-open") || hasAttached || !allowInitialOpenFallback) {
              if (active) setError(t("error.open"));
              return false;
            }
            try {
              if (!active || !visibility.isCurrentVisible()) return false;
              // Lifecycle creation is one-shot. It is never registered as a
              // replayable visual action; convergence after it uses show/hide only.
              await runDshNativeSurfaceInitialOpenSingleFlight(() => (
                client.open(boundsOf(mount))
              ));
              if (!(await visibility.reconcileAfterOneShotOpen())) return false;
              // Feature-enabled native creation is hidden, including explicit
              // cold opens. Only the still-current route lease may expose it.
              return await visibility.show(client, boundsOf(mount));
            } catch {
              if (active) setError(t("error.open"));
              return false;
            }
          }
        };
        if (!(await attach()) || !active || !visibility.isCurrentVisible()) return;
        hasAttached = true;
        setAttachedAttempt(attempt);
        ensureObserver();
        deliverOpenIntent();
      })().catch(() => {
        if (active) setError(t("error.startup"));
      });
    };
    syncVisibilityRef.current = syncVisibility;
    return () => {
      active = false;
      if (syncVisibilityRef.current === syncVisibility) syncVisibilityRef.current = null;
      if (deliverOpenIntentRef.current === deliverOpenIntent) deliverOpenIntentRef.current = null;
      observer?.disconnect();
      stopScaleWatch?.();
      unsubscribeOpenIntent();
      // Route-away is visual-only: hide the child, never close the surface.
      const visibility = activeVisibility ?? claimDshNativeSurfaceVisibility();
      void visibility.hide(clientPromise).catch(() => {});
    };
  }, [attempt, t]);

  useEffect(() => {
    restartingRef.current = restarting;
  }, [restarting]);

  useEffect(() => {
    nativeSurfacesVisibleRef.current = nativeSurfacesVisible;
  }, [nativeSurfacesVisible]);

  useEffect(() => {
    const wasRestarting = restartWasInFlightRef.current;
    restartWasInFlightRef.current = restarting;
    const settled = settleDshNativeSurfaceRestartProjection({
      wasRestarting,
      restarting,
      succeeded: restartSucceededRef.current,
      visible: nativeSurfacesVisibleRef.current,
      syncVisibility: (visible, allowInitialOpenFallback) => (
        syncVisibilityRef.current?.(visible, allowInitialOpenFallback)
      ),
      deliverOpenIntent: () => deliverOpenIntentRef.current?.(),
    });
    if (settled) restartSucceededRef.current = false;
  }, [restarting]);

  useEffect(() => {
    if (restartRequest <= 0 || restartRequest <= handledRestartRequestRef.current) return;
    handledRestartRequestRef.current = restartRequest;
    onRestartAccepted?.(restartRequest);
    restartSucceededRef.current = false;
    setError("");
    void (async () => {
      const mount = mountRef.current;
      if (!mount) throw new Error("dsh-native-surface-not-open");
      const client = await createDefaultDshNativeSurfaceClient();
      await client.restart(boundsOf(mount));
      resetDshBackgroundPreload();
      if (!routeMountedRef.current) {
        await client.hide().catch(() => undefined);
        return;
      }
      restartSucceededRef.current = true;
    })().catch(() => {
      if (routeMountedRef.current) setError(t("error.open"));
    }).finally(() => {
      onRestartSettled?.(restartRequest);
    });
  }, [onRestartAccepted, onRestartSettled, restartRequest, t]);

  useEffect(() => {
    syncVisibilityRef.current?.(nativeSurfacesVisible);
  }, [attempt, nativeSurfacesVisible]);

  // Watchdog surfacing: a surface can pass carrier-ready and then freeze (the
  // plugin-tree failure mode). The host reports it as unavailable; the
  // service-layer availability watch retires the dead native child (so the
  // HTML recovery panel is not covered by the stale webview) and promotes
  // the failure. Polling lives in the service so this page stays timer-free.
  useEffect(() => {
    // Normal cold-host preparation transiently reports "Host reset". Only
    // monitor after THIS attempt has attached, never during readiness/open.
    if (attachedAttempt !== attempt || error || restarting) return;
    return watchDshNativeSurfaceFailure(
      availabilityWatchClient,
      createDefaultDshPluginCompatClient,
      setError,
    );
  }, [attachedAttempt, attempt, error, restarting]);

  return (
    <div className="dsh-native-surface-layout">
      <div ref={mountRef} className="dsh-native-surface-mount">
        {(restarting || error || attachedAttempt !== attempt) && <div className={`dsh-native-surface-placeholder${error ? " is-error" : ""}`} aria-live="polite">
          <div className="dsh-native-surface-placeholder-content">
            {error && !restarting ? null : <span className="dsh-native-surface-loading-mark" aria-hidden="true" />}
            <span>{restarting ? t("status.restarting") : error || t("status.opening")}</span>
            {error && !restarting ? (
              <>
                <button
                  type="button"
                  disabled={compatBusy}
                  onClick={retrySurface}
                >
                  {t("action.retry")}
                </button>
                <div className="dsh-plugin-compat-panel" data-testid="dsh-plugin-compat-panel">
                  <p className="dsh-plugin-compat-title">{t("compat.title")}</p>
                  <p className="dsh-plugin-compat-intro">
                    {compat?.compatMode ? `${t("compat.modeOn")} ` : ""}
                    {t("compat.intro")}
                  </p>
                  {compat === null ? null : compat.plugins.length === 0 ? (
                    <p>{t("compat.none")}</p>
                  ) : (
                    <ul className="dsh-plugin-compat-list">
                      {compat.plugins.map((plugin) => (
                        <li key={`${plugin.packageName}/${plugin.entryId}`}>
                          <span className="dsh-plugin-compat-name">
                            {plugin.packageName}
                            {plugin.version ? `@${plugin.version}` : ""}
                          </span>
                          <span className="dsh-plugin-compat-outcome">
                            {t(COMPAT_REASON_COPY[dshPluginCompatReasonToken(plugin)])}
                          </span>
                          {plugin.quarantined ? (
                            <button
                              type="button"
                              disabled={compatBusy}
                              onClick={() => {
                                void createDefaultDshPluginCompatClient().then((client) => (
                                  runCompatAction(() => client.apply({ kind: "restore", entryId: plugin.entryId }), false)
                                ));
                              }}
                            >
                              {t("compat.restore")}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="dsh-plugin-compat-limited">{t("compat.limited")}</p>
                  {compatError ? <p className="dsh-plugin-compat-error" role="alert">{compatError}</p> : null}
                  <div className="dsh-plugin-compat-actions">
                    <button
                      type="button"
                      disabled={compatBusy}
                      onClick={() => {
                        void createDefaultDshPluginCompatClient().then((client) => (
                          runCompatAction(() => client.apply({ kind: "compatible" }), true)
                        ));
                      }}
                    >
                      {compatBusy ? t("compat.starting") : t("compat.start")}
                    </button>
                    <button
                      type="button"
                      disabled={compatBusy}
                      onClick={() => {
                        void createDefaultDshPluginCompatClient().then((client) => (
                          runCompatAction(() => client.check(false), false)
                        ));
                      }}
                    >
                      {compatBusy ? t("compat.rechecking") : t("compat.recheck")}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>}
      </div>
      {personalBrowserOpen ? (
        <aside className="ai-personal-browser-sidebar" aria-label={t("browser.aria")}>
          <BrowserPage embedded visible={nativeSurfacesVisible} />
        </aside>
      ) : null}
      {contentBrowserOpen ? <LightSeekContentBrowser /> : null}
      {intentError && !error ? <div className="dsh-native-surface-intent-error" role="alert">
        <p>{intentError}</p>
        {uncertainIntentId ? <button type="button" onClick={() => {
          if (!allowNewOpenInLightSeekActionAfterReview(uncertainIntentId)) return;
          setUncertainIntentId(null);
          setIntentError(t("error.intentReviewed"));
        }}>{t("action.intentReviewed")}</button> : null}
      </div> : null}
    </div>
  );
}
