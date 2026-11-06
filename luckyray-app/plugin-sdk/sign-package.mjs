// Sign with an existing author-owned Ed25519 key. This tool never creates keys.
import crypto from "node:crypto";
import fs from "node:fs";

// All valid package object keys are ASCII; sorting by UTF-8 bytes matches the
// native JSON map order. Package numbers are bounded integers, not floats.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

try {
  const [input, keyPath, output] = process.argv.slice(2);
  if (!input || !keyPath || !output || process.argv.length !== 5) throw Error("Usage: node sign-package.mjs <unsigned-package.json> <existing-ed25519-private-key.pem> <new-output.json>");
  const pkg = JSON.parse(fs.readFileSync(input, "utf8"));
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || Object.keys(pkg).sort().join(",") !== "manifest,resource") throw Error("Expected an unsigned package with exactly manifest and resource");
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (key.asymmetricKeyType !== "ed25519") throw Error("Expected an Ed25519 private key");
  const der = crypto.createPublicKey(key).export({ format: "der", type: "spki" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix)) throw Error("Unsupported Ed25519 public key format");
  const payload = Buffer.concat([Buffer.from("luckyray-package-v1\0"), Buffer.from(canonical(pkg))]);
  pkg.signature = { version: 1, publicKey: der.subarray(prefix.length).toString("base64"), signature: crypto.sign(null, payload, key).toString("base64") };
  const bytes = Buffer.from(JSON.stringify(pkg) + "\n");
  if (bytes.length > (pkg.manifest?.type === "desktop" ? 16 * 1024 * 1024 : 131072)) throw Error("Signed package exceeds the host limit");
  fs.writeFileSync(output, bytes, { flag: "wx" });
  console.log(`Signed package written to ${output}; distribute the public key through a trusted channel.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
