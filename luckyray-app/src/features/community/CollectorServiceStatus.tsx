import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../core/i18n/index";
import { CommunityIcon } from "./CommunityPresentation";

/** Presentation moved from Settings. This reads the existing bridge; it never starts or binds a service. */
export default function CollectorServiceStatus() {
  const { t } = useI18n();
  const [ready, setReady] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const attempt = ++generation.current;
    setChecking(true);
    let available = false;
    try {
      const baseUrl = await window.__LUCKYRAY__?.getCollectionServerBaseUrl?.();
      available = typeof baseUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl);
    } catch {
      // A failed read is unavailable, never an instruction to restart or re-pair.
    } finally {
      if (generation.current === attempt) {
        setReady(available);
        setChecking(false);
        inFlight.current = false;
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; inFlight.current = false; };
  }, [refresh]);

  return <section className="community-collector-service" aria-busy={checking}>
    <div className="community-collector-service-heading">
      <h3>{t("settings.general.collection.service.label")}</h3>
      <span className={`community-status${!checking && ready ? " is-on" : !checking && ready === false ? " is-unavailable" : ""}`} role="status" aria-live="polite" aria-atomic="true">
        {checking ? t("settings.general.collection.service.checking") : ready ? t("settings.general.collection.service.ready") : t("settings.general.collection.service.unavailable")}
      </span>
      <button type="button" className="lr-cap-run secondary" disabled={checking} onClick={() => void refresh()}><CommunityIcon name="refresh" />{t("common.action.refresh")}</button>
    </div>
    <p>{t("settings.general.collection.service.description")}</p>
  </section>;
}
