/// <reference path="../../index.d.ts" />
// A demonstration using a fixed synthetic prompt: event metadata and user content
// are deliberately not included. The host controls permissions, library and model.
LuckyRay.register(async event => {
  if (event.input.action === "event") {
    if (event.input.notification?.type !== "materials.imported") return { title: "Ignored event" };
    const result = await LuckyRay.call("ai.generate", { prompt: "Write one short sentence about a fictional blue square." });
    const data = await LuckyRay.call("data.get");
    await LuckyRay.call("data.set", { ...data, revision: data.revision + 1, cache: { lastResult: result.text } });
    return { title: "Synthetic result", text: result.text };
  }
  if (event.input.action === "subscribe") {
    await LuckyRay.call("events.subscribe", { type: "materials.imported" });
    return { title: "Subscribed", text: "New imports in the selected library may trigger the example while the host is open." };
  }
  if (event.input.action === "unsubscribe") {
    await LuckyRay.call("events.unsubscribe", { type: "materials.imported" });
    return { title: "Unsubscribed", text: "Pending deliveries are cancelled." };
  }
  const data = await LuckyRay.call("data.get");
  const cache = data.cache;
  const lastResult = cache && typeof cache === "object" && !Array.isArray(cache) && typeof cache.lastResult === "string" ? cache.lastResult : "No synthetic result yet.";
  return { title: "Event and AI sample", text: lastResult, actions: [{ id: "subscribe", label: "Subscribe to imports" }, { id: "unsubscribe", label: "Unsubscribe" }] };
});
