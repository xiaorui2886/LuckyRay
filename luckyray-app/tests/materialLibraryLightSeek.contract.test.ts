import assert from "node:assert/strict";
import test from "node:test";
import { createOpenInLightSeekCoordinator } from "../src/core/services/openInLightSeek.ts";
import { createOpenIntentSlot } from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs";
import { resolveMaterialLightSeekResourcesWithTransport } from "../src/core/services/materials.ts";

const id = "intent-00000001-0000-4000-8000-000000000000";
const coordinator = () => createOpenInLightSeekCoordinator({ navigate: () => {}, createId: () => id });
const resource = { kind: "material" as const, assetId: "asset-B", libraryId: "library-B", canonicalPath: "D:\\B\\picture.png", delivery: "image-attachment" as const };

test("selected library identity survives Catalog resolution, coordinator, authenticated carrier and exact acknowledgement", async () => {
  const resources = await resolveMaterialLightSeekResourcesWithTransport([resource.assetId], async () => [resource.canonicalPath], resource.libraryId);
  const intent = coordinator().stage({ source: "materials", text: "", localResources: resources });
  const slot = createOpenIntentSlot(); slot.bind(4);
  const { recoveryOnly: _, ...payload } = intent;
  slot.stage(4, Buffer.from(JSON.stringify(payload)).toString("base64url"));
  assert.equal(slot.read(4).localResources[0].libraryId, "library-B");
  assert.equal(slot.acknowledge(4, id), true);
  assert.equal(slot.status(4, id), "applied");
});

test("invalid optional identity is rejected by coordinator and sealed carrier; legacy shape is preserved", async () => {
  for (const libraryId of ["", " B", "B\n", "x".repeat(257), 42]) {
    const invalid = { ...resource, libraryId };
    assert.throws(() => coordinator().stage({ source: "materials", text: "", localResources: [invalid as typeof resource] }), /invalid/);
    const slot = createOpenIntentSlot(); slot.bind(4);
    assert.throws(() => slot.stage(4, Buffer.from(JSON.stringify({ intentId: id, source: "materials", text: "", localResources: [invalid] })).toString("base64url")), /invalid/);
  }
  const resources = await resolveMaterialLightSeekResourcesWithTransport([resource.assetId], async () => [resource.canonicalPath]);
  assert.equal(Object.hasOwn(resources[0], "libraryId"), false);
  const legacy = coordinator().stage({ source: "materials", text: "", localResources: resources });
  assert.equal(Object.hasOwn(legacy.localResources[0], "libraryId"), false);
});
