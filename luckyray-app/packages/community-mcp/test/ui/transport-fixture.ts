import type { McpStatus } from "../../../../src/features/community/mcp/model";
const installed = new URLSearchParams(location.search).get("installed") === "1";
let status: McpStatus = {
  revision: "fixture-1",
  phase: installed ? "installed" : "absent",
  version: installed ? "0.1.0-fixture" : null,
  packageAvailable: true,
  downloadBytes: 61436986,
  authorized: false,
  grant: null,
  configured: false,
  tunnelId: null,
  hasKey: false,
  connectOnLaunch: false,
  desktopReady: false,
  tunnelReady: false,
  lastWebCallAt: null,
  errorCode: null,
  libraries: [{ id: "assets", name: "我的素材库" }],
  vaults: [{ id: "notes", name: "我的知识库" }],
};
(window as any).__actions = [];
export async function invoke<T>(command: string, args?: any): Promise<T> {
  if (command === "community_mcp_status") return structuredClone(status) as T;
  if (command !== "community_mcp_action") throw "fixture-command-invalid";
  const input = args.input;
  (window as any).__actions.push({
    ...input,
    apiKey: input.apiKey ? "[redacted]" : null,
  });
  if (input.revision !== status.revision) throw "plugin-state-changed";
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (input.action === "install") {
    status.phase = "installed";
    status.version = "0.1.0-fixture";
  }
  if (input.action === "authorize") {
    status.authorized = true;
    status.grant = {
      libraryId: input.libraryId,
      vaultId: input.vaultId,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
  }
  if (input.action === "configure") {
    status.configured = true;
    status.tunnelId = input.tunnelId;
    status.hasKey = true;
  }
  if (input.action === "connect") {
    status.phase = "ready";
    status.desktopReady = true;
    status.tunnelReady = true;
  }
  if (input.action === "disconnect") status.phase = "stopped";
  if (input.action === "revoke") {
    status.phase = "stopped";
    status.authorized = false;
    status.grant = null;
    status.connectOnLaunch = false;
  }
  if (input.action === "preferences")
    status.connectOnLaunch = input.connectOnLaunch;
  if (input.action === "uninstall") {
    status = {
      ...status,
      phase: "absent",
      version: null,
      authorized: false,
      grant: null,
      configured: false,
      hasKey: false,
    };
  }
  status.revision += "x";
  return undefined as T;
}
export async function openUrl(url: string) {
  (window as any).__openedUrl = url;
}
