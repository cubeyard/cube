/*
 * cube-init: PID 1 of a keel machine.
 *
 * Mounts the pseudo filesystems, enables the cgroup v2 controllers, brings up
 * loopback, starts /sbin/cube-agent and starts it again when it dies, reaps
 * every orphan, and powers the machine off (or reboots it) on a signal.
 * Everything the machine is (layers, writable disk, identity) is the agent's
 * job; this program does only what has to happen before the agent can run and
 * must never exit, since the kernel panics when PID 1 dies.
 *
 * Signals to PID 1:
 *   SIGTERM, SIGUSR2, SIGPWR  power off
 *   SIGINT (Ctrl-Alt-Del)     reboot (QEMU's -no-reboot turns it into an exit)
 *
 * Shutdown: SIGTERM to the agent, then to every process, SIGKILL to what is
 * left, sync, unmount everything but the root (remount read-only what will
 * not unmount), then reboot(2).
 *
 * Messages go to the console prefixed "cube-init: ", so a failure is visible
 * even with "quiet" on the kernel command line.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/timerfd.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define AGENT "/sbin/cube-agent"
#define CONTROLLERS "cpu cpuset io memory pids"
#define AGENT_STOP_MS 5000   /* the agent's time to stop its operations */
#define REST_STOP_MS 2000    /* everything else, after SIGTERM */
#define RESTART_MIN_MS 100
#define RESTART_MAX_MS 5000
#define STABLE_MS 10000      /* an agent that ran this long restarts quickly */

static void say(const char *format, ...) {
	char line[512];
	va_list args;
	va_start(args, format);
	int n = vsnprintf(line, sizeof line - 1, format, args);
	va_end(args);
	if (n < 0) return;
	if (n > (int)sizeof line - 2) n = sizeof line - 2;
	line[n++] = '\n';
	/* "cube-init: " and the line in one write, so lines do not interleave. */
	char out[sizeof line + 16];
	memcpy(out, "cube-init: ", 11);
	memcpy(out + 11, line, n);
	(void)!write(STDERR_FILENO, out, 11 + n);
}

static int64_t now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

/* Mounts one filesystem; an existing mount at the target (devtmpfs, which the
 * kernel mounts itself with DEVTMPFS_MOUNT) counts as done. */
static int mount_one(const char *source, const char *target, const char *type,
		     unsigned long flags, const char *data) {
	mkdir(target, 0755);
	if (mount(source, target, type, flags, data) == 0 || errno == EBUSY) return 0;
	say("mount %s on %s failed: %s", type, target, strerror(errno));
	return -1;
}

static void console(void) {
	/* The kernel opens /dev/console for PID 1 when the root has /dev/console
	 * or devtmpfs is mounted first; make sure 0, 1 and 2 are valid either way. */
	if (fcntl(STDERR_FILENO, F_GETFD) == 0) return;
	int fd = open("/dev/console", O_RDWR | O_NOCTTY | O_CLOEXEC);
	if (fd < 0) fd = open("/dev/null", O_RDWR | O_CLOEXEC);
	if (fd < 0) return;
	for (int i = 0; i < 3; i++)
		if (fcntl(i, F_GETFD) < 0) dup2(fd, i);
	if (fd > 2) close(fd);
}

static int bring_up(void) {
	int failed = 0;
	const unsigned long secure = MS_NOSUID | MS_NODEV | MS_NOEXEC;
	failed |= mount_one("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, "mode=0755");
	console();
	failed |= mount_one("proc", "/proc", "proc", secure, NULL);
	failed |= mount_one("sysfs", "/sys", "sysfs", secure, NULL);
	failed |= mount_one("devpts", "/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC,
			    "newinstance,ptmxmode=0666,mode=0620,gid=5");
	failed |= mount_one("shm", "/dev/shm", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777");
	failed |= mount_one("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755");
	failed |= mount_one("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777");
	failed |= mount_one("cgroup2", "/sys/fs/cgroup", "cgroup2", secure, "nsdelegate");

	/* devtmpfs has no fd links; programs expect them. */
	static const char *links[][2] = {
		{"/proc/self/fd", "/dev/fd"},
		{"/proc/self/fd/0", "/dev/stdin"},
		{"/proc/self/fd/1", "/dev/stdout"},
		{"/proc/self/fd/2", "/dev/stderr"},
	};
	for (size_t i = 0; i < sizeof links / sizeof *links; i++)
		if (symlink(links[i][0], links[i][1]) < 0 && errno != EEXIST)
			say("link %s: %s", links[i][1], strerror(errno));

	/* One controller at a time, so a missing one is named. */
	char controllers[] = CONTROLLERS;
	for (char *name = strtok(controllers, " "); name; name = strtok(NULL, " ")) {
		int fd = open("/sys/fs/cgroup/cgroup.subtree_control", O_WRONLY | O_CLOEXEC);
		char enable[32];
		int n = snprintf(enable, sizeof enable, "+%s", name);
		if (fd < 0 || write(fd, enable, n) != n) {
			say("cgroup controller %s not enabled: %s", name, strerror(errno));
			failed = 1;
		}
		if (fd >= 0) close(fd);
	}

	/* Loopback up; the kernel gives it 127.0.0.1 and ::1. */
	int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	struct ifreq ifr = {0};
	strcpy(ifr.ifr_name, "lo");
	if (s < 0 || ioctl(s, SIOCGIFFLAGS, &ifr) < 0 ||
	    (ifr.ifr_flags |= IFF_UP, ioctl(s, SIOCSIFFLAGS, &ifr) < 0)) {
		say("loopback not up: %s", strerror(errno));
		failed = 1;
	}
	if (s >= 0) close(s);
	return failed ? -1 : 0;
}

static pid_t start_agent(const sigset_t *blocked) {
	pid_t pid = fork();
	if (pid < 0) {
		say("fork for %s failed: %s", AGENT, strerror(errno));
		return -1;
	}
	if (pid == 0) {
		sigprocmask(SIG_UNBLOCK, blocked, NULL);
		setsid();
		char *argv[] = {AGENT, NULL};
		char *envp[] = {"PATH=/sbin:/bin", "HOME=/", NULL};
		execve(AGENT, argv, envp);
		say("cannot run %s: %s", AGENT, strerror(errno));
		_exit(127);
	}
	return pid;
}

static void describe(int status, char *out, size_t size) {
	if (WIFEXITED(status))
		snprintf(out, size, "exit status %d", WEXITSTATUS(status));
	else if (WIFSIGNALED(status))
		snprintf(out, size, "signal %d (%s)", WTERMSIG(status), strsignal(WTERMSIG(status)));
	else
		snprintf(out, size, "status 0x%x", status);
}

static void arm(int timer, int64_t ms) {
	struct itimerspec t = {0};
	if (ms > 0) {
		t.it_value.tv_sec = ms / 1000;
		t.it_value.tv_nsec = (ms % 1000) * 1000000;
	}
	timerfd_settime(timer, 0, &t, NULL);
}

/* Unmounts everything but the root and cube-init's own pseudo filesystems,
 * innermost first; what stays busy is remounted read-only so its filesystem
 * is clean. */
static void unmount_all(void) {
	static const char *keep[] = {"/", "/proc", "/sys", "/sys/fs/cgroup", "/dev", "/dev/pts", NULL};
	char *points[256];
	int count = 0;
	FILE *f = fopen("/proc/self/mountinfo", "re");
	if (f) {
		char line[4096];
		while (count < 256 && fgets(line, sizeof line, f)) {
			char point[4096];
			if (sscanf(line, "%*s %*s %*s %*s %4095s", point) != 1) continue;
			int skip = 0;
			for (const char **p = keep; *p; p++) skip |= strcmp(point, *p) == 0;
			if (!skip) points[count++] = strdup(point);
		}
		fclose(f);
	}
	sync();
	for (int i = count - 1; i >= 0; i--) {
		if (!points[i]) continue;
		if (umount2(points[i], 0) < 0 && errno != EINVAL && errno != ENOENT &&
		    mount(NULL, points[i], NULL, MS_REMOUNT | MS_RDONLY, NULL) < 0 && errno != EINVAL)
			say("%s stays mounted: %s", points[i], strerror(errno));
		free(points[i]);
	}
	sync();
}

enum phase { RUNNING, STOP_AGENT, STOP_REST, FINAL };

int main(void) {
	if (getpid() != 1) {
		fprintf(stderr, "cube-init: must run as PID 1\n");
		return 2;
	}
	umask(022);
	setsid();
	if (bring_up() < 0) say("bring-up incomplete; starting the agent anyway");

	/* Ctrl-Alt-Del becomes SIGINT instead of an immediate reboot. */
	reboot(RB_DISABLE_CAD);

	sigset_t blocked;
	sigfillset(&blocked);
	sigprocmask(SIG_BLOCK, &blocked, NULL);
	sigset_t wanted;
	sigemptyset(&wanted);
	int handled[] = {SIGCHLD, SIGTERM, SIGINT, SIGUSR2, SIGPWR};
	for (size_t i = 0; i < sizeof handled / sizeof *handled; i++) sigaddset(&wanted, handled[i]);
	int signals = signalfd(-1, &wanted, SFD_CLOEXEC | SFD_NONBLOCK);
	int timer = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
	if (signals < 0 || timer < 0) {
		say("signalfd/timerfd: %s; halting", strerror(errno));
		for (;;) pause();
	}

	enum phase phase = RUNNING;
	int command = RB_POWER_OFF;
	pid_t agent = start_agent(&blocked);
	int64_t agent_started = now_ms();
	int64_t restart_delay = RESTART_MIN_MS;
	int restart_pending = agent < 0;
	if (restart_pending) arm(timer, restart_delay);

	for (;;) {
		struct pollfd fds[2] = {{signals, POLLIN, 0}, {timer, POLLIN, 0}};
		if (poll(fds, 2, -1) < 0) continue;

		if (fds[1].revents & POLLIN) {
			uint64_t expirations;
			(void)!read(timer, &expirations, sizeof expirations);
			if (phase == RUNNING && restart_pending) {
				restart_pending = 0;
				agent = start_agent(&blocked);
				agent_started = now_ms();
				if (agent < 0) {
					restart_pending = 1;
					arm(timer, restart_delay);
				}
			} else if (phase == STOP_AGENT) {
				if (agent > 0) say("%s did not stop in %d ms", AGENT, AGENT_STOP_MS);
				phase = STOP_REST;
				kill(-1, SIGTERM);
				arm(timer, REST_STOP_MS);
			} else if (phase == STOP_REST) {
				phase = FINAL;
			}
		}

		if (fds[0].revents & POLLIN) {
			struct signalfd_siginfo info;
			while (read(signals, &info, sizeof info) == sizeof info) {
				int sig = (int)info.ssi_signo;
				if (sig == SIGCHLD) continue;
				if (phase != RUNNING) continue;
				command = sig == SIGINT ? RB_AUTOBOOT : RB_POWER_OFF;
				say("%s: %s", strsignal(sig), command == RB_AUTOBOOT ? "rebooting" : "powering off");
				phase = STOP_AGENT;
				restart_pending = 0;
				if (agent > 0) {
					kill(agent, SIGTERM);
					arm(timer, AGENT_STOP_MS);
				} else {
					phase = STOP_REST;
					kill(-1, SIGTERM);
					arm(timer, REST_STOP_MS);
				}
				break;
			}
		}

		/* Reap every child: the agent, and orphans reparented to PID 1. */
		int status;
		pid_t pid;
		int any_left = 1;
		while ((pid = waitpid(-1, &status, WNOHANG)) != 0) {
			if (pid < 0) {
				any_left = errno != ECHILD;
				break;
			}
			if (pid != agent) continue;
			agent = -1;
			char how[64];
			describe(status, how, sizeof how);
			if (phase == RUNNING) {
				/* Quick restarts back off; an agent that ran a while
				 * starts again at once. */
				int64_t ran = now_ms() - agent_started;
				if (ran >= STABLE_MS) restart_delay = RESTART_MIN_MS;
				say("%s ended (%s) after %lld ms; starting it again in %lld ms", AGENT, how,
				    (long long)ran, (long long)restart_delay);
				restart_pending = 1;
				arm(timer, restart_delay);
				restart_delay = restart_delay * 2 > RESTART_MAX_MS ? RESTART_MAX_MS
										    : restart_delay * 2;
			} else if (phase == STOP_AGENT) {
				phase = STOP_REST;
				kill(-1, SIGTERM);
				arm(timer, REST_STOP_MS);
			}
		}
		if (phase == STOP_REST && !any_left) phase = FINAL;

		if (phase == FINAL) {
			kill(-1, SIGKILL);
			while (waitpid(-1, NULL, 0) > 0 || errno == EINTR) {
			}
			unmount_all();
			reboot(command);
			say("reboot(2): %s", strerror(errno));
			for (;;) pause();
		}
	}
}
