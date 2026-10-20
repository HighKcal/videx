#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "cam_core.h"

static void provisioning(void)
{
    cam_credentials_t c = {.ap_ssid = "VIDEX-unit-123", .ap_pass = "unique-password-123"};
    memset(c.cam_token, 'a', 64);
    assert(cam_credentials_valid(&c));
    c.ap_ssid[0] = 0;
    assert(!cam_credentials_valid(&c));
    strcpy(c.ap_ssid, "VIDEX-test");
    strcpy(c.ap_pass, "short");
    assert(!cam_credentials_valid(&c));
    strcpy(c.ap_pass, "12345678");
    assert(!cam_credentials_valid(&c));
    memset(c.ap_pass, 'p', 63); c.ap_pass[63] = 0;
    assert(cam_credentials_valid(&c));
    c.cam_token[20] = 'A';
    assert(!cam_credentials_valid(&c));
    c.cam_token[20] = 'g';
    assert(!cam_credentials_valid(&c));
    c.cam_token[20] = '0'; c.cam_token[63] = 0;
    assert(!cam_credentials_valid(&c));
    memset(&c, 'x', sizeof(c));
    assert(!cam_credentials_valid(&c));
    assert(!cam_credentials_valid(NULL));
}
static void wire_layout(void)
{
    const cam_frame_header_t h = {
        .magic = CAM_FRAME_MAGIC, .camera_id = CAMERA_LEFT,
        .flags = 3, .frame_id = 0x12345678, .jpeg_size = 100,
        .width = 320, .height = 240, .timestamp_us = UINT64_C(0x1020304050607080),
    };
    const unsigned char expected[28] = {
        'C','A','M','2',0,3,0,0,0x78,0x56,0x34,0x12,100,0,0,0,
        0x40,1,0xf0,0,0x80,0x70,0x60,0x50,0x40,0x30,0x20,0x10,
    };
    assert(sizeof(h) == 28);
    assert(memcmp(&h, expected, 28) == 0);
    uint8_t record[12];
    cam_button_encode(record, 0x12345678, true);
    const unsigned char btn[12] = {'B','T','N','2',0x78,0x56,0x34,0x12,1,0,0,0};
    assert(memcmp(record, btn, 12) == 0);
    cam_button_encode(record, UINT32_MAX, false);
    assert(record[8] == 0 && record[9] == 0 && record[10] == 0 && record[11] == 0);
}

static void independent_button_fifo(void)
{
    cam_button_stream_t stream = {0};
    cam_button_sample_t sample;
    assert(!cam_button_push(&stream, 1, true, 0));
    cam_button_start(&stream);
    /* No artificial release, even when reconnect happens while held. */
    assert(cam_button_push(&stream, UINT32_MAX, true, 20000));
    assert(cam_button_push(&stream, 0, false, 40000));
    assert(cam_button_pop(&stream, &sample, 40000));
    assert(sample.sequence == UINT32_MAX && sample.pressed);
    assert(cam_button_pop(&stream, &sample, 40000));
    assert(sample.sequence == 0 && !sample.pressed);
    assert(!cam_button_pop(&stream, &sample, 40000));
    for (unsigned i = 0; i < CAM_BUTTON_CAPACITY; ++i)
        assert(cam_button_push(&stream, i, i % 2, 60000 + i * 20000));
    assert(!cam_button_push(&stream, 100, false, 60000 + CAM_BUTTON_CAPACITY * 20000));
    assert(!stream.active); /* Overflow never overwrites an edge. */
    assert(!cam_button_pop(&stream, &sample, 220000));
    cam_button_start(&stream);
    assert(!cam_button_pop(&stream, &sample, 220000)); /* No replay. */
    assert(cam_button_push(&stream, 300, true, 300000));
    assert(!cam_button_pop(&stream, &sample, 400001)); /* Stale => fail closed. */
    assert(!stream.active);
    cam_button_start(&stream);
    assert(cam_button_push(&stream, 400, false, 500000));
    assert(!cam_button_push(&stream, 401, true, 560001)); /* Sampling stall. */
    cam_button_stop(&stream);
    assert(!cam_button_push(&stream, 402, false, 580000));
}

int main(void)
{
    provisioning();
    wire_layout();
    independent_button_fifo();
    puts("CAM core provisioning: PASS");
}
