import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

// Run from luckyray-app using isolated QA dependencies. Tests the production
// header/CSS in a browser; AppSidebar persistence/compact state has a DOM suite.
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
try {
  const css = await readFile("src/app/appShell.css", "utf8");
  const logo = (await readFile("public/luckyray-logo.png")).toString("base64");
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {SidebarBrandHeader} from './src/app/SidebarBrandHeader';
    function Fixture() {
      const [collapsed,setCollapsed] = useState(false);
      return <aside className={'sidebar'+(collapsed?' collapsed':'')}>
        <SidebarBrandHeader collapsed={collapsed} onToggle={()=>setCollapsed(v=>!v)} expandLabel="展开" collapseLabel="收起"/>
        <nav id="main-sidebar-navigation" className="sidebar-nav"/>
      </aside>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".svg": "dataurl" } });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/luckyray-logo.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from(logo, "base64") }));
  await page.setContent(`<base href="https://sidebar.qa.invalid/"><style>
    html,body{margin:0}*{box-sizing:border-box}
    .react-nav-shell{--theme-sidebar-bg:#111114;--theme-text-muted:#8e8e96;--theme-hover:#222228;--theme-border-subtle:#333;--theme-border-strong:#444;--text-secondary:#aaa;--text-primary:#f0f0f2;--accent:#7c8aff;--accent-glow:transparent}
    ${css}
  </style><div id="root" class="react-nav-shell" data-sidebar-motion="manual"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const toggle = page.locator(".sidebar-brand-toggle"), icon = page.locator(".sidebar-brand-toggle-icon"), mark = page.locator(".sidebar-toggle-brand");
  await toggle.waitFor();
  assert.equal(await icon.evaluate(el => getComputedStyle(el).width), "20px");
  for (const density of ["compact", "normal", "loose"]) {
    await page.locator("#root").evaluate((el,density)=>el.setAttribute("data-density",density),density);
    await page.waitForTimeout(250);
    const [button,header] = await Promise.all([toggle.boundingBox(),page.locator(".sidebar-header").boundingBox()]);
    assert.ok(button.x >= header.x && button.x + button.width <= header.x + header.width, `${density} button fits`);
  }
  await toggle.click(); await page.mouse.move(600,400); await page.waitForTimeout(250);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await mark.evaluate(el=>getComputedStyle(el).opacity), "1");
  assert.equal(await icon.evaluate(el=>getComputedStyle(el).opacity), "0");
  await toggle.hover(); await page.waitForTimeout(150);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "hover must not expand");
  assert.equal(await icon.evaluate(el=>getComputedStyle(el).opacity), "1");
  assert.equal(await mark.evaluate(el=>getComputedStyle(el).opacity), "0");
  await toggle.click(); await page.mouse.move(600,400);
  await toggle.focus(); await page.keyboard.press("Space"); await page.waitForTimeout(250);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await toggle.evaluate(el=>el===document.activeElement), true);
  await page.keyboard.press("Enter"); await page.waitForTimeout(250);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await toggle.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const selector of [".sidebar-brand-toggle", ".sidebar-toggle-brand", ".sidebar-brand-toggle-icon"]) {
    assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).transitionDuration), "0s");
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#root").evaluate(el=>el.setAttribute("data-sidebar-motion","automatic"));
  assert.equal(await mark.evaluate(el=>getComputedStyle(el).transitionDuration), "0s");
  console.log("Sidebar brand browser geometry, hover, keyboard and motion PASS");
} finally { await browser.close(); }
