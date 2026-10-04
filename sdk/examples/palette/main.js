/// <reference path="../../index.d.ts" />
// Rule-based average colour from the host's bounded thumbnail pixels. No AI, no network.
LuckyRay.register(async event => {
  const data = await LuckyRay.call("data.get");
  const prefix = (data.settings && typeof data.settings.prefix === "string" && data.settings.prefix.trim()) || "色彩";
  if (event.input.contribution === "settings") {
    let shown = prefix;
    if (event.input.action === "save") {
      shown = (event.input.fields.prefix || "").trim().slice(0, 20) || "色彩";
      await LuckyRay.call("data.set", { ...data, revision: data.revision + 1, settings: { prefix: shown } });
    }
    return {
      title: "配色设置",
      text: event.input.action === "save" ? "标签前缀已保存，下次添加颜色标签时使用。" : "标签前缀只影响本插件生成的颜色标签名，例如“色彩 #a1b2c3”。",
      fields: [{ id: "prefix", label: "颜色标签前缀", value: shown }],
      actions: [{ id: "save", label: "保存插件设置" }]
    };
  }
  const objects = await LuckyRay.call("materials.list");
  const images = objects.filter(a => a.kind === "image");
  const rows = [];
  let tagged = 0;
  for (const asset of images.slice(0, 4)) {
    const image = await LuckyRay.call("materials.image.open", { id: asset.id, revision: asset.revision });
    try {
      const pixels = await LuckyRay.call("materials.image.read", { handle: image.handle });
      const sum = [0, 0, 0]; let weight = 0;
      for (let i = 0; i < pixels.rgba.length; i += 4) { const a = pixels.rgba[i + 3] / 255; weight += a; for (let c = 0; c < 3; c++) sum[c] += pixels.rgba[i + c] * a; }
      const color = "#" + sum.map(v => Math.round(v / (weight || 1)).toString(16).padStart(2, "0")).join("");
      rows.push(asset.name + "：" + color);
      if (event.input.action === "tags") { await LuckyRay.call("materials.tags", { id: asset.id, revision: asset.revision, tags: [prefix + " " + color] }); tagged += 1; }
    } finally { await LuckyRay.call("materials.image.release", { handle: image.handle }); }
  }
  if (images.length === 0) return { title: "素材平均配色（规则计算）", text: "本次没有选择图片素材。请在上方选择图片后重新运行；缺少可选的知识库权限不影响配色提取。" };
  const notes = [];
  if (images.length > 4) notes.push("为控制运行时长，每次只处理前 4 张图片。");
  if (event.input.action === "tags") notes.push("已请求为 " + tagged + " 项素材添加“" + prefix + " #…”标签；实际结果以下方“宿主确认的操作”为准。");
  if (event.input.action === "note" && event.objects.knowledge) {
    await LuckyRay.call("knowledge.create", { title: "素材配色记录", content: "# 配色记录\n\n" + rows.join("\n") + "\n" });
    notes.push("已请求创建笔记《素材配色记录》；请以宿主确认结果为准。");
  }
  const actions = [];
  if (event.capabilities.includes("materials.tags")) actions.push({ id: "tags", label: "为这些素材添加颜色标签" });
  if (event.capabilities.includes("knowledge.create") && event.objects.knowledge) actions.push({ id: "note", label: "创建配色记录笔记" });
  return { title: "素材平均配色（规则计算，非 AI）", text: rows.join("\n") + (notes.length ? "\n\n" + notes.join("\n") : ""), actions };
});
