"""Loopback-only synthetic protocol fixture. No browser, product, or user data."""
import base64
import hashlib
import http.server
import json
import struct
import sys
import threading


class Fixture(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/json/list":
            payload = json.dumps([{"type": "page", "url": "http://tauri.localhost", "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.server.server_port}/fixture"}]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path != "/fixture":
            self.send_error(404)
            return
        accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.connection.settimeout(10)
        first = self.rfile.read(2)
        length = first[1] & 127
        if length == 126:
            length = struct.unpack("!H", self.rfile.read(2))[0]
        if length > 4096:
            raise ValueError("synthetic-request-too-large")
        mask = self.rfile.read(4)
        data = self.rfile.read(length)
        request = json.loads(bytes(byte ^ mask[index % 4] for index, byte in enumerate(data)))
        if request['method'] == 'Input.insertText':
            assert request['params'] == {'text': 'LR synthetic input'}
            response = json.dumps({'id': request['id'], 'result': {}}).encode()
        else:
            assert request['method'] == 'Runtime.evaluate'
            expression = request["params"]["expression"]
            result = {"type": "boolean", "value": True} if expression == "Boolean(window.__TAURI_INTERNALS__)" else {"type": "object", "value": {"stage": "unavailable", "canProbe": False, "canRetry": False}}
            response = json.dumps({"id": request["id"], "result": {"result": result}}).encode()
        header = bytes([0x81, len(response)]) if len(response) < 126 else bytes([0x81, 126]) + struct.pack("!H", len(response))
        self.wfile.write(header + response)
        self.wfile.flush()
        with self.server.count_lock:
            self.server.completed += 1
            if self.server.completed >= self.server.expected:
                threading.Thread(target=self.server.shutdown, daemon=True).start()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
server.daemon_threads = True
server.completed = 0
server.expected = 3 if '--input-check' in sys.argv else 2
server.count_lock = threading.Lock()
print(server.server_port, flush=True)
timer = threading.Timer(15, server.shutdown)
timer.daemon = True
timer.start()
server.serve_forever()
server.server_close()
