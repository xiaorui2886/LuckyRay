import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";

const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const absentOrEmptyDirectory = (path) => {
  const target = new URL(`../${path}`, import.meta.url);
  if (!existsSync(target)) return true;
  return statSync(target).isDirectory() && readdirSync(target).length === 0;
};

test("retained browser and media runtimes use the neutral owned-process authority", () => {
  const browser = text("src-tauri/src/agent_browser/runtime.rs");
  const media = text("src-tauri/src/media_transfer.rs");

  assert.match(browser, /crate::owned_process::\{spawn_in_owned_job, AtomicSpawn, OwnedJob, OwnedProcess\}/);
  assert.doesNotMatch(browser, /crate::agent_engine/);
  assert.match(media, /crate::owned_process::spawn_in_owned_job/);
  assert.doesNotMatch(media, /crate::agent_engine/);
});

test("production no longer exposes the retired AgentEngine execution truth", () => {
  const lib = text("src-tauri/src/lib.rs");
  const backend = text("src-tauri/src/backend/mod.rs");

  for (const source of [lib, backend]) {
    assert.doesNotMatch(source, /mod agent_engine|crate::agent_engine|agent_engine_(?:start|read|stop|abort|resolve|open|capabilities|set_browser)|\.agent_engine\(\)/);
    assert.doesNotMatch(source, /agent_engine_warm_runtime|AGENT_ENGINE_WARM_RUNTIME_SETTING/);
  }
});

test("reachable React surfaces do not import retired AgentEngine clients or controls", () => {
  for (const path of [
    "src/CanvasSpike.tsx",
    "src/app/AppSidebar.tsx",
    "src/features/community/CommunityPage.tsx",
    "src/features/settings/SettingsPage.tsx",
  ]) {
    const source = text(path);
    assert.doesNotMatch(source, /services\/agentEngine|AgentOperationsCenter|sharedAgentEngine|createAgentEngineClient|agentEngineClient/);
  }

  const sidebar = text("src/app/AppSidebar.tsx");
  assert.doesNotMatch(sidebar, /agentRunList|agentRunStop|agentScheduleNotificationList|运行记录|定时任务通知/);
  const community = text("src/features/community/CommunityPage.tsx");
  assert.match(community, /listCapabilities/);
  assert.doesNotMatch(community, /runCapability|restartAgent|resolveApproval|schedule\.manual_trigger|AgentOperationsCenter/);
  const settings = text("src/features/settings/SettingsPage.tsx");
  assert.doesNotMatch(settings, /agentWarmRuntime|Agent 启动加速|后台准备 Agent/);
});

test("retained Canvas generation uses its direct adapters without the retired Canvas Agent route", () => {
  const canvas = text("src/CanvasSpike.tsx");
  assert.match(canvas, /createCanvasGenerationTask/);
  assert.match(canvas, /executeCanvasGenerationTask/);
  assert.match(canvas, /createCanvasTextGenerationAdapter/);
  assert.match(canvas, /createCanvasImageGenerationAdapter/);
  assert.match(canvas, /createCanvasVideoGenerationAdapter/);
  assert.doesNotMatch(canvas, /Canvas Agent|sharedAgentEngine|setCanvasAgentOpen|setCanvasAgentPrompt/);
});

test("Hermes vendor, preparation, debug staging, and unreachable AI presentation are absent", () => {
  for (const path of [
    "third_party/hermes-engine",
    "src-tauri/src/agent_engine",
    "src/features/ai/presentation",
  ]) {
    assert.equal(absentOrEmptyDirectory(path), true, `${path} must have no remaining payload`);
  }

  for (const path of [
    "scripts/prepare-hermes-engine.ps1",
    "scripts/prepare-agent-engine-runtime.ps1",
    "scripts/build-agent-v1-portable.ps1",
    "src-tauri/tests/fixtures/agent_engine_mock_child.rs",
    "src/core/services/agentEngine.ts",
    "src/core/services/agentBrowser.ts",
    "src/features/ai/AiPage.tsx",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} must be retired`);
  }

  const build = text("src-tauri/build.rs");
  assert.doesNotMatch(build, /agent[-_]engine|Hermes/i);
});
