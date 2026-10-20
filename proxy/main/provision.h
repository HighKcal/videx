#ifndef VIDEX_PROVISION_H
#define VIDEX_PROVISION_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
typedef struct {
    char ap_ssid[33],ap_pass[65],cam_token[65],pair_token[65];
    char sta_ssid[33],sta_pass[65],origin[193],host[129];
    bool sta_enabled,usb_diagnostics;
} videx_config_t;
static inline bool videx_hex_token(const char *s)
{
    if(strlen(s)!=64) return false;
    for(unsigned i=0;i<64;i++) if(!((s[i]>='0'&&s[i]<='9') || (s[i]>='a'&&s[i]<='f'))) return false;
    return true;
}
static inline bool videx_host_valid(const char *s)
{
    if(!*s || strlen(s)>128) return false;
    for(;*s;s++) if(!((*s>='a'&&*s<='z') || (*s>='0'&&*s<='9') || *s=='.' || *s=='-')) return false;
    return true;
}
static inline bool videx_origin_valid(const char *s)
{
    if(strncmp(s,"https://",8)) return false;
    s+=8; if(!*s) return false;
    bool port=false;
    for(;*s;s++) {
        if(*s==':' && !port && s[1]) {port=true; continue;}
        if(port) { if(*s<'0'||*s>'9') return false; }
        else if(!((*s>='a'&&*s<='z') || (*s>='0'&&*s<='9') || *s=='.' || *s=='-')) return false;
    }
    return true;
}
static inline bool videx_config_valid(const videx_config_t *c)
{
    return c->ap_ssid[0] && strlen(c->ap_pass)>=16 && strlen(c->ap_pass)<=63 &&
        strcmp(c->ap_pass,"12345678") && videx_hex_token(c->cam_token) &&
        videx_hex_token(c->pair_token) && strcmp(c->cam_token,c->pair_token) &&
        videx_origin_valid(c->origin) && videx_host_valid(c->host) &&
        (!c->sta_enabled || (c->sta_ssid[0] && strlen(c->sta_pass)>=8 && strlen(c->sta_pass)<=63));
}
static inline bool videx_private_ipv4(uint32_t ip)
{
    return (ip>>24)==10 || (ip>>20)==0xac1 || (ip>>16)==0xc0a8;
}
#endif
