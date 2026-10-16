// Fixed bootstrap guard for owned pnpm children. Acquisition-cache phase may
// connect ONLY to its private literal IPv4 loopback port. Offline assembly may
// not open any socket or resolve any DNS name. No upstream code is changed.
// Native parent must clear NODE_OPTIONS and set this environment itself.
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const text = process.env.LUCKYRAY_FROZEN_CACHE_PORT ?? "";
const port = text === "" ? null : Number(text);
if (port !== null && (!/^[1-9]\d{0,4}$/u.test(text) || port > 65535)) throw new Error("assembly-network-policy-invalid");
let allowed = 0, blocked = 0, dnsBlocked = 0;
const connect = net.Socket.prototype.connect;
function address(args) {
  if (Array.isArray(args[0])) return address(args[0]);
  if (args[0] && typeof args[0] === "object") {
    if (args[0].path !== undefined && args[0].path !== null) return { host: null, port: null };
    return { host: args[0].host ?? "localhost", port: Number(args[0].port) };
  }
  if (typeof args[0] === "number" || typeof args[0] === "string" && /^\d+$/u.test(args[0])) {
    return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(args[0]) };
  }
  return { host: null, port: null };
}
net.Socket.prototype.connect = function (...args) {
  const target = address(args);
  if (port === null || target.host !== "127.0.0.1" || target.port !== port) {
    blocked++; throw new Error("assembly-network-denied");
  }
  allowed++; return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (port === null || host !== "127.0.0.1") { dnsBlocked++; throw new Error("assembly-dns-denied"); }
  return lookup.call(this, host, ...args);
};
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, ...args) {
  if (port === null || host !== "127.0.0.1") { dnsBlocked++; throw new Error("assembly-dns-denied"); }
  return promiseLookup.call(this, host, ...args);
};
syncBuiltinESMExports();
process.once("exit", () => process.stdout.write(JSON.stringify({ outcome: "ASSEMBLY_NETWORK_FENCE",
  phase: port === null ? "offline" : "verified-loopback-cache", allowedSockets: allowed,
  blockedSockets: blocked, blockedDns: dnsBlocked }) + "\n"));
