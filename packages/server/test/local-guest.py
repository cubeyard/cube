#!/usr/bin/env python3
"""Test only: the real guest helper under a temporary root, with a process
launcher in place of systemd. Production code knows only the systemd
launcher; this file injects the other one.

  local-guest.py ROOT call OP        one helper request on stdin/stdout
  local-guest.py ROOT supervise ID MS  (internal) stands in for the unit
  local-guest.py ROOT cli service ...  the agent's `cube` command
                                       (hooks in ROOT/hooks, their logs in ROOT/home/.cache/cube)
"""
import importlib.util
import os
import signal
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
# No __pycache__ next to the shipped helper.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cube_guest", os.path.join(HERE, "..", "guest", "cube-guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class ProcessLauncher:
    """A detached supervisor process per command: it runs the wrapper in its
    own process group, enforces the timeout and then calls `finish` with the
    variables systemd would set for ExecStopPost."""

    def __init__(self, root):
        self.root = root

    def start(self, op_id, timeout_ms):
        child = subprocess.Popen([sys.executable, os.path.abspath(__file__), self.root, "supervise", op_id, str(timeout_ms)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        guest.write_atomic(guest.op_path(op_id, "supervisor.pid"), str(child.pid).encode())

    def _pid(self, op_id, name):
        try:
            with open(guest.op_path(op_id, name)) as handle:
                return int(handle.read().strip())
        except (FileNotFoundError, ValueError):
            return None

    def active(self, op_id):
        pid = self._pid(op_id, "supervisor.pid")
        if pid is None:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        try:
            with open("/proc/%d/stat" % pid) as handle:
                return handle.read().split(") ")[-1].split()[0] != "Z"
        except FileNotFoundError:
            return True  # no procfs (macOS): kill(0) is the answer

    def kill(self, op_id):
        pid = self._pid(op_id, "wrap.pid")
        if pid is not None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def shutting_down(self):
        return False


class ProcessServices:
    """`cube service` services as detached process groups in place of
    systemd units; their output goes to ROOT/services/NAME.log."""

    def __init__(self, root):
        self.directory = os.path.join(root, "services")

    def _pid(self, name):
        try:
            with open(os.path.join(self.directory, name + ".pid")) as handle:
                return int(handle.read().strip())
        except (FileNotFoundError, ValueError):
            return None

    def _alive(self, pid):
        try:
            os.kill(pid, 0)
            with open("/proc/%d/stat" % pid) as handle:
                return handle.read().split(") ")[-1].split()[0] != "Z"
        except (ProcessLookupError, FileNotFoundError):
            return False

    def start(self, name):
        self.stop(name)
        os.makedirs(self.directory, exist_ok=True)
        with open(os.path.join(self.directory, name + ".log"), "ab") as output:
            child = subprocess.Popen([sys.executable, os.path.abspath(__file__), ROOT, "service-run", name],
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        guest.write_atomic(os.path.join(self.directory, name + ".pid"), str(child.pid).encode())

    def restart(self, name):
        self.start(name)

    def stop(self, name):
        pid = self._pid(name)
        if pid is not None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def remove(self, name):
        self.stop(name)
        try:
            os.unlink(os.path.join(self.directory, name + ".pid"))
        except FileNotFoundError:
            pass

    def state(self, name):
        pid = self._pid(name)
        if pid is None:
            return {"active": "missing", "sub": "", "restarts": 0}
        alive = self._alive(pid)
        return {"active": "active" if alive else "failed", "sub": "running" if alive else "exited", "restarts": 0}

    def logs(self, name, lines, follow):
        try:
            with open(os.path.join(self.directory, name + ".log")) as handle:
                return "".join(handle.readlines()[-lines:])
        except FileNotFoundError:
            return ""


ROOT = None


def configure(root):
    global ROOT
    ROOT = root
    # The machine is ROOT: an absolute path in a file operation lands beneath
    # it, never on the host running the tests.
    guest.configure(root=root, state=os.path.join(root, "state"), workspace=os.path.join(root, "workspace"),
                    env_file=os.path.join(root, "env"), user=None, ready_files=[], commands=[], launcher=ProcessLauncher(root),
                    helper=os.path.join(root, "cube-guest"), cli=os.path.join(root, "bin", "cube"),
                    portal_file=os.path.join(root, "portal.json"), services=ProcessServices(root), service_host="127.0.0.1",
                    hooks_dir=os.path.join(root, "hooks"), hook_logs=os.path.join(root, "home", ".cache", "cube"))


def supervise(root, op_id, timeout_ms):
    child = subprocess.Popen([sys.executable, os.path.abspath(__file__), root, "wrap", op_id],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    guest.write_atomic(guest.op_path(op_id, "wrap.pid"), str(child.pid).encode())
    # A cancel that came before wrap.pid existed left only its marker.
    if os.path.exists(guest.op_path(op_id, "cancel")):
        os.killpg(child.pid, signal.SIGKILL)
    timed_out = threading.Event()

    def expire():
        timed_out.set()
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    timer = threading.Timer(timeout_ms / 1000, expire)
    timer.start()
    code = child.wait()
    timer.cancel()
    os.environ["SERVICE_RESULT"] = "timeout" if timed_out.is_set() else "success" if code == 0 \
        else "signal" if code < 0 else "exit-code"
    os.environ["EXIT_CODE"] = "killed" if code < 0 else "exited"
    os.environ["EXIT_STATUS"] = str(-code if code < 0 else code)
    return guest.finish(op_id)


if __name__ == "__main__":
    root, command = sys.argv[1], sys.argv[2:]
    configure(root)
    if command[0] == "supervise":
        sys.exit(supervise(root, command[1], int(command[2])))
    if command[0] == "service-run":
        sys.exit(guest.service_run(command[1]))
    if command[0] == "wrap":
        # Like the unit's wrapper, but the command must not inherit this
        # process group's fate beyond the group the supervisor kills.
        sys.exit(guest.wrap(command[1]))
    sys.exit(guest.main(command))
