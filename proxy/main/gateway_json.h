#ifndef VIDEX_GATEWAY_JSON_H
#define VIDEX_GATEWAY_JSON_H
#include "gateway_core.h"
#include "cJSON.h"
enum {VDX_AUTHENTICATE,VDX_RESOLUTION};
typedef struct {int type; char token[65],request_id[65]; uint8_t mode;} vdx_command_t;
static inline bool vdx_command_allowed(bool authenticated,int type)
{
    return authenticated?type==VDX_RESOLUTION:type==VDX_AUTHENTICATE;
}
static inline bool vdx_parse_command(const char *text,size_t length,vdx_command_t *out)
{
    if(!text || !out || !length || length>384 || memchr(text,0,length)) return false;
    /* Protocol fields are ASCII tokens/IDs: reject escapes, including cJSON's
     * embedded-NUL truncation ambiguity, rather than normalizing identifiers. */
    if(memchr(text,'\\',length)) return false;
    char payload[385]; memcpy(payload,text,length); payload[length]=0;
    cJSON *root=cJSON_ParseWithLengthOpts(payload,length+1,NULL,true);
    if(!root) return false;
    bool ok=cJSON_IsObject(root);
    for(const cJSON *a=root->child;ok && a;a=a->next)
        for(const cJSON *b=a->next;b;b=b->next)
            if(!a->string || !b->string || !strcmp(a->string,b->string)) ok=false;
    const cJSON *type=cJSON_GetObjectItemCaseSensitive(root,"type");
    ok=ok && cJSON_IsString(type);
    *out=(vdx_command_t){0};
    if(ok && !strcmp(type->valuestring,"authenticate")) {
        const cJSON *token=cJSON_GetObjectItemCaseSensitive(root,"token");
        ok=cJSON_GetArraySize(root)==2 && cJSON_IsString(token) && strlen(token->valuestring)<=64;
        if(ok) {out->type=VDX_AUTHENTICATE;strcpy(out->token,token->valuestring);}
    } else if(ok && !strcmp(type->valuestring,"resolution")) {
        const cJSON *id=cJSON_GetObjectItemCaseSensitive(root,"request_id");
        const cJSON *mode=cJSON_GetObjectItemCaseSensitive(root,"mode");
        ok=cJSON_GetArraySize(root)==3 && cJSON_IsString(id) && vdx_request_id(id->valuestring) &&
            cJSON_IsNumber(mode) && mode->valuedouble>=0 && mode->valuedouble<=2 && mode->valuedouble==mode->valueint;
        if(ok) {out->type=VDX_RESOLUTION;strcpy(out->request_id,id->valuestring);out->mode=mode->valueint;}
    } else ok=false;
    cJSON_Delete(root); return ok;
}
#endif
