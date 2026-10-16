import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = (path: string) => readFile(process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT
  ? resolve(process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT, path)
  : new URL(`../${path}`, import.meta.url), "utf8");

test("the material viewer geometry follows the available main surface", async () => {
  const { resolveMaterialViewerBounds } = await import("../src/features/materials/materialViewerGeometry");
  assert.deepEqual(
    resolveMaterialViewerBounds({ left: 220, top: 0, right: 1600, bottom: 900 }, 58),
    { left: 220, top: 58, width: 1380, height: 842 },
  );
  assert.deepEqual(
    resolveMaterialViewerBounds({ left: 60, top: 0, right: 1600, bottom: 900 }, 58),
    { left: 60, top: 58, width: 1540, height: 842 },
  );
});

test("preview and detail are two modes of one bounded immersive viewer", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);

  assert.match(page, /type MaterialViewerMode = "preview" \| "detail"/);
  assert.match(page, /function MaterialViewer\(/);
  assert.match(page, /mode=\{viewerMode\}/);
  assert.match(page, /viewerMode === "detail"[\s\S]*<MaterialsDetailPanel/u);
  assert.match(page, /onClick:\s*\(asset:[\s\S]*openDetailViewer\(asset\)/u);
  assert.match(page, /onPreview:\s*openPreviewViewer/u);
  assert.match(page, /label:\s*t\("materials\.context\.open"\)[\s\S]*onSelect:\s*onOpen/u);
  assert.match(page, /resolveScopedShortcut\(event, "materials"[\s\S]*command === "materialsQuickPreview"[\s\S]*openPreviewViewer\(candidate\)/u);
  assert.match(page, /onDoubleClick=\{handleMediaDoubleClick\}/u);
  assert.match(page, /target\.closest\("button, a, input, textarea, select, video, audio, \[role='button'\]"\)/u);
  assert.match(page, /new ResizeObserver\(updateBounds\)/);
  assert.match(page, /boundsObserver\.observe\(main\)/);
  assert.match(css, /\.material-viewer-react\s*\{[^}]*left:\s*var\(--viewer-left[^}]*top:\s*var\(--viewer-top[^}]*width:\s*var\(--viewer-width[^}]*height:\s*var\(--viewer-height/s);
  assert.match(css, /\.material-viewer-surface\.detail\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(320px,\s*348px\)/s);
  assert.match(css, /container:\s*material-viewer \/ inline-size/u);
  assert.match(css, /@container material-viewer \(max-width:\s*860px\)[\s\S]*\.material-viewer-surface\.detail\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test("preview and detail fill the bounded main surface without a floating-card seam", async () => {
  const css = await source("src/features/materials/materials.css");

  assert.match(css, /\.material-viewer-react\s*\{[^}]*padding:\s*0;/s);
  assert.match(css, /\.material-viewer-surface\s*\{[^}]*box-sizing:\s*border-box;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(css, /@container material-viewer \(max-width:\s*620px\)[\s\S]*?\.material-viewer-react\s*\{[^}]*padding:/s);
  assert.doesNotMatch(css, /@container material-viewer \(max-width:\s*620px\)[\s\S]*?\.material-viewer-surface\s*\{[^}]*border-radius:/s);
});

test("only direct blank media-stage clicks dismiss detail mode", async () => {
  const { shouldDismissMaterialViewerFromBlank } = await import("../src/features/materials/materialViewerInteraction");
  const mediaSurface = {};
  const protectedImage = {};
  const protectedVideo = {};
  const protectedNavigation = {};
  const protectedInfo = {};

  assert.equal(shouldDismissMaterialViewerFromBlank("detail", mediaSurface, mediaSurface), true);
  for (const target of [protectedImage, protectedVideo, protectedNavigation, protectedInfo]) {
    assert.equal(shouldDismissMaterialViewerFromBlank("detail", mediaSurface, target), false);
  }
  assert.equal(shouldDismissMaterialViewerFromBlank("preview", mediaSurface, mediaSurface), false);

  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);
  assert.match(page, /className="material-viewer-media"[\s\S]*shouldDismissMaterialViewerFromBlank\(mode, event\.currentTarget, event\.target\)[\s\S]*onClose\(\)/u);
  assert.match(css, /\.qp-info-react\s*\{[^}]*pointer-events:\s*auto;/s);
  assert.match(css, /\.qp-media-stage-react\s*\{[^}]*pointer-events:\s*none;/s);
  const imageHitboxRule = css.match(/\.qp-media-stage-react img\s*\{[^}]*\}/s)?.[0] ?? "";
  const videoHitboxRule = css.match(/\.qp-media-stage-react video\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(imageHitboxRule, /width:\s*auto;[^}]*height:\s*auto;[^}]*pointer-events:\s*auto;/s);
  assert.match(videoHitboxRule, /width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain;[^}]*pointer-events:\s*auto;/s);
  assert.doesNotMatch(videoHitboxRule, /transform:\s*scale/u);
});

test("low and high resolution videos share one contained fit authority in detail and preview", async () => {
  const { resolveContainedMaterialMediaRect } = await import("../src/features/materials/materialViewerInteraction");
  const fixtures = [
    { label: "low-wide", intrinsic: { width: 320, height: 180 }, available: { width: 1280, height: 720 }, expected: { width: 1280, height: 720 } },
    { label: "low-tall", intrinsic: { width: 180, height: 320 }, available: { width: 900, height: 720 }, expected: { width: 405, height: 720 } },
    { label: "high-wide", intrinsic: { width: 3840, height: 2160 }, available: { width: 1280, height: 720 }, expected: { width: 1280, height: 720 } },
    { label: "sidebar-expanded", intrinsic: { width: 640, height: 360 }, available: { width: 1020, height: 700 }, expected: { width: 1020, height: 573.75 } },
  ];

  for (const mode of ["preview", "detail"] as const) {
    for (const fixture of fixtures) {
      assert.deepEqual(
        resolveContainedMaterialMediaRect(fixture.available, fixture.intrinsic),
        fixture.expected,
        `${mode}:${fixture.label}`,
      );
    }
  }
});

test("linked videos use their original file while masonry keeps the intrinsic media ratio", async () => {
  const { resolveMaterialVideoPlaybackPath } = await import("../src/features/materials/materialViewerInteraction");
  assert.equal(
    resolveMaterialVideoPlaybackPath({
      libraryPath: "C:\\LuckyRay\\managed.mp4",
      originalPath: "C:\\Downloads\\source.mp4",
    }),
    "C:\\LuckyRay\\managed.mp4",
  );
  assert.equal(
    resolveMaterialVideoPlaybackPath({ libraryPath: null, originalPath: "C:\\Downloads\\linked.mp4" }),
    "C:\\Downloads\\linked.mp4",
  );
  assert.equal(resolveMaterialVideoPlaybackPath({ libraryPath: null, originalPath: "" }), "");

  const page = await source("src/features/materials/MaterialsPage.tsx");
  assert.match(page, /const sourcePath = resolveMaterialVideoPlaybackPath\(asset\)/u);
  assert.doesNotMatch(page, /return asset\.thumbnailUrl \|\| "";/u);
  assert.match(page, /<HoverVideoPreview asset=\{asset\} className="asset-video-thumb-react" preserveAspectRatio \/>/u);
  assert.match(page, /const mediaAspectRatio = preserveAspectRatio \? intrinsicAspectRatio : null;/u);
  assert.doesNotMatch(page, /intrinsicAspectRatio \|\| 16 \/ 9/u);
  assert.match(page, /const ratio = video\.videoWidth \/ video\.videoHeight/u);
});

test("media dimensions are visible only for the current asset and source generation", async () => {
  const {
    resolveMaterialMediaDimensions,
    resolveMaterialVideoSource,
  } = await import("../src/features/materials/materialViewerInteraction");
  const loadedA = {
    assetId: "asset-a",
    sourceUrl: "asset://stable-a",
    sourceIdentity: "library://a\u001frevision-1",
    width: 1600,
    height: 1200,
  };

  assert.deepEqual(
    resolveMaterialMediaDimensions(loadedA, "asset-a", "asset://stable-a", "library://a\u001frevision-1"),
    { width: 1600, height: 1200 },
  );
  assert.equal(resolveMaterialMediaDimensions(loadedA, "asset-b", "asset://b-v1", "library://b\u001frevision-1"), null);
  assert.equal(resolveMaterialMediaDimensions(loadedA, "asset-a", "asset://a-v2", "library://a\u001frevision-1"), null);
  assert.equal(resolveMaterialMediaDimensions(loadedA, "asset-a", "asset://stable-a", "library://a\u001frevision-2"), null);

  const resolvedVideoA = {
    assetId: "asset-a",
    sourceIdentity: "library://a-v1",
    url: "asset://a-v1",
  };
  assert.equal(resolveMaterialVideoSource(resolvedVideoA, "asset-a", "library://a-v1"), "asset://a-v1");
  assert.equal(resolveMaterialVideoSource(resolvedVideoA, "asset-b", "library://b-v1"), "");
  assert.equal(resolveMaterialVideoSource(resolvedVideoA, "asset-a", "library://a-v2"), "");

  const page = await source("src/features/materials/MaterialsPage.tsx");
  const viewer = page.slice(page.indexOf("function MaterialViewer("), page.indexOf("function ImportProgressOverlay("));
  assert.match(viewer, /resolveMaterialMediaDimensions\(\s*mediaDimensionsSnapshot,\s*asset\.id,\s*mediaSourceUrl,\s*mediaSourceIdentity,?\s*\)/u);
  assert.match(viewer, /resolveMaterialVideoSource\(videoSourceSnapshot, asset\.id, videoSourceIdentity\)/u);
  assert.doesNotMatch(viewer, /\[previewUrl, setPreviewUrl\]/u);
  assert.match(viewer, /<ImagePreview\s+key=\{asset\.id\}[\s\S]*?sourceIdentity=\{imageSourceIdentity\}/u);
  const image = page.slice(page.indexOf("function ImagePreview("), page.indexOf("function AssetHoverControls("));
  assert.match(image, /<img key=\{identity\}/u);
  assert.doesNotMatch(viewer, /setMediaDimensions\(null\)/u);
});

test("the immersive viewer owns a bounded keyboard focus surface", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);

  assert.match(page, /className="materials-layout" inert=\{viewerAsset \? true : undefined\} aria-hidden=\{viewerAsset \? true : undefined\}/u);
  assert.doesNotMatch(page, /data-material-viewer-initial-focus/u);
  assert.doesNotMatch(page, /viewerRootRef\.current\?\.querySelector<HTMLElement>/u);
  assert.match(page, /viewerRootRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(page, /activeElement === viewerRootRef\.current/u);
  assert.match(page, /event\.key !== "Tab"/u);
  assert.match(page, /viewerReturnFocusRef\.current/u);
  assert.match(page, /focus\(\{ preventScroll: true \}\)/u);
  assert.match(page, /querySelectorAll<HTMLElement>\([\s\S]*a\[href\][\s\S]*button:not\(\[disabled\]\)[\s\S]*\[tabindex\]:not/u);
  assert.match(css, /\.material-viewer-react:focus\s*\{\s*outline:\s*none;/u);
});

test("opening and closing the viewer never reflows or scroll-corrects the material catalog", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);

  assert.doesNotMatch(page, /captureLayoutAnchor|pendingLayoutAnchorRef|anchorLockFrameRef/);
  assert.doesNotMatch(page, /container\.scrollTop\s*\+=/);
  assert.doesNotMatch(page, /materials-layout\$\{selectedAsset \? " detail-open"/);
  assert.doesNotMatch(css, /\.detail-panel\s*\{[^}]*(?<!-)width:\s*0/s);
  assert.doesNotMatch(css, /\.detail-panel\.open\s*\{[^}]*width:\s*var\(--detail-w\)/s);
  assert.match(css, /\.materials-layout\s*\{[^}]*display:\s*flex[^}]*height:\s*100%/s);
});

test("automatic compact changes are instant while manual sidebar changes keep the shared motion", async () => {
  const [shell, sidebar, shellCss, notesCss] = await Promise.all([
    source("src/app/AppShell.tsx"),
    source("src/app/AppSidebar.tsx"),
    source("src/app/appShell.css"),
    source("src/features/notes/notes.css"),
  ]);

  assert.match(shell, /type SidebarMotionIntent = "automatic" \| "manual"/);
  assert.match(shell, /data-sidebar-motion=\{sidebarMotionIntent\}/);
  assert.match(shell, /setSidebarMotionIntent\("automatic"\)/);
  assert.match(shell, /setSidebarMotionIntent\("manual"\)/);
  assert.match(sidebar, /onManualToggle\?\.\(\)/);
  assert.match(shellCss, /\.react-nav-shell\[data-sidebar-motion="automatic"\] \.sidebar\s*\{\s*transition:\s*none;/s);
  assert.match(notesCss, /\.react-nav-shell\[data-sidebar-motion="automatic"\][^}]*\.note-backlinks\s*\{[^}]*transition:\s*left 0s, width 220ms[^;]*flex-basis 220ms[^;]*!important;/s);
  assert.match(notesCss, /\.notes-index-resize-handle\s*\{\s*transition:\s*none !important;/s);
  assert.match(shellCss, /\.react-nav-shell \.sidebar\s*\{[^}]*transition:\s*width var\(--transition\), min-width var\(--transition\), transform var\(--transition\);/s);
});

test("the immersive video element box is sized to the contained media rectangle", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");

  // The stage is measured live so the video element box tracks the largest
  // contained media rectangle instead of covering the whole black stage.
  assert.match(page, /qpStageRef/u);
  assert.match(page, /setStageSize/u);
  assert.match(page, /resolveContainedMaterialMediaRect\(stageSize, mediaDimensions\)/u);

  // The video element adopts that rectangle once metadata is known; before
  // metadata arrives the object-fit CSS fallback still contains the frame.
  assert.match(page, /const containedVideoStyle =/u);
  assert.match(page, /style=\{containedVideoStyle\}/u);
  assert.match(page, /containedMediaRect\.width > 0 && containedMediaRect\.height > 0/u);
});
