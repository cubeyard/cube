// Smoke-test init for cube's guest kernel. Runs as PID 1 from an initramfs,
// checks what the VM base relies on and powers the machine off. Every line
// it prints starts with "cube-smoke:"; the last one is "ok" or "FAIL".
//
// Expected devices: /dev/vda = LZ4 EROFS layer, /dev/vdb = zstd EROFS layer
// (each holding /layer; the LZ4 one also /only-lz4), a virtio-rtc device.
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>

static int failures;

static void check(int ok, const char *what) {
	printf("cube-smoke: %s %s\n", ok ? "pass" : "FAIL", what);
	if (!ok) failures++;
}

static int file_contains(const char *path, const char *want) {
	static char buf[16384];
	memset(buf, 0, sizeof buf);
	int fd = open(path, O_RDONLY);
	if (fd < 0) return 0;
	ssize_t n = read(fd, buf, sizeof buf - 1);
	close(fd);
	return n > 0 && strstr(buf, want) != NULL;
}

// True when a driver directory in sysfs links at least one bound device.
static int driver_bound(const char *path) {
	DIR *d = opendir(path);
	if (!d) return 0;
	struct dirent *e;
	int bound = 0;
	while ((e = readdir(d)) != NULL)
		if (strncmp(e->d_name, "virtio", 6) == 0) bound = 1;
	closedir(d);
	return bound;
}

// Prints each "<dir>/*/<attr>" so the log shows which clocks the guest has.
static void list_attr(const char *dir, const char *attr) {
	DIR *d = opendir(dir);
	if (!d) return;
	struct dirent *e;
	while ((e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.') continue;
		char path[512], buf[128] = {0};
		snprintf(path, sizeof path, "%s/%s/%s", dir, e->d_name, attr);
		int fd = open(path, O_RDONLY);
		if (fd < 0) continue;
		ssize_t n = read(fd, buf, sizeof buf - 1);
		close(fd);
		if (n > 0 && buf[n - 1] == '\n') buf[n - 1] = 0;
		printf("cube-smoke: %s %s\n", e->d_name, buf);
	}
	closedir(d);
}

int main(void) {
	mkdir("/proc", 0755);
	mkdir("/sys", 0755);
	mkdir("/dev", 0755);
	mount("proc", "/proc", "proc", 0, NULL);
	mount("sysfs", "/sys", "sysfs", 0, NULL);
	mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
	setvbuf(stdout, NULL, _IONBF, 0);

	struct utsname u;
	uname(&u);
	printf("cube-smoke: kernel %s %s\n", u.release, u.machine);
	// Seconds from kernel start to this init running.
	char up[64] = {0};
	int ufd = open("/proc/uptime", O_RDONLY);
	if (ufd >= 0) {
		if (read(ufd, up, sizeof up - 1) > 0) *strchr(up, ' ') = 0;
		close(ufd);
	}
	printf("cube-smoke: init started at %s s uptime\n", up);

	check(driver_bound("/sys/bus/virtio/drivers/virtio_rtc"), "virtio-rtc driver bound");
	list_attr("/sys/class/rtc", "name");
	list_attr("/sys/class/ptp", "clock_name");
	check(file_contains("/proc/filesystems", "erofs"), "erofs registered");
	check(file_contains("/proc/filesystems", "overlay"), "overlay registered");

	mkdir("/lz4", 0755);
	mkdir("/zstd", 0755);
	check(mount("/dev/vda", "/lz4", "erofs", MS_RDONLY, NULL) == 0, "mount LZ4 erofs /dev/vda");
	check(file_contains("/lz4/layer", "lz4"), "read LZ4 layer");
	check(mount("/dev/vdb", "/zstd", "erofs", MS_RDONLY, NULL) == 0, "mount zstd erofs /dev/vdb");
	check(file_contains("/zstd/layer", "zstd"), "read zstd layer");

	// Overlay: zstd layer above LZ4 layer, tmpfs upper, as cube-init will.
	mkdir("/rw", 0755);
	mkdir("/root", 0755);
	mount("tmpfs", "/rw", "tmpfs", 0, NULL);
	mkdir("/rw/upper", 0755);
	mkdir("/rw/work", 0755);
	check(mount("overlay", "/root", "overlay", 0,
	            "lowerdir=/zstd:/lz4,upperdir=/rw/upper,workdir=/rw/work") == 0,
	      "mount overlay");
	check(file_contains("/root/layer", "zstd"), "top layer wins");
	check(file_contains("/root/only-lz4", "lz4"), "lower layer visible");
	int fd = open("/root/written", O_CREAT | O_WRONLY, 0644);
	check(fd >= 0 && write(fd, "rw\n", 3) == 3, "write through overlay");
	if (fd >= 0) close(fd);
	check(access("/rw/upper/written", F_OK) == 0, "write landed in upper");

	printf("cube-smoke: %s\n", failures == 0 ? "ok" : "FAIL");
	sync();
	reboot(RB_POWER_OFF);
	return 0;
}
