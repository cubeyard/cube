// Snapshot-test init for cube's guest kernel. Runs as PID 1 and, every
// 200 ms, writes one line to the virtio-serial port named "cube.0":
//   tick <n> mono=<s> real=<s> ptp=<s> layer=<ok|FAIL>
// mono and real are the guest's CLOCK_MONOTONIC and CLOCK_REALTIME, ptp is
// the host clock read through virtio-rtc (/dev/ptp0), layer re-reads a file
// from the EROFS disk /dev/vda so block I/O after restore is exercised.
// test.py snapshots the machine mid-stream and checks the ticks resume.
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define FD_TO_CLOCKID(fd) ((~(clockid_t)(fd) << 3) | 3)

static double seconds(clockid_t clock) {
	struct timespec ts;
	if (clock_gettime(clock, &ts) != 0) return -1;
	return ts.tv_sec + ts.tv_nsec / 1e9;
}

// The kernel names ports vport<virtio device index>p<port>, so the device
// node depends on how many virtio devices come first; find it by name.
static int open_port(const char *want) {
	DIR *d = opendir("/sys/class/virtio-ports");
	if (!d) return -1;
	struct dirent *e;
	int fd = -1;
	while (fd < 0 && (e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.') continue;
		char path[300], name[64] = {0};
		snprintf(path, sizeof path, "/sys/class/virtio-ports/%s/name", e->d_name);
		int nfd = open(path, O_RDONLY);
		if (nfd < 0) continue;
		ssize_t n = read(nfd, name, sizeof name - 1);
		close(nfd);
		if (n > 0 && name[n - 1] == '\n') name[n - 1] = 0;
		if (strcmp(name, want) == 0) {
			snprintf(path, sizeof path, "/dev/%s", e->d_name);
			fd = open(path, O_WRONLY);
		}
	}
	closedir(d);
	return fd;
}

static int layer_ok(void) {
	char buf[16] = {0};
	int fd = open("/layer/layer", O_RDONLY);
	if (fd < 0) return 0;
	// Drop the page cache copy so the read goes to the disk.
	posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
	ssize_t n = read(fd, buf, sizeof buf - 1);
	close(fd);
	return n > 0 && strncmp(buf, "lz4", 3) == 0;
}

int main(void) {
	mkdir("/proc", 0755);
	mkdir("/sys", 0755);
	mkdir("/dev", 0755);
	mkdir("/layer", 0755);
	mount("proc", "/proc", "proc", 0, NULL);
	mount("sysfs", "/sys", "sysfs", 0, NULL);
	mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
	mount("/dev/vda", "/layer", "erofs", MS_RDONLY, NULL);

	int port = -1;
	while ((port = open_port("cube.0")) < 0) usleep(10000);
	printf("tick: port open\n");
	int ptp = open("/dev/ptp0", O_RDONLY);

	for (unsigned long n = 0;; n++) {
		char line[160];
		int len = snprintf(line, sizeof line, "tick %lu mono=%.3f real=%.3f ptp=%.3f layer=%s\n", n,
		                   seconds(CLOCK_MONOTONIC), seconds(CLOCK_REALTIME),
		                   ptp >= 0 ? seconds(FD_TO_CLOCKID(ptp)) : -1.0, layer_ok() ? "ok" : "FAIL");
		// A write fails while no host end is connected; the tick is lost,
		// as a control channel message would be, and the loop goes on.
		if (write(port, line, len) < 0) {
			close(port);
			port = open_port("cube.0");
		}
		usleep(200000);
	}
}
