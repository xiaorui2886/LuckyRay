"""CI-only: one real AgentHost initialize exchange against the staged sidecar."""
import json, os, secrets, socket, subprocess, sys, threading

host, shell = sys.argv[1], sys.argv[2]
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
listener.settimeout(30)
port = listener.getsockname()[1]
token = secrets.token_hex(24)


def gateway():
    try:
        conn, _ = listener.accept()
        conn.close()
    except OSError:
        pass


threading.Thread(target=gateway, daemon=True).start()
profile = f"/tmp/luckyray-agent-probe-{secrets.token_hex(8)}"
os.makedirs(profile, mode=0o700)
env = {"TEMP": "/tmp", "TMP": "/tmp", "LUCKYRAY_AGENT_BROWSER_TEST_SHELL": shell}
proc = subprocess.Popen([host, "--agent-readonly", "--test-window-hidden"], cwd=os.path.dirname(host),
                        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
challenge = secrets.token_hex(24)
request = {"version": 1, "id": "initialize", "command": "initialize", "challenge": challenge,
           "agentGatewayPort": port, "agentGatewayToken": token, "agentProfileRoot": profile,
           "testFixtureHidden": True, "testFixturePort": port, "testFixtureId": "ci-agent-host-probe"}
body = json.dumps(request).encode()
proc.stdin.write(body + b"\n")
proc.stdin.flush()
line = proc.stdout.readline()
if line:
    print("host reply:", line.decode(errors="replace"))
else:
    print("host closed without a reply, exit:", proc.wait(timeout=10))
proc.kill()
print("host stderr:", proc.stderr.read().decode(errors="replace")[-4000:])
listener.close()
