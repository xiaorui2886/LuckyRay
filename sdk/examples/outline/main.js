/// <reference path="../../index.d.ts" />
// Line-based outline of one authorized note. Pure text rules; nothing is sent anywhere.
LuckyRay.register(async event => {
  const path = event.objects.knowledge?.documents[0];
  if (!path) return { title: "笔记结构提纲（规则提取）", text: "本次没有选择笔记。请在上方选择一篇笔记后重新运行。" };
  const note = await LuckyRay.call("knowledge.read", { path });
  let source = note.content;
  let basis = "已保存正文";
  try {
    const selected = await LuckyRay.call("knowledge.selection");
    if (selected.documentRef.relativePath === path && selected.selection) { source = selected.selection; basis = "当前选区"; }
  } catch { /* No clean live editor: the saved body is used and named below. */ }
  const lines = source.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 12).map(s => "- " + s.replace(/^#+\s*/, "").slice(0, 160));
  const outline = "## 结构提纲\n\n" + lines.join("\n");
  const notes = ["来源：《" + note.title + "》的" + basis + "，最多提取前 12 行。"];
  if (event.input.action === "create") {
    await LuckyRay.call("knowledge.create", { title: note.title + " · 提纲", content: "来源：[[" + path + "]]\n\n" + outline + "\n" });
    notes.push("已请求创建关联笔记《" + note.title + " · 提纲》；实际结果以“宿主确认的操作”为准。");
  }
  if (event.input.action === "insert") {
    await LuckyRay.call("knowledge.insert", { path, revision: note.revision, offset: note.content.length, text: "\n\n" + outline });
    notes.push("已请求追加到原笔记末尾；实际结果以“宿主确认的操作”为准，不要重复追加。");
  }
  const actions = [];
  if (event.capabilities.includes("knowledge.create") && event.input.action !== "create") actions.push({ id: "create", label: "创建关联提纲笔记" });
  if (event.capabilities.includes("knowledge.insert") && event.input.action !== "insert") actions.push({ id: "insert", label: "追加到原笔记末尾" });
  return { title: "笔记结构提纲（规则提取，非 AI）", text: notes.join("\n") + "\n\n" + outline, actions };
});
