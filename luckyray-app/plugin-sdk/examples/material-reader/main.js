/// <reference path="../../index.d.ts" />
// Material-only by default; Knowledge requires an explicit optional connection.
LuckyRay.register(async event => {
  if (!event.capabilities.includes("materials.read")) return { title: "Materials", text: "Materials permission is not granted. Review it in the host." };
  let materials;
  try { materials = await LuckyRay.call("materials.list"); }
  catch (error) { return { title: "Materials unavailable", text: "The host refused the read. Check permission and selected objects; no alternate library is used." }; }
  const text = materials.slice(0, 32).map(item => `${item.name} (${item.kind})`).join("\n") || "No materials selected for this invocation.";
  const connected = event.capabilities.includes("knowledge.create") && !!event.objects.knowledge;
  if (event.input.action === "note") {
    if (!connected) return { title: "Connection required", text: "Select a vault and explicitly grant the optional Knowledge permission. Material reading remains independent." };
    try {
      await LuckyRay.call("knowledge.create", { title: event.input.fields.title || "Selected materials", content: text });
      return { title: "Inspect host receipt", text: "The host returned from the write. Inspect its confirmed operations and target note; do not repeat this action." };
    } catch (error) {
      return { title: "Write not confirmed", text: "Inspect the host's operation record and original target. A failure may follow a committed write. This example never retries or chooses another vault." };
    }
  }
  return { title: "Selected materials", text, ...(connected ? { fields: [{ id: "title", label: "New note title", value: "Selected materials" }], actions: [{ id: "note", label: "Request note (host confirmation required)" }] } : {}) };
});
