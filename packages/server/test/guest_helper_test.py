"""Unit tests of the guest helper (packages/server/guest/cube-guest.py) with
a test launcher injected; run by guest-helper-test.ts. The workspace
contract over the helper runs in workspace-test.ts (local guest) and against
a real VM in smoke-node-adapter.ts."""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
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
                        user=None, ready_files=[], launcher=self.launcher)

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
        self.assertEqual(answer["limits"]["maxWriteBytes"], 524288)
        self.assertIn("fs.write", answer["capabilities"])
        guest.configure(ready_files=[os.path.join(self.root, "boot-finished")])
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

    def test_dispatch(self):
        stdout = io.BytesIO()
        guest.call("format-disk", io.BytesIO(b"{}\n"), stdout)
        self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "UNSUPPORTED")
        self.assertEqual(call("read", {"path": "x", "limit": 10 ** 9})[0]["error"]["code"], "INVALID_REQUEST")
        stdout = io.BytesIO()
        guest.call("hello", io.BytesIO(b"not json\n"), stdout)
        self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "INVALID_REQUEST")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
