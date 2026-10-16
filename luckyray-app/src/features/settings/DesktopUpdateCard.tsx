import { useMessages } from "../../core/i18n/index";
import { desktopUpdateMessages } from "./desktopUpdateMessages";
import type { InstallStatus } from "../../core/services/desktopUpdateInstall";
import DesktopInstallPanel from "./DesktopInstallPanel";
import { useEffect, useId, useRef, useState } from "react";
import { desktopUpdateSession, DESKTOP_LINKS, type DesktopUpdateResult } from "../../core/services/desktopUpdates";
import { useI18n } from "../../core/i18n/index";

export default function DesktopUpdateCard({ version, active, openLink }: {
  version: string; active: boolean; openLink: (label: string, url: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const { t: updateText } = useMessages(desktopUpdateMessages);
  const [nativeStatus,setNativeStatus]=useState<InstallStatus|null>(null);
  const nativeEnabled=Boolean(nativeStatus && nativeStatus.phase!=="disabled");
  const [automatic, setAutomatic] = useState(desktopUpdateSession.automatic);
  const [busy, setBusy] = useState(() => Boolean(desktopUpdateSession.pending(version)));
  const [result, setResult] = useState<DesktopUpdateResult | null>(() => desktopUpdateSession.result(version));
  const [dismissed, setDismissed] = useState(desktopUpdateSession.dismissed);
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  function observe(promise: Promise<DesktopUpdateResult>) {
    setBusy(true);
    void promise.then((value) => {
      if (!mounted.current) return;
      setResult(value);
      setBusy(false);
    });
  }
  useEffect(() => {
    mounted.current = true;
    setResult(desktopUpdateSession.result(version));
    const pending = desktopUpdateSession.pending(version);
    if (pending) observe(pending);
    return () => { mounted.current = false; };
  }, [version]);
  function check() {
    if (desktopUpdateSession.pending(version)) return;
    setDismissed(""); desktopUpdateSession.dismiss("");
    observe(desktopUpdateSession.check(version));
  }
  useEffect(() => {
    if (!active || !automatic || nativeStatus?.phase!=="disabled") return;
    const pending = desktopUpdateSession.checkAutomatically(version);
    if (pending) observe(pending);
  }, [active, automatic, version,nativeStatus]);
  const visible = result && !(result.status === "available" && result.release.version === dismissed);
  const available = visible && result.status === "available";
  const hasUpdate = nativeEnabled ? Boolean(nativeStatus && ["available","ready","scheduled"].includes(nativeStatus.phase)) : available;
  const description = nativeEnabled && nativeStatus ? updateText(nativeStatus.phase) : busy ? t("settings.update.checking")
    : available ? t("settings.update.entry.available", { version: result.release.version })
    : visible && result.status === "error" ? t("settings.update.entry.failed")
    : visible && result.status === "current" ? t("settings.update.entry.current")
    : t("settings.about.checkUpdates");
  function closePanel() {
    setExpanded(false);
    triggerRef.current?.focus();
  }
  return <>
    <button type="button" ref={triggerRef} id={`${panelId}-trigger`}
      className={`settings-link-card settings-update-entry${hasUpdate ? " has-update" : ""}`}
      aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)}
      onKeyDown={(event) => { if (expanded && event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 5.5A5.75 5.75 0 0 0 3 3.75L1.75 5.5M1.75 2v3.5h3.5M2.5 10.5A5.75 5.75 0 0 0 13 12.25l1.25-1.75M14.25 14v-3.5h-3.5" /></svg>
      <span className="settings-update-entry-copy">
        <span className="settings-link-name">{t("settings.update.title")}{hasUpdate && <span className="settings-update-dot" aria-hidden="true" />}</span>
        <span className="settings-link-desc" role="status" aria-live="polite">{description}</span>
      </span>
      <svg className="settings-update-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
    </button>
    <div id={panelId} className="settings-update-panel" hidden={!expanded} role="region" aria-labelledby={`${panelId}-trigger`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
      <div className="settings-update-heading">
        <span>{t("settings.update.title")}</span>
        <button type="button" className="settings-update-close" aria-label={t("common.action.close")} onClick={closePanel}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <DesktopInstallPanel active={active} visible={expanded} automatic={automatic} onStatus={setNativeStatus} />
      {!nativeEnabled && <p className="settings-update-description">{t("settings.update.manualInstall")}</p>}
      <div className="settings-update-preference">
        <span id={`${panelId}-automatic`}>{t("settings.update.automatic")}</span>
        <button type="button" role="switch" className={`toggle${automatic ? " on" : ""}`} aria-checked={automatic}
          aria-labelledby={`${panelId}-automatic`} title={t(automatic ? "settings.toggle.on" : "settings.toggle.off")}
          onClick={() => { setAutomatic(!automatic); desktopUpdateSession.setAutomatic(!automatic); }} />
      </div>
      <div className="settings-update-actions">
        {!nativeEnabled && <button type="button" className="settings-btn settings-btn-primary" disabled={busy} onClick={() => check()}>
          {t(busy ? "settings.update.checking" : "settings.about.checkUpdates")}
        </button>}
        <button type="button" className="settings-btn" onClick={() => void openLink(t("settings.update.download"), !nativeEnabled && result && result.status === "available" ? result.release.url : DESKTOP_LINKS.releases)}>{t("settings.update.download")}</button>
      </div>
      {!nativeEnabled && visible && <div className={`settings-update-status${result.status === "available" ? " has-update" : ""}`} role="status" aria-live="polite">
        <p>{result.status === "error" ? t(result.reason === "response-limit" ? "settings.update.responseLimit" : "settings.update.failed") : result.status === "available"
          ? t("settings.update.available", { version: result.release.version })
          : t("settings.update.current", { version })}</p>
        {result.status === "available" && <button type="button" className="settings-btn" onClick={() => {
          setDismissed(result.release.version); desktopUpdateSession.dismiss(result.release.version);
        }}>{t("settings.update.dismiss")}</button>}
      </div>}
    </div>
  </>;
}
