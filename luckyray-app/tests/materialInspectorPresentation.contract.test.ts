import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = (path: string) => readFile(process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT
  ? resolve(process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT, path)
  : new URL(`../${path}`, import.meta.url), "utf8");

test("the inspector uses the shared FavoriteGlyph rating interaction", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const inspector = page.slice(page.indexOf("function MaterialsDetailPanel("), page.indexOf("function AssetContextMenu("));

  assert.match(inspector, /role="radiogroup"[^>]*aria-label="素材评分"/u);
  assert.match(inspector, /role="radio"[\s\S]*aria-checked=\{draftRating === rating\}/u);
  assert.match(inspector, /rating <= previewDetailRating \? " filled" : ""/u);
  assert.match(inspector, /<FavoriteGlyph filled=\{rating <= previewDetailRating\}/u);
  assert.match(inspector, /onKeyDown=\{\(event\) => moveDetailRatingFocus\(event, rating\)\}/u);
  assert.match(inspector, /setDraftRating\(\(current\) => current === rating \? null : rating\)/u);
  assert.doesNotMatch(inspector, />\s*★\s*</u);
});

test("inspector hierarchy keeps description and its AI suggestion together while path presentation is absent", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const inspector = page.slice(page.indexOf("function MaterialsDetailPanel("), page.indexOf("function AssetContextMenu("));
  const title = inspector.indexOf(">标题</label>");
  const description = inspector.indexOf(">描述</label>");
  const rating = inspector.indexOf(">评分</div>");
  const tags = inspector.indexOf(">标签</div>");
  const palette = inspector.indexOf(">主色</div>");
  const fileInfo = inspector.indexOf(">文件信息</div>");
  const actions = inspector.indexOf("detail-action-grid-react");
  const ai = inspector.indexOf(">AI 建议</span>");
  const notes = inspector.indexOf(">关联笔记</div>");

  assert.ok([title, description, rating, tags, palette, fileInfo, actions, ai, notes].every((position) => position >= 0));
  assert.ok(title < description && description < ai && ai < rating && rating < tags && tags < palette);
  assert.ok(palette < fileInfo && fileInfo < actions && actions < notes);
  assert.doesNotMatch(inspector, /detail-path-(?:block|heading|value)-react|detail-copy-btn-react|copyPath|复制路径/u);
  assert.match(inspector, /const assetPath = asset\.libraryPath \|\| asset\.originalPath \|\| ""/u);
  assert.match(inspector, /onClick=\{openInExplorer\} disabled=\{!assetPath\}>文件管理器/u);
  assert.match(inspector, /onClick=\{relocateAssetPath\} disabled=\{relocating\}/u);
  assert.match(inspector, /<button onClick=\{\(\) => onOpen\(asset\)\}>打开<\/button>/u);
  assert.match(inspector, /aria-label="素材描述"/u);
});

test("the single AI generation trigger belongs to Description and preserves suggestion projections", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const inspector = page.slice(page.indexOf("function MaterialsDetailPanel("), page.indexOf("function AssetContextMenu("));
  const description = inspector.indexOf(">描述</label>");
  const trigger = inspector.indexOf("onClick={generateAiSuggestion}");
  const textarea = inspector.indexOf('aria-label="素材描述"');
  const aiSection = inspector.indexOf(">AI 建议</span>");

  assert.equal((inspector.match(/onClick=\{generateAiSuggestion\}/gu) || []).length, 1);
  assert.ok(description >= 0 && description < trigger && trigger < textarea && textarea < aiSection);
  assert.ok(aiSection < inspector.indexOf(">评分</div>"));
  assert.match(inspector, /\{aiLoading \? "生成中" : "AI 生成"\}/u);
  assert.match(inspector, /setDraftDescription\(generatedDescription\)/u);
  assert.match(inspector, /setAiSelectedTags\(Array\.isArray\(suggestion\?\.auto_tags\)/u);
  assert.doesNotMatch(inspector.slice(aiSection), /onClick=\{generateAiSuggestion\}/u);
});

test("AI generation and tag actions form a true compact metadata cluster", async () => {
  const css = await source("src/features/materials/materials.css");
  const generateRule = css.match(/\.ai-suggest-btn-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const tagRule = css.match(/\.detail-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const addTagRule = css.match(/\.detail-add-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const headingRule = css.match(/\.detail-field-heading-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const suggestionTagRule = css.match(/\.ai-suggest-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const scopedGenerateRule = css.match(/\.react-nav-shell \.ai-suggest-btn-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const scopedSuggestionTagRule = css.match(/\.react-nav-shell \.ai-suggest-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const scopedTagRule = css.match(/\.react-nav-shell \.detail-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const scopedAddTagRule = css.match(/\.react-nav-shell \.detail-add-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const inlineActionRule = css.match(/\.detail-ai-inline-react \.detail-primary-btn-react,\s*\.detail-ai-inline-react \.detail-secondary-btn-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const inlinePrimaryRule = css.match(/\.detail-ai-inline-react \.detail-primary-btn-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const inlineSecondaryRule = [...css.matchAll(/\.detail-ai-inline-react \.detail-secondary-btn-react\s*\{([^}]*)\}/gs)].at(-1)?.[1] ?? "";

  assert.match(headingRule, /justify-content:\s*flex-start;/u);
  assert.match(generateRule, /height:\s*20px;/u);
  assert.match(generateRule, /padding:\s*0 7px;/u);
  assert.match(generateRule, /border-radius:\s*5px;/u);
  assert.match(generateRule, /font-size:\s*10px;/u);
  assert.match(generateRule, /line-height:\s*1;/u);
  for (const rule of [tagRule, addTagRule]) {
    assert.match(rule, /height:\s*20px;/u);
    assert.match(rule, /border-radius:\s*5px;/u);
    assert.match(rule, /font-size:\s*10px;/u);
    assert.match(rule, /line-height:\s*1;/u);
  }
  assert.match(suggestionTagRule, /height:\s*20px;/u);
  assert.match(suggestionTagRule, /font-size:\s*10px;/u);
  assert.doesNotMatch(suggestionTagRule, /min-height:\s*24px;/u);
  for (const rule of [scopedGenerateRule, scopedSuggestionTagRule, scopedTagRule, scopedAddTagRule]) {
    assert.match(rule, /height:\s*20px;/u);
    assert.match(rule, /font-size:\s*10px;/u);
    assert.match(rule, /line-height:\s*1;/u);
  }
  assert.match(scopedGenerateRule, /font-weight:\s*600;/u);
  assert.match(scopedSuggestionTagRule, /font-weight:\s*500;/u);
  assert.match(inlineActionRule, /height:\s*22px;/u);
  assert.match(inlineActionRule, /font-size:\s*10px;/u);
  assert.match(inlinePrimaryRule, /border:\s*1px solid rgba\(250, 204, 21, 0\.28\);/u);
  assert.match(inlinePrimaryRule, /background:\s*rgba\(250, 204, 21, 0\.16\);/u);
  assert.match(inlinePrimaryRule, /color:\s*var\(--accent\);/u);
  assert.match(inlineSecondaryRule, /border:\s*1px solid rgba\(255, 255, 255, 0\.08\);/u);
  assert.match(inlineSecondaryRule, /background:\s*rgba\(255, 255, 255, 0\.045\);/u);
  assert.match(inlineSecondaryRule, /color:\s*var\(--text-secondary\);/u);
});

test("file information derives honest resolution from the already rendered original media", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const inspector = page.slice(page.indexOf("function MaterialsDetailPanel("), page.indexOf("function AssetContextMenu("));
  const viewer = page.slice(page.indexOf("function MaterialViewer("), page.indexOf("function ImportProgressOverlay("));

  assert.match(viewer, /const \[mediaDimensionsSnapshot, setMediaDimensionsSnapshot\] = useState<MaterialMediaDimensionsSnapshot \| null>\(null\)/u);
  assert.match(viewer, /width:\s*event\.currentTarget\.naturalWidth,\s*height:\s*event\.currentTarget\.naturalHeight/u);
  assert.match(viewer, /width:\s*event\.currentTarget\.videoWidth,\s*height:\s*event\.currentTarget\.videoHeight/u);
  assert.match(viewer, /const imagePreviewUrl = asset\.previewUrl \|\| asset\.thumbnailUrl \|\| ""/u);
  assert.match(page, /\{\(mediaDimensions\) => viewerMode === "detail" \? \(/u);
  assert.match(page, /resolution=\{mediaDimensions\}/u);
  assert.match(inspector, /resolution: MaterialMediaDimensions \| null/u);
  assert.match(inspector, /<span>分辨率<\/span><b>\{resolution \? `\$\{resolution\.width\} × \$\{resolution\.height\}` : "—"\}<\/b>/u);
});

test("description uses a three-line CSS-sized field with a bounded internal scroll", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);
  const inspector = page.slice(page.indexOf("function MaterialsDetailPanel("), page.indexOf("function AssetContextMenu("));

  assert.match(inspector, /<textarea[^>]*className="detail-textarea-react"[^>]*rows=\{3\}[^>]*aria-label="素材描述"/u);
  assert.match(css, /\.detail-textarea-react\s*\{[^}]*field-sizing:\s*content;[^}]*min-height:\s*(?:6[4-9]|7\d)px;[^}]*max-height:\s*(?:1[5-7]\d|180)px;[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(inspector, /ResizeObserver|scrollHeight|requestAnimationFrame|setTimeout/u);
});

test("detail tabs are compact segmented controls without a duplicated taxonomy title", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);
  const inspector = page.slice(page.indexOf("function MaterialsDetailPanel("), page.indexOf("function AssetContextMenu("));
  const taxonomy = inspector.slice(inspector.indexOf('activeTab === "inspector"'), inspector.indexOf("</aside>"));

  assert.match(inspector, /className="detail-tabs-react" role="tablist" aria-label="素材详情视图"/u);
  assert.match(inspector, /role="tab"[\s\S]*aria-selected=\{activeTab === "inspector"\}/u);
  assert.match(inspector, /role="tab"[\s\S]*aria-selected=\{activeTab === "taxonomy"\}/u);
  assert.doesNotMatch(taxonomy, /className="detail-section-title">分类详情<\/div>/u);
  assert.match(css, /\.detail-tabs-react\s*\{[^}]*padding:\s*3px;[^}]*border:\s*1px solid var\(--border-subtle\);[^}]*border-radius:\s*9px;/s);
});

test("add tag and missing-material actions use the compact approved icon language", async () => {
  const [page, css, retryIcon, closeIcon] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
    source("src/assets/icons/lightseek-ui-v2/sync-retry.svg"),
    source("src/assets/icons/lightseek-ui-v2/close.svg"),
  ]);

  assert.match(page, /className="detail-add-tag-react"[\s\S]*>\s*添加\s*<\/button>/u);
  assert.doesNotMatch(page, />\s*\+ 添加\s*<\/button>/u);
  const tagRule = css.match(/\.detail-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  const addTagRule = css.match(/\.detail-add-tag-react\s*\{([^}]*)\}/s)?.[1] ?? "";
  for (const rule of [tagRule, addTagRule]) {
    assert.match(rule, /height:\s*20px;/u);
    assert.match(rule, /border-radius:\s*5px;/u);
    assert.match(rule, /font-size:\s*10px;/u);
    assert.match(rule, /line-height:\s*1;/u);
  }
  assert.match(addTagRule, /background:\s*rgba\(255, 255, 255, \.025\);/u);

  assert.match(page, /className="missing-rescan-react"[\s\S]*material-action-icon-react sync-retry[\s\S]*重新扫描/u);
  assert.match(page, /className="missing-close-react"[\s\S]*material-action-icon-react close/u);
  assert.match(css, /\.missing-rescan-react\s*\{[^}]*height:\s*26px;[^}]*border-radius:\s*7px;/s);
  assert.match(css, /\.missing-close-react\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;[^}]*border-radius:\s*7px;/s);
  assert.match(css, /\.missing-rescan-react \.material-action-icon-react\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s);
  assert.match(css, /\.missing-close-react \.material-action-icon-react\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/s);

  for (const icon of [retryIcon, closeIcon]) {
    assert.match(icon, /viewBox="0 0 24 24"/u);
    assert.match(icon, /stroke="currentColor"/u);
    assert.match(icon, /stroke-linecap="round"/u);
    const withoutSvgNamespace = icon.replace('xmlns="http://www.w3.org/2000/svg"', "");
    assert.doesNotMatch(withoutSvgNamespace, /<script|<image|\bhref=|https?:|data:/iu);
  }
});
