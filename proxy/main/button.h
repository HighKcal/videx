#ifndef PROXY_BUTTON_H
#define PROXY_BUTTON_H
#include <stdbool.h>
#include <stdint.h>
#define FRAME_FLAG_BUTTON_PRESSED 1U
#define FRAME_FLAG_BUTTON_VALID 2U
#define FRAME_FLAG_BUTTON_CLASSIFIED 4U
#define BUTTON_DEBOUNCE_US UINT64_C(40000)
#define BUTTON_LONG_US UINT64_C(1000000)
#define BUTTON_MAX_GAP_US UINT64_C(250000)
enum { BUTTON_RESULT_NONE, BUTTON_RESULT_SHORT, BUTTON_RESULT_LONG };
typedef struct {
    bool initialized,known,pressed,candidate,armed,long_reported;
    uint64_t candidate_at,down_at,last_at;
    uint8_t last_result;
} button_state_t;
static inline void button_reset(button_state_t *s) { *s=(button_state_t){0}; }
/* Missing samples cancel the gesture; never turn a reconnect-held button into
 * an action. Time comes from S3, not unsynchronized camera timestamps. */
static inline uint8_t button_update(button_state_t *s,bool valid,bool raw,uint64_t now)
{
    if(!valid) { button_reset(s); return 0; }
    if(s->initialized && (now<s->last_at || now-s->last_at>BUTTON_MAX_GAP_US)) button_reset(s);
    if(!s->initialized) {
        s->initialized=true; s->candidate=raw; s->candidate_at=now; s->last_at=now;
        return 0;
    }
    s->last_at=now;
    if(raw!=s->candidate) { s->candidate=raw; s->candidate_at=now; }
    uint8_t event=0;
    if(now-s->candidate_at>=BUTTON_DEBOUNCE_US) {
        if(!s->known) {
            s->known=true; s->pressed=raw; s->armed=!raw;
        } else if(s->pressed!=raw) {
            s->pressed=raw;
            if(raw) { s->down_at=s->candidate_at; s->long_reported=false; }
            else {
                if(s->armed && !s->long_reported) event=BUTTON_RESULT_SHORT;
                s->armed=true;
            }
        }
    }
    if(s->known && s->pressed && raw && s->armed && !s->long_reported &&
       now-s->down_at>=BUTTON_LONG_US) { s->long_reported=true; event=BUTTON_RESULT_LONG; }
    if(event) s->last_result=event;
    return event;
}
static inline uint8_t button_update_session(button_state_t *s,uint32_t *session,
    uint32_t generation,bool valid,bool raw,uint64_t now)
{
    if(*session!=generation) {button_reset(s);*session=generation;}
    return button_update(s,valid,raw,now);
}
static inline uint8_t button_output_flags(const button_state_t *s)
{
    return FRAME_FLAG_BUTTON_CLASSIFIED | (s->known?FRAME_FLAG_BUTTON_VALID:0) |
        (s->pressed?FRAME_FLAG_BUTTON_PRESSED:0);
}
#endif