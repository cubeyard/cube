/*
 * A stand-in for cube-agent, for keel's boot check (work package 4) only.
 * It is not cube-agent: it does not speak DaemonFrame, keeps no journal and
 * knows nothing of OPERATIONS. cube-init starts it as /sbin/cube-agent until
 * the real agent exists (masterplan K-5a).
 *
 * It does what cube-agent's machine_setup will do with the disks: mounts the
 * layer disk's partitions (vdb1..vdbN) read-only as EROFS, formats the
 * writable disk (vdc) with mke2fs when it is blank or checks it with e2fsck
 * when it is not, and assembles the workload root
 *
 *   overlay(lowerdir = the partitions in the order given, topmost first;
 *           upperdir = vdc/upper, workdir = vdc/work)
 *
 * with vdc/state bind-mounted at /var/lib/cube, at /run/keel/root.
 *
 * Its channel is a line protocol on the virtio-serial port named cube.0:
 *
 *   agent  hello keel-agent-standin boot_id=B kernel=K boottime_ms=T assembled=0|1
 *   runner setup P1 P2 ...      partitions, topmost layer first
 *   agent  ready formatted=0|1 fsck=RC ms=M again=0|1   or   error TEXT
 *   runner run COMMAND          /bin/sh -c COMMAND in the workload root
 *   agent  out LINE ...  then  exit CODE
 *   runner poweroff             unmount, then ask cube-init to power off
 *   agent  bye
 *   runner hello                the agent says hello again
 *   runner crash                exit at once (cube-init starts it again)
 *
 * When the runner's end of the port closes (a snapshot restore gives it a new
 * socket) it waits for the next connection and says hello again.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RUN "/run/keel"
#define ROOT RUN "/root"
#define RW RUN "/rw"
#define LAYER_DISK "/dev/vdb"
#define RW_DISK "/dev/vdc"
#define MAX_LAYERS 128

static int port = -1;
static int connected;
static volatile sig_atomic_t stopping;

static void log_line(const char *format, ...) {
	va_list args;
	va_start(args, format);
	fprintf(stderr, "cube-agent (stand-in): ");
	vfprintf(stderr, format, args);
	fputc('\n', stderr);
	va_end(args);
}

static void send_line(const char *format, ...) {
	if (!connected) return;
	char line[8192];
	va_list args;
	va_start(args, format);
	int n = vsnprintf(line, sizeof line - 1, format, args);
	va_end(args);
	if (n < 0) return;
	if (n > (int)sizeof line - 2) n = sizeof line - 2;
	line[n++] = '\n';
	for (int done = 0; done < n;) {
		ssize_t w = write(port, line + done, n - done);
		if (w < 0) {
			if (errno == EINTR) continue;
			connected = 0;
			return;
		}
		done += w;
	}
}

static int64_t ms(clockid_t clock) {
	struct timespec t;
	clock_gettime(clock, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int find_port(char *path, size_t size) {
	DIR *dir = opendir("/sys/class/virtio-ports");
	if (!dir) return -1;
	struct dirent *entry;
	int found = -1;
	while ((entry = readdir(dir))) {
		if (entry->d_name[0] == '.') continue;
		char file[512], name[64] = {0};
		snprintf(file, sizeof file, "/sys/class/virtio-ports/%s/name", entry->d_name);
		FILE *f = fopen(file, "re");
		if (!f) continue;
		if (fgets(name, sizeof name, f)) name[strcspn(name, "\n")] = 0;
		fclose(f);
		if (strcmp(name, "cube.0") == 0) {
			snprintf(path, size, "/dev/%s", entry->d_name);
			found = 0;
			break;
		}
	}
	closedir(dir);
	return found;
}

static int is_mounted(const char *path) {
	struct stat here, parent;
	char up[512];
	snprintf(up, sizeof up, "%s/..", path);
	return stat(path, &here) == 0 && stat(up, &parent) == 0 && here.st_dev != parent.st_dev;
}

static int mkdirs(const char *path, mode_t mode) {
	char buffer[512];
	snprintf(buffer, sizeof buffer, "%s", path);
	for (char *p = buffer + 1; *p; p++) {
		if (*p != '/') continue;
		*p = 0;
		mkdir(buffer, 0755);
		*p = '/';
	}
	return mkdir(buffer, mode) == 0 || errno == EEXIST ? 0 : -1;
}

/* Runs a program from the base root and returns its exit status, -1 if it
 * could not run. Its output goes to the console. */
static int run_base(char *const argv[]) {
	pid_t pid = fork();
	if (pid < 0) return -1;
	if (pid == 0) {
		char *envp[] = {"PATH=/sbin:/bin", NULL};
		execve(argv[0], argv, envp);
		_exit(127);
	}
	int status;
	while (waitpid(pid, &status, 0) < 0)
		if (errno != EINTR) return -1;
	return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

/* 0: ext4, 1: blank (the first 64 KiB are zero), -1: something else. */
static int rw_disk_kind(void) {
	int fd = open(RW_DISK, O_RDONLY | O_CLOEXEC);
	if (fd < 0) return -1;
	static unsigned char head[65536];
	ssize_t n = pread(fd, head, sizeof head, 0);
	close(fd);
	if (n != (ssize_t)sizeof head) return -1;
	if (head[1080] == 0x53 && head[1081] == 0xef) return 0;
	for (size_t i = 0; i < sizeof head; i++)
		if (head[i]) return -1;
	return 1;
}

static char assembled_layers[1024];

static void setup(char *arguments) {
	int64_t started = ms(CLOCK_MONOTONIC);
	int partitions[MAX_LAYERS], count = 0;
	char list[1024] = "";
	for (char *word = strtok(arguments, " "); word; word = strtok(NULL, " ")) {
		char *end;
		long n = strtol(word, &end, 10);
		if (*end || n < 1 || n > MAX_LAYERS || count == MAX_LAYERS) {
			send_line("error bad partition %s", word);
			return;
		}
		partitions[count++] = (int)n;
		snprintf(list + strlen(list), sizeof list - strlen(list), "%s%ld", count > 1 ? " " : "", n);
	}
	if (count == 0) {
		send_line("error no layers");
		return;
	}
	/* Idempotent: the same list again is a no-op; another list cannot replace
	 * the layers under a running workload. */
	if (is_mounted(ROOT)) {
		if (strcmp(list, assembled_layers) != 0 && assembled_layers[0]) {
			send_line("error layers_changed");
			return;
		}
		snprintf(assembled_layers, sizeof assembled_layers, "%s", list);
		send_line("ready formatted=0 fsck=-1 ms=%lld again=1",
			  (long long)(ms(CLOCK_MONOTONIC) - started));
		return;
	}

	char lowerdir[8192] = "";
	for (int i = 0; i < count; i++) {
		char device[64], target[128];
		snprintf(device, sizeof device, LAYER_DISK "%d", partitions[i]);
		snprintf(target, sizeof target, RUN "/layers/%d", partitions[i]);
		mkdirs(target, 0755);
		if (!is_mounted(target) &&
		    mount(device, target, "erofs", MS_RDONLY | MS_NODEV | MS_NOSUID, NULL) < 0) {
			send_line("error mount %s: %s", device, strerror(errno));
			return;
		}
		snprintf(lowerdir + strlen(lowerdir), sizeof lowerdir - strlen(lowerdir), "%s%s",
			 i ? ":" : "", target);
	}

	int formatted = 0, fsck = -1;
	switch (rw_disk_kind()) {
	case 1: {
		char *argv[] = {"/sbin/mke2fs", "-q", "-t", "ext4", "-L", "cube-rw", "-E",
				"lazy_itable_init=1", RW_DISK, NULL};
		int rc = run_base(argv);
		if (rc != 0) {
			send_line("error mke2fs exited %d", rc);
			return;
		}
		formatted = 1;
		break;
	}
	case 0: {
		/* -p repairs what is safe; 1 means it fixed something. */
		char *argv[] = {"/sbin/e2fsck", "-p", RW_DISK, NULL};
		fsck = run_base(argv);
		if (fsck != 0 && fsck != 1) {
			send_line("error e2fsck exited %d", fsck);
			return;
		}
		break;
	}
	default:
		send_line("error %s is neither ext4 nor blank; not formatting it", RW_DISK);
		return;
	}
	mkdirs(RW, 0755);
	if (!is_mounted(RW) && mount(RW_DISK, RW, "ext4", MS_NODEV | MS_NOSUID, NULL) < 0) {
		send_line("error mount %s: %s", RW_DISK, strerror(errno));
		return;
	}
	mkdirs(RW "/upper", 0755);
	mkdirs(RW "/work", 0755);
	mkdirs(RW "/state", 0700);

	char options[8400];
	snprintf(options, sizeof options, "lowerdir=%s,upperdir=" RW "/upper,workdir=" RW "/work",
		 lowerdir);
	mkdirs(ROOT, 0755);
	if (mount("overlay", ROOT, "overlay", 0, options) < 0) {
		send_line("error overlay: %s", strerror(errno));
		return;
	}
	struct {
		const char *source, *target, *type;
		unsigned long flags;
		const char *data;
	} inner[] = {
		{RW "/state", ROOT "/var/lib/cube", NULL, MS_BIND, NULL},
		{"proc", ROOT "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL},
		{"/sys", ROOT "/sys", NULL, MS_BIND | MS_REC, NULL},
		{"/dev", ROOT "/dev", NULL, MS_BIND | MS_REC, NULL},
		{"tmpfs", ROOT "/run", "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755"},
		{"tmpfs", ROOT "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777"},
	};
	for (size_t i = 0; i < sizeof inner / sizeof *inner; i++) {
		mkdirs(inner[i].target, 0755);
		if (mount(inner[i].source, inner[i].target, inner[i].type, inner[i].flags,
			  inner[i].data) < 0) {
			send_line("error mount %s: %s", inner[i].target, strerror(errno));
			return;
		}
	}
	mkdirs(ROOT "/workspace", 0755);
	snprintf(assembled_layers, sizeof assembled_layers, "%s", list);
	send_line("ready formatted=%d fsck=%d ms=%lld again=0", formatted, fsck,
		  (long long)(ms(CLOCK_MONOTONIC) - started));
}

static void run(const char *command) {
	if (!is_mounted(ROOT)) {
		send_line("error not_ready");
		return;
	}
	int out[2];
	if (pipe2(out, O_CLOEXEC) < 0) {
		send_line("error pipe: %s", strerror(errno));
		return;
	}
	pid_t pid = fork();
	if (pid == 0) {
		setsid();
		int null = open("/dev/null", O_RDONLY);
		dup2(null, 0);
		dup2(out[1], 1);
		dup2(out[1], 2);
		if (chroot(ROOT) < 0 || chdir("/") < 0) _exit(126);
		char *envp[] = {"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				"HOME=/root", "LANG=C.UTF-8", NULL};
		execle("/bin/sh", "sh", "-c", command, (char *)NULL, envp);
		_exit(127);
	}
	close(out[1]);
	FILE *f = fdopen(out[0], "r");
	char line[4096];
	while (f && fgets(line, sizeof line, f)) {
		line[strcspn(line, "\n")] = 0;
		send_line("out %s", line);
	}
	if (f) fclose(f);
	int status = 0;
	if (pid > 0)
		while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
		}
	send_line("exit %d", pid < 0 ? -1 : WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
}

/* Unmounts what setup mounted, innermost first. */
static void teardown(void) {
	const char *inner[] = {ROOT "/tmp", ROOT "/run", ROOT "/proc", ROOT "/var/lib/cube", NULL};
	for (const char **p = inner; *p; p++) umount2(*p, 0);
	umount2(ROOT "/dev", MNT_DETACH);
	umount2(ROOT "/sys", MNT_DETACH);
	if (umount2(ROOT, 0) < 0 && errno != EINVAL) log_line("umount %s: %s", ROOT, strerror(errno));
	if (umount2(RW, 0) < 0 && errno != EINVAL) log_line("umount %s: %s", RW, strerror(errno));
	DIR *dir = opendir(RUN "/layers");
	struct dirent *entry;
	while (dir && (entry = readdir(dir))) {
		if (entry->d_name[0] == '.') continue;
		char path[512];
		snprintf(path, sizeof path, RUN "/layers/%s", entry->d_name);
		umount2(path, 0);
	}
	if (dir) closedir(dir);
	sync();
}

static void hello(void) {
	char boot_id[64] = "unknown";
	FILE *f = fopen("/proc/sys/kernel/random/boot_id", "re");
	if (f) {
		if (fgets(boot_id, sizeof boot_id, f)) boot_id[strcspn(boot_id, "\n")] = 0;
		fclose(f);
	}
	struct utsname u;
	uname(&u);
	send_line("hello keel-agent-standin boot_id=%s kernel=%s boottime_ms=%lld assembled=%d", boot_id,
		  u.release, (long long)ms(CLOCK_BOOTTIME), is_mounted(ROOT));
}

static void on_term(int sig) {
	(void)sig;
	stopping = 1;
}

int main(void) {
	struct sigaction stop = {.sa_handler = on_term};
	sigaction(SIGTERM, &stop, NULL);
	signal(SIGPIPE, SIG_IGN);

	char path[300];
	for (int tries = 0; find_port(path, sizeof path) < 0; tries++) {
		if (tries == 100) log_line("no virtio-serial port named cube.0 yet");
		if (stopping) return 0;
		usleep(10000);
	}
	port = open(path, O_RDWR | O_CLOEXEC);
	if (port < 0) {
		log_line("open %s: %s", path, strerror(errno));
		return 1;
	}

	char buffer[65536];
	size_t used = 0;
	while (!stopping) {
		struct pollfd p = {port, POLLIN, 0};
		if (poll(&p, 1, connected ? -1 : 20) < 0) continue;
		if (p.revents & POLLHUP && !(p.revents & POLLIN)) {
			/* The runner's end is closed: wait for it, then say hello. */
			connected = 0;
			used = 0;
			usleep(20000);
			continue;
		}
		if (!connected) {
			connected = 1;
			hello();
			if (!(p.revents & POLLIN)) continue;
		}
		ssize_t n = read(port, buffer + used, sizeof buffer - 1 - used);
		if (n <= 0) {
			if (n == 0 || errno != EINTR) connected = 0;
			continue;
		}
		used += n;
		char *start = buffer, *end;
		while ((end = memchr(start, '\n', buffer + used - start))) {
			*end = 0;
			if (strncmp(start, "setup ", 6) == 0) {
				setup(start + 6);
			} else if (strncmp(start, "run ", 4) == 0) {
				run(start + 4);
			} else if (strcmp(start, "poweroff") == 0) {
				send_line("bye");
				teardown();
				kill(1, SIGTERM);
				while (!stopping) pause();
				return 0;
			} else if (strcmp(start, "hello") == 0) {
				hello();
			} else if (strcmp(start, "crash") == 0) {
				log_line("exiting on request (crash)");
				_exit(3);
			} else if (*start) {
				send_line("error unknown request");
			}
			start = end + 1;
		}
		used = buffer + used - start;
		memmove(buffer, start, used);
		if (used == sizeof buffer - 1) used = 0;
	}
	teardown();
	return 0;
}
