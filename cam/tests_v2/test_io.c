#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include "cam_io.h"

static int64_t now_us(void) {
    struct timespec t;
    assert(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
    return (int64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}
static bool ready(void) { return true; }
static bool disconnected(void) { return false; }
int main(void)
{
    signal(SIGPIPE, SIG_IGN);
    int sockets[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    const char payload[] = "raw-token-and-record";
    assert(cam_send_until(sockets[0], payload, sizeof(payload), now_us()+100000,
                          now_us, ready));
    char got[sizeof(payload)];
    assert(recv(sockets[1], got, sizeof(got), 0) == sizeof(got));
    assert(memcmp(got, payload, sizeof(got)) == 0);
    assert(!cam_send_until(sockets[0], payload, sizeof(payload), now_us()-1, now_us, ready));
    assert(!cam_send_until(sockets[0], payload, sizeof(payload), now_us()+100000,
                           now_us, disconnected));
    int size = 4096;
    assert(setsockopt(sockets[0], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size)) == 0);
    char block[4096] = {0};
    while (send(sockets[0], block, sizeof(block), MSG_DONTWAIT) > 0) {}
    assert(errno == EAGAIN || errno == EWOULDBLOCK);
    int64_t begin = now_us();
    assert(!cam_send_until(sockets[0], payload, sizeof(payload), begin+60000, now_us, ready));
    assert(now_us()-begin >= 50000 && now_us()-begin < 500000);
    close(sockets[1]);
    assert(!cam_send_until(sockets[0], payload, sizeof(payload), now_us()+100000, now_us, ready));
    close(sockets[0]);
    puts("CAM actual socket deadline/disconnect: PASS");
}
