#!/usr/bin/env python3
"""Test only: the real guest helper under a temporary root, with a process
launcher in place of systemd. Production code knows only the systemd
launcher; this file injects the other one.

  local-guest.py ROOT call OP        one helper request on stdin/stdout
  local-guest.py ROOT supervise ID MS  (internal) stands in for the unit
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


def configure(root):
    guest.configure(state=os.path.join(root, "state"), workspace=os.path.join(root, "workspace"),
                    env_file=os.path.join(root, "env"), user=None, ready_files=[], commands=[], launcher=ProcessLauncher(root))


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
    if command[0] == "wrap":
        # Like the unit's wrapper, but the command must not inherit this
        # process group's fate beyond the group the supervisor kills.
        sys.exit(guest.wrap(command[1]))
    sys.exit(guest.main(command))
