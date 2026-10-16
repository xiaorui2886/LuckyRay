// Edge/Chrome discovery, launch and teardown for the S1 runtime fixture.
//
// Hard rules from Issue #13 §5A / §4:
//   - Windows prefers an installed Microsoft Edge, Chrome as fallback;
//   - every run gets a brand-new temporary user-data-dir, never a real profile;
//   - the runner refuses any user-data-dir argument that points at a known
//     real Chrome/Edge/Chromium profile location;
//   - the browser instance is always closed and the temp profile removed;
//   - no dependency on browser instances the user already has open.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS_CANDIDATES = [
  {
    product: "Microsoft Edge",
    executables: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
  {
    product: "Google Chrome",
    executables: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
];

// Marker substrings of real browser profile directories. The fixture must
// never point Chromium at one of these (or anything that looks like them).
const REAL_PROFILE_MARKERS = [
  "google\\chrome\\user data",
  "microsoft\\edge\\user data",
  "chromium\\user data",
  "\\user data\\default",
  "\\user data\\profile",
];

export function discoverBrowser() {
  const override = process.env.LUCKYRAY_TEST_BROWSER_PATH;
  if (override) {
    if (!fs.existsSync(override)) {
      // Basename only — the env value may point into a real user directory.
      const basename = path.basename(String(override).replace(/[\\/]+$/, ""));
      throw new Error(
        `LUCKYRAY_TEST_BROWSER_PATH points at a missing executable ("${basename}")`,
      );
    }
    return { product: "override", executable: override };
  }
  for (const candidate of WINDOWS_CANDIDATES) {
    for (const executable of candidate.executables) {
      if (fs.existsSync(executable)) return { product: candidate.product, executable };
    }
  }
  throw new Error(
    "No installed Microsoft Edge or Google Chrome found. Install Edge (preferred) or Chrome, "
    + "or set LUCKYRAY_TEST_BROWSER_PATH to an Edge/Chrome executable.",
  );
}

export function assertNotRealProfileDir(profileDir) {
  const normalized = String(profileDir || "").replace(/\//g, "\\").toLowerCase();
  for (const marker of REAL_PROFILE_MARKERS) {
    if (normalized.includes(marker)) {
      // Contract (Issue #13 §6): never print a real absolute user path, not
      // even in diagnostics. Only the matched marker and the path basename
      // (e.g. "User Data") are surfaced.
      const basename = path.basename(String(profileDir || "").replace(/[\\/]+$/, ""));
      throw new Error(
        `Refusing to run the fixture against a real browser profile (matched marker "${marker}", `
        + `path "${basename}"). The S1 fixture only ever uses a fresh temp user-data-dir.`,
      );
    }
  }
}

export function assertNoRealProfileArguments(argv) {
  for (const argument of Array.from(argv || [])) {
    if (!String(argument).startsWith("--user-data-dir=")) continue;
    const value = String(argument).slice("--user-data-dir=".length);
    assertNotRealProfileDir(value);
  }
}

const BASE_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-popup-blocking",
  "--mute-audio",
  "--disable-features=Translate,OptimizationHints,MediaRouter",
  "--window-size=1280,800",
  "--remote-debugging-port=0",
  "--remote-allow-origins=*",
];

function launchArguments(profileDir, extensionPath, headless) {
  const flags = [...BASE_FLAGS];
  if (headless) flags.push("--headless=new");
  flags.push(
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "about:blank",
  );
  return flags;
}

export async function readDevToolsActivePort(profileDir, timeoutMs = 30_000) {
  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const content = fs.readFileSync(activePortFile, "utf8").trim();
      const [port, ...rest] = content.split(/\r?\n/);
      const wsPath = rest.join("").trim();
      if (/^\d+$/.test(port) && wsPath) return { port: Number(port), wsPath };
    } catch (_) {
      // File not written yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // No absolute path in the diagnostic (Issue #13 §6).
  throw new Error(`DevToolsActivePort was not created within ${timeoutMs}ms`);
}

export async function launchChromium({ browser, extensionPath, headless = true }) {
  assertNoRealProfileArguments(process.argv);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "luckyray-browser-ext-"));
  assertNotRealProfileDir(profileDir);
  const args = launchArguments(profileDir, extensionPath, headless);
  let child;
  try {
    child = spawn(browser.executable, args, {
      stdio: "ignore",
      windowsHide: headless,
    });
  } catch (error) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    // Basename only — the executable path may live under a real user dir.
    const basename = path.basename(String(browser.executable || "").replace(/[\\/]+$/, ""));
    throw new Error(`Failed to start browser executable "${basename}" (${error.code || error.message})`);
  }
  let wsUrl = null;
  try {
    const { port, wsPath } = await readDevToolsActivePort(profileDir);
    wsUrl = `http://127.0.0.1:${port}${wsPath}`;
  } catch (error) {
    child.kill();
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }
  return {
    child,
    profileDir,
    wsUrl,
    product: browser.product,
    executable: browser.executable,
  };
}

export function processAlive(child) {
  return child && typeof child.exitCode !== "number" && typeof child.signalCode !== "string";
}

export async function stopChromium({ child, profileDir }) {
  // The caller closes the browser gracefully over CDP first when possible.
  if (processAlive(child)) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
  // Windows: Edge helper processes can hold the profile directory open for a
  // moment after the main process exits. Retry the removal instead of letting
  // a transient lock abort the caller's finally chain (a leaked fake
  // transport would then poison the next test's isolation guard). A leftover
  // temp profile is preferable to a hard failure here; it is test-owned and
  // disposable, never a real user profile.
  for (let attempt = 0; attempt < 6 && fs.existsSync(profileDir); attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_) {
      // Transient directory lock — retry.
    }
  }
  return !fs.existsSync(profileDir);
}
