#!/usr/bin/python3
"""cube-guest: a thread's workspace inside its VM.

cubed reaches this helper over SSH (the key in /etc/cube/authorized_keys may
only run `cube-guest ssh`, which dispatches on SSH_ORIGINAL_COMMAND). One
request is one JSON header line on stdin, optionally followed by a raw body;
the answer is one JSON header line on stdout, optionally followed by a raw
body. Errors are answered as {"error": {"code", "message"}} with exit status 0,
so a nonzero status always means the transport or the helper itself failed.

Operations keep protocol 2's semantics: commands and writes carry a key that
is journaled under /var/lib/cube/ops/<id> before anything happens (the same
key and request returns the recorded state, a different request is CONFLICT,
records are never deleted), mutations carry a lease epoch that never goes
back (an older one is LEASE_STALE), and a command runs in a transient
systemd unit, so it survives cubed or gateway restarts and is found again by
its key. A reboot marks unfinished records interrupted; nothing is ever run
twice.

The same file is the `cube` command inside the guest (/usr/local/bin/cube
is a shim that runs `cube-guest cli`): `cube service` runs the agent's web
servers as supervised systemd services, outside the transient unit of the
command that started them, and registers their port for cubed's portal.
cubed reads the registrations with the `services` operation; nothing in the
guest calls cubed. `cube hooks` shows the hooks this machine runs and their
last outcomes and logs, read only, from files in this machine.

File operations take a path relative to /workspace or an absolute path in
this machine. Inside the workspace they act as root and give what they
create to the agent; anywhere else they act with the agent account's own
permissions, as its commands do without sudo. /proc, /sys and /dev are not
files to them.

The VM is the isolation boundary: path checks are contract, not security.
Python 3 standard library only.
"""

import errno
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import time

VERSION = "1"
HELPER = "/usr/local/sbin/cube-guest"
CLI_PATH = "/usr/local/bin/cube"
CLI_SHIM = "#!/bin/sh\nexec %s cli \"$@\"\n" % HELPER
CAPABILITIES = ["exec.start", "exec.cancel", "operation.get", "fs.read", "fs.write", "fs.stat", "fs.absolute",
                "services.list", "helper.install", "portal.configure"]
# Kernel and device pseudo-filesystems: endless, blocking or live "files" a
# file tool must not read or write whole; bash reaches them.
PSEUDO_FILESYSTEMS = ("/proc", "/sys", "/dev")
LIMITS = {
    "maxFrameBytes": 1048576,
    "requestTimeoutMs": 30000,
    "maxCommandBytes": 8192,
    "maxPathBytes": 4096,
    "maxExecTimeoutMs": 1800000,
    "maxOutputBytes": 262144,
    "outputPageBytes": 65536,
    "maxReadBytes": 524288,
    "maxWriteBytes": 524288,
}
MAX_RECORDS = 100000
MAX_WAIT_MS = 20000
MAX_HEADER_BYTES = 16384
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
STANDARD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class Fail(Exception):
    def __init__(self, code, message=None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


class SystemdLauncher:
    """Runs a command's wrapper in a transient unit. The unit's ExecStopPost
    records the result, whatever stopped it (exit, timeout, cancel)."""

    def argv(self, op_id, timeout_ms):
        unit = unit_name(op_id)
        return [
            "systemd-run", "--quiet", "--collect", "--unit", unit,
            "--property", "Type=simple",
            "--property", "KillMode=control-group",
            "--property", "RuntimeMaxSec=%dms" % timeout_ms,
            "--property", "TimeoutStopSec=5s",
            "--property", "ExecStopPost=+%s finish %s" % (HELPER, op_id),
            "--property", "StandardInput=null",
            "--property", "StandardOutput=null",
            "--property", "StandardError=journal",
            HELPER, "wrap", op_id,
        ]

    def start(self, op_id, timeout_ms):
        result = subprocess.run(self.argv(op_id, timeout_ms), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if result.returncode != 0:
            raise Fail("IO_ERROR", "systemd-run failed: %s" % result.stderr.decode(errors="replace").strip()[:200])

    def active(self, op_id):
        result = subprocess.run(["systemctl", "show", "--property=ActiveState", "--value", unit_name(op_id)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
        state = result.stdout.decode().strip()
        return state not in ("", "inactive", "failed")

    def kill(self, op_id):
        subprocess.run(["systemctl", "kill", "--signal=SIGKILL", unit_name(op_id)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)

    def shutting_down(self):
        try:
            result = subprocess.run(["systemctl", "is-system-running"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return False
        return result.stdout.decode().strip() == "stopping"


class SystemdServices:
    """`cube service`'s services as persistent systemd units: enabled, so a
    machine that boots again starts them again, restarted when they fail,
    with their output in the journal. Each unit runs `cube-guest service-run
    NAME`, which reads the registration; nothing the agent typed goes into
    a unit file."""

    UNIT_DIRECTORY = "/etc/systemd/system"

    def unit(self, name):
        return "cube-service-%s.service" % name

    def text(self, name):
        return "\n".join([
            "[Unit]",
            "Description=cube service %s" % name,
            "After=network-online.target",
            "Wants=network-online.target",
            # A service that keeps failing stops being restarted; `cube service
            # status` shows it failed and `restart` starts it again.
            "StartLimitIntervalSec=60",
            "StartLimitBurst=5",
            "",
            "[Service]",
            "Type=simple",
            "ExecStart=%s service-run %s" % (HELPER, name),
            "Restart=on-failure",
            "RestartSec=2",
            "KillMode=control-group",
            "TimeoutStopSec=10",
            "StandardInput=null",
            "StandardOutput=journal",
            "StandardError=journal",
            "SyslogIdentifier=cube-service-%s" % name,
            "",
            "[Install]",
            "WantedBy=multi-user.target",
            "",
        ])

    def _systemctl(self, *args):
        result = subprocess.run(["systemctl"] + list(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=60)
        return result.returncode, result.stdout.decode(errors="replace").strip()

    def start(self, name):
        """Writes the unit and (re)starts it."""
        write_atomic(os.path.join(self.UNIT_DIRECTORY, self.unit(name)), self.text(name).encode(), 0o644)
        for args in (["daemon-reload"], ["reset-failed", self.unit(name)], ["enable", self.unit(name)], ["restart", self.unit(name)]):
            code, output = self._systemctl(*args)
            if code != 0 and args[0] != "reset-failed":
                raise Fail("IO_ERROR", "systemctl %s failed: %s" % (args[0], output[-300:]))

    def restart(self, name):
        self._systemctl("reset-failed", self.unit(name))
        code, output = self._systemctl("restart", self.unit(name))
        if code != 0:
            raise Fail("IO_ERROR", "systemctl restart failed: %s" % output[-300:])

    def remove(self, name):
        """Stops the unit and removes it; absent is fine."""
        self._systemctl("disable", "--now", self.unit(name))
        remove(os.path.join(self.UNIT_DIRECTORY, self.unit(name)))
        self._systemctl("daemon-reload")
        self._systemctl("reset-failed", self.unit(name))

    def state(self, name):
        """{active: ActiveState, sub: SubState, restarts: NRestarts}."""
        code, output = self._systemctl("show", self.unit(name), "--property=ActiveState,SubState,NRestarts,LoadState")
        values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        if values.get("LoadState") == "not-found":
            return {"active": "missing", "sub": "", "restarts": 0}
        restarts = values.get("NRestarts", "0")
        return {"active": values.get("ActiveState", "unknown"), "sub": values.get("SubState", ""),
                "restarts": int(restarts) if restarts.isdigit() else 0}

    def logs(self, name, lines, follow):
        argv = ["journalctl", "--no-pager", "--output=cat", "--unit", self.unit(name), "--lines", str(lines)]
        if follow:
            os.execvp(argv[0], argv + ["--follow"])
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        return result.stdout.decode(errors="replace")


class Config:
    def __init__(self):
        self.state = "/var/lib/cube"
        self.workspace = "/workspace"
        self.env_file = "/etc/cube/env"
        # Commands and files belong to this account; None keeps the caller's.
        self.user = "agent"
        self.ready_files = ["/var/lib/cloud/instance/boot-finished", "/var/lib/cube/initialized"]
        # Same list as GUEST_PACKAGES in vm-seed.ts. boot-finished survives a
        # reboot, so readiness also needs the commands themselves: a first boot
        # whose package install failed must not count as ready forever.
        self.packages = ["git", "gh", "curl", "ca-certificates"]
        self.commands = ["git", "gh", "curl"]
        self.launcher = SystemdLauncher()
        # Everything `seal_final` touches lives under this root (tests: a temporary one).
        self.root = "/"
        # This file and its `cube` shim (`install` replaces both).
        self.helper = HELPER
        self.cli = CLI_PATH
        # Where cubed's portal settings are (`portal` writes them).
        self.portal_file = "/etc/cube/portal.json"
        self.services = SystemdServices()
        # The address cubed's portal reaches services on; None: this machine's
        # address on the gateway's LAN.
        self.service_host = None
        # The project's external hooks (from the seed) and the hook logs
        # (None: ~/.cache/cube of `user`, the account the hooks run as).
        self.hooks_dir = "/etc/cube/hooks"
        self.hook_logs = None


CONFIG = Config()


def configure(**options):
    """Tests run the helper under a temporary root with their own launcher."""
    for key, value in options.items():
        if not hasattr(CONFIG, key):
            raise KeyError(key)
        setattr(CONFIG, key, value)


def unit_name(op_id):
    return "cube-op-%s.service" % op_id


def ops_dir():
    return os.path.join(CONFIG.state, "ops")


def op_path(op_id, *names):
    return os.path.join(ops_dir(), op_id, *names)


# --- files ---------------------------------------------------------------

def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(target, data, mode=0o600):
    temporary = "%s.tmp-%d" % (target, os.getpid())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(temporary, target)
    except OSError:
        os.unlink(temporary)
        raise
    fsync_dir(os.path.dirname(target))


def write_json(target, value):
    write_atomic(target, json.dumps(value, sort_keys=True).encode())


def read_json(target):
    try:
        with open(target, "rb") as handle:
            return json.loads(handle.read().decode())
    except FileNotFoundError:
        return None


def sha256_file(target):
    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def account():
    if CONFIG.user is None:
        return None
    import pwd
    entry = pwd.getpwnam(CONFIG.user)
    return entry.pw_uid, entry.pw_gid, entry.pw_dir


def give(target):
    """Files the helper creates belong to the agent's account."""
    owner = account()
    if owner is not None and os.geteuid() == 0:
        os.chown(target, owner[0], owner[1], follow_symlinks=False)


class AsAgent:
    """File access outside the workspace, with the agent account's
    permissions: what it may not touch without sudo stays so here. The
    helper's real uid stays root, so the journal is written again after."""

    def __init__(self, active):
        self.owner = account() if active and os.geteuid() == 0 else None

    def __enter__(self):
        if self.owner is not None:
            self.groups = os.getgroups()
            os.setgroups(os.getgrouplist(CONFIG.user, self.owner[1]))
            try:
                os.setegid(self.owner[1])
                os.seteuid(self.owner[0])
            except BaseException:
                os.setegid(0)
                os.setgroups(self.groups)
                raise
        return self

    def __exit__(self, kind, error, trace):
        if self.owner is not None:
            os.seteuid(0)
            os.setegid(0)
            os.setgroups(self.groups)
        if self.owner is not None and isinstance(error, PermissionError):
            raise Fail("IO_ERROR", "permission denied: this path leads outside the workspace, where the file tools have the "
                                   "agent account's permissions; use sudo in bash for this file")
        return False


class Lock:
    """One journal mutation at a time across helper processes."""

    def __enter__(self):
        os.makedirs(CONFIG.state, mode=0o700, exist_ok=True)
        self.fd = os.open(os.path.join(CONFIG.state, "lock"), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        os.close(self.fd)


# --- requests ------------------------------------------------------------

def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def integer(value, minimum, maximum=None):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum and (maximum is None or value <= maximum)


def op_id(header):
    value = header.get("id")
    if not isinstance(value, str) or not ID.match(value):
        raise Fail("INVALID_REQUEST", "invalid operation id")
    return value


def fence(header):
    """Lease epochs never go back; call with the lock held."""
    epoch = header.get("epoch")
    if not integer(epoch, 1):
        raise Fail("INVALID_REQUEST", "epoch must be a positive integer")
    target = os.path.join(CONFIG.state, "epoch")
    current = current_epoch()
    if epoch < current:
        raise Fail("LEASE_STALE", "a newer workspace lease has been used")
    if epoch > current:
        write_atomic(target, str(epoch).encode())


def current_epoch():
    try:
        with open(os.path.join(CONFIG.state, "epoch"), "rb") as handle:
            return int(handle.read().decode().strip() or "0")
    except FileNotFoundError:
        return 0


def workspace_path(relative, follow=True):
    """A path relative to the workspace, never leaving it."""
    if not isinstance(relative, str) or not relative or "\0" in relative or relative.startswith("/") \
            or len(relative.encode()) > LIMITS["maxPathBytes"] or ".." in relative.split("/"):
        raise Fail("INVALID_REQUEST", "path must be relative to the workspace")
    root = os.path.realpath(CONFIG.workspace)
    full = os.path.normpath(os.path.join(root, relative))
    checked = os.path.realpath(full) if follow else os.path.realpath(os.path.dirname(full)) if full != root else root
    if checked != root and not checked.startswith(root + os.sep):
        raise Fail("INVALID_REQUEST", "path leaves the workspace")
    return full


def within(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def file_path(path, follow=True):
    """A file operation's target: relative to the workspace or absolute in
    this machine, never with `..`. Returns it and whether it lies outside the
    workspace (then it is reached as the agent, see `AsAgent`), wherever its
    symlinks lead; the workspace's own links may lead out of it."""
    if not isinstance(path, str) or not path or "\0" in path or len(path.encode()) > LIMITS["maxPathBytes"] \
            or ".." in path.split("/"):
        raise Fail("INVALID_REQUEST", "path must be relative to the workspace or absolute, without ..")
    workspace = os.path.realpath(CONFIG.workspace)
    machine = os.path.realpath(CONFIG.root)
    full = os.path.normpath(os.path.join(machine, path.lstrip("/")) if path.startswith("/") else os.path.join(workspace, path))
    resolved = os.path.realpath(full)
    # A write or stat acts on a final symlink itself, not on what it names.
    located = resolved if follow else os.path.join(os.path.realpath(os.path.dirname(full)), os.path.basename(full))
    # `full` too: /proc/self/root/… resolves elsewhere but opens through /proc.
    for where in (full, located, resolved):
        for pseudo in PSEUDO_FILESYSTEMS:
            if within(where, os.path.join(machine, pseudo.lstrip("/"))):
                raise Fail("INVALID_REQUEST", "%s is in %s, a kernel or device filesystem; use bash" % (path, pseudo))
    if within(located, workspace) and within(resolved, workspace):
        return full, False
    if not all(within(where, machine) for where in (full, located, resolved)):
        raise Fail("INVALID_REQUEST", "path leaves the machine")
    return full, True


def new_record(op, request):
    """Creates the journal record of a new key, or returns the existing one.
    Raises CONFLICT when the key was used for a different request."""
    digest = canonical(request)
    os.makedirs(ops_dir(), mode=0o700, exist_ok=True)
    try:
        os.mkdir(op_path(op), 0o700)
    except FileExistsError:
        recorded = read_json(op_path(op, "request.json"))
        if recorded is not None and recorded.get("kind") == "cancelled":
            return False  # cancelled before it arrived: report that, never run it
        if recorded is None or recorded.get("hash") != digest:
            raise Fail("CONFLICT", "this key was used for a different request")
        return False
    fsync_dir(ops_dir())
    write_json(op_path(op, "request.json"), dict(request, hash=digest))
    return True


def count_records():
    try:
        with os.scandir(ops_dir()) as entries:
            return sum(1 for _ in entries)
    except FileNotFoundError:
        return 0


# --- operation state -----------------------------------------------------

CANCELLED = {"state": "Failed", "error": "CANCELLED", "completionUnknown": False}


def state_of(op, cursor=0):
    """The protocol-2 operation state of a key; call with the lock held.
    Returns (header, body)."""
    request = read_json(op_path(op, "request.json"))
    if request is None:
        return {"state": "Unknown"}, b""
    result = read_json(op_path(op, "result.json"))
    if result is None:
        if request["kind"] == "exec" and CONFIG.launcher.active(op):
            return {"state": "Running"}, b""
        # Nothing runs this key and nothing recorded an end. A cancel's
        # SIGKILL to the unit's cgroup can also kill its ExecStopPost; then
        # the marker is the record. Otherwise the helper or the VM stopped in
        # between: never run it again.
        result = CANCELLED if os.path.exists(op_path(op, "cancel")) else {"state": "Interrupted", "completionUnknown": True}
        write_json(op_path(op, "result.json"), result)
    if result["state"] != "Succeeded":
        return result, b""
    retained = result["result"]["retainedBytes"]
    if not integer(cursor, 0, retained):
        raise Fail("INVALID_REQUEST", "output cursor is past the retained output")
    page = b""
    if retained:
        with open(op_path(op, "output"), "rb") as handle:
            handle.seek(cursor)
            page = handle.read(min(LIMITS["outputPageBytes"], retained - cursor))
    header = {"state": "Succeeded", "result": dict(result["result"], outputOffset=cursor, outputLength=len(page))}
    return header, page


# --- operations ----------------------------------------------------------

def ready():
    return all(os.path.exists(path) for path in CONFIG.ready_files) \
        and all(shutil.which(command) for command in CONFIG.commands)


def template_seal():
    """How the template this machine was made from was sealed: `ok`, the
    seal's failure, or None for a machine from the base image."""
    try:
        with open(os.path.join(CONFIG.state, "template-seal"), "rb") as handle:
            outcome = handle.read(1000).decode(errors="replace").strip()
    except FileNotFoundError:
        return None
    return outcome if outcome.startswith("failed") else "ok"


def op_hello(header, body):
    answer = {"version": VERSION, "ready": ready(), "capabilities": CAPABILITIES, "limits": LIMITS, "epoch": current_epoch(),
              "build": build()}
    seal = template_seal()
    if seal is not None:
        answer["templateSeal"] = seal
    return answer, b""


def op_exec(header, body):
    op = op_id(header)
    command, cwd = header.get("command"), header.get("cwd", ".")
    timeout_ms, output_limit = header.get("timeoutMs"), header.get("outputLimit", LIMITS["maxOutputBytes"])
    if not isinstance(command, str) or not command or "\0" in command or len(command.encode()) > LIMITS["maxCommandBytes"]:
        raise Fail("INVALID_REQUEST", "command must be 1-%d bytes" % LIMITS["maxCommandBytes"])
    if cwd != ".":
        workspace_path(cwd)
    if not integer(timeout_ms, 1, LIMITS["maxExecTimeoutMs"]):
        raise Fail("INVALID_REQUEST", "timeout is 1-%d ms" % LIMITS["maxExecTimeoutMs"])
    if not integer(output_limit, 0, LIMITS["maxOutputBytes"]):
        raise Fail("INVALID_REQUEST", "output limit is at most %d bytes" % LIMITS["maxOutputBytes"])
    request = {"kind": "exec", "command": command, "cwd": cwd, "timeoutMs": timeout_ms, "outputLimit": output_limit}
    with Lock():
        fence(header)
        if not os.path.isdir(op_path(op)) and count_records() >= MAX_RECORDS:
            raise Fail("CAPACITY_EXCEEDED", "the guest keeps at most %d operation records" % MAX_RECORDS)
        if new_record(op, request):
            try:
                CONFIG.launcher.start(op, timeout_ms)
            except Fail as failure:
                write_json(op_path(op, "result.json"), {"state": "Failed", "error": "IO_ERROR", "completionUnknown": False,
                                                        "message": failure.message})
            except Exception as error:  # the unit may or may not exist
                write_json(op_path(op, "result.json"), {"state": "Interrupted", "completionUnknown": True})
                raise Fail("IO_ERROR", "starting the command failed: %s" % error)
        return state_of(op)


def op_get(header, body):
    op = op_id(header)
    cursor = header.get("cursor", 0)
    wait_ms = header.get("waitMs", 0)
    if not integer(cursor, 0) or not integer(wait_ms, 0, MAX_WAIT_MS):
        raise Fail("INVALID_REQUEST", "invalid cursor or wait")
    deadline = time.monotonic() + wait_ms / 1000
    while True:
        with Lock():
            state = state_of(op, cursor)
        if state[0]["state"] != "Running" or time.monotonic() >= deadline:
            return state
        # Running: wait cheaply for the unit's ExecStopPost to record an end.
        while time.monotonic() < deadline and not os.path.exists(op_path(op, "result.json")):
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))


def op_cancel(header, body):
    """Kills a running command. A key not seen yet is cancelled before it
    arrives: a stop can overtake the command it stops."""
    op = op_id(header)
    with Lock():
        fence(header)
        request = read_json(op_path(op, "request.json"))
        if request is None:
            new_record(op, {"kind": "cancelled"})
            write_json(op_path(op, "result.json"), CANCELLED)
        elif request["kind"] == "exec" and not os.path.exists(op_path(op, "result.json")) and CONFIG.launcher.active(op):
            write_atomic(op_path(op, "cancel"), b"")
            CONFIG.launcher.kill(op)
        return state_of(op)


def op_read(header, body):
    target, outside = file_path(header.get("path"))
    offset = header.get("offset", 0)
    limit = header.get("limit", LIMITS["maxReadBytes"])
    if not integer(offset, 0) or not integer(limit, 1, LIMITS["maxReadBytes"]):
        raise Fail("INVALID_REQUEST", "read limit is at most %d bytes" % LIMITS["maxReadBytes"])
    with AsAgent(outside):
        try:
            info = os.stat(target)
        except FileNotFoundError:
            raise Fail("NOT_FOUND", "no such file")
        if not stat.S_ISREG(info.st_mode):
            raise Fail("INVALID_REQUEST", "not a regular file")
        # Never blocks on a FIFO swapped in after the check.
        fd = os.open(target, os.O_RDONLY | os.O_NONBLOCK)
        try:
            handle = open(fd, "rb")
        except BaseException:
            os.close(fd)
            raise
        with handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise Fail("INVALID_REQUEST", "not a regular file")
            whole = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                whole.update(chunk)
            size = handle.tell()
            handle.seek(offset)
            content = handle.read(limit)
    return {"path": header["path"], "offset": offset, "size": size, "eof": offset + len(content) >= size,
            "sha256": whole.hexdigest(), "length": len(content)}, content


def op_write(header, body):
    op = op_id(header)
    relative = header.get("path")
    target, outside = file_path(relative, follow=False)
    expected = header.get("expectedSha")
    parents = header.get("createParents", False)
    length = header.get("length")
    if expected is not None and (not isinstance(expected, str) or not SHA.match(expected)):
        raise Fail("INVALID_REQUEST", "expectedSha must be a sha256")
    if not isinstance(parents, bool) or not integer(length, 0, LIMITS["maxWriteBytes"]) or length != len(body):
        raise Fail("INVALID_REQUEST", "file content is at most %d bytes" % LIMITS["maxWriteBytes"])
    content_sha = hashlib.sha256(body).hexdigest()
    request = {"kind": "write", "path": relative, "sha256": content_sha, "expectedSha": expected, "createParents": parents}
    with Lock():
        fence(header)
        if not os.path.isdir(op_path(op)) and count_records() >= MAX_RECORDS:
            raise Fail("CAPACITY_EXCEEDED", "the guest keeps at most %d operation records" % MAX_RECORDS)
        if not new_record(op, request):
            result = read_json(op_path(op, "result.json"))
            if result is None:
                # The helper stopped between journaling and recording.
                result = {"state": "Interrupted", "completionUnknown": True}
                write_json(op_path(op, "result.json"), result)
            return written(result)
        try:
            with AsAgent(outside):
                result = {"state": "Written", "result": replace(target, body, expected, parents)}
        except Fail as failure:
            result = {"state": "Failed", "error": failure.code, "completionUnknown": False, "message": failure.message}
        except OSError as error:
            result = {"state": "Failed", "error": "IO_ERROR", "completionUnknown": False, "message": error.strerror or str(error)}
        write_json(op_path(op, "result.json"), result)
        return written(result)


def written(result):
    if result["state"] == "Written":
        return result["result"], b""
    if result["state"] == "Interrupted":
        raise Fail("COMPLETION_UNKNOWN", "the outcome of this write is unknown")
    raise Fail(result["error"], result.get("message"))


def replace(target, content, expected, parents):
    directory = os.path.dirname(target)
    if os.path.lexists(target) and not os.path.isfile(target):
        raise Fail("INVALID_REQUEST", "not a regular file")
    if expected is not None:
        if not os.path.isfile(target) or sha256_file(target) != expected:
            raise Fail("PRECONDITION_FAILED", "the file changed since it was read")
    if not os.path.isdir(directory):
        if not parents:
            raise Fail("NOT_FOUND", "the parent directory does not exist")
        missing = []
        probe = directory
        while not os.path.isdir(probe) and probe != os.path.dirname(probe):
            missing.append(probe)
            probe = os.path.dirname(probe)
        for created in reversed(missing):
            os.mkdir(created, 0o755)
            give(created)
    mode = stat.S_IMODE(os.stat(target).st_mode) if os.path.isfile(target) else 0o644
    write_atomic(target, content, mode)
    os.chmod(target, mode)
    give(target)
    return {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}


def op_stat(header, body):
    target, outside = file_path(header.get("path"), follow=False)
    with AsAgent(outside):
        try:
            info = os.lstat(target)
        except FileNotFoundError:
            raise Fail("NOT_FOUND", "no such file")
        kind = "file" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) \
            else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
        sha = sha256_file(target) if kind == "file" else None
    return {"kind": kind, "size": info.st_size, "mode": stat.S_IMODE(info.st_mode),
            "modifiedMs": info.st_mtime_ns // 1000000, "sha256": sha}, b""


def build():
    """The sha256 of this helper as installed: cubed compares it with the
    helper it ships and replaces an older one (`install`)."""
    try:
        return sha256_file(CONFIG.helper)
    except OSError:
        return None


def op_install(header, body):
    """Replaces this helper (and its `cube` shim) with the one cubed ships.
    Content-addressed: the same bytes again change nothing. Commands already
    running keep the code they started with, but their unit's ExecStopPost
    (`finish`) runs the new file: every helper version must keep reading and
    writing the journal (`/var/lib/cube/ops`) in the same format."""
    expected = header.get("sha256")
    if not isinstance(expected, str) or not SHA.match(expected) or hashlib.sha256(body).hexdigest() != expected:
        raise Fail("INVALID_REQUEST", "sha256 must name the helper's content")
    if not body.startswith(b"#!/usr/bin/python3\n"):
        raise Fail("INVALID_REQUEST", "not a guest helper")
    if build() != expected:
        write_atomic(CONFIG.helper, body, 0o755)
        os.chmod(CONFIG.helper, 0o755)
    install_cli()
    return {"build": build()}, b""


def install_cli():
    """The `cube` command: a shim that runs this helper's CLI."""
    try:
        with open(CONFIG.cli, "rb") as handle:
            if handle.read() == CLI_SHIM.encode():
                return
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(CONFIG.cli), exist_ok=True)
    write_atomic(CONFIG.cli, CLI_SHIM.encode(), 0o755)
    os.chmod(CONFIG.cli, 0o755)


PORTAL_TEMPLATE = re.compile(r"^http://\{name\}-[a-z0-9]{1,32}\.[a-z0-9.-]{1,200}(?::[0-9]{1,5})?/$")


def op_portal(header, body):
    """cubed's portal settings for this machine, which `cube service` shows:
    the URL template of its services, or why there is no portal."""
    portal = header.get("portal")
    if not isinstance(portal, dict):
        raise Fail("INVALID_REQUEST", "portal must be an object")
    template, reason = portal.get("urlTemplate"), portal.get("reason")
    if template is not None and (not isinstance(template, str) or not PORTAL_TEMPLATE.fullmatch(template)):
        raise Fail("INVALID_REQUEST", "invalid portal url template")
    if template is None and (not isinstance(reason, str) or not reason or len(reason) > 300):
        raise Fail("INVALID_REQUEST", "a portal without url template needs a reason")
    value = {"urlTemplate": template} if template else {"reason": reason}
    os.makedirs(os.path.dirname(CONFIG.portal_file), exist_ok=True)
    write_atomic(CONFIG.portal_file, json.dumps(value, sort_keys=True).encode(), 0o644)
    os.chmod(CONFIG.portal_file, 0o644)
    return value, b""


def op_services(header, body):
    """The registered services, for cubed's portal and the thread view."""
    return {"services": [service_view(record, probe=header.get("probe") is True) for record in registrations()]}, b""


OPERATIONS = {"hello": op_hello, "exec": op_exec, "get": op_get, "cancel": op_cancel, "read": op_read,
              "write": op_write, "stat": op_stat, "services": op_services, "install": op_install, "portal": op_portal}


# --- services ------------------------------------------------------------

SERVICE_NAME = re.compile(r"^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
MAX_SERVICES = 16
MIN_SERVICE_PORT = 1024
MAX_SERVICE_COMMAND = 8192


def services_dir():
    return os.path.join(CONFIG.state, "services")


def registration(name):
    return read_json(os.path.join(services_dir(), name + ".json"))


def registrations():
    try:
        names = sorted(os.listdir(services_dir()))
    except FileNotFoundError:
        return []
    found = []
    for name in names:
        if name.endswith(".json") and SERVICE_NAME.fullmatch(name[:-5]):
            record = read_json(os.path.join(services_dir(), name))
            if isinstance(record, dict) and record.get("name") == name[:-5] and integer(record.get("port"), MIN_SERVICE_PORT, 65535) \
                    and record.get("kind") in ("command", "external"):
                found.append(record)
    return found


def save_registration(record):
    os.makedirs(services_dir(), mode=0o700, exist_ok=True)
    write_json(os.path.join(services_dir(), record["name"] + ".json"), record)


def drop_registration(name):
    target = os.path.join(services_dir(), name + ".json")
    if os.path.exists(target):
        os.unlink(target)
        fsync_dir(services_dir())


def service_host():
    """This machine's address on the gateway's LAN: where the portal connects."""
    if CONFIG.service_host:
        return CONFIG.service_host
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.77.0.1", 9))  # no packet is sent
        return probe.getsockname()[0]
    except OSError:
        return "10.77.0.2"
    finally:
        probe.close()


def listening(host, port, timeout=1.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_probe(host, port, host_header, timeout=5.0):
    """The status line a GET / answers with, or why there is none."""
    try:
        with socket.create_connection((host, port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(("GET / HTTP/1.1\r\nHost: %s\r\nUser-Agent: cube-service\r\nAccept: */*\r\nConnection: close\r\n\r\n"
                                % host_header).encode())
            data = b""
            while b"\r\n" not in data and len(data) < 4096:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                data += chunk
    except OSError as error:
        return None, "no HTTP answer (%s)" % (error.strerror or error)
    line = data.split(b"\r\n", 1)[0].decode(errors="replace")
    if not re.match(r"^HTTP/1\.[01] [0-9]{3}", line):
        return None, "it answers, but not with HTTP/1.x" if data else "it closed the connection without an answer"
    return int(line.split()[1]), line


def portal_settings():
    value = read_json(CONFIG.portal_file)
    return value if isinstance(value, dict) else {}


def service_url(name):
    template = portal_settings().get("urlTemplate")
    return template.replace("{name}", name) if isinstance(template, str) else None


def no_portal_reason():
    return portal_settings().get("reason") or "cube has not configured a portal for this machine yet"


def service_view(record, probe=False):
    view = {"name": record["name"], "port": record["port"], "kind": record["kind"], "url": service_url(record["name"]),
            "createdAt": record.get("createdAt")}
    if record["kind"] == "command":
        view["command"] = record["command"]
        view["cwd"] = record["cwd"]
        state = CONFIG.services.state(record["name"])
        view["state"] = state["active"]
        view["restarts"] = state["restarts"]
    if probe:
        view["listening"] = listening(service_host(), record["port"])
    return view


def service_run(name):
    """The unit's main process: the registered command as the agent, with
    PORT and HOST set, in its directory."""
    record = registration(name) if SERVICE_NAME.fullmatch(name) else None
    if not record or record.get("kind") != "command":
        sys.stderr.write("cube service %s is not registered\n" % name)
        return 1
    env = environment()
    env.update(record.get("env") or {})
    env.update({"PORT": str(record["port"]), "HOST": "0.0.0.0", "CUBE_SERVICE": name})
    owner = account()
    try:
        os.chdir(record["cwd"])
    except OSError as error:
        sys.stderr.write("cube service %s: cannot enter %s: %s\n" % (name, record["cwd"], error.strerror or error))
        return 1
    if owner is not None:
        os.setgroups(os.getgrouplist(CONFIG.user, owner[1]))
        os.setgid(owner[1])
        os.setuid(owner[0])
    os.umask(0o022)
    os.execve("/bin/bash", ["/bin/bash", "-c", record["command"]], env)
    return 1


# --- the `cube` command --------------------------------------------------

CLI_USAGE = """usage: cube service <command> [options]
       cube hooks [-n LINES] [--json]

Runs web servers in this machine as supervised services that outlive the
command that started them, and opens them in cube's portal.

  cube service start NAME --port PORT [--cwd DIR] [--env KEY=VALUE]... [--wait SECONDS] [--json] -- COMMAND...
      run COMMAND as service NAME (restarted when it fails and when the
      machine boots again); waits until it listens on PORT and prints its URL
  cube service open NAME --port PORT [--wait SECONDS] [--json]
      register a server that already runs outside cube service (its own
      systemd unit, a container) on PORT
  cube service list [--json]
  cube service status NAME [--json]
  cube service logs NAME [-n LINES] [-f]
  cube service restart NAME [--wait SECONDS] [--json]
  cube service stop NAME [--json]
      stop the service and remove it from the portal
  cube hooks [-n LINES] [--json]
      the hooks this machine runs, their last outcomes and logs (read only;
      cube hooks --help)

A service gets PORT and HOST=0.0.0.0 in its environment and must listen on
0.0.0.0 (or this machine's address), not only on 127.0.0.1: the portal
reaches it over the machine's network. Ports 1024-65535; plain HTTP and
WebSocket. NAME is 1-24 lowercase letters, digits and dashes.
"""


HOOKS_USAGE = """usage: cube hooks [-n LINES] [--json]

Shows the hooks this machine runs, read only: the project's external
pre-setup and pre-resume hooks (set in cube's projects, written to
/etc/cube/hooks when this machine was made) and the repository's
.agents/setup and .agents/resume, each with its last outcome in this
machine and the last LINES lines of its log (default 20, at most 200).

Order: pre-setup, then .agents/setup (only if pre-setup succeeded), once
when the machine is prepared; pre-resume, then .agents/resume, on every
boot. All run as agent in /workspace. A thread cannot change the project's
hooks: the user changes them in cube's projects, or asks OptChat
(project_hooks_write). New threads use the hooks saved when they start.
"""

# name, where the script is, its log: the order they run in.
HOOKS = (("pre-setup", "external", "pre-setup.log"), ("setup", ".agents/setup", "setup.log"),
         ("pre-resume", "external", "pre-resume.log"), ("resume", ".agents/resume", "resume.log"))
HOOK_STATUS = re.compile(r"^(ok|absent|skipped|notrun|failed:(\d+)) (\d+) (\d+)$")


class Usage(Exception):
    pass


def cli_options(args, flags, values, repeated=()):
    """Parses `--flag`, `--key VALUE` / `--key=VALUE` and positionals; what
    follows `--` is returned as is (None without `--`)."""
    options, positionals, rest = {}, [], None
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            rest = args[index + 1:]
            break
        if arg.startswith("-") and arg != "-":
            key, sep, inline = arg.partition("=")
            if key in flags and not sep:
                options[key] = True
            elif key in values or key in repeated:
                if not sep:
                    index += 1
                    if index >= len(args):
                        raise Usage("%s needs a value" % key)
                    inline = args[index]
                if key in repeated:
                    options.setdefault(key, []).append(inline)
                else:
                    options[key] = inline
            else:
                raise Usage("unknown option %s" % arg)
        else:
            positionals.append(arg)
        index += 1
    return options, positionals, rest


def cli_name(positionals):
    if len(positionals) != 1:
        raise Usage("give one service name")
    if not SERVICE_NAME.fullmatch(positionals[0]):
        raise Usage("a service name is 1-24 lowercase letters, digits and dashes, starting with a letter")
    return positionals[0]


def cli_port(options):
    raw = options.get("--port")
    if raw is None:
        raise Usage("--port is required")
    if not raw.isdigit() or not MIN_SERVICE_PORT <= int(raw) <= 65535:
        raise Usage("--port must be %d-65535" % MIN_SERVICE_PORT)
    return int(raw)


def cli_wait(options, default):
    raw = options.get("--wait", str(default))
    if not raw.isdigit() or int(raw) > 600:
        raise Usage("--wait is 0-600 seconds")
    return int(raw)


class Out:
    def __init__(self, as_json):
        self.as_json = as_json

    def say(self, text):
        if not self.as_json:
            sys.stdout.write(text + "\n")
            sys.stdout.flush()

    def result(self, value, text):
        sys.stdout.write((json.dumps(value, sort_keys=True) if self.as_json else text) + "\n")


def indent(text):
    return "\n".join("  " + line for line in text.splitlines())


def describe(view):
    """One service in a few lines."""
    if view["kind"] == "command":
        state = view["state"] + (" (%d restarts)" % view["restarts"] if view.get("restarts") else "")
    else:
        state = "external"
    lines = ["%s  port %d  %s" % (view["name"], view["port"], state)]
    if "listening" in view:
        lines.append("  listening: %s" % ("yes" if view["listening"] else "no"))
    lines.append("  url: %s" % (view["url"] or "none (%s)" % no_portal_reason()))
    if view["kind"] == "command":
        lines.append("  command: %s" % view["command"])
        lines.append("  cwd: %s" % view["cwd"])
    return "\n".join(lines)


def wait_healthy(name, port, kind, seconds):
    """Waits until the service listens on the machine's LAN address.
    Returns (ok, error, http status line)."""
    host = service_host()
    started = time.monotonic()
    deadline = started + seconds
    while True:
        if kind == "command":
            state = CONFIG.services.state(name)
            # Restart=on-failure: a command that exits 0 is not restarted.
            if state["active"] in ("failed", "missing") or (state["active"] == "inactive" and time.monotonic() - started > 3):
                return False, "the service stopped (%s)" % (state["sub"] or state["active"]), None
        if listening(host, port):
            break
        if time.monotonic() >= deadline:
            if host != "127.0.0.1" and listening("127.0.0.1", port):
                return False, ("port %d answers on 127.0.0.1 only, and the portal reaches the service on %s: make it "
                               "listen on 0.0.0.0 (for example --host 0.0.0.0, or HOST and PORT from its environment)"
                               % (port, host)), None
            return False, "nothing listens on %s:%d after %d s" % (host, port, seconds), None
        time.sleep(0.25)
    url = service_url(name)
    status, line = http_probe(host, port, url.split("/")[2] if url else "%s:%d" % (host, port))
    return True, None, line if status is not None else "listening, but %s" % line


def logs_tail(name, lines=20):
    try:
        return CONFIG.services.logs(name, lines, False).rstrip()
    except (OSError, subprocess.SubprocessError, Fail):
        return ""


def report(name, ok, error, http, out, verb):
    record = registration(name)
    view = service_view(record) if record else {"name": name}
    view.update({"ok": ok, "http": http, "error": error})
    if ok:
        text = ["service %s %s on port %d" % (name, verb, record["port"]), "  http: %s" % http,
                "  url: %s" % (view["url"] or "none (%s)" % no_portal_reason())]
        if record["kind"] == "command":
            text.append("  logs: cube service logs %s" % name)
        out.result(view, "\n".join(text))
        return 0
    text = ["service %s is registered but not healthy: %s" % (name, error)]
    if record and record["kind"] == "command":
        view["logTail"] = logs_tail(name)
        if view["logTail"]:
            text += ["last output:", indent(view["logTail"])]
        text.append("fix it and run cube service restart %s, or remove it with cube service stop %s" % (name, name))
    else:
        text.append("start the server, or remove it with cube service stop %s" % name)
    out.result(view, "\n".join(text))
    return 1


def register(record):
    """Saves a registration under the lock; returns `started` or `replaced`."""
    with Lock():
        current = registrations()
        for other in current:
            if other["name"] != record["name"] and other["port"] == record["port"]:
                raise Usage("port %d is already service %s" % (record["port"], other["name"]))
        existing = any(other["name"] == record["name"] for other in current)
        if not existing and len(current) >= MAX_SERVICES:
            raise Usage("a machine has at most %d services; stop one first" % MAX_SERVICES)
        save_registration(dict(record, createdAt=int(time.time() * 1000)))
    return "replaced" if existing else "started"


def service_start(args, caller_cwd):
    options, positionals, rest = cli_options(args, {"--json"}, {"--port", "--cwd", "--wait"}, {"--env"})
    name, port, out = cli_name(positionals), cli_port(options), Out("--json" in options)
    wait = cli_wait(options, 60)
    if not rest:
        raise Usage("give the command after --, for example: cube service start web --port 8000 -- python3 -m http.server")
    # One word is a shell command line; several are quoted as they are.
    text = rest[0] if len(rest) == 1 else shlex.join(rest)
    if len(text.encode()) > MAX_SERVICE_COMMAND or "\0" in text:
        raise Usage("the command is at most %d bytes" % MAX_SERVICE_COMMAND)
    cwd = os.path.normpath(os.path.join(caller_cwd, options.get("--cwd", ".")))
    if not os.path.isdir(cwd):
        raise Usage("no directory %s" % cwd)
    env = {}
    for item in options.get("--env", []):
        key, sep, value = item.partition("=")
        if not sep or not ENV_NAME.fullmatch(key) or "\0" in value or "\n" in value or key in ("PORT", "HOST"):
            raise Usage("--env takes KEY=VALUE (cube sets PORT and HOST)")
        env[key] = value
    verb = register({"name": name, "port": port, "kind": "command", "command": text, "cwd": cwd, "env": env})
    try:
        CONFIG.services.start(name)
    except Fail:
        with Lock():
            drop_registration(name)
        raise
    out.say("starting service %s on port %d ..." % (name, port))
    ok, error, http = wait_healthy(name, port, "command", wait)
    return report(name, ok, error, http, out, verb)


def service_open(args):
    options, positionals, rest = cli_options(args, {"--json"}, {"--port", "--wait"})
    name, port, out = cli_name(positionals), cli_port(options), Out("--json" in options)
    wait = cli_wait(options, 10)
    if rest is not None:
        raise Usage("open takes no command; cube service start runs one")
    existing = registration(name)
    verb = register({"name": name, "port": port, "kind": "external"})
    if existing and existing["kind"] == "command":
        CONFIG.services.remove(name)
    ok, error, http = wait_healthy(name, port, "external", wait)
    return report(name, ok, error, http, out, "opened" if verb == "started" else verb)


def service_status(args):
    options, positionals, _ = cli_options(args, {"--json"}, set())
    name, out = cli_name(positionals), Out("--json" in options)
    record = registration(name)
    if not record:
        out.result({"name": name, "error": "not registered"}, "no service %s" % name)
        return 1
    view = service_view(record, probe=True)
    text = describe(view)
    if view["kind"] == "command" and (view["state"] != "active" or not view["listening"]):
        view["logTail"] = logs_tail(name, 10)
        if view["logTail"]:
            text += "\nlast output:\n" + indent(view["logTail"])
    out.result(view, text)
    return 0


def service_logs(args):
    options, positionals, _ = cli_options(args, {"-f", "--follow"}, {"-n", "--lines"})
    name = cli_name(positionals)
    record = registration(name)
    if not record:
        raise Usage("no service %s" % name)
    if record["kind"] != "command":
        raise Usage("%s is not run by cube service; its logs are where it runs" % name)
    lines = options.get("-n", options.get("--lines", "100"))
    if not lines.isdigit() or not 1 <= int(lines) <= 10000:
        raise Usage("-n is 1-10000 lines")
    sys.stdout.write(CONFIG.services.logs(name, int(lines), "-f" in options or "--follow" in options))
    return 0


def service_restart(args):
    options, positionals, _ = cli_options(args, {"--json"}, {"--wait"})
    name, out = cli_name(positionals), Out("--json" in options)
    wait = cli_wait(options, 60)
    record = registration(name)
    if not record or record["kind"] != "command":
        raise Usage("no service %s run by cube service" % name)
    CONFIG.services.restart(name)
    ok, error, http = wait_healthy(name, record["port"], "command", wait)
    return report(name, ok, error, http, out, "restarted")


def service_stop(args):
    options, positionals, _ = cli_options(args, {"--json"}, set())
    name, out = cli_name(positionals), Out("--json" in options)
    with Lock():
        record = registration(name)
        # Off the portal first: nothing routes to a port being given up.
        drop_registration(name)
    if not record or record["kind"] == "command":
        CONFIG.services.remove(name)
    out.result({"name": name, "stopped": record is not None}, "service %s stopped" % name if record else "no service %s" % name)
    return 0


def cli_service(args, caller_cwd):
    if not args or args[0] in ("-h", "--help", "help"):
        sys.stdout.write(CLI_USAGE)
        return 0 if args else 2
    command, args = args[0], args[1:]
    if command == "start":
        return service_start(args, caller_cwd)
    if command == "open":
        return service_open(args)
    if command == "list":
        options, positionals, _ = cli_options(args, {"--json"}, set())
        if positionals:
            raise Usage("list takes no name")
        views = [service_view(record, probe=True) for record in registrations()]
        Out("--json" in options).result({"services": views}, "\n".join(describe(view) for view in views) or "no services")
        return 0
    if command == "status":
        return service_status(args)
    if command == "logs":
        return service_logs(args)
    if command == "restart":
        return service_restart(args)
    if command == "stop":
        return service_stop(args)
    raise Usage("unknown command %s (start, open, list, status, logs, restart, stop)" % command)


def hook_logs():
    if CONFIG.hook_logs:
        return CONFIG.hook_logs
    owner = account()
    return os.path.join(owner[2] if owner else os.path.expanduser("~"), ".cache", "cube")


def tail_lines(target, lines):
    """The last `lines` lines of a file, at most 64 KiB of it."""
    try:
        with open(target, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            text = handle.read().decode(errors="replace")
    except OSError:
        return None
    return "\n".join(text.splitlines()[-lines:]) if lines else ""


def hook_view(name, source, log, lines):
    script = os.path.join(CONFIG.hooks_dir, name) if source == "external" else os.path.join(CONFIG.workspace, source)
    view = {"name": name, "source": "project" if source == "external" else "repository", "path": script,
            "present": os.access(script, os.X_OK) and os.path.isfile(script), "log": os.path.join(hook_logs(), log)}
    if view["present"]:
        view["bytes"] = os.path.getsize(script)
        view["sha256"] = sha256_file(script)
    status = tail_lines(os.path.join(hook_logs(), name + ".status"), 1)
    match = HOOK_STATUS.match((status or "").strip())
    view["last"] = None if not match else {
        "status": "failed" if match.group(1).startswith("failed") else match.group(1),
        "exitCode": int(match.group(2)) if match.group(2) else None,
        "ms": int(match.group(3)), "endedAt": int(match.group(4))}
    view["logTail"] = tail_lines(view["log"], lines)
    return view


def describe_hook(view):
    script = ("%s, %d bytes" % (view["path"], view["bytes"])) if view["present"] else "none (%s)" % view["path"]
    last = view["last"]
    outcome = "no outcome recorded in this machine" if not last else "%s%s, %.1f s, %s" % (
        last["status"], " (exit %d)" % last["exitCode"] if last["exitCode"] is not None else "", last["ms"] / 1000.0,
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last["endedAt"] / 1000.0)))
    lines = ["%s (%s hook): %s" % (view["name"], view["source"], script), "  last: %s" % outcome]
    if view["logTail"] is None:
        lines.append("  log: none (%s)" % view["log"])
    elif view["logTail"]:
        lines.append("  log %s, last lines:" % view["log"])
        lines.append(indent(indent(view["logTail"])))
    return "\n".join(lines)


def cli_hooks(args):
    if args[:1] in (["-h"], ["--help"], ["help"]):
        sys.stdout.write(HOOKS_USAGE)
        return 0
    options, positionals, rest = cli_options(args, {"--json"}, {"-n", "--lines"})
    if positionals or rest is not None:
        raise Usage("hooks takes no arguments")
    raw = options.get("-n", options.get("--lines", "20"))
    if not raw.isdigit() or int(raw) > 200:
        raise Usage("-n is 0-200 lines")
    views = [hook_view(name, source, log, int(raw)) for name, source, log in HOOKS]
    Out("--json" in options).result({"hooks": views}, "\n".join(describe_hook(view) for view in views)
                                    + "\n\nthe project's hooks are changed in cube's projects, not here; see cube hooks --help")
    return 0


def cli(argv):
    """`cube ...`, run by the agent. Units and the registry need root, which
    the agent has through sudo; the caller's directory travels along."""
    try:
        caller_cwd = os.getcwd()
    except OSError:
        caller_cwd = "/"
    if argv[:1] == ["--from"] and len(argv) >= 2:
        caller_cwd, argv = argv[1], argv[2:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        sys.stdout.write(CLI_USAGE)
        return 0 if argv else 2
    if argv[0] == "--version":
        sys.stdout.write("cube (cube-guest %s, build %s)\n" % (VERSION, (build() or "unknown")[:12]))
        return 0
    if argv[0] == "hooks":
        # Read only, as the caller: the hooks and their logs are the agent's to read.
        try:
            return cli_hooks(argv[1:])
        except Usage as problem:
            sys.stderr.write("cube hooks: %s\n" % problem)
            return 2
    if argv[0] != "service":
        sys.stderr.write("cube: unknown command %s\n%s" % (argv[0], CLI_USAGE))
        return 2
    if CONFIG.user is not None and os.geteuid() != 0:
        os.execvp("sudo", ["sudo", "-n", CONFIG.helper, "cli", "--from", caller_cwd] + argv)
    try:
        return cli_service(argv[1:], caller_cwd)
    except Usage as problem:
        sys.stderr.write("cube service: %s\n" % problem)
        return 2
    except Fail as failure:
        sys.stderr.write("cube service: %s\n" % failure.message)
        return 1


# --- inside the command's unit -------------------------------------------

def environment():
    owner = account()
    env = {"PATH": STANDARD_PATH, "LANG": "C.UTF-8", "HOME": owner[2] if owner else os.environ.get("HOME", "/"),
           "USER": CONFIG.user or os.environ.get("USER", ""), "LOGNAME": CONFIG.user or os.environ.get("USER", ""),
           "SHELL": "/bin/bash", "TERM": "dumb", "GIT_TERMINAL_PROMPT": "0"}
    try:
        with open(CONFIG.env_file, "r") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    env[key.strip()] = value.strip()
    except FileNotFoundError:
        pass
    return env


def wrap(op):
    """The unit's main process: runs the command as the agent, keeps the first
    outputLimit bytes of combined output and drains the rest."""
    request = read_json(op_path(op, "request.json"))
    cwd = CONFIG.workspace if request["cwd"] == "." else workspace_path(request["cwd"])
    limit = request["outputLimit"]
    options = {}
    owner = account()
    if owner is not None:
        options = {"user": owner[0], "group": owner[1], "extra_groups": os.getgrouplist(CONFIG.user, owner[1])}
    total = 0
    with open(op_path(op, "output"), "wb") as output:
        try:
            child = subprocess.Popen(["/bin/bash", "-c", request["command"]], cwd=cwd, env=environment(),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     umask=0o022, **options)
        except OSError as error:
            message = ("cube: cannot start the command: %s\n" % (error.strerror or error)).encode()[:limit]
            output.write(message)
            write_json(op_path(op, "wrapped.json"), {"exitCode": 127, "signal": None, "outputBytes": len(message)})
            return 0
        while True:
            chunk = child.stdout.read1(65536)
            if not chunk:
                break
            keep = limit - total
            if keep > 0:
                output.write(chunk[:keep])
                output.flush()
            total += len(chunk)
        code = child.wait()
        output.flush()
        os.fsync(output.fileno())
    write_json(op_path(op, "wrapped.json"), {"exitCode": code if code >= 0 else None,
                                             "signal": -code if code < 0 else None, "outputBytes": total})
    return 0


def finish(op):
    """ExecStopPost: the command's unit stopped. Records its terminal state
    from the wrapper's record and $SERVICE_RESULT/$EXIT_CODE/$EXIT_STATUS."""
    with Lock():
        if os.path.exists(op_path(op, "result.json")):
            return 0
        if read_json(op_path(op, "request.json")) is None:
            return 0
        cancelled = os.path.exists(op_path(op, "cancel"))
        if cancelled:
            result = CANCELLED
        elif CONFIG.launcher.shutting_down():
            result = {"state": "Interrupted", "completionUnknown": True}
        else:
            result = {"state": "Succeeded", "result": exec_result(op)}
        write_json(op_path(op, "result.json"), result)
    return 0


def exec_result(op):
    wrapped = read_json(op_path(op, "wrapped.json"))
    try:
        retained = os.path.getsize(op_path(op, "output"))
    except FileNotFoundError:
        retained = 0
    if os.environ.get("SERVICE_RESULT") == "timeout":
        exit_code, termination = None, "timedOut"
    elif wrapped is not None:
        exit_code = wrapped["exitCode"] if wrapped["exitCode"] is not None and 0 <= wrapped["exitCode"] <= 255 else None
        termination = "exited" if exit_code is not None else "signalled"
    elif os.environ.get("EXIT_CODE") == "exited" and os.environ.get("EXIT_STATUS", "").isdigit():
        exit_code, termination = int(os.environ["EXIT_STATUS"]) % 256, "exited"
    else:
        exit_code, termination = None, "signalled"
    output_bytes = max(retained, wrapped["outputBytes"] if wrapped is not None else retained)
    return {"exitCode": exit_code, "termination": termination, "outputBytes": output_bytes,
            "truncated": output_bytes > retained, "retainedBytes": retained}


def recover():
    """At boot, before sshd: transient units do not survive a reboot, so every
    record without a result was cut off. Mark it interrupted; never rerun."""
    with Lock():
        try:
            names = os.listdir(ops_dir())
        except FileNotFoundError:
            return 0
        for name in names:
            if ID.match(name) and os.path.exists(op_path(name, "request.json")) \
                    and not os.path.exists(op_path(name, "result.json")):
                write_json(op_path(name, "result.json"), {"state": "Interrupted", "completionUnknown": True})
    return 0


def packages(attempts=5):
    """Every boot (cloud-init per-boot script): install the guest packages a
    failed first boot left out. cloud-init's own package step runs once."""
    if all(shutil.which(command) for command in CONFIG.commands):
        return 0
    env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
    for attempt in range(attempts):
        if subprocess.run(["apt-get", "update", "-q"], env=env).returncode == 0 \
                and subprocess.run(["apt-get", "install", "-y", "-q"] + CONFIG.packages, env=env).returncode == 0 \
                and all(shutil.which(command) for command in CONFIG.commands):
            return 0
        time.sleep(min(60, 10 * (attempt + 1)))
    return 1


SEAL_UNIT = "cube-seal.service"
SEAL_MARKER = "var/lib/cube-seal/sealed"
SEAL_VERSION = "1"


def rooted(path):
    return os.path.join(CONFIG.root, path.lstrip("/"))


def seal():
    """Turns this build machine into a template at its next power-off (as
    root, run by cubed after a successful preparation). The cleaning itself
    happens at shutdown, when nothing uses the identity it removes; cubed
    then powers the machine off and the runner publishes the disk."""
    unit = "\n".join([
        "[Unit]",
        "Description=cube: clean this disk for a template at power-off",
        "DefaultDependencies=no",
        "Requires=local-fs.target",
        "After=local-fs.target",
        "Conflicts=shutdown.target",
        "Before=shutdown.target",
        "",
        "[Service]",
        "Type=oneshot",
        "RemainAfterExit=yes",
        "ExecStart=/bin/true",
        "ExecStop=%s seal-final" % HELPER,
        "TimeoutStopSec=180",
        "",
    ])
    write_atomic(rooted("/etc/systemd/system/" + SEAL_UNIT), unit.encode(), 0o644)
    # Failed until seal_final says otherwise: a power-off that never ran it
    # still leaves machines made from this disk to clean up and report.
    os.makedirs(os.path.dirname(rooted(SEAL_MARKER)), mode=0o700, exist_ok=True)
    write_atomic(rooted(SEAL_MARKER), b"failed: the seal did not run at power-off", 0o600)
    subprocess.run(["apt-get", "clean"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # The bulk of the discard now, while the machine is up: the runner gives
    # a powering-off guest 30 s before it counts the stop as interrupted.
    try:
        subprocess.run(["fstrim", "--all"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
    except subprocess.TimeoutExpired:
        sys.stdout.write("seal failed: fstrim timed out\n")
        return 1
    for command in (["systemctl", "daemon-reload"], ["systemctl", "start", SEAL_UNIT]):
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        if result.returncode != 0:
            sys.stdout.write("seal failed: %s\n" % result.stdout.decode(errors="replace").strip()[:500])
            return 1
    sys.stdout.write("sealed at power-off\n")
    return 0


def remove(path):
    """Removes a file, a symlink or a whole directory; absent is fine."""
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.unlink(path)
    except FileNotFoundError:
        pass


def empty(directory):
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return
    for name in names:
        remove(os.path.join(directory, name))


def remove_service_units(directory):
    """`cube service` units and their enablement links under `directory`."""
    for sub in ("", "multi-user.target.wants"):
        folder = os.path.join(directory, sub)
        for name in (os.listdir(folder) if os.path.isdir(folder) else []):
            if name.startswith("cube-service-") and name.endswith(".service"):
                remove(os.path.join(folder, name))


def seal_final():
    """ExecStop of the seal unit, at power-off: removes what makes this
    machine one machine (host keys, machine id, cloud-init instance, the
    helper's journal and epoch, cubed's per-machine files and the build's
    placeholders), then discards the freed blocks so the deleted bytes do
    not stay in the template file. Every later machine gets all of these
    new from its own seed. Package caches, toolchains and the prepared
    checkout stay: they are the point of the template."""
    failures = []
    marker = rooted(SEAL_MARKER)
    steps = [
        ("/var/lib/cube", remove), ("/etc/cube", remove),
        ("/var/lib/cloud", empty), ("/var/log/journal", empty), ("/tmp", empty),
        ("/var/lib/dhcp", empty), ("/var/lib/systemd/random-seed", remove),
        ("/var/lib/dbus/machine-id", remove), ("/root/.bash_history", remove),
        ("/home/agent/.bash_history", remove), ("/etc/systemd/system/" + SEAL_UNIT, remove),
        # Services a setup started: their registrations go with /var/lib/cube.
        ("/etc/systemd/system", remove_service_units),
        # The build's hook logs: they may echo its (dead) placeholder.
        ("/home/agent/.cache/cube", remove),
    ]
    for path, action in steps:
        try:
            action(rooted(path))
        except OSError as error:
            failures.append("%s: %s" % (path, error.strerror or error))
    def ssh_keys():
        ssh = rooted("/etc/ssh")
        for name in (os.listdir(ssh) if os.path.isdir(ssh) else []):
            if name.startswith("ssh_host_"):
                remove(os.path.join(ssh, name))

    def machine_id():
        # Empty, not absent: systemd makes a new id at the next boot.
        with open(rooted("/etc/machine-id"), "w"):
            pass
    for name, action in (("logs", lambda: [remove(rooted(log)) for log in ("/var/log/cloud-init.log", "/var/log/cloud-init-output.log")]),
                         ("/etc/ssh host keys", ssh_keys), ("/etc/machine-id", machine_id)):
        try:
            action()
        except OSError as error:
            failures.append("%s: %s" % (name, error.strerror or error))
    os.makedirs(os.path.dirname(marker), mode=0o700, exist_ok=True)
    if failures:
        # The machines made from this disk report it, and cubed drops the template.
        message = "failed: %s" % "; ".join(failures)
        write_atomic(marker, message.encode()[:1000], 0o600)
        sys.stderr.write("cube-guest seal: %s\n" % message)
        return 1
    write_atomic(marker, SEAL_VERSION.encode(), 0o600)
    if CONFIG.root == "/":
        # Only what was deleted since seal(): bounded, the runner's grace is 30 s.
        try:
            subprocess.run(["fstrim", "--all"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        except subprocess.TimeoutExpired:
            pass
        subprocess.run(["sync"])
    return 0


def init():
    """First boot of an instance (cloud-init runcmd): the journal and the
    agent's directories. On a machine made from a template the seal marker
    exists: whatever is left of the build machine's journal goes (nothing,
    if the seal succeeded), and the seal's outcome is kept for `hello`."""
    marker = rooted(SEAL_MARKER)
    if os.path.exists(marker):
        with open(marker, "rb") as handle:
            outcome = handle.read(1000)
        try:
            remove(CONFIG.state)
        except OSError as error:
            # Never boot on the build machine's journal: move it aside.
            os.rename(CONFIG.state, "%s.stale-%d" % (CONFIG.state, os.getpid()))
            if not outcome.startswith(b"failed"):
                outcome = ("failed: %s" % (error.strerror or error)).encode()
        os.makedirs(CONFIG.state, mode=0o700, exist_ok=True)
        write_atomic(os.path.join(CONFIG.state, "template-seal"), outcome)
        remove(os.path.dirname(marker))
        # A seal that failed may have left the build's services behind.
        remove_service_units(rooted("/etc/systemd/system"))
    os.makedirs(ops_dir(), mode=0o700, exist_ok=True)
    for directory in (CONFIG.workspace, rooted("/repos")):
        os.makedirs(directory, mode=0o755, exist_ok=True)
        give(directory)
    if CONFIG.root == "/":
        install_cli()
    write_atomic(os.path.join(CONFIG.state, "initialized"), b"")
    return 0


# --- entry ---------------------------------------------------------------

def read_request(stream):
    line = stream.readline(MAX_HEADER_BYTES + 1)
    if not line.endswith(b"\n"):
        raise Fail("INVALID_REQUEST", "request header must be one JSON line")
    try:
        header = json.loads(line.decode())
    except ValueError:
        raise Fail("INVALID_REQUEST", "request header is not JSON")
    if not isinstance(header, dict):
        raise Fail("INVALID_REQUEST", "request header must be an object")
    length = header.get("length", 0)
    if not integer(length, 0, LIMITS["maxWriteBytes"]):
        raise Fail("INVALID_REQUEST", "invalid body length")
    body = stream.read(length) if length else b""
    if len(body) != length:
        raise Fail("INVALID_REQUEST", "request body is shorter than its length")
    return header, body


def call(name, stdin, stdout):
    try:
        if name not in OPERATIONS:
            raise Fail("UNSUPPORTED", "unknown operation")
        header, body = read_request(stdin)
        answer, payload = OPERATIONS[name](header, body)
    except Fail as failure:
        answer, payload = {"error": {"code": failure.code, "message": failure.message[:256]}}, b""
    except OSError as error:
        answer, payload = {"error": {"code": "IO_ERROR", "message": (error.strerror or str(error))[:256]}}, b""
    stdout.write(json.dumps(answer, separators=(",", ":")).encode() + b"\n")
    stdout.write(payload)
    stdout.flush()
    return 0


def main(argv):
    command = argv[0] if argv else ""
    if command == "ssh":
        return call(os.environ.get("SSH_ORIGINAL_COMMAND", "").strip(), sys.stdin.buffer, sys.stdout.buffer)
    if command == "call" and len(argv) == 2:
        return call(argv[1], sys.stdin.buffer, sys.stdout.buffer)
    if command == "wrap" and len(argv) == 2 and ID.match(argv[1]):
        return wrap(argv[1])
    if command == "finish" and len(argv) == 2 and ID.match(argv[1]):
        return finish(argv[1])
    if command == "recover":
        return recover()
    if command == "init":
        return init()
    if command == "seal":
        return seal()
    if command == "seal-final":
        return seal_final()
    if command == "packages":
        return packages()
    if command == "cli":
        return cli(argv[1:])
    if command == "service-run" and len(argv) == 2:
        return service_run(argv[1])
    if command == "--version":
        print("cube-guest %s" % VERSION)
        return 0
    sys.stderr.write("usage: cube-guest ssh | call OP | wrap ID | finish ID | recover | init | seal | seal-final | packages | cli ... | service-run NAME | --version\n")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(errno.EPIPE)
