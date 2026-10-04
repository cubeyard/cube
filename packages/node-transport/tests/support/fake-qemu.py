#!/usr/bin/env python3
"""Test stand-in for qemu-system-*: answers QMP on the -qmp socket, echoes
every frame it receives on its -netdev dgram socket back to the runner, and
writes a console line. Behaviour switches are files next to this script
(the runner clears QEMU's environment):

  ignore-powerdown  system_powerdown is acknowledged but ignored
  exit-at-once      exits with status 3 before opening QMP
"""
import json
import os
import socket
import sys
import threading
import time

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
if args == ["--version"]:
    print("QEMU emulator version 8.2.2 (fake)")
    sys.exit(0)


def opt(name):
    return args[args.index(name) + 1]


name = opt("-name").split("=", 1)[1]
qmp_path = opt("-qmp")[len("unix:"):].split(",")[0]
console = opt("-serial")[len("file:"):]
netdev = dict(kv.split("=", 1) for kv in opt("-netdev").split(",") if "=" in kv)
vm_dir = os.path.dirname(console)

with open(os.path.join(vm_dir, "fake.pid"), "w") as f:
    f.write(str(os.getpid()))
with open(os.path.join(vm_dir, "fake.args"), "w") as f:
    f.write("\n".join(args))
with open(console, "a") as f:
    f.write("fake qemu booting %s\nCloud-init finished (fake)\n" % name)
if os.path.exists(os.path.join(here, "exit-at-once")):
    sys.stderr.write("fake qemu refused to start\n")
    sys.exit(3)

net = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
net.bind(netdev["local.path"])


def echo():
    while True:
        frame = net.recv(65536)
        try:
            net.sendto(frame, netdev["remote.path"])
        except OSError:
            pass


threading.Thread(target=echo, daemon=True).start()

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(qmp_path)
server.listen(1)


def reply(f, value):
    f.write(json.dumps(value) + "\n")
    f.flush()


while True:
    connection, _ = server.accept()
    f = connection.makefile("rw")
    reply(f, {"QMP": {"version": {"qemu": {"major": 8, "minor": 2, "micro": 2}}, "capabilities": []}})
    for line in f:
        command = json.loads(line).get("execute")
        if command == "query-name":
            reply(f, {"return": {"name": name}})
        elif command == "system_powerdown":
            reply(f, {"return": {}})
            if not os.path.exists(os.path.join(here, "ignore-powerdown")):
                reply(f, {"event": "SHUTDOWN", "data": {"guest": True}})
                time.sleep(0.2)
                os._exit(0)
        elif command == "quit":
            reply(f, {"return": {}})
            os._exit(0)
        else:
            reply(f, {"return": {}})
    connection.close()
