#!/usr/bin/env python3
"""Test only: the real guest helper under a temporary root, with the
helper's own process launcher (host mode's) in place of systemd.

  local-guest.py ROOT call OP        one helper request on stdin/stdout
  local-guest.py ROOT supervise ID MS  (internal) stands in for the unit
  local-guest.py ROOT cli service ...  the agent's `cube` command
                                       (hooks in ROOT/hooks, their logs in ROOT/home/.cache/cube)
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# No __pycache__ next to the shipped helper.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cube_guest", os.path.join(HERE, "..", "guest", "cube-guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


def configure(root):
    # The machine is ROOT: an absolute path in a file operation lands beneath
    # it, never on the host running the tests.
    prefix = [sys.executable, os.path.abspath(__file__), root]
    guest.configure(root=root, state=os.path.join(root, "state"), workspace=os.path.join(root, "workspace"),
                    env_file=os.path.join(root, "env"), user=None, ready_files=[], commands=[],
                    launcher=guest.ProcessLauncher(prefix, root),
                    helper=os.path.join(root, "cube-guest"), cli=os.path.join(root, "bin", "cube"),
                    portal_file=os.path.join(root, "portal.json"), services=guest.ProcessServices(prefix, os.path.join(root, "services")),
                    service_host="127.0.0.1",
                    hooks_dir=os.path.join(root, "hooks"), hook_logs=os.path.join(root, "home", ".cache", "cube"))


if __name__ == "__main__":
    root, command = sys.argv[1], sys.argv[2:]
    configure(root)
    if command[0] == "supervise":
        sys.exit(guest.CONFIG.launcher.supervise(command[1], int(command[2])))
    sys.exit(guest.main(command))
