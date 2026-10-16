import { readFileSync } from "node:fs";

// The client embeds this same declaration. Protocol versions are bound to
// native dispatch; focused tests exercise the authenticated adapter and gates.
export const HOST_INTERFACES = Object.freeze(JSON.parse(readFileSync(new URL("../config/dsh-host-compatibility.json", import.meta.url))));
const fail = () => { throw new Error("compatibility-contract-invalid"); };
const keys = (value, expected) => {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) fail();
};
const release = value => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value);
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    const left = BigInt(a.split(".")[i]), right = BigInt(b.split(".")[i]);
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}
export function compatibilityDeclaration({ minimumHostVersion = "1.9.4", maximumHostVersionExclusive = "2.0.0",
  requiredCapabilities = HOST_INTERFACES.capabilities } = {}) {
  return { schema: 1, adapterProtocol: HOST_INTERFACES.adapterProtocol, resourceProtocol: HOST_INTERFACES.resourceProtocol,
    minimumHostVersion, maximumHostVersionExclusive, requiredCapabilities: [...requiredCapabilities] };
}
export function validateCompatibility(value, hostVersion, interfaces = HOST_INTERFACES) {
  keys(value, ["schema", "adapterProtocol", "resourceProtocol", "minimumHostVersion", "maximumHostVersionExclusive", "requiredCapabilities"]);
  keys(interfaces, ["schema", "adapterProtocol", "resourceProtocol", "capabilities"]);
  if (value.schema !== 1 || interfaces.schema !== 1
      || !Number.isSafeInteger(interfaces.adapterProtocol) || interfaces.adapterProtocol < 1
      || !Number.isSafeInteger(interfaces.resourceProtocol) || interfaces.resourceProtocol < 1
      || !Array.isArray(interfaces.capabilities) || !interfaces.capabilities.length
      || new Set(interfaces.capabilities).size !== interfaces.capabilities.length
      || !interfaces.capabilities.every(x => typeof x === "string" && /^[a-z0-9-]{1,96}$/u.test(x))
      || !release(value.minimumHostVersion) || !release(value.maximumHostVersionExclusive) || !release(hostVersion)
      || compare(value.minimumHostVersion, value.maximumHostVersionExclusive) >= 0
      || compare(hostVersion, value.minimumHostVersion) < 0 || compare(hostVersion, value.maximumHostVersionExclusive) >= 0
      || value.adapterProtocol !== interfaces.adapterProtocol || value.resourceProtocol !== interfaces.resourceProtocol
      || !Array.isArray(value.requiredCapabilities) || !value.requiredCapabilities.length || value.requiredCapabilities.length > 32
      || new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length
      || !value.requiredCapabilities.every(x => typeof x === "string" && /^[a-z0-9-]{1,96}$/u.test(x) && interfaces.capabilities.includes(x))) fail();
  return value;
}
