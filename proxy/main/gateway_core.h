#ifndef VIDEX_GATEWAY_CORE_H
#define VIDEX_GATEWAY_CORE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CAM2_MAGIC UINT32_C(0x324d4143)
#define VDX_MAX_JPEG (1024U * 1024U)
#define VDX_CONTROL_CAPACITY 16U
#define VDX_CONTROL_BYTES 256U
#define VDX_RESOLUTION_TIMEOUT_US UINT64_C(5000000)
typedef int (*vdx_writer_t)(void *,const uint8_t *,size_t);
typedef uint64_t (*vdx_clock_t)(void *);
static inline bool vdx_command_frame_allowed(bool text,bool final,size_t size)
{
    return text && final && size>0 && size<=384;
}
static inline bool vdx_send_bounded(void *ctx,vdx_writer_t write_fn,vdx_clock_t clock_fn,
                                    const uint8_t *p,size_t size,uint64_t deadline)
{
    while(size) {
        if(clock_fn(ctx)>=deadline) return false;
        size_t chunk=size>4096?4096:size;
        int n=write_fn(ctx,p,chunk);
        if(n<=0 || (size_t)n>chunk) return false;
        p+=n; size-=(size_t)n;
    }
    return clock_fn(ctx)<deadline;
}
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t camera_id, flags, reserved[2];
    uint32_t frame_id, jpeg_size;
    uint16_t width, height;
    uint64_t timestamp_us;
} cam2_header_t;
_Static_assert(sizeof(cam2_header_t)==28,"CAM2 unchanged");
typedef struct {uint32_t last;bool known;} vdx_button_sequence_t;
static inline bool vdx_button_record(vdx_button_sequence_t *s,const uint8_t p[12],bool *raw)
{
    uint32_t seq=(uint32_t)p[4]|((uint32_t)p[5]<<8)|((uint32_t)p[6]<<16)|((uint32_t)p[7]<<24);
    if(memcmp(p,"BTN2",4) || p[8]>1 || p[9] || p[10] || p[11] ||
       (s->known && seq!=(uint32_t)(s->last+1))) return false;
    s->known=true;s->last=seq;*raw=p[8]!=0;return true;
}

static inline bool vdx_valid_header(const cam2_header_t *h)
{
    return h && h->magic==CAM2_MAGIC && h->camera_id==0 &&
        (h->flags==0 || h->flags==2 || h->flags==3) &&
        !h->reserved[0] && !h->reserved[1] &&
        h->jpeg_size>=4 && h->jpeg_size<=VDX_MAX_JPEG &&
        h->width>0 && h->width<=4096 && h->height>0 && h->height<=4096;
}
/* Validate marker boundaries and SOF dimensions, rather than trusting CAM metadata.
 * This is not a JPEG decoder: browser decoding remains a second validation layer. */
static inline bool vdx_valid_jpeg(const cam2_header_t *h,const uint8_t *p,size_t n)
{
    if(!vdx_valid_header(h) || !p || n!=h->jpeg_size || n<4 ||
       p[0]!=255 || p[1]!=216 || p[n-2]!=255 || p[n-1]!=217) return false;
    size_t i=2;
    while(i+1<n-2) {
        if(p[i++]!=255) return false;
        while(i<n-2 && p[i]==255) i++;
        if(i>=n-2) return false;
        unsigned marker=p[i++];
        if(marker==0 || marker==0xda || marker==0xd9 || marker==0xd8) return false;
        if(marker==1 || (marker>=0xd0 && marker<=0xd7)) continue;
        if(i+2>n-2) return false;
        size_t len=((size_t)p[i]<<8)|p[i+1];
        if(len<2 || len>n-2-i) return false;
        if((marker>=0xc0 && marker<=0xc3) || (marker>=0xc5 && marker<=0xc7) ||
           (marker>=0xc9 && marker<=0xcb) || (marker>=0xcd && marker<=0xcf)) {
            if(len<8 || p[i+2]!=8) return false;
            unsigned height=((unsigned)p[i+3]<<8)|p[i+4];
            unsigned width=((unsigned)p[i+5]<<8)|p[i+6];
            return width==h->width && height==h->height;
        }
        i+=len;
    }
    return false;
}
static inline void vdx_put_le(uint8_t *p,uint64_t v,unsigned n)
{ for(unsigned i=0;i<n;i++) p[i]=(uint8_t)(v>>(8*i)); }
static inline void vdx_write_header(uint8_t out[52],const cam2_header_t *h,
                                    uint32_t epoch,uint32_t seq,uint64_t received)
{
    memcpy(out,"VDX2",4); vdx_put_le(out+4,1,2); vdx_put_le(out+6,52,2);
    vdx_put_le(out+8,epoch,4); vdx_put_le(out+12,seq,4);
    vdx_put_le(out+16,received,8); memcpy(out+24,h,28);
}
static inline bool vdx_exact_secret(const char *expected,const char *actual,size_t n)
{
    if(!expected || !actual || strlen(expected)!=n || strlen(actual)!=n) return false;
    unsigned diff=0;
    for(size_t i=0;i<n;i++) diff|=(unsigned char)expected[i]^(unsigned char)actual[i];
    return diff==0;
}
static inline bool vdx_request_id(const char *s)
{
    if(!s || !*s || strlen(s)>64) return false;
    for(;*s;s++) if(!((*s>='a'&&*s<='z') || (*s>='A'&&*s<='Z') ||
        (*s>='0'&&*s<='9') || *s=='-' || *s=='_')) return false;
    return true;
}
typedef struct {
    bool pending; char id[65]; uint8_t mode; uint64_t deadline;
    unsigned observed_width,observed_height;
} vdx_resolution_t;
enum { VDX_PENDING, VDX_APPLIED, VDX_FAILED };
static inline bool vdx_resolution_begin(vdx_resolution_t *r,const char *id,uint8_t mode,uint64_t now)
{
    if(r->pending || mode>2 || !vdx_request_id(id)) return false;
    r->pending=true; strcpy(r->id,id); r->mode=mode;
    r->observed_width=r->observed_height=0;
    r->deadline=now+VDX_RESOLUTION_TIMEOUT_US; return true;
}
static inline int vdx_resolution_observe(vdx_resolution_t *r,unsigned w,unsigned h,uint64_t now)
{
    static const unsigned widths[]={320,640,1280}, heights[]={240,480,1024};
    if(!r->pending) return VDX_PENDING;
    int result=now>=r->deadline ? VDX_FAILED :
        (w==widths[r->mode] && h==heights[r->mode] ? VDX_APPLIED : VDX_PENDING);
    if(result!=VDX_PENDING) {
        r->pending=false;
        if(result==VDX_APPLIED) {r->observed_width=w;r->observed_height=h;}
    }
    return result;
}
/* Same serializer used by firmware and host tests. Width/height are populated
 * only by validated JPEG observations, never derived from requested mode. */
static inline bool vdx_resolution_json(char *out,size_t n,const vdx_resolution_t *r,
                                       int result,const char *reason)
{
    int size=snprintf(out,n,"{\"type\":\"resolution_%s\",\"request_id\":\"%s\",\"mode\":%u,\"width\":%u,\"height\":%u,\"reason\":\"%s\"}",
        result==VDX_APPLIED?"applied":"failed",r->id,r->mode,
        r->observed_width,r->observed_height,reason);
    return size>=0 && (size_t)size<n;
}
typedef struct {
    char items[VDX_CONTROL_CAPACITY][VDX_CONTROL_BYTES];
    unsigned head,count; bool failed;
} vdx_controls_t;
/* Caller serializes; controls are never replaced by frames. */
static inline bool vdx_control_push(vdx_controls_t *q,const char *s)
{
    if(q->failed || q->count==VDX_CONTROL_CAPACITY || strlen(s)>=VDX_CONTROL_BYTES) {
        q->failed=true; return false;
    }
    strcpy(q->items[(q->head+q->count)%VDX_CONTROL_CAPACITY],s); q->count++; return true;
}
static inline bool vdx_control_pop(vdx_controls_t *q,char out[VDX_CONTROL_BYTES])
{
    if(q->failed || !q->count) return false;
    strcpy(out,q->items[q->head]); q->head=(q->head+1)%VDX_CONTROL_CAPACITY; q->count--; return true;
}
#endif
