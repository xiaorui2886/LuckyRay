(function (global) {
  "use strict";
  const MAX_BYTES = 64 * 1024;
  const NOISE = 'script,style,noscript,template,form,nav,footer,aside,iframe,object,embed,svg,button,input,select,textarea,[hidden],[aria-hidden="true"],[role="navigation"],[role="banner"],[role="contentinfo"],[inert]';
  const noiseName = /(?:^|[-_\s])(advert(?:isement)?|ads?|sponsor|sidebar|share|social|related|recommend|comment|cookie|newsletter|paywall|subscribe|subscription|breadcrumb|toolbar|menu)(?:$|[-_\s])/i;
  const escape = value => String(value || "").replace(/[\\`*_{}\[\]<>]/g, "\\$&");
  const text = value => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  function boundedTitle(value) {
    let result = "";
    for (const character of String(value || "").replace(/\s+/g, " ").trim()) {
      if (new TextEncoder().encode(result + character).length > 220) break;
      result += character;
    }
    return result;
  }
  function compactBlocks(markdown) {
    let fence = null, blank = false;
    const output = [];
    for (const line of markdown.split("\n")) {
      const marker = /^(`{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1].length >= fence.length && /^`+\s*$/.test(line)) fence = null;
      }
      if (!fence && !line.trim()) { if (blank) continue; blank = true; }
      else blank = false;
      output.push(line);
    }
    return output.join("\n").trim();
  }
  function url(value, base) {
    try {
      const u = new URL(value, base);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.href.length > 4096) return "";
      const secretKey = key => /^(token|auth|authorization|bearer|cookie|secret|signature|sig|access_token|api_key|apikey|x-amz-.+)$/i.test(key);
      if ([...u.searchParams.keys()].some(secretKey)) return "";
      let fragment = u.hash.slice(1);
      for (let depth = 0; depth < 2; depth++) fragment = decodeURIComponent(fragment);
      if (fragment.split(/[?&;]/).some(part => secretKey(part.split("=")[0]))) return "";
      return u.href;
    } catch (_) { return ""; }
  }
  function extract(doc, options = {}) {
    const base = options.url || doc.URL || global.location?.href || "";
    const images = [];
    let visited = 0;
    function visibleAncestors(node) {
      if (!doc.defaultView?.getComputedStyle) return true;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = doc.defaultView.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      }
      return true;
    }
    function clean(root) {
      const copy = root.cloneNode(true);
      // Read visibility from the live DOM only. Detached clones lose the site's
      // computed styles; hidden/paid content must not be recovered from them.
      const originals = [...root.querySelectorAll("*")];
      const clones = [...copy.querySelectorAll("*")];
      if (originals.length > 12000) throw new Error("article-complexity-limit");
      if (root.isConnected && doc.defaultView?.getComputedStyle) {
        for (let i = 0; i < originals.length; i++) {
          const style = doc.defaultView.getComputedStyle(originals[i]);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") clones[i]?.remove();
          else if (originals[i].tagName === "IMG" && originals[i].currentSrc) clones[i]?.setAttribute("src", originals[i].currentSrc);
        }
      }
      for (const node of copy.querySelectorAll(NOISE)) node.remove();
      for (const node of [...copy.querySelectorAll("*")].slice(0, 12000)) {
        if (noiseName.test(`${node.id || ""} ${node.className || ""}`)) node.remove();
      }
      return copy;
    }
    function render(node, depth = 0, listDepth = 0) {
      if (++visited > 16000 || depth > 48) throw new Error("article-complexity-limit");
      if (node.nodeType === 3) return escape(text(node.nodeValue).replace(/\s+/g, " "));
      if (node.nodeType !== 1 && node.nodeType !== 11) return "";
      const tag = (node.tagName || "").toLowerCase();
      const inner = () => [...node.childNodes].map(n => render(n, depth + 1, listDepth)).join("");
      if (tag === "br") return "  \n";
      if (tag === "hr") return "\n\n---\n\n";
      if (tag === "pre") {
        const code = text(node.textContent).replace(/\r\n?/g, "\n").replace(/\n$/, "");
        const runs = code.match(/`+/g) || [];
        const fence = "`".repeat(Math.max(3, ...runs.map(r => r.length + 1)));
        const language = /(?:language|lang)-([\w+-]{1,32})/.exec(node.querySelector("code")?.className || "")?.[1] || "";
        return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
      }
      if (tag === "code") {
        const code = text(node.textContent), runs = code.match(/`+/g) || [];
        const fence = "`".repeat(Math.max(1, ...runs.map(run => run.length + 1)));
        const padding = /^`|`$/.test(code) ? " " : "";
        return `${fence}${padding}${code}${padding}${fence}`;
      }
      if (tag === "img") {
        const src = url(node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-original"), base);
        if (!src || images.length >= 32) return "";
        images.push({ url: src, alt: text(node.getAttribute("alt")).slice(0, 300) });
        return `\n\n![${escape(node.getAttribute("alt"))}](<${src.replace(/[<>]/g, c => encodeURIComponent(c))}>)\n\n`;
      }
      if (tag === "a") {
        const label = inner().trim(); const href = url(node.getAttribute("href"), base);
        return href && label ? `[${label}](<${href.replace(/[<>]/g, c => encodeURIComponent(c))}>)` : label;
      }
      if (tag === "ul" || tag === "ol") {
        const start = Number(node.getAttribute("start")) || 1;
        const items = [...node.children].filter(n => n.tagName === "LI");
        const body = items.map((n, index) => {
          const item = [...n.childNodes].map(c => render(c, depth + 1, listDepth + 1)).join("").trim();
          const marker = tag === "ol" ? `${start + index}. ` : "- ";
          return marker + item.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
        }).join("\n");
        return `\n\n${body}\n\n`;
      }
      const raw = inner(), body = raw.trim();
      if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${body}\n\n`;
      if (tag === "blockquote") return `\n\n${body.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
      if (tag === "strong" || tag === "b") return `**${body}**`;
      if (tag === "em" || tag === "i") return `*${body}*`;
      if (["p", "div", "section", "article", "main", "figure", "figcaption", "table", "tr"].includes(tag)) return `\n\n${body}\n\n`;
      if (tag === "td" || tag === "th") return `${body} | `;
      return raw;
    }
    try {
      let root, kind = "article";
      const selection = options.selection ?? doc.defaultView?.getSelection?.();
      if (selection && String(selection).trim()) {
        kind = "selection";
        root = doc.createElement("div");
        // A Range fragment can include CSS-hidden descendants even when the
        // browser's visible selection does not. Selection fallback therefore
        // uses exactly the user-visible selected text, never hidden fragment HTML.
        root.textContent = String(selection);
      } else {
        const candidates = new Set([...doc.querySelectorAll('[itemprop="articleBody"],article,.RichContent-inner,.Post-RichText,.RichText,main,[role="main"]')].slice(0, 48));
        for (const p of [...doc.querySelectorAll("p")].slice(0, 160)) if ((p.textContent || "").length >= 80) candidates.add(p.parentElement);
        let bestScore = 0;
        for (const candidate of candidates) {
          if (!candidate || candidate.closest(NOISE) || noiseName.test(`${candidate.id || ""} ${candidate.className || ""}`)) continue;
          if (!visibleAncestors(candidate)) continue;
          if (candidate.getBoundingClientRect && candidate.getBoundingClientRect().height === 0) continue;
          const candidateStyle = doc.defaultView?.getComputedStyle?.(candidate);
          if (candidateStyle && (candidateStyle.display === "none" || candidateStyle.visibility !== "visible" || candidateStyle.opacity === "0")) continue;
          const clone = clean(candidate);
          const length = clone.textContent.trim().length;
          const links = [...clone.querySelectorAll("a")].reduce((sum, a) => sum + a.textContent.length, 0);
          const ratio = links / Math.max(length, 1);
          const paragraphs = clone.querySelectorAll("p,pre,blockquote,li").length;
          if (length < 80 || ratio > .55 || paragraphs === 0) continue;
          const score = length * (1 - ratio) + Math.min(paragraphs, 40) * 40 + (/ARTICLE/.test(candidate.tagName) ? 300 : 0);
          if (score > bestScore) { bestScore = score; root = clone; }
        }
      }
      if (!root) return { ok: false, code: "no-readable-content", kind: "link", markdown: "", images: [] };
      const markdown = kind === "selection" ? escape(text(String(selection))).trim() : compactBlocks(render(clean(root)));
      if (!markdown || (kind === "article" && root.textContent.trim().length < 80)) return { ok: false, code: "no-readable-content", kind: "link", markdown: "", images: [] };
      if (new TextEncoder().encode(markdown).length > MAX_BYTES) return { ok: false, code: "article-size-limit", kind, markdown: "", images: [] };
      return { ok: true, kind, markdown, images, text: text(root.textContent).trim(),
        title: boundedTitle(root.querySelector("h1")?.textContent || doc.title),
        author: boundedTitle(doc.querySelector('meta[name="author"]')?.getAttribute("content")),
        publishedAt: boundedTitle(doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content") || doc.querySelector("time[datetime]")?.getAttribute("datetime")), version: 1 };
    } catch (error) { return { ok: false, code: error?.message === "article-complexity-limit" ? error.message : "article-extraction-failed", kind: "link", markdown: "", images: [] }; }
  }
  global.LuckyRayArticleExtractor = { extract, url, MAX_BYTES };
  if (typeof module !== "undefined") module.exports = global.LuckyRayArticleExtractor;
})(globalThis);
