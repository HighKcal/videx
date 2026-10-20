/* Single-camera local gateway. All WSS writes run on the HTTPD task; producers
 * only publish into bounded queues under a mutex. No cloud or image storage. */
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "driver/usb_serial_jtag.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_https_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"
#include "button.h"
#include "gateway_core.h"
#include "gateway_json.h"
#include "provision.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "VIDEX receiver target is esp32s3"
#endif
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG || CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG || CONFIG_ESP_CONSOLE_USB_CDC
#error "Binary USB diagnostics require UART-only console"
#endif
static const char *TAG="videx_gateway";
static videx_config_t config;
static uint8_t *certificate,*private_key;
static size_t certificate_len,private_key_len;
static SemaphoreHandle_t lock;
static httpd_handle_t server;
static QueueHandle_t usb_frames;
/* Obtained through the public HTTPS user callback, never by casting private
 * HTTPD transport internals. These entries are HTTPD-task-owned. */
static struct {int fd; esp_tls_t *tls;} tls_sessions[2];
static uint64_t ws_send_deadline;
typedef struct { uint8_t *bytes; size_t size; uint64_t received; } frame_t;
static struct {
    int fd;
    bool authenticated,work_pending,camera_online,button_online;
    uint32_t epoch,sequence,event_id,mode_generation,auth_generation;
    uint8_t desired_mode;
    uint64_t auth_deadline,last_heartbeat,last_camera;
    frame_t latest;
    vdx_controls_t controls;
    vdx_resolution_t resolution;
    const char *fault;
} state={.fd=-1};
#define LOCK() xSemaphoreTake(lock,portMAX_DELAY)
#define UNLOCK() xSemaphoreGive(lock)

static bool nvs_string(nvs_handle_t n,const char *key,char *out,size_t capacity)
{
    size_t nbytes=capacity;
    return nvs_get_str(n,key,out,&nbytes)==ESP_OK && nbytes>1 &&
        nbytes<=capacity && out[nbytes-1]==0 && strlen(out)+1==nbytes;
}
static bool nvs_pem(nvs_handle_t n,const char *key,uint8_t **out,size_t *length,size_t max)
{
    if(nvs_get_blob(n,key,NULL,length)!=ESP_OK || *length<32 || *length>max) return false;
    *out=calloc(1,*length+1);
    if(!*out || nvs_get_blob(n,key,*out,length)!=ESP_OK) return false;
    /* ESP-TLS PEM input includes its trailing NUL. */
    if((*out)[*length-1]!=0) ++*length;
    return true;
}
static bool load_provisioning(void)
{
    if(nvs_flash_init()!=ESP_OK) return false; /* Never erase credentials on error. */
    nvs_handle_t n;
    if(nvs_open("videx",NVS_READONLY,&n)!=ESP_OK) return false;
    bool ok=nvs_string(n,"ap_ssid",config.ap_ssid,sizeof config.ap_ssid) &&
        nvs_string(n,"ap_pass",config.ap_pass,sizeof config.ap_pass) &&
        nvs_string(n,"cam_token",config.cam_token,sizeof config.cam_token) &&
        nvs_string(n,"pair_token",config.pair_token,sizeof config.pair_token) &&
        nvs_string(n,"origin",config.origin,sizeof config.origin) &&
        nvs_string(n,"host",config.host,sizeof config.host);
    uint8_t flag=0;
    nvs_get_u8(n,"sta_enabled",&flag); config.sta_enabled=flag==1;
    flag=0; nvs_get_u8(n,"usb_diag",&flag); config.usb_diagnostics=flag==1;
    if(config.sta_enabled) ok=ok &&
        nvs_string(n,"sta_ssid",config.sta_ssid,sizeof config.sta_ssid) &&
        nvs_string(n,"sta_pass",config.sta_pass,sizeof config.sta_pass);
    ok=ok && videx_config_valid(&config) &&
        nvs_pem(n,"tls_cert",&certificate,&certificate_len,8192) &&
        nvs_pem(n,"tls_key",&private_key,&private_key_len,4096);
    nvs_close(n);
    return ok;
}
static void queue_control(const char *message)
{
    if(state.authenticated && !vdx_control_push(&state.controls,message)) state.fault="control_overflow";
}
static void resolution_result(int result,const char *reason)
{
    char message[VDX_CONTROL_BYTES];
    if(vdx_resolution_json(message,sizeof message,&state.resolution,result,reason)) queue_control(message);
    else state.fault="control_serialize_failed";
}
static void fault_client(const char *reason)
{
    LOCK(); if(state.fd>=0) state.fault=reason; UNLOCK();
}
static void wifi_event(void *arg,esp_event_base_t base,int32_t id,void *data)
{
    (void)arg; (void)data;
    if(base==WIFI_EVENT && id==WIFI_EVENT_STA_START) esp_wifi_connect();
    /* Reconnect from a separate task, not a tight event-handler retry loop. */
}
static void sta_retry(void *arg)
{
    (void)arg;
    for(;;) {
        wifi_ap_record_t ap;
        if(esp_wifi_sta_get_ap_info(&ap)!=ESP_OK) esp_wifi_connect();
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
static void start_wifi(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *ap=esp_netif_create_default_wifi_ap();
    if(!ap) abort();
    ESP_ERROR_CHECK(esp_netif_dhcps_stop(ap));
    esp_netif_ip_info_t ip={0};
    IP4_ADDR(&ip.ip,192,168,4,1); IP4_ADDR(&ip.gw,192,168,4,1); IP4_ADDR(&ip.netmask,255,255,255,0);
    ESP_ERROR_CHECK(esp_netif_set_ip_info(ap,&ip));
    ESP_ERROR_CHECK(esp_netif_dhcps_start(ap));
    if(config.sta_enabled) {
        esp_netif_t *sta=esp_netif_create_default_wifi_sta();
        if(!sta) abort();
        ESP_ERROR_CHECK(esp_netif_set_hostname(sta,config.host));
    }
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(config.sta_enabled?WIFI_MODE_APSTA:WIFI_MODE_AP));
    wifi_config_t ap_config={.ap={.channel=6,.max_connection=2,.authmode=WIFI_AUTH_WPA2_PSK,
        .pmf_cfg={.required=false}}};
    memcpy(ap_config.ap.ssid,config.ap_ssid,strlen(config.ap_ssid));
    ap_config.ap.ssid_len=strlen(config.ap_ssid);
    memcpy(ap_config.ap.password,config.ap_pass,strlen(config.ap_pass));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP,&ap_config));
    if(config.sta_enabled) {
        wifi_config_t sta={.sta={.threshold.authmode=WIFI_AUTH_WPA2_PSK,.pmf_cfg={.capable=true}}};
        memcpy(sta.sta.ssid,config.sta_ssid,strlen(config.sta_ssid));
        memcpy(sta.sta.password,config.sta_pass,strlen(config.sta_pass));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&sta));
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    if(config.sta_enabled && xTaskCreate(sta_retry,"sta_retry",3072,NULL,3,NULL)!=pdPASS) abort();
}
static int listen_local(uint16_t port)
{
    int fd=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP),yes=1;
    if(fd<0) return -1;
    /* CAM TCP is deliberately NOT bound to STA or INADDR_ANY. */
    struct sockaddr_in addr={.sin_family=AF_INET,.sin_port=htons(port)};
    inet_pton(AF_INET,"192.168.4.1",&addr.sin_addr);
    if(setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof yes)<0 ||
       bind(fd,(struct sockaddr*)&addr,sizeof addr)<0 || listen(fd,1)<0) {close(fd);return -1;}
    return fd;
}
static int accept_camera(int listener)
{
    struct sockaddr_in peer; socklen_t length=sizeof peer;
    int fd=accept(listener,(struct sockaddr*)&peer,&length);
    if(fd<0) return -1;
    struct timeval timeout={.tv_sec=0,.tv_usec=200000}; int yes=1;
    if((ntohl(peer.sin_addr.s_addr)>>8)!=0xc0a804 ||
       setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout)<0 ||
       setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout)<0 ||
       setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof yes)<0) {close(fd);return -1;}
    return fd;
}
static bool receive_exact(int fd,void *buf,size_t length,uint64_t deadline)
{
    uint8_t *p=buf;
    while(length && (uint64_t)esp_timer_get_time()<deadline) {
        int n=recv(fd,p,length,0);
        if(n>0) {p+=n;length-=n;}
        else if(n==0 || (errno!=EINTR && errno!=EAGAIN && errno!=EWOULDBLOCK)) return false;
    }
    return !length;
}
static void publish_usb(const uint8_t *bytes,size_t n)
{
    if(!config.usb_diagnostics) return;
    frame_t copy={.bytes=heap_caps_malloc(n,MALLOC_CAP_8BIT),.size=n};
    if(!copy.bytes) return;
    memcpy(copy.bytes,bytes,n);
    if(xQueueSend(usb_frames,&copy,0)!=pdTRUE) {
        frame_t old;
        if(xQueueReceive(usb_frames,&old,0)==pdTRUE) free(old.bytes);
        if(xQueueSend(usb_frames,&copy,0)!=pdTRUE) free(copy.bytes);
    }
}
static void camera_receiver(void *arg)
{
    (void)arg;
    int listener=listen_local(5000);
    if(listener<0) {ESP_LOGE(TAG,"CAM listener failed");vTaskDelete(NULL);return;}
    for(;;) {
        int fd=accept_camera(listener);
        if(fd<0) {vTaskDelay(pdMS_TO_TICKS(100));continue;}
        uint32_t sent_generation=UINT32_MAX;
        for(;;) {
            LOCK(); uint8_t mode=state.desired_mode; uint32_t generation=state.mode_generation; UNLOCK();
            if(generation!=sent_generation) {
                if(send(fd,&mode,1,0)!=1) break;
                sent_generation=generation;
            }
            cam2_header_t h;
            if(!receive_exact(fd,&h,sizeof h,esp_timer_get_time()+3000000) || !vdx_valid_header(&h)) break;
            size_t size=52+h.jpeg_size;
            uint8_t *bytes=heap_caps_malloc(size,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
            if(!bytes) bytes=heap_caps_malloc(size,MALLOC_CAP_8BIT);
            if(!bytes) break;
            if(!receive_exact(fd,bytes+52,h.jpeg_size,esp_timer_get_time()+5000000) ||
               !vdx_valid_jpeg(&h,bytes+52,h.jpeg_size)) {free(bytes);break;}
            uint64_t now=esp_timer_get_time();
            /* USB has an independent copy; mobile retains original CAM2 metadata. */
            memcpy(bytes+24,&h,28);
            publish_usb(bytes+24,28+h.jpeg_size);
            LOCK();
            state.camera_online=true; state.last_camera=now;
            int result=vdx_resolution_observe(&state.resolution,h.width,h.height,now);
            if(result!=VDX_PENDING) resolution_result(result,result==VDX_APPLIED?"observed":"timeout");
            if(state.authenticated && !state.fault) {
                free(state.latest.bytes);
                state.latest=(frame_t){.bytes=bytes,.size=size,.received=now}; bytes=NULL;
            }
            UNLOCK(); free(bytes);
        }
        close(fd);
        LOCK(); state.camera_online=false;
        if(state.resolution.pending) {state.resolution.pending=false;resolution_result(VDX_FAILED,"camera_disconnected");}
        /* A fresh authentication/epoch is required after capture link loss. */
        if(state.fd>=0) state.fault="camera_disconnected";
        free(state.latest.bytes); state.latest=(frame_t){0}; UNLOCK();
    }
}
static void button_receiver(void *arg)
{
    (void)arg;
    int listener=listen_local(5001);
    if(listener<0) {ESP_LOGE(TAG,"Button listener failed");vTaskDelete(NULL);return;}
    for(;;) {
        int fd=accept_camera(listener);
        if(fd<0) {vTaskDelay(pdMS_TO_TICKS(100));continue;}
        char token[65]={0};
        if(!receive_exact(fd,token,64,esp_timer_get_time()+2000000) ||
           !vdx_exact_secret(config.cam_token,token,64)) {close(fd);continue;}
        button_state_t button={0}; vdx_button_sequence_t sequence={0}; uint32_t session=0;
        LOCK(); state.button_online=true; UNLOCK();
        for(;;) {
            uint8_t record[12];
            if(!receive_exact(fd,record,sizeof record,esp_timer_get_time()+250000)) break;
            bool raw;
            if(!vdx_button_record(&sequence,record,&raw)) break;
            LOCK();
            uint8_t event=button_update_session(&button,&session,state.auth_generation,true,raw,esp_timer_get_time());
            if(event) {
                char message[VDX_CONTROL_BYTES];
                if(state.event_id==UINT32_MAX) state.fault="event_counter_exhausted";
                else {
                    snprintf(message,sizeof message,"{\"type\":\"button_%s\",\"event_id\":%"PRIu32",\"epoch\":%"PRIu32"}",
                        event==BUTTON_RESULT_LONG?"long":"short",++state.event_id,state.epoch);
                    queue_control(message);
                }
            }
            UNLOCK();
        }
        close(fd);
        LOCK(); state.button_online=false;
        if(state.fd>=0) state.fault="button_disconnected";
        UNLOCK();
    }
}
static void session_free(void *ptr)
{
    LOCK();
    state.fd=-1; state.authenticated=false; state.fault=NULL;
    state.controls=(vdx_controls_t){0}; state.resolution.pending=false;
    state.desired_mode=0; ++state.mode_generation;
    free(state.latest.bytes); state.latest=(frame_t){0};
    UNLOCK(); free(ptr);
}
static bool peer_is_local(int fd)
{
    struct sockaddr_in addr; socklen_t n=sizeof addr;
    return getpeername(fd,(struct sockaddr*)&addr,&n)==0 && addr.sin_family==AF_INET &&
        videx_private_ipv4(ntohl(addr.sin_addr.s_addr));
}
static int exact_tls_send(httpd_handle_t hd,int fd,const char *p,size_t n,int flags);
static esp_err_t handshake(httpd_req_t *req)
{
    char origin[sizeof config.origin],host[sizeof config.host];
    int fd=httpd_req_to_sockfd(req);
    if(strcmp(req->uri,"/ws") || !peer_is_local(fd) ||
       httpd_req_get_hdr_value_str(req,"Origin",origin,sizeof origin)!=ESP_OK || strcmp(origin,config.origin) ||
       httpd_req_get_hdr_value_str(req,"Host",host,sizeof host)!=ESP_OK || strcmp(host,config.host)) return ESP_FAIL;
    LOCK(); bool busy=state.fd>=0; UNLOCK();
    return busy?ESP_FAIL:httpd_sess_set_send_override(req->handle,fd,exact_tls_send);
}
static esp_err_t ws_handler(httpd_req_t *req)
{
    int fd=httpd_req_to_sockfd(req);
    if(req->method==HTTP_GET) {
        void *ctx=calloc(1,1); if(!ctx) return ESP_ERR_NO_MEM;
        LOCK();
        if(state.fd>=0) {UNLOCK();free(ctx);return ESP_FAIL;}
        state.fd=fd; state.authenticated=false; state.auth_deadline=esp_timer_get_time()+5000000;
        state.fault=NULL;
        UNLOCK(); req->sess_ctx=ctx; req->free_ctx=session_free;
        return ESP_OK;
    }
    httpd_ws_frame_t frame={0};
    if(httpd_ws_recv_frame(req,&frame,0)!=ESP_OK) return ESP_FAIL;
    /* IDF recv populates `final`; `fragmented` is a send-only field. */
    if(!vdx_command_frame_allowed(frame.type==HTTPD_WS_TYPE_TEXT,frame.final,frame.len)) return ESP_FAIL;
    char payload[385]={0}; frame.payload=(uint8_t*)payload;
    if(httpd_ws_recv_frame(req,&frame,384)!=ESP_OK || memchr(payload,0,frame.len)) return ESP_FAIL;
    vdx_command_t command;
    if(!vdx_parse_command(payload,frame.len,&command)) return ESP_FAIL;
    bool ok=true;
    LOCK();
    if(state.fd!=fd || state.fault || !vdx_command_allowed(state.authenticated,command.type)) ok=false;
    if(ok && !state.authenticated) {
        ok=vdx_exact_secret(config.pair_token,command.token,64) &&
            (uint64_t)esp_timer_get_time()<state.auth_deadline;
        if(ok) {
            state.authenticated=true; state.epoch=esp_random(); if(!state.epoch) state.epoch=1;
            ++state.auth_generation;
            state.sequence=state.event_id=0; state.controls=(vdx_controls_t){0};
            state.last_heartbeat=esp_timer_get_time();
            char msg[128]; snprintf(msg,sizeof msg,"{\"type\":\"connected\",\"epoch\":%"PRIu32"}",state.epoch);
            queue_control(msg);
        }
    } else if(ok) {
        if(state.resolution.pending) {
            char msg[VDX_CONTROL_BYTES];
            snprintf(msg,sizeof msg,"{\"type\":\"resolution_failed\",\"request_id\":\"%s\",\"mode\":%u,\"reason\":\"busy\"}",command.request_id,command.mode);
            queue_control(msg);
        } else if(vdx_resolution_begin(&state.resolution,command.request_id,command.mode,esp_timer_get_time())) {
            state.desired_mode=command.mode; ++state.mode_generation;
            if(!state.camera_online) {state.resolution.pending=false;resolution_result(VDX_FAILED,"camera_unavailable");}
        }
    }
    UNLOCK();
    return ok?ESP_OK:ESP_FAIL;
}
/* Called ONLY by the HTTPD task; HTTPD owns socket/session lifetime. No sends
 * from RX tasks, timers or a second writer can interleave WebSocket messages. */
static uint64_t send_clock(void *ctx) {(void)ctx;return esp_timer_get_time();}
static int tls_write_chunk(void *ctx,const uint8_t *p,size_t n)
{
    return (int)esp_tls_conn_write((esp_tls_t*)ctx,p,n);
}
/* IDF's WS sender treats any positive partial transport return as success.
 * Override it with exact writes and one absolute deadline for the whole
 * message (header AND payload); close on a partial/timeout, never resume. */
static int exact_tls_send(httpd_handle_t hd,int fd,const char *p,size_t n,int flags)
{
    (void)hd; (void)flags;
    esp_tls_t *tls=NULL;
    for(unsigned i=0;i<2;i++) if(tls_sessions[i].tls && tls_sessions[i].fd==fd) tls=tls_sessions[i].tls;
    uint64_t deadline=ws_send_deadline?ws_send_deadline:(uint64_t)esp_timer_get_time()+2000000;
    return tls && vdx_send_bounded(tls,tls_write_chunk,send_clock,(const uint8_t*)p,n,deadline)?(int)n:-1;
}
static void tls_session_callback(esp_https_server_user_cb_arg_t *arg)
{
    if(arg->user_cb_state==HTTPD_SSL_USER_CB_SESS_CREATE) {
        int fd=-1;
        if(esp_tls_get_conn_sockfd(arg->tls,&fd)!=ESP_OK) return;
        for(unsigned i=0;i<2;i++) if(!tls_sessions[i].tls) {
            tls_sessions[i].tls=arg->tls; tls_sessions[i].fd=fd;
            struct timeval timeout={.tv_usec=200000};
            setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout);
            break;
        }
    } else {
        for(unsigned i=0;i<2;i++) if(tls_sessions[i].tls==arg->tls) tls_sessions[i].tls=NULL;
    }
}
static esp_err_t send_ws(int fd,httpd_ws_type_t type,const void *p,size_t n)
{
    httpd_ws_frame_t frame={.final=true,.type=type,.payload=(uint8_t*)p,.len=n};
    ws_send_deadline=esp_timer_get_time()+2000000;
    esp_err_t result=httpd_ws_send_frame_async(server,fd,&frame);
    ws_send_deadline=0;
    return result;
}
static void pump(void *arg)
{
    (void)arg;
    LOCK();
    int fd=state.fd;
    uint64_t now=esp_timer_get_time();
    if(fd<0) {state.work_pending=false;UNLOCK();return;}
    if(!state.authenticated && now>=state.auth_deadline) state.fault="authentication_timeout";
    if(state.authenticated) {
        if(vdx_resolution_observe(&state.resolution,0,0,now)==VDX_FAILED) resolution_result(VDX_FAILED,"timeout");
        if(now-state.last_heartbeat>=2000000) {
            char msg[VDX_CONTROL_BYTES];
            snprintf(msg,sizeof msg,"{\"type\":\"heartbeat\",\"epoch\":%"PRIu32",\"s3_time_us\":%"PRIu64",\"camera_online\":%s,\"button_online\":%s}",
                state.epoch,now,state.camera_online && now-state.last_camera<3000000?"true":"false",state.button_online?"true":"false");
            queue_control(msg); state.last_heartbeat=now;
        }
    }
    const char *fault=state.fault;
    bool authenticated=state.authenticated;
    if(fault) {
        state.authenticated=false;
        free(state.latest.bytes); state.latest=(frame_t){0};
        UNLOCK();
        if(authenticated && strcmp(fault,"send_failed")) {
            char message[128]; snprintf(message,sizeof message,"{\"type\":\"disconnected\",\"reason\":\"%s\"}",fault);
            send_ws(fd,HTTPD_WS_TYPE_TEXT,message,strlen(message));
        }
        httpd_sess_trigger_close(server,fd);
        LOCK(); state.work_pending=false; UNLOCK(); return;
    }
    UNLOCK();
    if(authenticated) {
        for(unsigned i=0;i<VDX_CONTROL_CAPACITY;i++) {
            char message[VDX_CONTROL_BYTES];
            LOCK(); bool have=vdx_control_pop(&state.controls,message); bool failed=state.controls.failed; UNLOCK();
            if(failed) {fault_client("control_overflow");break;}
            if(!have) break;
            if(send_ws(fd,HTTPD_WS_TYPE_TEXT,message,strlen(message))!=ESP_OK) {fault_client("send_failed");break;}
        }
        LOCK();
        frame_t frame={0};
        if(!state.fault && !state.controls.count && state.latest.bytes) {
            frame=state.latest; state.latest=(frame_t){0};
            if(state.sequence==UINT32_MAX) {state.fault="sequence_exhausted";free(frame.bytes);frame=(frame_t){0};}
            else {
                cam2_header_t h; memcpy(&h,frame.bytes+24,28);
                vdx_write_header(frame.bytes,&h,state.epoch,++state.sequence,frame.received);
            }
        }
        UNLOCK();
        if(frame.bytes) {
            if(send_ws(fd,HTTPD_WS_TYPE_BINARY,frame.bytes,frame.size)!=ESP_OK) fault_client("send_failed");
            free(frame.bytes);
        }
    }
    LOCK(); state.work_pending=false; UNLOCK();
}
static void gateway_tick(void *arg)
{
    (void)arg;
    for(;;) {
        LOCK(); bool schedule=!state.work_pending;
        if(schedule) state.work_pending=true;
        UNLOCK();
        if(schedule && httpd_queue_work(server,pump,NULL)!=ESP_OK) {
            LOCK(); state.work_pending=false;
            if(state.fd>=0) state.fault="work_queue_overload";
            UNLOCK();
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
static void usb_sender(void *arg)
{
    (void)arg;
    for(;;) {
        frame_t frame; xQueueReceive(usb_frames,&frame,portMAX_DELAY);
        size_t offset=0; uint64_t deadline=esp_timer_get_time()+500000;
        while(offset<frame.size && usb_serial_jtag_is_connected() && (uint64_t)esp_timer_get_time()<deadline) {
            size_t n=frame.size-offset; if(n>4096) n=4096;
            int sent=usb_serial_jtag_write_bytes(frame.bytes+offset,n,pdMS_TO_TICKS(20));
            if(sent<0) break;
            offset+=sent; if(!sent) vTaskDelay(1);
        }
        free(frame.bytes);
    }
}
void videx_gateway_start(void)
{
    if(!load_provisioning()) {
        ESP_LOGE(TAG,"UNPROVISIONED/INVALID: radio and WSS disabled; provision NVS offline; no credential erase");
        free(certificate); free(private_key); return;
    }
    lock=xSemaphoreCreateMutex(); if(!lock) abort();
    if(config.usb_diagnostics) {
        usb_frames=xQueueCreate(1,sizeof(frame_t)); if(!usb_frames) abort();
        usb_serial_jtag_driver_config_t usb={.tx_buffer_size=8192,.rx_buffer_size=256};
        ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
        if(xTaskCreate(usb_sender,"usb_diagnostic",4096,NULL,3,NULL)!=pdPASS) abort();
    }
    start_wifi();
    httpd_ssl_config_t tls=HTTPD_SSL_CONFIG_DEFAULT();
    tls.servercert=certificate; tls.servercert_len=certificate_len;
    tls.prvtkey_pem=private_key; tls.prvtkey_len=private_key_len;
    tls.transport_mode=HTTPD_SSL_TRANSPORT_SECURE; tls.port_secure=443;
    tls.httpd.max_open_sockets=2; tls.httpd.lru_purge_enable=false;
    tls.httpd.recv_wait_timeout=1; tls.httpd.send_wait_timeout=1;
    tls.tls_handshake_timeout_ms=3000;
    tls.user_cb=tls_session_callback;
    ESP_ERROR_CHECK(httpd_ssl_start(&server,&tls));
    const httpd_uri_t ws={.uri="/ws",.method=HTTP_GET,.handler=ws_handler,
        .is_websocket=true,.ws_pre_handshake_cb=handshake};
    ESP_ERROR_CHECK(httpd_register_uri_handler(server,&ws));
    if(xTaskCreate(camera_receiver,"cam_rx",6144,NULL,5,NULL)!=pdPASS ||
       xTaskCreate(button_receiver,"button_rx",4096,NULL,5,NULL)!=pdPASS ||
       xTaskCreate(gateway_tick,"gateway_tick",3072,NULL,4,NULL)!=pdPASS) abort();
    ESP_LOGI(TAG,"Local authenticated WSS ready; one camera; USB diagnostics %s; AP+STA %s",
        config.usb_diagnostics?"on":"off",config.sta_enabled?"on":"off");
}
