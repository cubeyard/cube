"""Unit tests of the guest helper (packages/server/guest/cube-guest.py) with
a test launcher injected; run by guest-helper-test.ts. The workspace
contract over the helper runs in workspace-test.ts (local guest) and against
a real VM in smoke-node-adapter.ts."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# No __pycache__ next to the shipped helper.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cube_guest", os.path.join(HERE, "..", "guest", "cube-guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class FakeLauncher:
    def __init__(self):
        self.started = []
        self.running = set()
        self.killed = []
        self.stopping = False
        self.fail = None

    def start(self, op_id, timeout_ms):
        if self.fail:
            raise self.fail
        self.started.append((op_id, timeout_ms))
        self.running.add(op_id)

    def active(self, op_id):
        return op_id in self.running

    def kill(self, op_id):
        self.killed.append(op_id)

    def shutting_down(self):
        return self.stopping


def read(path):
    with open(path, "rb") as handle:
        return handle.read()


def call(op, header, body=b""):
    stdin = io.BytesIO(json.dumps(dict(header, length=len(body)) if body else header).encode() + b"\n" + body)
    stdout = io.BytesIO()
    guest.call(op, stdin, stdout)
    line, _, rest = stdout.getvalue().partition(b"\n")
    return json.loads(line), rest


class GuestHelperTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cube-guest-")
        self.workspace = os.path.join(self.root, "workspace")
        os.mkdir(self.workspace)
        self.launcher = FakeLauncher()
        guest.configure(state=os.path.join(self.root, "state"), workspace=self.workspace, env_file=os.path.join(self.root, "env"),
                        user=None, ready_files=[], commands=[], launcher=self.launcher)

    def tearDown(self):
        shutil.rmtree(self.root)

    def exec_header(self, op_id, epoch=10, command="true"):
        return {"id": op_id, "epoch": epoch, "command": command, "cwd": ".", "timeoutMs": 1000, "outputLimit": 100}

    def test_systemd_launcher_runs_the_wrapper_in_a_transient_unit(self):
        argv = guest.SystemdLauncher().argv("ws-abc", 1500)
        self.assertEqual(argv[:2], ["systemd-run", "--quiet"])
        self.assertIn("--collect", argv)
        self.assertEqual(argv[argv.index("--unit") + 1], "cube-op-ws-abc.service")
        self.assertIn("RuntimeMaxSec=1500ms", argv)
        self.assertIn("ExecStopPost=+/usr/local/sbin/cube-guest finish ws-abc", argv)
        self.assertIn("KillMode=control-group", argv)
        self.assertEqual(argv[-3:], ["/usr/local/sbin/cube-guest", "wrap", "ws-abc"])

    def test_hello_reports_readiness_limits_and_epoch(self):
        answer, _ = call("hello", {})
        self.assertTrue(answer["ready"])
        self.assertNotIn("templateSeal", answer, "a machine from the base image")
        self.assertEqual(answer["limits"]["maxWriteBytes"], 524288)
        self.assertIn("fs.write", answer["capabilities"])
        guest.configure(commands=["cube-no-such-command"])
        self.assertFalse(call("hello", {})[0]["ready"], "a missing guest package is not ready")
        guest.configure(commands=[], ready_files=[os.path.join(self.root, "boot-finished")])
        self.assertFalse(call("hello", {})[0]["ready"])
        call("exec", self.exec_header("e1", epoch=42))
        self.assertEqual(call("hello", {})[0]["epoch"], 42)

    def test_exec_journals_once_and_conflicts_on_change(self):
        first, _ = call("exec", self.exec_header("e1"))
        self.assertEqual(first, {"state": "Running"})
        again, _ = call("exec", self.exec_header("e1"))
        self.assertEqual(again, {"state": "Running"})
        self.assertEqual(len(self.launcher.started), 1, "a repeated key never starts again")
        changed, _ = call("exec", self.exec_header("e1", command="false"))
        self.assertEqual(changed["error"]["code"], "CONFLICT")

    def test_epoch_fence(self):
        call("exec", self.exec_header("e1", epoch=10))
        stale, _ = call("exec", self.exec_header("e2", epoch=9))
        self.assertEqual(stale["error"]["code"], "LEASE_STALE")
        self.assertFalse(os.path.exists(guest.op_path("e2")), "a stale lease journals nothing")
        self.assertEqual(call("cancel", {"id": "e1", "epoch": 9})[0]["error"]["code"], "LEASE_STALE")
        self.assertEqual(call("exec", self.exec_header("e3", epoch=10))[0], {"state": "Running"})
        self.assertEqual(call("exec", {**self.exec_header("e4"), "epoch": 0})[0]["error"]["code"], "INVALID_REQUEST")

    def test_unit_gone_without_result_is_interrupted_never_rerun(self):
        call("exec", self.exec_header("e1"))
        self.launcher.running.clear()
        state, _ = call("get", {"id": "e1"})
        self.assertEqual(state, {"state": "Interrupted", "completionUnknown": True})
        self.assertEqual(call("exec", self.exec_header("e1"))[0]["state"], "Interrupted")
        self.assertEqual(len(self.launcher.started), 1)

    def test_launch_failure_is_recorded(self):
        self.launcher.fail = guest.Fail("IO_ERROR", "no systemd")
        state, _ = call("exec", self.exec_header("e1"))
        self.assertEqual(state["state"], "Failed")
        self.assertEqual(state["error"], "IO_ERROR")

    def test_finish_maps_the_unit_result(self):
        cases = [
            ({"SERVICE_RESULT": "timeout"}, None, {"exitCode": None, "termination": "timedOut"}),
            ({"SERVICE_RESULT": "exit-code", "EXIT_CODE": "exited", "EXIT_STATUS": "3"}, {"exitCode": 3, "signal": None, "outputBytes": 250},
             {"exitCode": 3, "termination": "exited", "outputBytes": 250, "truncated": True}),
            ({"SERVICE_RESULT": "signal", "EXIT_CODE": "killed", "EXIT_STATUS": "9"}, None, {"exitCode": None, "termination": "signalled"}),
            ({"SERVICE_RESULT": "exit-code", "EXIT_CODE": "exited", "EXIT_STATUS": "1"}, None, {"exitCode": 1, "termination": "exited"}),
        ]
        for index, (env, wrapped, expected) in enumerate(cases):
            op_id = "f%d" % index
            call("exec", self.exec_header(op_id))
            with open(guest.op_path(op_id, "output"), "wb") as handle:
                handle.write(b"x" * 100)
            if wrapped:
                guest.write_json(guest.op_path(op_id, "wrapped.json"), wrapped)
            saved = dict(os.environ)
            os.environ.update(env)
            try:
                guest.finish(op_id)
            finally:
                os.environ.clear()
                os.environ.update(saved)
            self.launcher.running.discard(op_id)
            state, body = call("get", {"id": op_id, "cursor": 10})
            self.assertEqual(state["state"], "Succeeded")
            for key, value in expected.items():
                self.assertEqual(state["result"][key], value, (op_id, key))
            self.assertEqual(state["result"]["retainedBytes"], 100)
            self.assertEqual(state["result"]["outputOffset"], 10)
            self.assertEqual(body, b"x" * 90)
        self.assertEqual(call("get", {"id": "f0", "cursor": 101})[0]["error"]["code"], "INVALID_REQUEST")

    def test_cancel_and_shutdown(self):
        call("exec", self.exec_header("c1"))
        call("cancel", {"id": "c1", "epoch": 10})
        self.assertEqual(self.launcher.killed, ["c1"])
        guest.finish("c1")
        self.launcher.running.discard("c1")
        self.assertEqual(call("get", {"id": "c1"})[0], {"state": "Failed", "error": "CANCELLED", "completionUnknown": False})
        call("exec", self.exec_header("s1"))
        self.launcher.stopping = True
        guest.finish("s1")
        self.launcher.running.discard("s1")
        self.assertEqual(call("get", {"id": "s1"})[0], {"state": "Interrupted", "completionUnknown": True})

    def test_cancel_whose_stop_post_was_killed_too(self):
        call("exec", self.exec_header("k9"))
        call("cancel", {"id": "k9", "epoch": 10})
        self.launcher.running.discard("k9")  # the unit is gone and finish never ran
        self.assertEqual(call("get", {"id": "k9"})[0], {"state": "Failed", "error": "CANCELLED", "completionUnknown": False})

    def test_cancel_overtaking_its_command(self):
        self.assertEqual(call("cancel", {"id": "o1", "epoch": 10})[0], {"state": "Failed", "error": "CANCELLED", "completionUnknown": False})
        self.assertEqual(call("exec", self.exec_header("o1"))[0]["error"], "CANCELLED")
        self.assertEqual(self.launcher.started, [], "a command cancelled before it arrived never starts")
        self.assertEqual(call("write", {"id": "o1", "epoch": 10, "path": "o"}, b"x")[0]["error"]["code"], "CANCELLED")
        self.assertFalse(os.path.exists(os.path.join(self.workspace, "o")))

    def test_recover_marks_unfinished_records_interrupted(self):
        call("exec", self.exec_header("r1"))
        call("exec", self.exec_header("r2"))
        guest.write_json(guest.op_path("r2", "result.json"), {"state": "Failed", "error": "CANCELLED", "completionUnknown": False})
        guest.recover()
        self.launcher.running.clear()
        self.assertEqual(call("get", {"id": "r1"})[0]["state"], "Interrupted")
        self.assertEqual(call("get", {"id": "r2"})[0]["error"], "CANCELLED")

    def test_writes_are_journaled_and_conditional(self):
        written, _ = call("write", {"id": "w1", "epoch": 10, "path": "a/b.txt", "createParents": True}, b"hello")
        self.assertEqual(written["size"], 5)
        self.assertEqual(read(os.path.join(self.workspace, "a/b.txt")), b"hello")
        with open(os.path.join(self.workspace, "a/b.txt"), "wb") as handle:
            handle.write(b"changed")
        self.assertEqual(call("write", {"id": "w1", "epoch": 10, "path": "a/b.txt", "createParents": True}, b"hello")[0], written)
        self.assertEqual(read(os.path.join(self.workspace, "a/b.txt")), b"changed", "a repeated key never writes again")
        self.assertEqual(call("write", {"id": "w1", "epoch": 10, "path": "a/b.txt", "createParents": True}, b"other")[0]["error"]["code"], "CONFLICT")
        stale = call("write", {"id": "w2", "epoch": 10, "path": "a/b.txt", "expectedSha": written["sha256"]}, b"x")[0]
        self.assertEqual(stale["error"]["code"], "PRECONDITION_FAILED")
        self.assertEqual(call("write", {"id": "w2", "epoch": 10, "path": "a/b.txt", "expectedSha": written["sha256"]}, b"x")[0]["error"]["code"],
                         "PRECONDITION_FAILED", "a failed key replays its failure")
        self.assertEqual(call("exec", self.exec_header("w1"))[0]["error"]["code"], "CONFLICT", "a write key cannot become a command")
        self.assertEqual(call("get", {"id": "w1"})[0], {"state": "Written", "result": written})
        missing = call("write", {"id": "w3", "epoch": 10, "path": "no/parent.txt"}, b"x")[0]
        self.assertEqual(missing["error"]["code"], "NOT_FOUND")
        # Journaled but never recorded: the helper stopped in between.
        request = {"kind": "write", "path": "z", "sha256": hashlib.sha256(b"z").hexdigest(), "expectedSha": None, "createParents": False}
        os.mkdir(guest.op_path("w4"))
        guest.write_json(guest.op_path("w4", "request.json"), dict(request, hash=guest.canonical(request)))
        self.assertEqual(call("write", {"id": "w4", "epoch": 10, "path": "z"}, b"z")[0]["error"]["code"], "COMPLETION_UNKNOWN")

    def test_paths_stay_beneath_the_workspace(self):
        os.symlink("/etc", os.path.join(self.workspace, "outside"))
        for path in ["/etc/passwd", "../x", "a/../../x", "a\0b", "", "outside/passwd"]:
            self.assertEqual(call("read", {"path": path})[0]["error"]["code"], "INVALID_REQUEST", path)
        self.assertEqual(call("stat", {"path": "outside"})[0]["kind"], "symlink", "the link itself may be inspected")
        self.assertEqual(call("write", {"id": "p1", "epoch": 10, "path": "outside/x"}, b"x")[0]["error"]["code"], "INVALID_REQUEST")
        self.assertEqual(call("stat", {"path": "."})[0]["kind"], "directory")
        self.assertEqual(call("read", {"path": "missing"})[0]["error"]["code"], "NOT_FOUND")
        self.assertEqual(call("read", {"path": "."})[0]["error"]["code"], "INVALID_REQUEST")

    def test_record_capacity(self):
        original = guest.MAX_RECORDS
        guest.MAX_RECORDS = 2
        try:
            call("exec", self.exec_header("k1"))
            call("exec", self.exec_header("k2"))
            self.assertEqual(call("exec", self.exec_header("k3"))[0]["error"]["code"], "CAPACITY_EXCEEDED")
            self.assertEqual(call("exec", self.exec_header("k1"))[0]["state"], "Running", "existing keys stay readable")
        finally:
            guest.MAX_RECORDS = original

    def test_seal_final_removes_the_machine_identity_and_keeps_the_preparation(self):
        system = os.path.join(self.root, "system")
        guest.configure(root=system, state=os.path.join(system, "var/lib/cube"))
        try:
            files = {
                "var/lib/cube/ops/ws-1/request.json": "{}", "var/lib/cube/epoch": "9", "etc/cube/env": "GH_TOKEN=cube_ph_github_x",
                "etc/cube/hooks/pre-setup": "#!/bin/sh", "etc/ssh/ssh_host_ed25519_key": "private", "etc/ssh/sshd_config": "keep",
                "etc/machine-id": "0123456789abcdef0123456789abcdef", "var/lib/cloud/instances/a/boot-finished": "",
                "var/lib/dhcp/dhclient.leases": "lease", "var/lib/systemd/random-seed": "seed", "tmp/socket": "",
                "home/agent/.bash_history": "history", "home/agent/.cache/cube/setup.log": "keep",
                "workspace/node_modules/x": "keep", "etc/systemd/system/cube-seal.service": "[Unit]",
            }
            for name, content in files.items():
                os.makedirs(os.path.dirname(os.path.join(system, name)), exist_ok=True)
                with open(os.path.join(system, name), "w") as handle:
                    handle.write(content)
            self.assertEqual(guest.seal_final(), 0)
            gone = ["var/lib/cube", "etc/cube", "etc/ssh/ssh_host_ed25519_key", "var/lib/cloud/instances", "var/lib/dhcp/dhclient.leases",
                    "var/lib/systemd/random-seed", "tmp/socket", "home/agent/.bash_history", "etc/systemd/system/cube-seal.service",
                    "home/agent/.cache/cube/setup.log"]
            for name in gone:
                self.assertFalse(os.path.exists(os.path.join(system, name)), name)
            for name in ["etc/ssh/sshd_config", "workspace/node_modules/x"]:
                self.assertTrue(os.path.exists(os.path.join(system, name)), name)
            self.assertEqual(os.path.getsize(os.path.join(system, "etc/machine-id")), 0, "empty: a new id at the next boot")
            self.assertTrue(os.path.exists(os.path.join(system, guest.SEAL_MARKER)))
            # The first boot of a machine made from it: a fresh journal, the marker consumed.
            os.makedirs(os.path.join(system, "var/lib/cube/ops/ws-stale"))
            self.assertEqual(guest.init(), 0)
            self.assertEqual(os.listdir(os.path.join(system, "var/lib/cube/ops")), [])
            self.assertFalse(os.path.exists(os.path.join(system, guest.SEAL_MARKER)))
            self.assertEqual(call("hello", {})[0]["templateSeal"], "ok")
            # An ordinary later init keeps the journal (only a template's first boot clears it).
            os.makedirs(os.path.join(system, "var/lib/cube/ops/ws-2"))
            guest.init()
            self.assertEqual(os.listdir(os.path.join(system, "var/lib/cube/ops")), ["ws-2"])
            # A seal that could not clean everything says so, and the next
            # machine still starts with an empty journal and reports it.
            os.remove(os.path.join(system, "etc/machine-id"))
            os.makedirs(os.path.join(system, "etc/machine-id"))
            self.assertEqual(guest.seal_final(), 1)
            guest.init()
            self.assertEqual(os.listdir(os.path.join(system, "var/lib/cube/ops")), [])
            self.assertRegex(call("hello", {})[0]["templateSeal"], r"^failed: /etc/machine-id")
            # A seal that never ran at power-off: seal() left the failure up front.
            os.makedirs(os.path.dirname(os.path.join(system, guest.SEAL_MARKER)))
            with open(os.path.join(system, guest.SEAL_MARKER), "w") as handle:
                handle.write("failed: the seal did not run at power-off")
            os.makedirs(os.path.join(system, "var/lib/cube/ops/ws-3"))
            guest.init()
            self.assertEqual(os.listdir(os.path.join(system, "var/lib/cube/ops")), [])
            self.assertEqual(call("hello", {})[0]["templateSeal"], "failed: the seal did not run at power-off")
        finally:
            guest.configure(root="/")

    def test_dispatch(self):
        stdout = io.BytesIO()
        guest.call("format-disk", io.BytesIO(b"{}\n"), stdout)
        self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "UNSUPPORTED")
        self.assertEqual(call("read", {"path": "x", "limit": 10 ** 9})[0]["error"]["code"], "INVALID_REQUEST")
        stdout = io.BytesIO()
        guest.call("hello", io.BytesIO(b"not json\n"), stdout)
        self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "INVALID_REQUEST")


class FakeServices:
    """Runs each service's command as a process group in place of a unit."""

    def __init__(self, root):
        self.root = root
        self.processes = {}
        self.removed = []
        self.fail = None

    def log(self, name):
        return os.path.join(self.root, "service-%s.log" % name)

    def start(self, name):
        if self.fail:
            raise self.fail
        self.stop(name)
        record = guest.registration(name)
        env = dict(os.environ, PORT=str(record["port"]), HOST="0.0.0.0", **record["env"])
        with open(self.log(name), "ab") as output:
            self.processes[name] = subprocess.Popen(["/bin/bash", "-c", record["command"]], cwd=record["cwd"], env=env,
                                                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                                    start_new_session=True)

    def restart(self, name):
        self.start(name)

    def stop(self, name):
        process = self.processes.pop(name, None)
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

    def remove(self, name):
        self.removed.append(name)
        self.stop(name)

    def state(self, name):
        process = self.processes.get(name)
        if process is None:
            return {"active": "missing", "sub": "", "restarts": 0}
        code = process.poll()
        return {"active": "active" if code is None else "failed" if code else "inactive", "sub": "running" if code is None else "exited",
                "restarts": 0}

    def logs(self, name, lines, follow):
        try:
            with open(self.log(name), "r") as handle:
                return "".join(handle.readlines()[-lines:])
        except FileNotFoundError:
            return ""


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ServicesTest(unittest.TestCase):
    """`cube service` with processes in place of systemd units."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cube-services-")
        self.workspace = os.path.join(self.root, "workspace")
        os.mkdir(self.workspace)
        self.services = FakeServices(self.root)
        guest.configure(state=os.path.join(self.root, "state"), workspace=self.workspace, env_file=os.path.join(self.root, "env"),
                        user=None, ready_files=[], commands=[], launcher=FakeLauncher(), services=self.services,
                        portal_file=os.path.join(self.root, "portal.json"), service_host="127.0.0.1",
                        helper=os.path.join(self.root, "cube-guest"), cli=os.path.join(self.root, "bin", "cube"))

    def tearDown(self):
        for name in list(self.services.processes):
            self.services.stop(name)
        guest.configure(services=guest.SystemdServices(), portal_file="/etc/cube/portal.json", service_host=None,
                        helper=guest.HELPER, cli=guest.CLI_PATH)
        shutil.rmtree(self.root)

    def cube(self, *argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = guest.cli(["--from", self.workspace] + list(argv))
        return code, stdout.getvalue(), stderr.getvalue()

    def portal(self):
        self.assertEqual(call("portal", {"portal": {"urlTemplate": "http://{name}-0123456789.100-64-0-1.sslip.io:7780/"}})[0],
                         {"urlTemplate": "http://{name}-0123456789.100-64-0-1.sslip.io:7780/"})

    def test_start_waits_for_the_port_and_prints_the_url(self):
        self.portal()
        port = free_port()
        code, out, err = self.cube("service", "start", "web", "--port", str(port), "--env", "GREETING=hi", "--json", "--",
                                   "python3", "-m", "http.server", "--bind", "127.0.0.1", str(port))
        self.assertEqual(code, 0, out + err)
        view = json.loads(out)
        self.assertTrue(view["ok"])
        self.assertEqual(view["url"], "http://web-0123456789.100-64-0-1.sslip.io:7780/")
        self.assertRegex(view["http"], r"^HTTP/1\.[01] 200")
        self.assertEqual(view["command"], "python3 -m http.server --bind 127.0.0.1 %d" % port)
        self.assertEqual(view["cwd"], self.workspace)
        record = guest.registration("web")
        self.assertEqual((record["kind"], record["port"], record["env"]), ("command", port, {"GREETING": "hi"}))
        # cubed's view of it.
        services = call("services", {"probe": True})[0]["services"]
        self.assertEqual([(item["name"], item["port"], item["state"], item["listening"]) for item in services], [("web", port, "active", True)])
        code, out, _ = self.cube("service", "list")
        self.assertIn("web  port %d  active" % port, out)
        self.assertIn("url: http://web-0123456789", out)
        # Another name may not take the port; the same name replaces itself.
        code, _, err = self.cube("service", "start", "other", "--port", str(port), "--", "true")
        self.assertEqual(code, 2)
        self.assertIn("already service web", err)
        code, out, _ = self.cube("service", "stop", "web")
        self.assertEqual((code, out.strip()), (0, "service web stopped"))
        self.assertEqual(self.services.removed, ["web"])
        self.assertEqual(call("services", {})[0], {"services": []})
        self.assertEqual(self.cube("service", "stop", "web")[1].strip(), "no service web")

    def test_a_failing_service_reports_its_output(self):
        port = free_port()
        code, out, err = self.cube("service", "start", "broken", "--port", str(port), "--wait", "5", "--",
                                   "echo cannot find module; exit 3")
        self.assertEqual(code, 1, out + err)
        self.assertIn("service broken is registered but not healthy: the service stopped", out)
        self.assertIn("cannot find module", out)
        self.assertIn("cube service restart broken", out)
        # Without a portal the URL says why.
        code, out, _ = self.cube("service", "status", "broken")
        self.assertIn("url: none (cube has not configured a portal", out)
        call("portal", {"portal": {"reason": "this cube installation has no portal (CUBED_PORTAL_IP is not set)"}})
        self.assertIn("url: none (this cube installation has no portal", self.cube("service", "status", "broken")[1])

    def test_loopback_only_listeners_are_named(self):
        guest.configure(service_host="127.0.0.2")
        port = free_port()
        code, out, _ = self.cube("service", "start", "local", "--port", str(port), "--wait", "2", "--",
                                 "exec python3 -m http.server --bind 127.0.0.1 %d" % port)
        self.assertEqual(code, 1)
        self.assertIn("answers on 127.0.0.1 only", out)

    def test_open_registers_a_server_that_runs_elsewhere(self):
        port = free_port()
        code, out, _ = self.cube("service", "open", "api", "--port", str(port), "--wait", "0", "--json")
        self.assertEqual(code, 1)
        self.assertIn("nothing listens", json.loads(out)["error"])
        with socket.socket() as server:
            server.bind(("127.0.0.1", port))
            server.listen()
            code, out, _ = self.cube("service", "open", "api", "--port", str(port), "--wait", "0")
        self.assertEqual(code, 0, out)
        self.assertIn("service api replaced on port %d" % port, out)
        self.assertEqual(guest.registration("api")["kind"], "external")
        self.assertEqual(self.cube("service", "logs", "api")[0], 2)

    def test_usage_errors(self):
        for argv, message in [(["service", "start", "Web", "--port", "8000", "--", "x"], "service name"),
                              (["service", "start", "web\nExecStartPre=x", "--port", "8000", "--", "x"], "service name"),
                              (["service", "status", "web\n"], "service name"),
                              (["service", "start", "web", "--port", "80", "--", "x"], "--port must be 1024-65535"),
                              (["service", "start", "web", "--port", "8000"], "give the command after --"),
                              (["service", "start", "web", "--port", "8000", "--env", "PORT=1", "--", "x"], "--env takes"),
                              (["service", "start", "web", "--port", "8000", "--cwd", "missing", "--", "x"], "no directory"),
                              (["service", "frobnicate"], "unknown command"),
                              (["service", "status"], "one service name")]:
            code, _, err = self.cube(*argv)
            self.assertEqual(code, 2, argv)
            self.assertIn(message, err)
        self.assertEqual(self.cube("deploy")[0], 2)
        self.assertEqual(self.cube("service", "--help")[0], 0)
        for index in range(guest.MAX_SERVICES):
            guest.save_registration({"name": "s%d" % index, "port": 2000 + index, "kind": "external"})
        self.assertIn("at most 16 services", self.cube("service", "open", "one-more", "--port", "3000")[2])
        # A start systemd refuses leaves nothing registered.
        self.services.fail = guest.Fail("IO_ERROR", "systemctl enable failed")
        code, _, err = self.cube("service", "start", "s0", "--port", "2000", "--", "true")
        self.assertEqual((code, err.strip()), (1, "cube service: systemctl enable failed"))
        self.assertIsNone(guest.registration("s0"))

    def test_service_run_runs_the_registration_as_its_unit(self):
        port = free_port()
        guest.save_registration({"name": "env", "port": port, "kind": "command", "cwd": self.workspace, "env": {"A": "b"},
                                 "command": "echo $PORT $HOST $CUBE_SERVICE $A; pwd"})
        script = ("import importlib.util,sys;sys.dont_write_bytecode=True;spec=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(spec);"
                  "spec.loader.exec_module(g);g.configure(state=sys.argv[2],user=None,env_file='/nonexistent');sys.exit(g.main(['service-run',sys.argv[3]]))")
        helper = os.path.join(HERE, "..", "guest", "cube-guest.py")
        result = subprocess.run([sys.executable, "-c", script, helper, os.path.join(self.root, "state"), "env"], capture_output=True, text=True)
        self.assertEqual(result.stdout.split("\n")[:2], ["%d 0.0.0.0 env b" % port, self.workspace], result.stderr)
        result = subprocess.run([sys.executable, "-c", script, helper, os.path.join(self.root, "state"), "gone"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not registered", result.stderr)

    def test_unit_text_names_only_the_service(self):
        text = guest.SystemdServices().text("web")
        self.assertIn("ExecStart=/usr/local/sbin/cube-guest service-run web\n", text)
        self.assertIn("Restart=on-failure", text)
        self.assertIn("WantedBy=multi-user.target", text)

    def test_install_replaces_the_helper_and_writes_the_shim(self):
        with open(os.path.join(HERE, "..", "guest", "cube-guest.py"), "rb") as handle:
            source = handle.read()
        self.assertIsNone(call("hello", {})[0]["build"])
        digest = hashlib.sha256(source).hexdigest()
        self.assertEqual(call("install", {"sha256": "0" * 64}, source)[0]["error"]["code"], "INVALID_REQUEST")
        self.assertEqual(call("install", {"sha256": hashlib.sha256(b"x").hexdigest()}, b"x")[0]["error"]["code"], "INVALID_REQUEST")
        self.assertEqual(call("install", {"sha256": digest}, source)[0], {"build": digest})
        self.assertEqual(read(os.path.join(self.root, "cube-guest")), source)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.root, "cube-guest")).st_mode), 0o755)
        self.assertEqual(read(os.path.join(self.root, "bin", "cube")).decode(), guest.CLI_SHIM)
        self.assertEqual(call("hello", {})[0]["build"], digest)
        self.assertEqual(call("install", {"sha256": digest}, source)[0], {"build": digest})

    def test_portal_settings_are_checked(self):
        for portal in [{"urlTemplate": "https://{name}-x.example/"}, {"urlTemplate": "http://evil/{name}"}, {}, None,
                       {"urlTemplate": "http://{name}-x.example/\n"}]:
            self.assertEqual(call("portal", {"portal": portal})[0]["error"]["code"], "INVALID_REQUEST", portal)

    def test_seal_removes_service_units(self):
        system = os.path.join(self.root, "system")
        units = os.path.join(system, "etc/systemd/system")
        os.makedirs(os.path.join(units, "multi-user.target.wants"))
        for path in ("cube-service-web.service", "multi-user.target.wants/cube-service-web.service", "ssh.service"):
            with open(os.path.join(units, path), "w") as handle:
                handle.write("x")
        guest.remove_service_units(units)
        self.assertEqual(sorted(os.listdir(units)), ["multi-user.target.wants", "ssh.service"])
        self.assertEqual(os.listdir(os.path.join(units, "multi-user.target.wants")), [])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
