// SPDX-License-Identifier: GPL-2.0-only
/*
 * aw1000-at: send one AT command to a modem port and print the reply.
 *
 *   aw1000-at [-t seconds] <tty> <command>
 *
 * sms_tool's "at" gives up after 5 s; here the timeout is the caller's, as a
 * cell scan (AT+QSCAN) takes minutes. The exchange holds an flock on
 * /var/lock/aw1000-modem.lock, the modem's lock that the quectel proto, the
 * LuCI backend (around sms_tool) and aw1000-leds also take: all AT ports lead
 * to the same command parser, so a command on one stalls the others.
 *
 * Prints the reply lines without the command's echo, ending with the final
 * result code (OK, ERROR, +CME ERROR: ...). Exit status: 0 OK, 1 an error
 * result, 2 timeout, 3 modem busy or port unusable.
 */

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static const char *const final_ok[] = { "OK", NULL };
static const char *const final_err[] = {
	"ERROR", "+CME ERROR:", "+CMS ERROR:", "NO CARRIER", "NO ANSWER",
	"NO DIALTONE", "BUSY", "COMMAND NOT SUPPORT", NULL
};

static long now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static int matches(const char *line, const char *const *list)
{
	for (; *list; list++)
		if (!strncmp(line, *list, strlen(*list)) &&
		    (strcmp(*list, "OK") || !line[2]))
			return 1;
	return 0;
}

#define LOCK "/var/lock/aw1000-modem.lock"

static int lock_modem(long deadline)
{
	int fd;

	fd = open(LOCK, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
	if (fd < 0) {
		fprintf(stderr, "open(%s): %s\n", LOCK, strerror(errno));
		return -1;
	}
	while (flock(fd, LOCK_EX | LOCK_NB)) {
		if (errno != EWOULDBLOCK || now_ms() >= deadline) {
			fprintf(stderr, "the modem is busy with another command\n");
			close(fd);
			return -1;
		}
		usleep(100 * 1000);
	}
	return fd;
}

int main(int argc, char **argv)
{
	struct termios saved, t;
	char line[4096], echo[1024];
	size_t len = 0;
	long deadline;
	int timeout = 10, opt, fd, rc = 2, first = 1;

	while ((opt = getopt(argc, argv, "t:")) != -1) {
		if (opt == 't' && atoi(optarg) > 0)
			timeout = atoi(optarg);
		else
			goto usage;
	}
	if (argc - optind != 2)
		goto usage;

	deadline = now_ms() + timeout * 1000L;
	if (lock_modem(deadline) < 0)
		return 3;

	fd = open(argv[optind], O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0 || tcgetattr(fd, &saved)) {
		fprintf(stderr, "%s: %s\n", argv[optind], strerror(errno));
		return 3;
	}
	t = saved;
	cfmakeraw(&t);
	cfsetispeed(&t, B115200);
	cfsetospeed(&t, B115200);
	t.c_cflag |= CLOCAL | CREAD;
	t.c_cc[VMIN] = 0;
	t.c_cc[VTIME] = 0;
	tcsetattr(fd, TCSANOW, &t);
	tcflush(fd, TCIOFLUSH);

	snprintf(echo, sizeof(echo), "%s", argv[optind + 1]);
	if (dprintf(fd, "%s\r", echo) < 0) {
		fprintf(stderr, "write: %s\n", strerror(errno));
		rc = 3;
		goto out;
	}

	for (;;) {
		struct pollfd pfd = { .fd = fd, .events = POLLIN };
		long left = deadline - now_ms();
		char c;
		int n;

		if (left <= 0) {
			fprintf(stderr, "no final result within %d s\n", timeout);
			break;
		}
		n = poll(&pfd, 1, left);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			continue;
		if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
			fprintf(stderr, "%s went away\n", argv[optind]);
			rc = 3;
			break;
		}
		while (read(fd, &c, 1) == 1) {
			if (c != '\n' && c != '\r') {
				if (len < sizeof(line) - 1)
					line[len++] = c;
				continue;
			}
			if (!len)
				continue;
			line[len] = 0;
			len = 0;
			/* the modem echoes the command first (ATE1) */
			if (first && !strcmp(line, echo)) {
				first = 0;
				continue;
			}
			first = 0;
			puts(line);
			if (matches(line, final_ok)) {
				rc = 0;
				goto out;
			}
			if (matches(line, final_err)) {
				rc = 1;
				goto out;
			}
		}
	}

out:
	fflush(stdout);
	tcsetattr(fd, TCSANOW, &saved);
	close(fd);
	return rc;

usage:
	fprintf(stderr, "usage: %s [-t seconds] <tty> <command>\n", argv[0]);
	return 3;
}
