"""Test-only standard WebSocket client for the isolated LSH full-chain fixture.

The pairing cookie and certificate arrive on stdin, never in argv, URLs, or
diagnostics. Requires Python websockets 15.x in the isolated test environment.
"""

import base64
import json
import socket
import ssl
import sys

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect


def main() -> None:
    fixture = json.loads(sys.stdin.readline())
    port = int(fixture["port"])
    pem = ssl.DER_cert_to_PEM_cert(base64.b64decode(fixture["certificateDer"]))
    context = ssl.create_default_context(cadata=pem)
    origin = f"https://luckyray-companion.local:{port}"
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    with connect(
        f"wss://luckyray-companion.local:{port}/api/remote.mux",
        sock=sock,
        ssl=context,
        server_hostname="luckyray-companion.local",
        origin=origin,
        additional_headers={"Cookie": fixture["cookie"]},
        proxy=None,
        open_timeout=30,
        ping_interval=None,
    ) as websocket:
        print("OPEN", flush=True)
        if not websocket.ping(b"lsh-fixture-ping").wait(timeout=10):
            raise TimeoutError("no WebSocket pong")
        print("PONG", flush=True)
        while True:
            try:
                websocket.recv(timeout=30)
            except ConnectionClosed:
                print("CLOSED", flush=True)
                return


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print exception values: HTTP clients may include the cookie.
        status = getattr(getattr(error, "response", None), "status_code", None)
        suffix = f":http-{status}" if isinstance(status, int) and 100 <= status <= 599 else ""
        print(f"FAIL:{type(error).__name__}{suffix}", flush=True)
        sys.exit(1)
