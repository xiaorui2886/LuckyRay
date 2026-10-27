(function installLuckyRayNativeSurfaceState(root, build) {
  const observer = build();
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = observer;
    return;
  }
  const loader = root.window?.__ModuleLoader__;
  if (!loader || typeof loader.load !== "function") {
    throw new Error("dsh-native-surface-state-install-invalid");
  }
  // Official 0.1.5 combines many modules into one script URL. Registration
  // identity is the package name, never the current script pathname.
  loader.load({ id: "@luckyray/dsh-native-surface-state", factory: () => observer.clientModule });
})(globalThis, function buildLuckyRayNativeSurfaceState() {
  "use strict";

  const STATE_PATH = "/_luckyray/surface-state";
  const BOOT_MARKER = 'globalThis["__DSH_BOOT__"] = ';
  const CONVERSATION_ID = "@deepseek-ai/dsh-client-ui-conversation";
  const STATE_ID = "@luckyray/dsh-native-surface-state";
  const MAX_BOUND_SESSIONS = 64;
  const OPEN_INTENT_PATH = "/_luckyray/open-intent";
  const OPEN_INTENT_WAKE_EVENT = "luckyray:open-intent";
  const OPEN_INTENT_SOURCES = new Set(["materials", "notes", "collection", "graph", "search"]);
  const OPEN_INTENT_LOCAL_RESOURCE_SOURCES = new Set(["materials", "notes", "collection"]);
  const OPEN_INTENT_IMAGE_ATTACHMENT_SOURCES = new Set(["materials", "notes"]);
  const MAX_OPEN_INTENT_LOCAL_RESOURCES = 64;
  const MAX_OPEN_INTENT_LOCAL_PATH_BYTES = 4 * 1024;
  const MAX_OPEN_INTENT_FILE_BYTES = 200 * 1024 * 1024;
  const OPEN_INTENT_POLL_MS = 250;
  const UPDATE_PATH = "/_luckyray/desktop-update";

  function createUpdateClient(sessions, conversation, request, document) {
    let composing = false;
    let locked = false;
    let previousInert = false;
    let running = false;
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; };
    document.addEventListener("compositionstart", compositionStart, true);
    document.addEventListener("compositionend", compositionEnd, true);
    const restore = () => {
      if (locked) document.body.inert = previousInert;
      locked = false;
    };
    return Object.freeze({
      async poll() {
        if (running) return;
        running = true;
        try {
          const response = await request(UPDATE_PATH, { credentials: "same-origin" });
          if (response.status === 204) { restore(); return; }
          if (!response.ok) throw new Error("update-lsh-client-unavailable");
          const ticket = await response.json();
          if (typeof ticket.id !== "string" || !Number.isSafeInteger(ticket.generation)) throw new Error("update-lsh-client-unavailable");
          if (!locked) {
            previousInert = document.body.inert;
            document.body.inert = true;
            locked = true;
          }
          let reason = composing ? "update-lsh-composition-pending" : null;
          const inventory = sessions.list.getSnapshot();
          // Catalog membership does not retain a browser Session generation.
          // Include retained subagent fallbacks, not just Host-list ids. Zero
          // official references + no scope proves no resident composer exists;
          // missing ownership data or a still-loading list never proves idle.
          const ids = inventory?.phase === "ready" && Array.isArray(inventory.ids)
            && inventory.byId && typeof inventory.byId === "object" && !Array.isArray(inventory.byId)
            ? Object.keys(inventory.byId) : null;
          if (!ids) reason = "update-lsh-client-unavailable";
          let residentCount = 0;
          for (const id of ids ?? []) {
            const references = sessions.retainInfo?.(id)?.getSnapshot?.()?.referenceCount;
            const actx = sessions.scope(id);
            if (references === 0 && actx === undefined) continue;
            if (++residentCount > MAX_BOUND_SESSIONS) { reason = "update-lsh-client-unavailable"; break; }
            const session = actx && sessions.sessionOf?.(actx)?.getSnapshot?.();
            if (!Number.isSafeInteger(references) || references <= 0 || !session
              || session.sessionId !== id || session.openState !== "open"
              || typeof session.running !== "boolean" || !Array.isArray(session.pendingSubmissions)) {
              reason = "update-lsh-client-unavailable";
              continue;
            }
            if (session.running || session.pendingSubmissions.length > 0) reason ??= "update-lsh-task-active";
            const snapshot = actx && conversation.input.for(actx)?.state?.getSnapshot?.();
            if (!snapshot || typeof snapshot.draft !== "string" || !Array.isArray(snapshot.attachmentIds)
              || !["plain", "claimed", "adjudicating", "submitting"].includes(snapshot.phase)) {
              reason = "update-lsh-client-unavailable";
            } else if (snapshot.draft.length > 0 || snapshot.attachmentIds.length > 0
              || ["adjudicating", "submitting"].includes(snapshot.phase)) {
              reason ??= "update-lsh-draft-pending";
            }
          }
          const ack = await request(UPDATE_PATH, { method: "POST", credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...ticket, ready: reason === null, reason }) });
          if (!ack.ok) throw new Error("update-lsh-client-unavailable");
        } finally { running = false; }
      },
      dispose() {
        restore();
        document.removeEventListener("compositionstart", compositionStart, true);
        document.removeEventListener("compositionend", compositionEnd, true);
      },
    });
  }

  // 0.1.5 replaced the eager boot graph with lazy module materialization:
  // execution order now follows each package's dsh.client.inject declaration
  // (sessions from @deepseek-ai/dsh-api-session-controller, conversation from
  // @deepseek-ai/dsh-client-ui-conversation). This tap neither reorders
  // entries nor asserts graph positions; it fail-closed asserts the observer
  // and its conversation dependency are present exactly once.
  function assertLuckyRayStateGraphOrder(html) {
    if (typeof html !== "string") throw new Error("dsh-native-surface-state-graph-invalid");
    const markerAt = html.indexOf(BOOT_MARKER);
    if (markerAt < 0 || html.indexOf(BOOT_MARKER, markerAt + BOOT_MARKER.length) >= 0) {
      throw new Error("dsh-native-surface-state-graph-invalid");
    }
    const jsonAt = markerAt + BOOT_MARKER.length;
    const scriptEnd = html.indexOf("</script>", jsonAt);
    if (scriptEnd < 0) throw new Error("dsh-native-surface-state-graph-invalid");
    let graph;
    try {
      graph = JSON.parse(html.slice(jsonAt, scriptEnd).trim());
    } catch {
      throw new Error("dsh-native-surface-state-graph-invalid");
    }
    if (!graph || !Array.isArray(graph.entries)) throw new Error("dsh-native-surface-state-graph-invalid");
    const count = (id) => graph.entries.filter((entry) => entry?.id === id).length;
    if (count(CONVERSATION_ID) !== 1 || count(STATE_ID) !== 1) {
      throw new Error("dsh-native-surface-state-graph-invalid");
    }
    return html;
  }

  function isSessionFace(value) {
    // Official SessionFace contract: ObservableSnapshot<ConversationSnapshot>.
    // The concrete openState lives inside getSnapshot(); it is never read as a
    // direct property of the face.
    return value !== null && typeof value === "object"
      && typeof value.getSnapshot === "function"
      && typeof value.subscribe === "function";
  }

  // Session-open is true iff at least one bounded observed official Session
  // snapshot reports openState === "open". Client readiness is a module fact
  // and never depends on a session existing.
  function projectBoundSessions(boundSessions) {
    let sessionOpen = null;
    for (const [id, session] of boundSessions) {
      const snapshot = session.getSnapshot();
      if (snapshot?.openState === "open") {
        sessionOpen = id;
        break;
      }
    }
    return Object.freeze({ clientReady: true, sessionOpen });
  }

  function createStateReporter(postState) {
    if (typeof postState !== "function") throw new Error("dsh-native-surface-state-invalid");
    let last = null;
    let delivery = Promise.resolve();
    return Object.freeze({
      report(state) {
        if (last !== null && last.clientReady === state.clientReady
          && last.sessionOpen === state.sessionOpen) return;
        last = Object.freeze({ ...state });
        delivery = delivery.then(() => postState(last)).catch(() => undefined);
      },
      settled() { return delivery; },
    });
  }

  // Reconciles bounded per-session subscriptions against the official session
  // list. Each bound SessionFace subscription lets loading->open, reconnect
  // resync, and later session-local changes republish without requiring a
  // sessions.list mutation; removed sessions are unsubscribed exactly once.
  function createSessionObserver(sessions, report) {
    if (typeof report !== "function") throw new Error("dsh-native-surface-state-invalid");
    if (!sessions || typeof sessions.list?.getSnapshot !== "function"
      || typeof sessions.list?.subscribe !== "function"
      || typeof sessions.binding !== "function") {
      throw new Error("dsh-native-surface-state-sessions-invalid");
    }
    const boundSessions = new Map();
    const disposables = new Map();
    let disposed = false;
    const publish = () => {
      if (!disposed) report(projectBoundSessions(boundSessions));
    };
    const reconcile = () => {
      if (disposed) return;
      const snapshot = sessions.list.getSnapshot();
      const ids = Array.isArray(snapshot?.ids) ? snapshot.ids.slice(0, MAX_BOUND_SESSIONS) : [];
      const visible = new Set();
      for (const id of ids) {
        if (typeof id !== "string" || id.length === 0 || id.length > 128) continue;
        if (visible.has(id)) continue;
        visible.add(id);
        if (boundSessions.has(id)) continue;
        const session = sessions.binding(id)?.session;
        if (!isSessionFace(session)) continue;
        const dispose = session.subscribe(publish);
        boundSessions.set(id, session);
        if (typeof dispose === "function") disposables.set(id, dispose);
      }
      for (const id of [...boundSessions.keys()]) {
        if (!visible.has(id)) {
          const dispose = disposables.get(id);
          if (typeof dispose === "function") dispose();
          disposables.delete(id);
          boundSessions.delete(id);
        }
      }
      publish();
    };
    return Object.freeze({
      reconcile,
      boundSessions,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const dispose of disposables.values()) {
          if (typeof dispose === "function") dispose();
        }
        disposables.clear();
        boundSessions.clear();
      },
    });
  }

  function absoluteLocalPath(value) {
    return /^[a-z]:[\\/]/iu.test(value)
      || /^\\\\(?:\?\\)?[^\\/]+[\\/][^\\/]+/u.test(value)
      || value.startsWith("/");
  }

  function parseOpenIntentLocalResources(source, resources) {
    if (!Array.isArray(resources) || resources.length > MAX_OPEN_INTENT_LOCAL_RESOURCES
      || resources.length > 0 && !OPEN_INTENT_LOCAL_RESOURCE_SOURCES.has(source)) {
      throw new Error("dsh-open-intent-invalid");
    }
    return Object.freeze(resources.map((resource) => {
      if (!resource || !["assetId,canonicalPath,delivery,kind", "assetId,canonicalPath,delivery,kind,libraryId"].includes(Object.keys(resource).sort().join(","))
      || resource.libraryId !== undefined && (typeof resource.libraryId !== "string" || !resource.libraryId || resource.libraryId.length > 256
        || resource.libraryId.trim() !== resource.libraryId || /[\u0000-\u001f\u007f]/u.test(resource.libraryId))
        || resource.kind !== "material"
        || !["image-attachment", "file-attachment", "path-reference"].includes(resource.delivery)
        || resource.delivery !== "path-reference" && !OPEN_INTENT_IMAGE_ATTACHMENT_SOURCES.has(source)
        || typeof resource.assetId !== "string" || resource.assetId.length === 0 || resource.assetId.length > 256
        || resource.assetId.trim() !== resource.assetId || /[\u0000-\u001f\u007f]/u.test(resource.assetId)
        || typeof resource.canonicalPath !== "string" || resource.canonicalPath.length === 0
        || resource.canonicalPath.trim() !== resource.canonicalPath
        || new TextEncoder().encode(resource.canonicalPath).byteLength > MAX_OPEN_INTENT_LOCAL_PATH_BYTES
        || /[\u0000-\u001f\u007f]/u.test(resource.canonicalPath)
        || !absoluteLocalPath(resource.canonicalPath)) {
        throw new Error("dsh-open-intent-invalid");
      }
      return Object.freeze({
        kind: "material",
        assetId: resource.assetId,
      ...(resource.libraryId === undefined ? {} : { libraryId: resource.libraryId }),
        canonicalPath: resource.canonicalPath,
        delivery: resource.delivery,
      });
    }));
  }

  function formatOpenIntentDraft(intent) {
    const paths = intent.localResources
      .filter((resource) => resource.delivery === "path-reference")
      .map((resource) => resource.canonicalPath);
    if (paths.length === 0) return intent.text;
    return intent.text ? `${intent.text}\n${paths.join("\n")}` : paths.join("\n");
  }

  function localFileName(value) {
    const normalized = value.replace(/\\/gu, "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
    return name || "image";
  }

  function imageLimitsForSession(sessions, sessionId) {
    const session = sessions.binding?.(sessionId)?.session;
    const limits = session?.projections?.faceOf?.("imageLimits")?.getSnapshot?.();
    if (!limits || !Number.isSafeInteger(limits.maxImageBytes) || limits.maxImageBytes <= 0
      || !Number.isSafeInteger(limits.maxImagesPerMessage) || limits.maxImagesPerMessage <= 0
      || !Number.isSafeInteger(limits.maxMessageImageBytes) || limits.maxMessageImageBytes <= 0
      || !Array.isArray(limits.mediaTypes) || limits.mediaTypes.length === 0) {
      throw new Error("dsh-open-intent-image-limits-unavailable");
    }
    return limits;
  }

  async function createOpenIntentImages(intent, sessionId, sessions, conversation, input, request, stillCurrent) {
    const resources = intent.localResources
      .map((resource, index) => ({ resource, index }))
      .filter(({ resource }) => resource.delivery !== "path-reference");
    if (resources.length === 0) return [];
    if (typeof conversation?.createDrafts !== "function"
      || typeof conversation?.resolveDraftAttachments !== "function"
      || typeof conversation?.releaseDraftAttachments !== "function"
      || typeof input?.addAttachments !== "function"
      || typeof input?.removeAttachment !== "function") {
      throw new Error("dsh-open-intent-client-invalid");
    }
    const imageCount = resources.filter(({ resource }) => resource.delivery === "image-attachment").length;
    const limits = imageCount ? imageLimitsForSession(sessions, sessionId) : null;
    const snapshot = input.state.getSnapshot();
    const currentAttachments = conversation.resolveDraftAttachments(Array.isArray(snapshot?.attachmentIds) ? snapshot.attachmentIds : []).filter((attachment) => attachment.kind === "image");
    if (limits && currentAttachments.length + imageCount > limits.maxImagesPerMessage) {
      throw new Error("dsh-open-intent-images-too-many");
    }
    let totalBytes = currentAttachments.reduce((sum, attachment) => sum + (attachment?.file?.size || 0), 0);
    let fileBytes = 0;
    const files = [];
    for (const { resource, index } of resources) {
      const path = `${OPEN_INTENT_PATH}-resource/${encodeURIComponent(intent.intentId)}/${index}`;
      const response = await request(path, { method: "GET", credentials: "same-origin" });
      if (!stillCurrent()) throw new Error("dsh-open-intent-session-changed");
      if (!response.ok) throw new Error("dsh-open-intent-image-read-failed");
      const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      const declaredLength = Number(response.headers.get("content-length"));
      const isImage = resource.delivery === "image-attachment";
      const maxBytes = isImage ? limits.maxImageBytes : MAX_OPEN_INTENT_FILE_BYTES;
      if (response.headers.get("content-length") === null
        || !Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes
        || (isImage ? !limits.mediaTypes.includes(mediaType) || declaredLength === 0
          || totalBytes + declaredLength > limits.maxMessageImageBytes
          : mediaType !== "application/octet-stream" || fileBytes + declaredLength > MAX_OPEN_INTENT_FILE_BYTES)) {
        throw new Error("dsh-open-intent-image-rejected");
      }
      const blob = await response.blob();
      if (!stillCurrent()) throw new Error("dsh-open-intent-session-changed");
      if (blob.size !== declaredLength) {
        throw new Error("dsh-open-intent-image-rejected");
      }
      if (isImage) totalBytes += blob.size;
      else fileBytes += blob.size;
      files.push(new File([blob], localFileName(resource.canonicalPath), { type: mediaType }));
    }
    if (!stillCurrent()) throw new Error("dsh-open-intent-session-changed");
    const attachments = conversation.createDrafts(sessionId, files);
    if (attachments.length !== files.length) {
      conversation.releaseDraftAttachments(attachments);
      throw new Error("dsh-open-intent-image-create-failed");
    }
    return attachments;
  }

  function parseOpenIntent(value) {
    const localResources = value && OPEN_INTENT_SOURCES.has(value.source)
      ? parseOpenIntentLocalResources(value.source, value.localResources)
      : null;
    if (!value || Object.keys(value).sort().join(",") !== "intentId,localResources,source,text"
      || typeof value.intentId !== "string"
      || !/^intent-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(value.intentId)
      || value.intentId.length > 64
      || !OPEN_INTENT_SOURCES.has(value.source)
      || typeof value.text !== "string" || value.text.trim() !== value.text
      || value.text.length === 0 && localResources?.length === 0
      || new TextEncoder().encode(value.text).byteLength > 12 * 1024
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)) {
      throw new Error("dsh-open-intent-invalid");
    }
    return Object.freeze({
      intentId: value.intentId,
      localResources,
      source: value.source,
      text: value.text,
    });
  }

  function createOpenIntentConsumer(sessions, conversation, request, eventTarget, selectedSession, updateClient = null) {
    if (!sessions || typeof sessions.list?.getSnapshot !== "function"
      || typeof sessions.list?.subscribe !== "function" || typeof sessions.scope !== "function"
      || typeof conversation?.input?.for !== "function" || typeof request !== "function"
      || typeof eventTarget?.addEventListener !== "function"
      || typeof eventTarget?.removeEventListener !== "function"
      || typeof selectedSession?.getSnapshot !== "function"
      || typeof selectedSession?.subscribe !== "function") {
      throw new Error("dsh-open-intent-client-invalid");
    }
    let disposed = false;
    let running = null;
    let trailing = false;
    let appliedIntentId = null;
    let claimedIntentId = null;
    let claimedSessionId = null;
    let imageLimitsSessionId = null;
    let imageLimitsFace = null;
    let unsubscribeImageLimits = null;
    // The official Session list is an inventory ({byId, phase}), not the
    // selected-session authority. uiSession.current is the public renderer
    // binding source and remains correct across workspace/session switches.
    const currentSessionId = () => selectedSession.getSnapshot()?.key;

    const run = async () => {
      if (disposed) return;
      if (running) {
        trailing = true;
        return running;
      }
      const current = currentSessionId();
      if (typeof current !== "string" || current.length === 0 || current.length > 128) return;
      const actx = sessions.scope(current);
      if (!actx) return;
      running = (async () => {
        const response = await request(OPEN_INTENT_PATH, { method: "GET", credentials: "same-origin" });
        if (response.status === 204) return;
        if (!response.ok) throw new Error("dsh-open-intent-delivery-failed");
        const intent = parseOpenIntent(await response.json());
        if (claimedIntentId !== intent.intentId) {
          claimedIntentId = intent.intentId;
          claimedSessionId = current;
        }
        if (claimedSessionId !== current) throw new Error("dsh-open-intent-session-changed");
        if (currentSessionId() !== current) {
          trailing = true;
          return;
        }
        const input = conversation.input.for(actx);
        if (!input || typeof input.setDraft !== "function"
          || typeof input.state?.getSnapshot !== "function") {
          throw new Error("dsh-open-intent-client-invalid");
        }
        if (appliedIntentId !== intent.intentId) {
          const before = input.state.getSnapshot();
          const existing = before?.draft;
          const priorAttachmentIds = Array.isArray(before?.attachmentIds) ? [...before.attachmentIds] : null;
          const stillCurrent = () => !disposed && currentSessionId() === current;
          if (!stillCurrent() || typeof existing !== "string" || priorAttachmentIds === null
            || ["adjudicating", "submitting"].includes(before?.phase)) {
            throw new Error("dsh-open-intent-composer-changed");
          }
          const incoming = formatOpenIntentDraft(intent);
          const draft = typeof existing === "string" && existing.trim().length > 0
            ? incoming ? `${existing.trimEnd()}\n\n${incoming}` : existing
            : incoming;
          const attachments = await createOpenIntentImages(intent, current, sessions, conversation, input, request, stillCurrent);
          let draftApplied = false;
          try {
            const beforeCommit = input.state.getSnapshot();
            if (!stillCurrent() || beforeCommit?.draft !== existing
              || JSON.stringify(beforeCommit?.attachmentIds) !== JSON.stringify(priorAttachmentIds)
              || ["adjudicating", "submitting"].includes(beforeCommit?.phase)) {
              throw new Error("dsh-open-intent-composer-changed");
            }
            input.setDraft(draft);
            draftApplied = true;
            if (attachments.length > 0
              && !input.addAttachments(attachments.map((attachment) => attachment.id))) {
              throw new Error("dsh-open-intent-image-add-failed");
            }
            const committed = input.state.getSnapshot();
            if (!stillCurrent() || committed?.draft !== draft
              || !Array.isArray(committed.attachmentIds)
              || attachments.some((attachment) => !committed.attachmentIds.includes(attachment.id))) {
              throw new Error("dsh-open-intent-draft-not-applied");
            }
          } catch (error) {
            for (const attachment of attachments) input.removeAttachment(attachment.id);
            conversation.releaseDraftAttachments(attachments);
            if (draftApplied && input.state.getSnapshot()?.draft === draft) input.setDraft(existing);
            throw error;
          }
          appliedIntentId = intent.intentId;
        }
        if (currentSessionId() !== current) {
          throw new Error("dsh-open-intent-session-changed");
        }
        const acknowledged = await request(OPEN_INTENT_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intentId: intent.intentId }),
        });
        if (!acknowledged.ok) {
          throw new Error("dsh-open-intent-delivery-failed");
        }
        claimedIntentId = null;
        claimedSessionId = null;
      })().finally(() => {
        running = null;
        const rerun = trailing;
        trailing = false;
        if (rerun && !disposed) void run().catch(() => undefined);
      });
      return running;
    };
    const wake = () => {
      if (updateClient) void updateClient.poll().catch(() => undefined);
      void run().catch(() => undefined);
    };
    const refreshImageLimitsSubscription = () => {
      const current = currentSessionId();
      const nextFace = typeof current === "string"
        ? sessions.binding?.(current)?.session?.projections?.faceOf?.("imageLimits")
        : null;
      if (current === imageLimitsSessionId && nextFace === imageLimitsFace) return;
      if (typeof unsubscribeImageLimits === "function") unsubscribeImageLimits();
      imageLimitsSessionId = typeof current === "string" ? current : null;
      imageLimitsFace = nextFace || null;
      unsubscribeImageLimits = typeof nextFace?.subscribe === "function"
        ? nextFace.subscribe(wake)
        : null;
    };
    const wakeFromSessionList = () => {
      refreshImageLimitsSubscription();
      wake();
    };
    const unsubscribeList = sessions.list.subscribe(wakeFromSessionList);
    const unsubscribeSelection = selectedSession.subscribe(wakeFromSessionList);
    eventTarget.addEventListener(OPEN_INTENT_WAKE_EVENT, wake);
    // The native carrier and this persistent browser surface do not share an
    // in-process event target. Keep a small local poll as the delivery clock;
    // session/projection events remain the immediate fast path.
    const pollHandle = globalThis.setInterval(wake, OPEN_INTENT_POLL_MS);
    refreshImageLimitsSubscription();
    wake();
    return Object.freeze({
      run,
      dispose() {
        disposed = true;
        if (typeof unsubscribeList === "function") unsubscribeList();
        if (typeof unsubscribeSelection === "function") unsubscribeSelection();
        if (typeof unsubscribeImageLimits === "function") unsubscribeImageLimits();
        globalThis.clearInterval(pollHandle);
        eventTarget.removeEventListener(OPEN_INTENT_WAKE_EVENT, wake);
      },
    });
  }

  function selectedSessionSource(uiSession) {
    // The frozen predecessor keeps the binding source on the scoped adapter.
    return uiSession?.current ?? uiSession?.adapter?.current;
  }

  function apply(ctx) {
    const sessions = ctx.get("sessions");
    const conversation = ctx.get("conversation");
    const uiSession = ctx.get("uiSession");
    const selectedSession = selectedSessionSource(uiSession);
    if (!sessions || !selectedSession || typeof ctx.effect !== "function" || typeof ctx.on !== "function") {
      throw new Error("dsh-native-surface-state-sessions-unavailable");
    }
    const reporter = createStateReporter(async (state) => {
      const response = await fetch(STATE_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!response.ok) throw new Error("dsh-native-surface-state-delivery-failed");
    });
    const observer = createSessionObserver(sessions, (state) => reporter.report(state));
    const unsubscribeList = sessions.list.subscribe(() => observer.reconcile());
    const removeReset = ctx.on("connection/reset", () => observer.reconcile());
    const updateClient = createUpdateClient(sessions, conversation, fetch, globalThis.document);
    const intentConsumer = createOpenIntentConsumer(sessions, conversation, fetch, globalThis, selectedSession, updateClient);
    observer.reconcile();
    ctx.effect(() => () => {
      if (typeof removeReset === "function") removeReset();
      if (typeof unsubscribeList === "function") unsubscribeList();
      observer.dispose();
      intentConsumer.dispose();
      updateClient.dispose();
    }, "luckyray: native surface state observer");
  }

  const clientModule = Object.freeze({
    inject: Object.freeze(["sessions", "conversation", "uiSession"]),
    apply,
  });
  return Object.freeze({
    STATE_PATH,
    clientModule,
    createSessionObserver,
    createStateReporter,
    createOpenIntentConsumer,
    createUpdateClient,
    selectedSessionSource,
    formatOpenIntentDraft,
    assertLuckyRayStateGraphOrder,
    projectBoundSessions,
    apply(ctx) {
      const webServer = ctx?.get?.("webServer");
      if (typeof ctx?.provide !== "function" || typeof ctx?.effect !== "function"
        || typeof webServer?.tapIndex !== "function") throw new Error("dsh-native-surface-state-host-invalid");
      ctx.provide("luckyrayNativeSurfaceState", Object.freeze({ version: 1 }));
      ctx.effect(
        () => webServer.tapIndex(assertLuckyRayStateGraphOrder),
        "luckyray: native surface state graph order",
      );
    },
  });
});
