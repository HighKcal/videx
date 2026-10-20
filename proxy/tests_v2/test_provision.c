#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "provision.h"
int main(void)
{
    videx_config_t c={0};
    assert(!videx_config_valid(&c));
    strcpy(c.ap_ssid,"VIDEX-unique"); strcpy(c.ap_pass,"unique-long-passphrase");
    memset(c.cam_token,'a',64); memset(c.pair_token,'b',64);
    strcpy(c.origin,"https://videx.example.com"); strcpy(c.host,"device.example.com");
    assert(videx_config_valid(&c));
    strcpy(c.origin,"https://videx.example.com/"); assert(!videx_config_valid(&c));
    strcpy(c.origin,"https://videx.example.com");
    strcpy(c.host,"device.example.com/path"); assert(!videx_config_valid(&c));
    strcpy(c.host,"device.example.com");
    strcpy(c.ap_pass,"12345678"); assert(!videx_config_valid(&c));
    strcpy(c.ap_pass,"unique-long-passphrase");
    c.cam_token[0]='Z'; assert(!videx_config_valid(&c)); c.cam_token[0]='a';
    c.sta_enabled=true; assert(!videx_config_valid(&c));
    strcpy(c.sta_ssid,"router"); strcpy(c.sta_pass,"router-password");
    assert(videx_config_valid(&c));
    assert(videx_private_ipv4(0xc0a80402)); assert(videx_private_ipv4(0x0a000001));
    assert(!videx_private_ipv4(0x08080808)); assert(!videx_private_ipv4(0xac200001));
    puts("PASS: fail-closed provisioning, exact origin/host, local network boundary");
}
