import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoUrl = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoUrl), "utf8");
}

const ordinaryIcons = [
  ["knowledge-library.svg", "1 0 22 22", 1.833333, 18],
  ["knowledge-graph.svg", "1.6 1.65 20.5 20.5", 1.708333, 18],
  ["canvas.svg", "0 0 24 24", 2, 18],
  ["community.svg", "1 0 22 22", 1.833333, 18],
  ["tag.svg", "1 1 22 22", 1.833333, 18],
  ["favorite.svg", "3.9 0.6 16.2 16.2", 1.35, 18],
  ["smart-folder.svg", "0.5 0.4 23 23", 1.916667, 18],
  ["collection.svg", "1 1 22 22", 1.833333, 18],
  ["settings.svg", "0 0 24 24", 2, 18],
  ["sidebar-collapse.svg", "1 1 22 22", 2.0625, 16],
  ["sidebar-expand.svg", "1 1 22 22", 2.0625, 16],
] as const;

test("main navigation uses the approved icon mapping without changing untouched entries", async () => {
  const sidebar = await source("src/app/AppSidebar.tsx");
  const messages = await source("src/core/i18n/index.ts");

  const mappings = [
    ["notes", "知识库", "knowledgeLibraryIconUrl"],
    ["graph", "图谱", "knowledgeGraphIconUrl"],
    ["canvas", "画布", "canvasIconUrl"],
    ["community", "社区", "communityIconUrl"],
    ["tags", "标签", "tagIconUrl"],
    ["favorites", "收藏", "favoriteIconUrl"],
    ["smart", "智能文件夹", "smartFolderIconUrl"],
    ["collection", "收集箱", "collectionIconUrl"],
  ] as const;
  for (const [id, label, icon] of mappings) {
    assert.match(
      sidebar,
      new RegExp(`id: "${id}", labelKey: "sidebar.route.${id === "smart" ? "smartFolders" : id}", icon: <MaskedSidebarIcon src=\\{${icon}\\}`),
    );
    assert.match(messages, new RegExp(`"sidebar.route.${id === "smart" ? "smartFolders" : id}": "${label}"`));
  }

  assert.match(sidebar, /id: "ai", labelKey: "sidebar.route.ai", icon: <MaskedSidebarIcon src=\{lightSeekHarnessMarkUrl\} brand \/>/);
  assert.match(messages, /"sidebar.route.ai": "LightSeek harness"/);
  assert.match(sidebar, /id: "materials", labelKey: "sidebar.route.materials", icon: <IconGrid \/>/);
  assert.match(messages, /"sidebar.route.materials": "素材库"/);
  assert.doesNotMatch(sidebar, /function IconInbox\(/);
  const header = await source("src/app/SidebarBrandHeader.tsx");
  assert.match(header, /collapsed \? sidebarExpandIconUrl : sidebarCollapseIconUrl/);
  assert.match(sidebar, /collapsed=\{effectiveCollapsed\}/);
  assert.doesNotMatch(sidebar, /Downloads|LuckyRay-SVG-1to1|LightSeek_UI_Icons_v2/);
});

test("each ordinary navigation asset has its bounded optical crop and a 1.5px rendered stroke", async () => {
  for (const [filename, viewBox, strokeWidth, boxSize] of ordinaryIcons) {
    const svg = await source(`src/assets/icons/lightseek-ui-v2/${filename}`);
    assert.match(svg, new RegExp(`viewBox="${viewBox.replaceAll(".", "\\.")}"`));
    assert.match(svg, /fill="none"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, new RegExp(`stroke-width="${strokeWidth.toString().replace(".", "\\.")}"`));
    const viewBoxWidth = Number(viewBox.split(" ")[2]);
    const renderedStroke = strokeWidth * boxSize / viewBoxWidth;
    assert.ok(Math.abs(renderedStroke - 1.5) < 0.00001, `${filename} renders a ${renderedStroke}px stroke`);
    assert.doesNotMatch(svg, /<(?:script|image|foreignObject)\b|\b(?:href|xlink:href)=/i);
  }
});

test("LightSeek harness mark remains transparent, proportional, and contained by the shared icon box", async () => {
  const [logo, css] = await Promise.all([
    source("src/assets/branding/lightseek-harness-mark.svg"),
    source("src/app/appShell.css"),
  ]);

  assert.match(logo, /<svg[^>]+width="800"[^>]+height="800"[^>]+viewBox="219 197 800 800"/);
  assert.equal(logo.match(/<path\b/g)?.length, 14);
  assert.doesNotMatch(logo, /<(?:script|image|foreignObject|rect)\b|\b(?:href|xlink:href)=/i);
  assert.match(css, /\.sidebar-masked-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*background:\s*currentColor;[^}]*mask:\s*var\(--sidebar-icon-url\) center \/ contain no-repeat;/s);
  assert.match(css, /\.lightseek-harness-mark\s*\{[^}]*background:\s*none;[^}]*mask:\s*none;/s);
  assert.match(css, /\.lightseek-harness-mark::before,\s*\.react-nav-shell \.lightseek-harness-mark::after\s*\{[^}]*inset:\s*0;[^}]*background:\s*currentColor;[^}]*mask:\s*var\(--sidebar-icon-url\) center \/ contain no-repeat;/s);
  assert.doesNotMatch(css, /\.lightseek-harness-mark[^}]*transform:/s);
  assert.match(css, /\.sidebar-toggle \.sidebar-toggle-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/s);
});

test("navigation geometry, animation, and DSH internal LightSeek brand stay unchanged", async () => {
  const [sidebar, css, dshBrand] = await Promise.all([
    source("src/app/AppSidebar.tsx"),
    source("src/app/appShell.css"),
    source("src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js"),
  ]);

  assert.match(css, /--sidebar-w:\s*220px;/);
  assert.match(css, /data-density="compact"[^}]+--sidebar-w:\s*210px;/s);
  assert.match(css, /data-density="loose"[^}]+--sidebar-w:\s*236px;/s);
  assert.match(css, /\.sidebar\.collapsed\s*\{[^}]*width:\s*60px;[^}]*min-width:\s*60px;/s);
  assert.match(css, /\.nav-item\s*\{[^}]*gap:\s*10px;[^}]*padding:\s*7px 10px;/s);
  assert.match(css, /transition:\s*width var\(--transition\), min-width var\(--transition\), transform var\(--transition\);/);
  assert.match(css, /--transition:\s*200ms cubic-bezier\(0\.25, 0\.1, 0\.25, 1\);/);
  assert.match(sidebar, /<SidebarBrandHeader[\s\S]*?onToggle=\{toggle\}/);
  assert.doesNotMatch(sidebar, /className="sidebar-toggle" onClick=\{toggle\}/);
  assert.match(dshBrand, /children:\s*"LightSeek"/);
  assert.doesNotMatch(dshBrand, /LightSeek harness/);
});
