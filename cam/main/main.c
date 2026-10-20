#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_camera.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_psram.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"
#include "cam_core.h"
#include "cam_io.h"

#define SERVER_IP "192.168.4.1"
#define SERVER_PORT 5000
#define BUTTON_PORT 5001
#define FRAME_FLAG_BUTTON_PRESSED (1U << 0)
#define FRAME_FLAG_BUTTON_VALID (1U << 1)
/* Switch GPIO13 to GND, internal pull-up. Do not use microSD with this wiring. */
#define BUTTON_GPIO GPIO_NUM_13
#define MAX_JPEG_SIZE (1024U * 1024U)
#define MAX_FRAME_DIMENSION 4096U
#define WIFI_READY BIT0
#define WIFI_RETRY BIT1
#define RETRY_MS 1000
#define CONNECT_TIMEOUT_US INT64_C(5000000)
#define FRAME_SEND_TIMEOUT_US INT64_C(5000000)
#define FPS_INTERVAL_US INT64_C(5000000)

#if !CONFIG_IDF_TARGET_ESP32
#error "This sender requires the classic ESP32 AI-Thinker ESP32-CAM"
#endif
#if CONFIG_FREERTOS_UNICORE
#error "Enable both cores: capture uses Core 1, TCP sender uses Core 0"
#endif

typedef struct {
    camera_fb_t *fb;
    uint32_t frame_id;
    uint64_t timestamp_us;
    uint8_t flags;
} frame_item_t;

typedef struct {
    int64_t start_us;
    uint32_t count;
} fps_counter_t;

static const char *TAG = "cam";
static QueueHandle_t frame_queue;
static QueueHandle_t resolution_queue;
static SemaphoreHandle_t camera_reconfigure_lock;
static EventGroupHandle_t wifi_events;
static cam_credentials_t credentials;
static cam_button_stream_t button_stream;
static portMUX_TYPE button_mux = portMUX_INITIALIZER_UNLOCKED;
static const framesize_t resolution_modes[] = {
    FRAMESIZE_QVGA, FRAMESIZE_VGA, FRAMESIZE_SXGA,
};

static bool load_nvs_string(nvs_handle_t handle, const char *key, char *out, size_t capacity)
{
    size_t length = capacity;
    if (nvs_get_str(handle, key, out, &length) != ESP_OK || length < 1 ||
        length > capacity || out[length - 1] != '\0') return false;
    /* Reject embedded NULs, not just the visible prefix. */
    return strlen(out) + 1 == length;
}

static bool load_credentials(void)
{
    nvs_handle_t handle;
    if (nvs_open("videx", NVS_READONLY, &handle) != ESP_OK) return false;
    bool valid = load_nvs_string(handle, "ap_ssid", credentials.ap_ssid,
                                 sizeof(credentials.ap_ssid)) &&
                 load_nvs_string(handle, "ap_pass", credentials.ap_pass,
                                 sizeof(credentials.ap_pass)) &&
                 load_nvs_string(handle, "cam_token", credentials.cam_token,
                                 sizeof(credentials.cam_token)) &&
                 cam_credentials_valid(&credentials);
    nvs_close(handle);
    if (!valid) memset(&credentials, 0, sizeof(credentials));
    return valid;
}

static bool wifi_ready(void)
{
    return (xEventGroupGetBits(wifi_events) & WIFI_READY) != 0;
}

static void button_disconnect(void)
{
    portENTER_CRITICAL(&button_mux);
    cam_button_stop(&button_stream);
    portEXIT_CRITICAL(&button_mux);
}

static bool button_ready(void)
{
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&button_mux);
    bool ready = button_stream.active &&
                 (!button_stream.has_sample || now - button_stream.last_us <= CAM_BUTTON_MAX_GAP_US);
    portEXIT_CRITICAL(&button_mux);
    return ready && wifi_ready();
}

static void report_fps(fps_counter_t *counter, const char *kind)
{
    ++counter->count;
    int64_t now = esp_timer_get_time();
    int64_t elapsed = now - counter->start_us;
    if (elapsed >= FPS_INTERVAL_US) {
        ESP_LOGI(TAG, "[LEFT] %s fps=%.1f", kind, counter->count * 1000000.0 / elapsed);
        counter->count = 0;
        counter->start_us = now;
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        xEventGroupSetBits(wifi_events, WIFI_RETRY);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events, WIFI_READY);
        button_disconnect();
        const wifi_event_sta_disconnected_t *event = data;
        ESP_LOGW(TAG, "Wi-Fi disconnected, reason=%u", (unsigned)event->reason);
        xEventGroupSetBits(wifi_events, WIFI_RETRY);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        xEventGroupClearBits(wifi_events, WIFI_RETRY);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(wifi_events, WIFI_READY);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
        xEventGroupClearBits(wifi_events, WIFI_READY);
        button_disconnect();
    }
}

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    if (esp_netif_create_default_wifi_sta() == NULL) abort();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                             wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID,
                                             wifi_event_handler, NULL));
    wifi_config_t config = {
        .sta = {
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
            .pmf_cfg = {.capable = true, .required = false},
        },
    };
    memcpy(config.sta.ssid, credentials.ap_ssid, strlen(credentials.ap_ssid));
    memcpy(config.sta.password, credentials.ap_pass, strlen(credentials.ap_pass));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
}

static void wifi_retry_task(void *arg)
{
    (void)arg;
    for (;;) {
        EventBits_t bits = xEventGroupWaitBits(wifi_events, WIFI_RETRY,
                                              pdTRUE, pdFALSE, pdMS_TO_TICKS(RETRY_MS));
        if ((bits & WIFI_RETRY) && !wifi_ready()) {
            if (esp_wifi_connect() != ESP_OK) xEventGroupSetBits(wifi_events, WIFI_RETRY);
        }
        vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
    }
}

static void button_init(void)
{
    const gpio_config_t config = {
        .pin_bit_mask = UINT64_C(1) << BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&config));
}

static uint8_t button_flags(void)
{
    /* Legacy metadata is raw only. S3 MUST use independent BTN2 for gestures. */
    return FRAME_FLAG_BUTTON_VALID |
           (gpio_get_level(BUTTON_GPIO) == 0 ? FRAME_FLAG_BUTTON_PRESSED : 0);
}

static void button_sample_task(void *arg)
{
    (void)arg;
    uint32_t sequence = 0;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        int64_t now = esp_timer_get_time();
        bool pressed = gpio_get_level(BUTTON_GPIO) == 0;
        portENTER_CRITICAL(&button_mux);
        cam_button_push(&button_stream, sequence++, pressed, now);
        portEXIT_CRITICAL(&button_mux);
        /* No capture, socket, allocation, or blocking queue in this task. */
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(20));
    }
}

static int connect_server(uint16_t port)
{
    if (!wifi_ready()) return -1;
    int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock < 0) return -1;
    const int enabled = 1;
    int nonblocking = 1;
    if (setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled)) < 0 ||
        ioctl(sock, FIONBIO, &nonblocking) < 0) goto failed;
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(port)};
    if (inet_pton(AF_INET, SERVER_IP, &address.sin_addr) != 1) goto failed;
    int result = connect(sock, (struct sockaddr *)&address, sizeof(address));
    if (result < 0) {
        if (errno != EINPROGRESS) goto failed;
        int64_t deadline = esp_timer_get_time() + CONNECT_TIMEOUT_US;
        for (;;) {
            int64_t remaining = deadline - esp_timer_get_time();
            if (!wifi_ready() || remaining <= 0) goto failed;
            if (remaining > 50000) remaining = 50000;
            fd_set writable;
            FD_ZERO(&writable);
            FD_SET(sock, &writable);
            struct timeval timeout = {.tv_sec = 0, .tv_usec = (long)remaining};
            result = select(sock + 1, NULL, &writable, NULL, &timeout);
            if (result > 0) {
                int error = 0;
                socklen_t size = sizeof(error);
                if (getsockopt(sock, SOL_SOCKET, SO_ERROR, &error, &size) < 0 || error != 0)
                    goto failed;
                break;
            }
            if (result < 0 && errno != EINTR) goto failed;
        }
    }
    return sock; /* Retain nonblocking mode for absolute send deadlines. */
failed:
    close(sock);
    return -1;
}

static void button_sender_task(void *arg)
{
    (void)arg;
    for (;;) {
        button_disconnect();
        if (!(xEventGroupWaitBits(wifi_events, WIFI_READY, pdFALSE, pdTRUE,
                                  pdMS_TO_TICKS(RETRY_MS)) & WIFI_READY)) continue;
        int sock = connect_server(BUTTON_PORT);
        if (sock < 0) {
            vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
            continue;
        }
        /* EXACTLY 64 ASCII bytes: no NUL, newline, length, JSON or CAM2 preface. */
        if (!cam_send_until(sock, credentials.cam_token, 64,
                             esp_timer_get_time() + CAM_BUTTON_MAX_AGE_US,
                             esp_timer_get_time, wifi_ready)) {
            close(sock);
            vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
            continue;
        }
        portENTER_CRITICAL(&button_mux);
        cam_button_start(&button_stream);
        portEXIT_CRITICAL(&button_mux);
        int64_t last_delivery = esp_timer_get_time();
        while (button_ready()) {
            /* BTN2 is one way. A close or unexpected server data ends the session. */
            uint8_t unexpected;
            int count = recv(sock, &unexpected, 1, MSG_DONTWAIT | MSG_PEEK);
            if (count >= 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) break;
            cam_button_sample_t sample;
            portENTER_CRITICAL(&button_mux);
            bool have_sample = cam_button_pop(&button_stream, &sample, esp_timer_get_time());
            portEXIT_CRITICAL(&button_mux);
            if (!have_sample) {
                if (esp_timer_get_time() - last_delivery > CAM_BUTTON_MAX_AGE_US) break;
                vTaskDelay(1);
                continue;
            }
            uint8_t record[12];
            cam_button_encode(record, sample.sequence, sample.pressed);
            /* Timestamp stays local; never deliver a stale/replayed gesture. */
            if (!cam_send_until(sock, record, sizeof(record),
                                 sample.sampled_us + CAM_BUTTON_MAX_AGE_US,
                                 esp_timer_get_time, button_ready)) break;
            last_delivery = esp_timer_get_time();
        }
        button_disconnect();
        close(sock); /* Overflow/stall/partial write cancels the entire gesture. */
        vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
    }
}

static esp_err_t camera_init(uint8_t mode)
{
    if (mode >= sizeof(resolution_modes) / sizeof(resolution_modes[0]))
        return ESP_ERR_INVALID_ARG;
    bool use_psram = false;
#if CONFIG_SPIRAM
    use_psram = esp_psram_is_initialized();
#endif
    if (mode > 0 && !use_psram) return ESP_ERR_NOT_SUPPORTED;
    const camera_config_t config = {
        .pin_pwdn = 32, .pin_reset = -1, .pin_xclk = 0,
        .pin_sccb_sda = 26, .pin_sccb_scl = 27,
        .pin_d7 = 35, .pin_d6 = 34, .pin_d5 = 39, .pin_d4 = 36,
        .pin_d3 = 21, .pin_d2 = 19, .pin_d1 = 18, .pin_d0 = 5,
        .pin_vsync = 25, .pin_href = 23, .pin_pclk = 22,
        .xclk_freq_hz = 20000000,
        .ledc_timer = LEDC_TIMER_0, .ledc_channel = LEDC_CHANNEL_0,
        .pixel_format = PIXFORMAT_JPEG,
        .frame_size = resolution_modes[mode],
        .jpeg_quality = use_psram ? 12 : 20,
        .fb_count = use_psram ? 2 : 1,
        .fb_location = use_psram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM,
        .grab_mode = use_psram ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY,
    };
    return esp_camera_init(&config);
}

/* Only the producer discards queued frames. Each dequeued FB has one owner. */
static void discard_queued_frame(void)
{
    frame_item_t old;
    if (xQueueReceive(frame_queue, &old, 0) == pdTRUE) esp_camera_fb_return(old.fb);
}

static void camera_task(void *arg)
{
    (void)arg;
    uint32_t frame_id = 0;
    uint8_t current_mode = 0;
    bool camera_active = false;
    fps_counter_t fps = {.start_us = esp_timer_get_time()};
    int64_t last_error_us = -FPS_INTERVAL_US;
    for (;;) {
        /* Initial sensor failure must not stop independent buttons or Wi-Fi. */
        if (!camera_active) {
            esp_err_t result = camera_init(current_mode);
            if (result != ESP_OK) {
                ESP_LOGW(TAG, "Camera unavailable (%s); buttons remain active", esp_err_to_name(result));
                vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
                continue;
            }
            camera_active = true;
        }
        uint8_t requested;
        if (xQueueReceive(resolution_queue, &requested, 0) == pdTRUE && requested != current_mode) {
            if (xSemaphoreTake(camera_reconfigure_lock, pdMS_TO_TICKS(6000)) != pdTRUE) {
                xQueueOverwrite(resolution_queue, &requested);
                continue;
            }
            discard_queued_frame();
            esp_err_t result = esp_camera_deinit();
            if (result == ESP_OK) {
                camera_active = false;
                result = camera_init(requested);
                if (result == ESP_OK) {
                    current_mode = requested;
                    camera_active = true;
                    ESP_LOGI(TAG, "Resolution applied: mode=%u", (unsigned)current_mode);
                } else {
                    /* Restore previous mode on next iteration, without aborting buttons. */
                    ESP_LOGW(TAG, "Resolution mode=%u failed: %s", (unsigned)requested,
                             esp_err_to_name(result));
                }
            }
            xSemaphoreGive(camera_reconfigure_lock);
            if (!camera_active) continue;
        }
        discard_queued_frame();
        camera_fb_t *fb = esp_camera_fb_get();
        if (fb == NULL) {
            int64_t now = esp_timer_get_time();
            if (now - last_error_us >= FPS_INTERVAL_US) {
                ESP_LOGW(TAG, "Camera capture failed; buttons remain active");
                last_error_us = now;
            }
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        frame_item_t item = {
            .fb = fb, .frame_id = frame_id++,
            .timestamp_us = (uint64_t)esp_timer_get_time(), .flags = button_flags(),
        };
        report_fps(&fps, "CAPTURE");
        if (fb->format != PIXFORMAT_JPEG || fb->len == 0 || fb->len > MAX_JPEG_SIZE ||
            fb->width == 0 || fb->height == 0 || fb->width > MAX_FRAME_DIMENSION ||
            fb->height > MAX_FRAME_DIMENSION) {
            esp_camera_fb_return(fb);
        } else if (xQueueSend(frame_queue, &item, 0) != pdTRUE) {
            discard_queued_frame();
            if (xQueueSend(frame_queue, &item, 0) != pdTRUE) esp_camera_fb_return(fb);
        }
        vTaskDelay(1);
    }
}

/* Existing server->CAM protocol remains one byte, binary or ASCII 0..2. */
static bool receive_resolution_commands(int sock)
{
    uint8_t commands[32];
    int count = recv(sock, commands, sizeof(commands), MSG_DONTWAIT);
    if (count == 0) return false;
    if (count < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
    for (int i = 0; i < count; ++i) {
        uint8_t mode = commands[i];
        if (mode >= '0' && mode <= '2') mode -= '0';
        if (mode < sizeof(resolution_modes) / sizeof(resolution_modes[0]))
            xQueueOverwrite(resolution_queue, &mode);
    }
    return true;
}

static void tcp_sender_task(void *arg)
{
    (void)arg;
    int sock = -1;
    fps_counter_t fps = {.start_us = esp_timer_get_time()};
    for (;;) {
        if (!wifi_ready()) {
            if (sock >= 0) { close(sock); sock = -1; }
            xEventGroupWaitBits(wifi_events, WIFI_READY, pdFALSE, pdTRUE,
                                pdMS_TO_TICKS(RETRY_MS));
            continue;
        }
        if (sock < 0) {
            sock = connect_server(SERVER_PORT);
            if (sock < 0) { vTaskDelay(pdMS_TO_TICKS(RETRY_MS)); continue; }
        }
        if (!receive_resolution_commands(sock)) { close(sock); sock = -1; continue; }
        if (xSemaphoreTake(camera_reconfigure_lock, pdMS_TO_TICKS(100)) != pdTRUE) continue;
        frame_item_t item;
        if (xQueueReceive(frame_queue, &item, pdMS_TO_TICKS(50)) != pdTRUE) {
            xSemaphoreGive(camera_reconfigure_lock);
            continue;
        }
        const cam_frame_header_t header = {
            .magic = CAM_FRAME_MAGIC, .camera_id = CAMERA_LEFT,
            .flags = item.flags, .reserved = {0, 0}, .frame_id = item.frame_id,
            .jpeg_size = (uint32_t)item.fb->len, .width = (uint16_t)item.fb->width,
            .height = (uint16_t)item.fb->height, .timestamp_us = item.timestamp_us,
        };
        int64_t deadline = esp_timer_get_time() + FRAME_SEND_TIMEOUT_US;
        bool sent = cam_send_until(sock, &header, sizeof(header), deadline,
                                    esp_timer_get_time, wifi_ready) &&
                    cam_send_until(sock, item.fb->buf, item.fb->len, deadline,
                                    esp_timer_get_time, wifi_ready);
        esp_camera_fb_return(item.fb);
        xSemaphoreGive(camera_reconfigure_lock);
        if (sent) report_fps(&fps, "TX");
        else {
            close(sock); /* Never resume a partially transmitted frame. */
            sock = -1;
            vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
        }
    }
}

void app_main(void)
{
    esp_err_t result = nvs_flash_init();
    if (result != ESP_OK || !load_credentials()) {
        /* NO erase/recovery/default credentials. Preserve factory data for offline repair. */
        ESP_LOGE(TAG, "Unprovisioned/invalid NVS (%s); network and capture disabled",
                 esp_err_to_name(result));
        return;
    }
    frame_queue = xQueueCreate(1, sizeof(frame_item_t));
    resolution_queue = xQueueCreate(1, sizeof(uint8_t));
    camera_reconfigure_lock = xSemaphoreCreateMutex();
    wifi_events = xEventGroupCreate();
    if (!frame_queue || !resolution_queue || !camera_reconfigure_lock || !wifi_events) {
        ESP_LOGE(TAG, "Queue/event allocation failed");
        abort();
    }
    button_init();
    wifi_init();
    if (xTaskCreatePinnedToCore(wifi_retry_task, "wifi_retry", 3072, NULL, 5, NULL, 0) != pdPASS ||
        xTaskCreatePinnedToCore(button_sample_task, "button_sample", 3072, NULL, 7, NULL, 1) != pdPASS ||
        xTaskCreatePinnedToCore(button_sender_task, "button_sender", 4096, NULL, 6, NULL, 0) != pdPASS ||
        xTaskCreatePinnedToCore(camera_task, "camera", 4096, NULL, 5, NULL, 1) != pdPASS ||
        xTaskCreatePinnedToCore(tcp_sender_task, "tcp_sender", 6144, NULL, 5, NULL, 0) != pdPASS) {
        ESP_LOGE(TAG, "Task creation failed");
        abort();
    }
}
