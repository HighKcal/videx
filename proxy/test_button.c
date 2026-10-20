/* Real monotonic time, independent of camera FPS. */
#include <assert.h>
#include <stdio.h>
#include "main/button.h"
int main(void)
{
    button_state_t s={0};
    assert(button_update(&s,true,true,0)==0);
    assert(button_update(&s,true,true,2000000)==0); /* reconnect held */
    assert(button_update(&s,true,false,2020000)==0);
    assert(button_update(&s,true,false,2060000)==0); /* arm on release */
    assert(button_update(&s,true,true,2100000)==0);
    assert(button_update(&s,true,true,2140000)==0);
    assert(button_update(&s,true,false,2200000)==0);
    assert(button_update(&s,true,false,2240000)==BUTTON_RESULT_SHORT);
    assert(button_update(&s,true,false,2300000)==0);
    assert(button_update(&s,true,true,2400000)==0);
    assert(button_update(&s,true,true,2440000)==0);
    for(uint64_t t=2460000;t<3400000;t+=20000) assert(button_update(&s,true,true,t)==0);
    assert(button_update(&s,true,true,3400000)==BUTTON_RESULT_LONG);
    assert(button_update(&s,true,true,3500000)==0);
    assert(button_update(&s,true,false,3520000)==0);
    assert(button_update(&s,true,false,3560000)==0);
    button_reset(&s);
    for(uint64_t t=0;t<1000000;t+=10000) assert(button_update(&s,true,(t/10000)%2,t)==0);
    button_reset(&s);
    assert(button_update(&s,true,false,0)==0);
    assert(button_update(&s,true,false,40000)==0);
    assert(button_update(&s,true,true,50000)==0);
    assert(button_update(&s,true,true,90000)==0);
    assert(button_update(&s,true,true,2000000)==0); /* sampling gap cancels */
    assert(button_update(&s,true,false,2010000)==0);
    assert(button_update(&s,true,false,2050000)==0);
    assert(button_update(&s,false,false,2060000)==0);
    assert(!s.known);
    button_reset(&s);
    uint32_t session=1;
    assert(button_update_session(&s,&session,1,true,false,0)==0);
    assert(button_update_session(&s,&session,1,true,false,40000)==0);
    assert(button_update_session(&s,&session,1,true,true,60000)==0);
    assert(button_update_session(&s,&session,1,true,true,100000)==0);
    /* Browser reauthentication while held cannot carry an old gesture. */
    assert(button_update_session(&s,&session,2,true,true,120000)==0);
    for(uint64_t t=140000;t<1400000;t+=20000) assert(button_update_session(&s,&session,2,true,true,t)==0);
    assert(button_update_session(&s,&session,2,true,false,1400000)==0);
    assert(button_update_session(&s,&session,2,true,false,1440000)==0);
    puts("PASS: elapsed-time button debounce, short/long, bounce, reconnect, stale input");
}
