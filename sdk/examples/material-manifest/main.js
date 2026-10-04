/// <reference path="../../index.d.ts" />
// Rule-based manifest of the materials authorized for this run. Written against the public SDK only.
LuckyRay.register(async event => {
  const data = await LuckyRay.call("data.get");
  const settings = data.settings && typeof data.settings === "object" ? data.settings : {};
  const groupMode = settings.group === "storage" ? "storage" : "kind";
  const titlePref = typeof settings.title === "string" && settings.title.trim() ? settings.title.trim().slice(0, 40) : "素材使用清单";

  if (event.input.contribution === "settings") {
    let shownGroup = groupMode;
    let shownTitle = titlePref;
    if (event.input.action === "save") {
      const nextGroup = event.input.fields.group === "storage" ? "storage" : "kind";
      const nextTitle = (event.input.fields.title || "").trim().slice(0, 40) || "素材使用清单";
      await LuckyRay.call("data.set", { ...data, revision: data.revision + 1, settings: { group: nextGroup, title: nextTitle } });
      shownGroup = nextGroup;
      shownTitle = nextTitle;
    }
    return {
      title: "素材清单设置",
      text: event.input.action === "save" ? "清单偏好已保存。下次运行清单时生效。" : "设置只保存在本插件自己的数据里，不影响素材本身。",
      fields: [
        { id: "group", label: "分组方式（kind=按类型 / storage=按存储模式）", value: shownGroup },
        { id: "title", label: "清单标题", value: shownTitle }
      ],
      actions: [{ id: "save", label: "保存清单偏好" }]
    };
  }

  const materials = await LuckyRay.call("materials.list");
  if (!Array.isArray(materials) || materials.length === 0) {
    return { title: titlePref, text: "本次未选择素材。请先在宿主中选择要授权的素材，再运行素材清单。缺少知识库权限不影响素材清单本身。" };
  }

  const groups = new Map();
  for (const material of materials) {
    const key = groupMode === "storage" ? (material.storageMode || "unknown") : (material.kind || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(material);
  }
  const lines = ["共 " + materials.length + " 项素材，按" + (groupMode === "storage" ? "存储模式" : "类型") + "分为 " + groups.size + " 组："];
  for (const [key, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push("【" + key + "】" + list.length + " 项");
    for (const material of list) lines.push("- " + material.name + "（" + (material.mimeType || "unknown") + "，" + material.storageMode + "，标签 " + material.tagIds.length + " 个）");
  }
  if (lines.length > 100) {
    const hidden = lines.length - 100;
    lines.length = 100;
    lines.push("…其余 " + hidden + " 行未展示（清单面板最多显示 100 行）。");
  }

  const actions = [];
  if (event.capabilities.includes("knowledge.create") && event.objects.knowledge) {
    actions.push({ id: "note", label: "生成素材清单笔记" });
  }

  if (event.input.action === "note") {
    let note = null;
    // Minute stamp in local time, filename-safe (no colon — the vault rejects ':' in titles):
    // repeat runs each create their own note instead of colliding with the previous one.
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " + pad(now.getHours()) + "-" + pad(now.getMinutes());
    const noteTitle = titlePref + " " + stamp;
    try {
      note = await LuckyRay.call("knowledge.create", { title: noteTitle, content: "# " + noteTitle + "\n\n" + lines.join("\n") + "\n" });
      lines.push("已请求创建笔记《" + note.title + "》（" + note.documentRef.relativePath + "）；实际结果以“宿主确认的操作”为准。");
    } catch (error) {
      const raw = String((error && error.message) || error);
      let code = raw;
      try { const parsed = JSON.parse(raw); if (parsed && parsed.code) code = String(parsed.code); } catch (ignored) { /* plain code */ }
      lines.push(code === "knowledge-name-conflict" ? "同名笔记已存在，未重复创建；可在“清单设置”里换个标题后再试。" : "笔记创建未完成：" + code);
    }
    if (note) {
      try {
        await LuckyRay.call("data.set", { ...data, revision: data.revision + 1, cache: { lastNote: { title: note.title, path: note.documentRef.relativePath, total: materials.length } } });
      } catch (error) {
        lines.push("笔记已创建，但“上次生成笔记”信息未能保存到插件数据：" + String((error && error.message) || error));
      }
    }
  } else if (data.cache && data.cache.lastNote) {
    lines.push("上次生成笔记：" + data.cache.lastNote.title + "（共 " + data.cache.lastNote.total + " 项）");
  }

  return { title: titlePref, text: lines.join("\n"), actions };
});
