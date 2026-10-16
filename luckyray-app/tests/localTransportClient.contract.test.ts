import assert from "node:assert/strict";
import test from "node:test";

import { withLocalTransportAuthorization } from "../src/core/localApi.ts";

test("desktop and legacy clients attach an in-memory bearer token without changing caller headers", () => {
  const init = withLocalTransportAuthorization(
    { method: "POST", headers: { "Content-Type": "application/json", "X-LuckyRay-Source": "fixture" } },
    "secure-install-token",
  );
  const headers = new Headers(init.headers);
  assert.equal(headers.get("Authorization"), "Bearer secure-install-token");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-LuckyRay-Source"), "fixture");
});

test("browser preview fallback does not invent or persist a credential", () => {
  const init = withLocalTransportAuthorization({ method: "GET" }, "");
  assert.equal(new Headers(init.headers).has("Authorization"), false);
});
