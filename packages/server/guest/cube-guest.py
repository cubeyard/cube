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

The VM is the isolation boundary: path checks are contract, not security.
Python 3 standard library only.
"""

import errno
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time

VERSION = "1"
HELPER = "/usr/local/sbin/cube-guest"
CAPABILITIES = ["exec.start", "exec.cancel", "operation.get", "fs.read", "fs.write", "fs.stat"]
LIMITS = {
    "maxFrameBytes": 1048576,
    "requestTimeoutMs": 30000,
    "maxCommandBytes": 8192,
    "maxPathBytes": 4096,
    "maxExecTimeoutMs": 600000,
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
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(temporary, target)
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
    if owner is not None:
        os.chown(target, owner[0], owner[1], follow_symlinks=False)


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


def op_hello(header, body):
    return {"version": VERSION, "ready": ready(), "capabilities": CAPABILITIES, "limits": LIMITS,
            "epoch": current_epoch()}, b""


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
    target = workspace_path(header.get("path"))
    offset = header.get("offset", 0)
    limit = header.get("limit", LIMITS["maxReadBytes"])
    if not integer(offset, 0) or not integer(limit, 1, LIMITS["maxReadBytes"]):
        raise Fail("INVALID_REQUEST", "read limit is at most %d bytes" % LIMITS["maxReadBytes"])
    try:
        info = os.stat(target)
    except FileNotFoundError:
        raise Fail("NOT_FOUND", "no such file")
    if not stat.S_ISREG(info.st_mode):
        raise Fail("INVALID_REQUEST", "not a regular file")
    with open(target, "rb") as handle:
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
    target = workspace_path(relative, follow=False)
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
        root = os.path.realpath(CONFIG.workspace)
        missing = []
        probe = directory
        while not os.path.isdir(probe) and probe != root:
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
    target = workspace_path(header.get("path"), follow=False)
    try:
        info = os.lstat(target)
    except FileNotFoundError:
        raise Fail("NOT_FOUND", "no such file")
    kind = "file" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) \
        else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
    return {"kind": kind, "size": info.st_size, "mode": stat.S_IMODE(info.st_mode),
            "modifiedMs": info.st_mtime_ns // 1000000, "sha256": sha256_file(target) if kind == "file" else None}, b""


OPERATIONS = {"hello": op_hello, "exec": op_exec, "get": op_get, "cancel": op_cancel, "read": op_read,
              "write": op_write, "stat": op_stat}


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


def init():
    """First boot (cloud-init runcmd): the journal and the agent's directories."""
    os.makedirs(ops_dir(), mode=0o700, exist_ok=True)
    for directory in (CONFIG.workspace, "/repos"):
        os.makedirs(directory, mode=0o755, exist_ok=True)
        give(directory)
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
    if command == "packages":
        return packages()
    if command == "--version":
        print("cube-guest %s" % VERSION)
        return 0
    sys.stderr.write("usage: cube-guest ssh | call OP | wrap ID | finish ID | recover | init | packages | --version\n")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(errno.EPIPE)
