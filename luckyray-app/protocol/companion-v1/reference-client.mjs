const QR_KEYS = ["v", "name", "instance", "ip", "port", "secret", "fp"];

function isPrivateLanIpv4(value) {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  return numbers[0] === 10
    || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31)
    || (numbers[0] === 192 && numbers[1] === 168);
}

export function assertQrEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("QR envelope must be an object");
  }
  if (Object.keys(value).length !== QR_KEYS.length || QR_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("QR envelope must contain exactly the canonical fields");
  }
  if (
    value.v !== 1
    || typeof value.name !== "string"
    || !value.name
    || typeof value.instance !== "string"
    || !/^desktop-[a-f0-9]{32}$/.test(value.instance)
    || typeof value.ip !== "string"
    || !isPrivateLanIpv4(value.ip)
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65_535
    || typeof value.secret !== "string"
    || !/^[a-f0-9]{64}$/.test(value.secret)
    || typeof value.fp !== "string"
    || !/^[a-f0-9]{64}$/.test(value.fp)
  ) {
    throw new TypeError("QR envelope fields are invalid");
  }
  return Object.fromEntries(QR_KEYS.map((key) => [key, value[key]]));
}

function requireResponse(response, expectedStatus, expectedCode) {
  if (!response || response.status !== expectedStatus) {
    throw new Error(`unexpected response status ${response?.status ?? "missing"}`);
  }
  if (expectedCode && response.body?.code !== expectedCode) {
    throw new Error(`unexpected response code ${response.body?.code ?? "missing"}`);
  }
  return response.body;
}

export async function runCompanionV1ReferenceFlow({ envelope, transport, deviceLabel = "Fixture Phone" }) {
  const qr = assertQrEnvelope(envelope);
  const pinned = await transport.pin(qr.fp);
  if (pinned !== qr.fp) throw new Error("TLS fingerprint pin did not match");

  const hello = requireResponse(await transport.request({ method: "GET", path: "/v1/hello" }), 200);
  if (hello.protocolVersion !== 1 || hello.instanceId !== qr.instance || hello.certificateFingerprint !== qr.fp) {
    throw new Error("Desktop hello does not match the pinned QR identity");
  }

  const pair = requireResponse(await transport.request({
    method: "POST",
    path: "/v1/pair",
    headers: { "content-type": "application/json" },
    body: { secret: qr.secret, fingerprint: qr.fp, deviceLabel },
  }), 200);
  if (pair.protocolVersion !== 1 || typeof pair.credential !== "string" || pair.deviceId !== pair.credential.split(".")[0]) {
    throw new Error("Pair response is invalid");
  }

  const authorization = `Bearer ${pair.credential}`;
  const session = requireResponse(await transport.request({
    method: "GET",
    path: "/v1/session",
    headers: { authorization },
  }), 200);
  if (session.protocolVersion !== 1 || session.deviceId !== pair.deviceId) {
    throw new Error("Authenticated session is invalid");
  }

  const events = await transport.openEvents({
    method: "GET",
    path: "/v1/events",
    headers: { authorization },
  });
  if (events.serverPingBytes !== 8 || events.pongEchoed !== true) {
    throw new Error("WebSocket heartbeat contract was not honored");
  }

  await transport.revoke(pair.deviceId);
  requireResponse(await transport.request({
    method: "GET",
    path: "/v1/session",
    headers: { authorization },
  }), 401, "AUTH_REVOKED");
  requireResponse(await transport.openEvents({
    method: "GET",
    path: "/v1/events",
    headers: { authorization },
  }), 401, "AUTH_REVOKED");

  return {
    deviceId: pair.deviceId,
    heartbeatVerified: true,
    revokedCredentialRejected: true,
    revokedEventReconnectRejected: true,
  };
}
