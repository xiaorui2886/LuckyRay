/// <reference path="../../index.d.ts" />
// EXT-PAGE verification sample: two pages from one package, own data only, no permissions.
LuckyRay.register(async event => {
  const data = await LuckyRay.call("data.get");
  const settings = data.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? data.settings : {};
  const views = typeof settings.views === "number" && Number.isFinite(settings.views) ? settings.views : 0;
  let shownViews = views;
  let shownNote = typeof settings.note === "string" ? settings.note : "";
  if (event.input.contribution === "about") {
    return { title: "关于此示例", text: "这是一个声明了两个 page 入口的验证样例。"+
      ("本页累计被打开 " + (views + 1) + " 次（含看板页）。")+
      ("\n当前页：about。宿主会记住你正在填写的字段；写入类能力此样例未申请。") };
  }
  if (event.input.action === "save") {
    const nextNote = event.input.fields.note || "";
    await LuckyRay.call("data.set", { ...data, revision: data.revision + 1, settings: { views: views + 1, note: nextNote } });
    shownViews = views + 1;
    shownNote = nextNote;
  }
  return { title: "示例看板", text: "这是主内容区的插件页面（不是弹窗）。"+
    ("\n保存的备注：" + (shownNote || "（还没有）")) +
    ("\n已保存次数：" + shownViews), fields: [{ id: "note", label: "备注（保存在插件自己的数据里）", value: shownNote }], actions: [{ id: "save", label: "保存备注" }] };
});
