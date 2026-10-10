#!/usr/bin/env python3
"""Snapshot and resume of a running guest under QEMU.

Boots cube's guest kernel with snapshot/tick.c as init, reads its ticks from
the virtio-serial port, saves the machine to a file (`migrate file:`), quits,
waits, restores it in a new QEMU process and checks that the ticks continue
where they stopped: same counter, the EROFS disk still readable, and the guest
clocks compared with the host's. Run smoke/build.sh first.

Usage: packages/keel/snapshot/test.py <arm64|x86_64> [accel] [--mapped-ram] [--pause SECONDS]
"""
import argparse
import json
import os
import platform
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MACHINES = {
    "arm64": ("qemu-system-aarch64", "virt-11.1", "ttyAMA0"),
    "x86_64": ("qemu-system-x86_64", "pc-q35-11.1", "ttyS0"),
}
TICK = re.compile(r"tick (\d+) mono=([\d.]+) real=([\d.]+) ptp=([-\d.]+) layer=(\w+)")


def native_accel(arch):
    host = (platform.system(), platform.machine())
    if host == ("Darwin", "arm64") and arch == "arm64":
        return "hvf"
    if host in (("Linux", "x86_64"),) and arch == "x86_64":
        return "kvm"
    if host in (("Linux", "aarch64"),) and arch == "arm64":
        return "kvm"
    return "tcg"


class Qmp:
    def __init__(self, path):
        for _ in range(200):
            try:
                self.sock = socket.socket(socket.AF_UNIX)
                self.sock.connect(path)
                break
            except OSError:
                time.sleep(0.02)
        else:
            raise RuntimeError("QMP socket did not appear")
        self.file = self.sock.makefile("rw")
        json.loads(self.file.readline())
        self.call("qmp_capabilities")

    def call(self, command, **arguments):
        self.file.write(json.dumps({"execute": command, "arguments": arguments}) + "\n")
        self.file.flush()
        while True:
            reply = json.loads(self.file.readline())
            if "return" in reply:
                return reply["return"]
            if "error" in reply:
                raise RuntimeError("%s: %s" % (command, reply["error"]))

    def wait_migration(self):
        while True:
            status = self.call("query-migrate").get("status")
            if status == "completed":
                return
            if status in ("failed", "cancelled"):
                raise RuntimeError("migration %s" % status)
            time.sleep(0.01)


class Ticks:
    """Reads tick lines from the host end of the virtio-serial port."""

    def __init__(self, path):
        for _ in range(200):
            try:
                self.sock = socket.socket(socket.AF_UNIX)
                self.sock.connect(path)
                break
            except OSError:
                time.sleep(0.02)
        else:
            raise RuntimeError("serial socket did not appear")
        self.lines = []
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        buffer = b""
        while True:
            try:
                data = self.sock.recv(4096)
            except OSError:
                return
            if not data:
                return
            buffer += data
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                match = TICK.match(line.decode(errors="replace"))
                if match:
                    with self.lock:
                        self.lines.append((time.time(), match))

    def wait(self, count, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.lines) >= count:
                    return list(self.lines)
            time.sleep(0.005)
        raise RuntimeError("only %d ticks after %ss" % (len(self.lines), timeout))


def qemu_argv(arch, accel, work, incoming):
    binary, machine, console = MACHINES[arch]
    out = os.path.join(ROOT, "out", arch)
    argv = [
        binary, "-machine", machine, "-accel", accel, "-cpu", "max" if accel == "tcg" else "host",
        "-smp", "2", "-m", "512", "-nodefaults", "-no-user-config", "-display", "none",
        "-serial", "file:" + os.path.join(work, "console.log"),
        "-qmp", "unix:%s,server=on,wait=off" % os.path.join(work, "qmp.sock"),
        "-kernel", os.path.join(out, "vmlinuz"), "-initrd", os.path.join(out, "tick.cpio"),
        "-append", "console=%s panic=-1 quiet" % console,
        "-drive", "if=virtio,format=raw,readonly=on,file=" + os.path.join(out, "lz4.erofs"),
        "-device", "virtio-rtc-pci",
        "-device", "virtio-serial-pci",
        "-chardev", "socket,id=ctl,path=%s,server=on,wait=off" % os.path.join(work, "ctl.sock"),
        "-device", "virtserialport,chardev=ctl,name=cube.0",
    ]
    if incoming:
        argv += ["-S", "-incoming", "defer"]
    return argv


RUNNING = []


def start(argv):
    """Starts QEMU detached from our stdio; main() kills leftovers on exit."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    RUNNING.append(process)
    return process


def describe(host_time, match):
    n, mono, real, ptp, layer = match.groups()
    return int(n), float(mono), float(real), float(ptp), layer, host_time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("arch", choices=MACHINES)
    parser.add_argument("accel", nargs="?")
    parser.add_argument("--mapped-ram", action="store_true")
    parser.add_argument("--pause", type=float, default=5.0)
    args = parser.parse_args()
    accel = args.accel or native_accel(args.arch)
    capabilities = [{"capability": "mapped-ram", "state": True}] if args.mapped_ram else []

    with tempfile.TemporaryDirectory(prefix="cube-snapshot-", dir="/tmp") as work:
        snapshot = os.path.join(work, "machine.snap")

        started = time.time()
        first = start(qemu_argv(args.arch, accel, work, False))
        qmp = Qmp(os.path.join(work, "qmp.sock"))
        ticks = Ticks(os.path.join(work, "ctl.sock"))
        before = ticks.wait(10)
        boot = before[0][0] - started

        t0 = time.monotonic()
        qmp.call("stop")
        if capabilities:
            qmp.call("migrate-set-capabilities", capabilities=capabilities)
        qmp.call("migrate", uri="file:" + snapshot)
        qmp.wait_migration()
        save = time.monotonic() - t0
        qmp.call("quit")
        first.wait(timeout=30)
        with ticks.lock:
            stopped_at = describe(*ticks.lines[-1])
        size = os.stat(snapshot)
        for name in ("qmp.sock", "ctl.sock"):
            if os.path.exists(os.path.join(work, name)):
                os.unlink(os.path.join(work, name))

        time.sleep(args.pause)

        t0 = time.monotonic()
        second = start(qemu_argv(args.arch, accel, work, True))
        qmp = Qmp(os.path.join(work, "qmp.sock"))
        resumed_ticks = Ticks(os.path.join(work, "ctl.sock"))
        if capabilities:
            qmp.call("migrate-set-capabilities", capabilities=capabilities)
        qmp.call("migrate-incoming", uri="file:" + snapshot)
        qmp.wait_migration()
        loaded = time.monotonic() - t0
        cont_at = time.time()
        qmp.call("cont")
        first_tick = resumed_ticks.wait(1)[0][0] - cont_at
        after = resumed_ticks.wait(5)
        qmp.call("quit")
        second.wait(timeout=30)

    resumed = [describe(*item) for item in after]
    n0, mono0, real0, ptp0, layer0, host0 = resumed[0]
    n_last, _, _, _, _, host_last = resumed[-1]
    print("arch=%s accel=%s mapped-ram=%s pause=%.1fs" % (args.arch, accel, args.mapped_ram, args.pause))
    print("boot: QEMU start to first tick %.3fs" % boot)
    print("save: stop + migrate to file %.3fs, file %.1f MiB on disk (%.1f MiB apparent)"
          % (save, size.st_blocks * 512 / 2**20, size.st_size / 2**20))
    print("restore: new QEMU to state loaded %.3fs; first tick %.3fs after cont (the guest sleeps up to 0.2s between ticks)"
          % (loaded, first_tick))
    print("ticks: last before save %d, first after resume %d (%s)"
          % (stopped_at[0], n0, "continues" if n0 in (stopped_at[0], stopped_at[0] + 1) else "GAP"))
    print("guest monotonic across the gap: %.3fs -> %.3fs (+%.3fs)" % (stopped_at[1], mono0, mono0 - stopped_at[1]))
    print("guest realtime behind host after resume: %.3fs" % (host0 - real0))
    print("virtio-rtc (ptp) behind host after resume: %.3fs" % (host0 - ptp0))
    print("EROFS reads after resume: %s" % ("ok" if all(r[4] == "ok" for r in resumed) else "FAIL"))
    ok = n0 in (stopped_at[0], stopped_at[0] + 1) and all(r[4] == "ok" for r in resumed)
    print("result: %s" % ("ok" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        for process in RUNNING:
            if process.poll() is None:
                process.kill()
            error = process.stderr.read().decode(errors="replace").strip()
            if error:
                print("qemu stderr: " + error[-1500:], file=sys.stderr)
