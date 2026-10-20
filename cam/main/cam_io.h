#ifndef VIDEX_CAM_IO_H
#define VIDEX_CAM_IO_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* Nonblocking per-call I/O, one absolute deadline for the whole message. */
bool cam_send_until(int sock, const void *data, size_t length, int64_t deadline_us,
                    int64_t (*clock_us)(void), bool (*ready)(void));
#endif
