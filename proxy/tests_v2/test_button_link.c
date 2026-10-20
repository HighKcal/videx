#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "cam_core.h"
#include "gateway_core.h"
#include "button.h"
int main(void)
{
    cam_button_stream_t tx={0}; button_state_t button={0};
    cam_button_start(&tx);
    vdx_button_sequence_t seq={0};
    unsigned shorts=0,longs=0;
    /* Camera frames deliberately absent. Only 20ms independent button samples. */
    for(uint32_t i=0;i<140;i++) {
        bool pressed=(i>=5 && i<20) || (i>=30 && i<100);
        int64_t time=(int64_t)i*20000;
        assert(cam_button_push(&tx,i,pressed,time));
        cam_button_sample_t sample;
        assert(cam_button_pop(&tx,&sample,time+1000));
        uint8_t record[12]; bool raw=false;
        cam_button_encode(record,sample.sequence,sample.pressed);
        assert(vdx_button_record(&seq,record,&raw));
        assert(raw==pressed);
        unsigned event=button_update(&button,true,raw,(uint64_t)(time+1000));
        shorts+=event==BUTTON_RESULT_SHORT; longs+=event==BUTTON_RESULT_LONG;
    }
    assert(shorts==1 && longs==1);
    uint8_t invalid[12]; bool raw=false;
    cam_button_encode(invalid,142,false); /* missed sequence140/141 */
    assert(!vdx_button_record(&seq,invalid,&raw));
    seq=(vdx_button_sequence_t){0}; invalid[9]=1;
    assert(!vdx_button_record(&seq,invalid,&raw));
    cam_button_encode(invalid,0,false); invalid[8]=2;
    assert(!vdx_button_record(&seq,invalid,&raw));
    cam_button_encode(invalid,UINT32_MAX,false);
    assert(vdx_button_record(&seq,invalid,&raw));
    cam_button_encode(invalid,0,false);
    assert(vdx_button_record(&seq,invalid,&raw));
    puts("PASS: actual CAM FIFO/BTN2 -> S3 parser -> elapsed-time events without video");
}
