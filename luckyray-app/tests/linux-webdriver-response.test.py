"""Regression for real HTTP protocol errors versus command-result values."""
import importlib.util
import http.client
import json
import threading
import socket
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "linux_desktop_smoke", Path(__file__).with_name("linux-desktop-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class Handler(BaseHTTPRequestHandler):
    calls = {}

    def do_GET(self):
        self.calls[self.path] = self.calls.get(self.path, 0) + 1
        if self.path == "/always-reset" or self.path == "/read-reset" and self.calls[self.path] == 1:
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.path == "/command-conflict":
            status = 200
            value = {"ok": False, "error": '{"code":"knowledge-revision-conflict"}'}
        elif self.path == "/read-reset":
            status, value = 200, {"ready": True}
        else:
            status = 400
            value = {"error": "invalid argument", "message": "synthetic protocol failure"}
        body = json.dumps({"value": value}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.calls[self.path] = self.calls.get(self.path, 0) + 1
        self.connection.shutdown(socket.SHUT_RDWR)
        self.connection.close()

    def log_message(self, *_args):
        pass


class ResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.worker = threading.Thread(
            target=cls.server.serve_forever, kwargs={"poll_interval": 0.05})
        cls.worker.start()
        cls.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(timeout=2)

    def request(self, path):
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        return smoke.webdriver_value(self.http, urllib.request.Request(url), 2)

    def test_business_conflict_remains_an_explicit_failed_command_result(self):
        value = self.request("/command-conflict")
        self.assertIs(value["ok"], False)
        self.assertEqual(json.loads(value["error"])["code"], "knowledge-revision-conflict")

    def test_webdriver_protocol_failure_is_still_raised(self):
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request("/protocol-error")
        self.assertEqual(failure.exception.code, 400)

    def test_read_connection_reset_retries_once_and_remains_bounded(self):
        self.assertTrue(self.request("/read-reset")["ready"])
        self.assertEqual(Handler.calls["/read-reset"], 2)
        with self.assertRaises(http.client.RemoteDisconnected):
            self.request("/always-reset")
        self.assertEqual(Handler.calls["/always-reset"], 2)

    def test_mutating_requests_are_never_retried_after_a_lost_response(self):
        request = urllib.request.Request(f"http://127.0.0.1:{self.server.server_port}/write-reset", data=b"{}", method="POST")
        with self.assertRaises(http.client.RemoteDisconnected):
            smoke.webdriver_value(self.http, request, 2)
        self.assertEqual(Handler.calls["/write-reset"], 1)


if __name__ == "__main__":
    unittest.main()
