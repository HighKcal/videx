#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "gateway_json.h"
static bool parse(const char *text,vdx_command_t *cmd)
{ return vdx_parse_command(text,strlen(text),cmd); }
int main(void)
{
    vdx_command_t cmd;
    assert(parse("{\"type\":\"authenticate\",\"token\":\"secret\"}",&cmd));
    assert(cmd.type==VDX_AUTHENTICATE && !strcmp(cmd.token,"secret"));
    assert(parse("{ \"mode\": 2, \"request_id\": \"abc-123_X\",\"type\":\"resolution\" }",&cmd));
    assert(cmd.type==VDX_RESOLUTION && cmd.mode==2 && !strcmp(cmd.request_id,"abc-123_X"));
    assert(!parse("{\"type\":\"resolution\",\"mode\":3,\"request_id\":\"x\"}",&cmd));
    assert(!parse("{\"type\":\"resolution\",\"mode\":1.5,\"request_id\":\"x\"}",&cmd));
    assert(!parse("{\"type\":\"resolution\",\"mode\":true,\"request_id\":\"x\"}",&cmd));
    assert(!parse("{\"type\":\"resolution\",\"mode\":0,\"request_id\":\"bad quote\\\"\"}",&cmd));
    assert(!parse("{\"type\":\"authenticate\",\"token\":\"a\",\"token\":\"b\"}",&cmd));
    assert(!parse("{\"type\":\"authenticate\",\"token\":\"a\",\"extra\":0}",&cmd));
    assert(!parse("{\"type\":\"authenticate\",\"token\":\"a\\u0000evil\"}",&cmd));
    assert(!parse("{\"type\":\"authenticate\",\"token\":\"a\"}garbage",&cmd));
    assert(!parse("[]",&cmd)); assert(!parse("null",&cmd)); assert(!parse("{}",&cmd));
    assert(!parse("{\"type\":\"unknown\"}",&cmd));
    assert(!vdx_command_allowed(false,VDX_RESOLUTION));
    assert(vdx_command_allowed(false,VDX_AUTHENTICATE));
    assert(!vdx_command_allowed(true,VDX_AUTHENTICATE));
    assert(vdx_command_allowed(true,VDX_RESOLUTION));
    puts("PASS: actual cJSON WSS command parser, duplicate/unknown/size/schema/auth-phase rejection");
}
