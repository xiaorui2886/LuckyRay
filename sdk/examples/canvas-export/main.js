/// <reference path="../../index.d.ts" />
// Saved-graph export. The host chooses the destination file before the run; the plugin never sees paths.
LuckyRay.register(async event => {
  const id = event.objects.canvases[0];
  if (!id) return { title: "画布关系图导出", text: "本次没有选择画布。请在上方选择一个已保存的画布后重新运行。导出只包含节点标题、位置和有向连线，不包含媒体附件。" };
  const graph = await LuckyRay.call("canvas.read", { id });
  const summary = graph.nodes.length + " 个节点，" + graph.edges.length + " 条连线（已保存快照，不含未保存改动与附件）。";
  if (event.input.action === "export") {
    const result = await LuckyRay.call("canvas.export", { id, digest: graph.digest });
    return { title: "已请求导出 SVG", text: "《" + graph.name + "》：" + result.nodes + " 个节点，" + result.edges + " 条连线，" + result.bytes + " 字节。文件写入运行前选择的位置；实际结果以“宿主确认的操作”为准，可用浏览器打开查看。" };
  }
  return {
    title: "《" + graph.name + "》关系图",
    text: summary + (event.capabilities.includes("canvas.export") ? "\n\n点击下方按钮导出为独立 SVG；运行前需允许写入并选择保存位置。" : "\n\n未授予导出权限时只能查看结构摘要。"),
    actions: event.capabilities.includes("canvas.export") ? [{ id: "export", label: "导出为 SVG" }] : []
  };
});
