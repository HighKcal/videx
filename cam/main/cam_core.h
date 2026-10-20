#ifndef VIDEX_CAM_CORE_H
#define VIDEX_CAM_CORE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    char ap_ssid[33];
    char ap_pass[64];
    char cam_token[65];
} cam_credentials_t;
#define CAMERA_LEFT 0
#define CAM_FRAME_MAGIC UINT32_C(0x324d4143)
/* Classic ESP32 is little-endian: unchanged CAM2 <IBB2xIIHHQ. */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t camera_id;
    uint8_t flags;
    uint8_t reserved[2];
    uint32_t frame_id;
    uint32_t jpeg_size;
    uint16_t width;
    uint16_t height;
    uint64_t timestamp_us;
} cam_frame_header_t;
_Static_assert(sizeof(cam_frame_header_t) == 28, "CAM2 must remain 28 bytes");
void cam_button_encode(uint8_t out[12], uint32_t sequence, bool pressed);

#define CAM_BUTTON_CAPACITY 8
#define CAM_BUTTON_MAX_AGE_US INT64_C(100000)
#define CAM_BUTTON_MAX_GAP_US INT64_C(60000)
typedef struct {
    uint32_t sequence;
    bool pressed;
    int64_t sampled_us;
} cam_button_sample_t;
/* Caller serializes ALL accesses; firmware uses a short portMUX section. */
typedef struct {
    cam_button_sample_t samples[CAM_BUTTON_CAPACITY];
    unsigned head, count;
    bool active, has_sample;
    int64_t last_us;
} cam_button_stream_t;
void cam_button_start(cam_button_stream_t *s);
void cam_button_stop(cam_button_stream_t *s);
bool cam_button_push(cam_button_stream_t *s, uint32_t seq, bool pressed, int64_t now);
bool cam_button_pop(cam_button_stream_t *s, cam_button_sample_t *out, int64_t now);

bool cam_credentials_valid(const cam_credentials_t *c);
#endif
