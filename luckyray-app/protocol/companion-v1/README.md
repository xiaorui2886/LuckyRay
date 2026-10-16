# LuckyRay Companion Protocol v1

This is the single canonical Desktop-to-Mobile handoff bundle for the implemented Companion Gateway foundation. It freezes transport and trust behavior only.

## Trust sequence

1. Decode the QR object and reject missing, aliased, or additional fields.
2. Pin the TLS certificate DER SHA-256 fingerprint from `fp` before any HTTP request.
3. Read `GET /v1/hello` and require protocol version `1`, matching Desktop instance, and matching certificate fingerprint.
4. Exchange the one-time `secret` at `POST /v1/pair`. Keep the returned device credential in the Mobile platform's protected credential owner.
5. Send `Authorization: Bearer <credential>` to `GET /v1/session` and the `/v1/events` WebSocket upgrade.
6. Echo each eight-byte server ping payload in a pong. A missing or mismatched pong retires the socket.
7. A normal transport loss may reconnect with the same credential. `AUTH_REVOKED` is terminal for that credential and requires an explicit new pairing.

The Desktop local management command is the sole revocation authority. Revocation closes existing event sessions and rejects the old credential on later requests.

## Contracts

- Schemas live only in `schemas/`.
- Golden examples live only in `fixtures/` and use synthetic credentials.
- `reference-client.mjs` is transport-injected so tests can prove the complete sequence without network access or user secrets.

Run the isolated bundle contract from the Desktop repository:

```powershell
node --test tests/companionProtocolV1.contract.test.mjs
```

The Mobile implementation still owns its native TLS pinning, protected credential storage, WebSocket client, lifecycle, and UI. No Desktop business routes are declared by this bundle.
