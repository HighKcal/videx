#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "gateway_core.h"
typedef struct {size_t bytes; uint64_t now; int limit;} writer_t;
static int write_partial(void *ctx,const uint8_t *p,size_t n)
{
    writer_t *w=ctx; (void)p;
    if(w->limit<=0) return w->limit;
    if(n>(size_t)w->limit) n=w->limit;
    w->bytes+=n; w->now+=100;
    return (int)n;
}
static uint64_t clock_now(void *ctx) {return ((writer_t*)ctx)->now;}

int main(void)
{
    cam2_header_t h = {.magic=CAM2_MAGIC,.camera_id=0,.flags=2,
        .jpeg_size=17,.width=320,.height=240,.frame_id=9,.timestamp_us=123};
    const uint8_t jpeg[] = {0xff,0xd8,0xff,0xc0,0,11,8,0,240,1,64,1,1,0x11,0,0xff,0xd9};
    assert(vdx_valid_header(&h));
    h.camera_id=1; assert(!vdx_valid_header(&h)); h.camera_id=0;
    h.flags=8; assert(!vdx_valid_header(&h)); h.flags=2;
    h.reserved[0]=1; assert(!vdx_valid_header(&h)); h.reserved[0]=0;
    assert(vdx_valid_jpeg(&h,jpeg,sizeof jpeg));
    h.width=640; assert(!vdx_valid_jpeg(&h,jpeg,sizeof jpeg)); h.width=320;
    for(size_t n=0;n<sizeof jpeg;n++) assert(!vdx_valid_jpeg(&h,jpeg,n));
    uint8_t wire[52]; vdx_write_header(wire,&h,7,8,0x0102030405060708ULL);
    assert(!memcmp(wire,"VDX2\1\0\64\0",8));
    assert(wire[8]==7 && wire[12]==8 && wire[16]==8 && wire[23]==1);
    assert(!memcmp(wire+24,&h,28));
    assert(vdx_exact_secret("abc","abc",3));
    assert(!vdx_exact_secret("abc","ab",3));
    assert(!vdx_exact_secret("abc","abcd",3));
    assert(vdx_request_id("a-B_42")); assert(!vdx_request_id("quote\""));
    assert(!vdx_request_id(""));
    assert(vdx_command_frame_allowed(true,true,100));
    assert(!vdx_command_frame_allowed(true,false,100));
    assert(!vdx_command_frame_allowed(false,true,100));
    assert(!vdx_command_frame_allowed(true,true,385));
    assert(!vdx_command_frame_allowed(true,true,0));
    vdx_resolution_t r={0};
    assert(vdx_resolution_begin(&r,"req-1",1,100));
    assert(!vdx_resolution_begin(&r,"req-2",0,100));
    assert(vdx_resolution_observe(&r,320,240,101)==VDX_PENDING);
    assert(vdx_resolution_observe(&r,640,480,102)==VDX_APPLIED);
    assert(!r.pending);
    char ack[256];
    assert(vdx_resolution_json(ack,sizeof ack,&r,VDX_APPLIED,"observed"));
    assert(strstr(ack,"\"width\":640,\"height\":480"));
    assert(strstr(ack,"\"request_id\":\"req-1\""));
    assert(vdx_resolution_begin(&r,"timeout",2,200));
    assert(vdx_resolution_observe(&r,1280,1024,200+VDX_RESOLUTION_TIMEOUT_US)==VDX_FAILED);
    assert(vdx_resolution_json(ack,sizeof ack,&r,VDX_FAILED,"timeout"));
    assert(strstr(ack,"\"width\":0,\"height\":0"));
    assert(vdx_resolution_begin(&r,"actual",2,300));
    assert(vdx_resolution_observe(&r,1280,1024,301)==VDX_APPLIED);
    assert(!vdx_resolution_begin(&r,"bad",3,0));
    vdx_controls_t q={0};
    for(unsigned i=0;i<VDX_CONTROL_CAPACITY;i++) assert(vdx_control_push(&q,"event"));
    assert(!vdx_control_push(&q,"lost")); assert(q.failed);
    char out[VDX_CONTROL_BYTES];
    assert(!vdx_control_pop(&q,out)); /* overflow fails closed, not partial delivery */
    q=(vdx_controls_t){0};
    assert(vdx_control_push(&q,"one")); assert(vdx_control_push(&q,"two"));
    assert(vdx_control_pop(&q,out) && !strcmp(out,"one"));
    assert(vdx_control_pop(&q,out) && !strcmp(out,"two"));
    assert(!vdx_control_pop(&q,out));
    writer_t writer={.limit=3};
    assert(vdx_send_bounded(&writer,write_partial,clock_now,wire,sizeof wire,2000));
    assert(writer.bytes==sizeof wire);
    writer=(writer_t){.limit=3};
    assert(!vdx_send_bounded(&writer,write_partial,clock_now,wire,sizeof wire,100));
    writer=(writer_t){.limit=0};
    assert(!vdx_send_bounded(&writer,write_partial,clock_now,wire,sizeof wire,100));
    puts("PASS: CAM2/VDX2, JPEG observed dimensions, authentication, resolution, reliable queue");
}
