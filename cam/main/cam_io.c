#include "cam_io.h"
#include <errno.h>
#ifdef ESP_PLATFORM
#include "lwip/sockets.h"
#else
#include <sys/select.h>
#include <sys/socket.h>
#endif

bool cam_send_until(int sock, const void *data, size_t length, int64_t deadline_us,
                    int64_t (*clock_us)(void), bool (*ready)(void))
{
    const uint8_t *cursor = data;
    while (length) {
        int64_t remaining = deadline_us - clock_us();
        if (!ready() || remaining <= 0) return false;
        int flags = MSG_DONTWAIT;
#ifdef MSG_NOSIGNAL
        flags |= MSG_NOSIGNAL;
#endif
        int sent = send(sock, cursor, length, flags);
        if (sent > 0) {
            cursor += sent;
            length -= (size_t)sent;
        } else if (sent < 0 && errno == EINTR) {
            continue;
        } else if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            fd_set writable;
            FD_ZERO(&writable);
            FD_SET(sock, &writable);
            remaining = deadline_us - clock_us();
            if (remaining <= 0) return false;
            if (remaining > 50000) remaining = 50000;
            struct timeval timeout = {.tv_sec = 0, .tv_usec = (long)remaining};
            int result = select(sock + 1, NULL, &writable, NULL, &timeout);
            if (result < 0 && errno != EINTR) return false;
        } else {
            return false;
        }
    }
    return ready() && clock_us() < deadline_us;
}
