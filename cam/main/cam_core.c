#include "cam_core.h"
#include <string.h>

void cam_button_encode(uint8_t out[12], uint32_t sequence, bool pressed)
{
    memcpy(out, "BTN2", 4);
    for (unsigned i = 0; i < 4; ++i) out[4 + i] = (uint8_t)(sequence >> (8 * i));
    out[8] = pressed ? 1 : 0;
    memset(out + 9, 0, 3);
}

void cam_button_start(cam_button_stream_t *s)
{
    memset(s, 0, sizeof(*s));
    s->active = true;
}

void cam_button_stop(cam_button_stream_t *s)
{
    s->active = false;
    s->count = 0;
}

bool cam_button_push(cam_button_stream_t *s, uint32_t seq, bool pressed, int64_t now)
{
    if (!s->active) return false;
    if (s->count == CAM_BUTTON_CAPACITY ||
        (s->has_sample && (now < s->last_us || now - s->last_us > CAM_BUTTON_MAX_GAP_US))) {
        cam_button_stop(s);
        return false;
    }
    unsigned tail = (s->head + s->count) % CAM_BUTTON_CAPACITY;
    s->samples[tail] = (cam_button_sample_t){seq, pressed, now};
    ++s->count;
    s->has_sample = true;
    s->last_us = now;
    return true;
}

bool cam_button_pop(cam_button_stream_t *s, cam_button_sample_t *out, int64_t now)
{
    if (!s->active || !s->count) return false;
    *out = s->samples[s->head];
    if (now < out->sampled_us || now - out->sampled_us > CAM_BUTTON_MAX_AGE_US) {
        cam_button_stop(s);
        return false;
    }
    s->head = (s->head + 1) % CAM_BUTTON_CAPACITY;
    --s->count;
    return true;
}

static size_t bounded_length(const char *s, size_t capacity)
{
    size_t n = 0;
    while (n < capacity && s[n]) ++n;
    return n;
}

bool cam_credentials_valid(const cam_credentials_t *c)
{
    if (!c) return false;
    size_t ssid = bounded_length(c->ap_ssid, sizeof(c->ap_ssid));
    size_t pass = bounded_length(c->ap_pass, sizeof(c->ap_pass));
    if (ssid < 1 || ssid > 32 || pass < 16 || pass > 63 ||
        bounded_length(c->cam_token, sizeof(c->cam_token)) != 64) return false;
    for (size_t i = 0; i < pass; ++i) {
        if ((unsigned char)c->ap_pass[i] < 32 || (unsigned char)c->ap_pass[i] > 126)
            return false;
    }
    for (size_t i = 0; i < 64; ++i) {
        char ch = c->cam_token[i];
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
    }
    return true;
}
