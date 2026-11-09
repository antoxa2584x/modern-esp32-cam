#include "camera.h"

#include <esp_camera.h>

#include "board.h"
#include "motion.h"
#include "recorder.h"

#define LAMP_CHANNEL 7

namespace cam {
static bool initOk = false;
static const char* sensorName = "";
static int maxSize = FRAMESIZE_UXGA;  // largest frame size the sensor and buffers allow

// Frame sizes as the settings and the pages number them: esp32-camera's
// framesize_t up to Arduino 2. Arduino 3's library inserted 128x128 and
// 320x320, which moved every size from QCIF up (HD came out as 800x600).
static const framesize_t SIZES[] = {
    FRAMESIZE_96X96, FRAMESIZE_QQVGA, FRAMESIZE_QCIF, FRAMESIZE_HQVGA, FRAMESIZE_240X240, FRAMESIZE_QVGA,
    FRAMESIZE_CIF,   FRAMESIZE_HVGA,  FRAMESIZE_VGA,  FRAMESIZE_SVGA,  FRAMESIZE_XGA,     FRAMESIZE_HD,
    FRAMESIZE_SXGA,  FRAMESIZE_UXGA,  FRAMESIZE_FHD,  FRAMESIZE_P_HD,  FRAMESIZE_P_3MP,   FRAMESIZE_QXGA,
};
static const int SIZE_COUNT = sizeof(SIZES) / sizeof(SIZES[0]);

// The largest setting the sensor allows
static int maxSetting() {
    int n = 0;
    while (n + 1 < SIZE_COUNT && SIZES[n + 1] <= maxSize) n++;
    return n;
}
static const int FB_COUNT = 2;
static SemaphoreHandle_t hubMtx;
static SemaphoreHandle_t sensorMtx;
static uint8_t* hubBuf = nullptr;
static size_t hubCap = 0;
static size_t hubLen = 0;
static volatile uint32_t hubSeq = 0;
static volatile int viewerCount = 0;
static volatile uint32_t touchedAt = 0;
static volatile int w = 0, h = 0;
static volatile float measuredFps = 0;
static int lampPct = 0;
static volatile bool frameSizeChanged = false;

static bool grow(uint8_t*& buf, size_t& cap, size_t need) {
    if (need <= cap) return true;
    size_t ncap = need + need / 4 + 4096;
    uint8_t* nb = (uint8_t*)heap_caps_realloc(buf, ncap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!nb) return false;
    buf = nb;
    cap = ncap;
    return true;
}

static bool wanted() {
    return viewerCount > 0 || motion::running() || rec::recording() || rec::manual() || millis() - touchedAt < 3000;
}

static void grabTask(void*) {
    uint32_t windowStart = millis(), windowFrames = 0;
    uint32_t lastGrab = 0;
    int fails = 0;
    int stale = 0;  // buffered frames to drop before the picture is current
    for (;;) {
        if (!wanted()) {
            measuredFps = 0;
            // The driver stops once its buffers are full; they hold old frames
            stale = FB_COUNT;
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        // At most ~15 fps: leaves CPU and Wi-Fi time for everything else
        uint32_t since = millis() - lastGrab;
        if (since < 66) vTaskDelay(pdMS_TO_TICKS(66 - since));
        lastGrab = millis();

        xSemaphoreTake(sensorMtx, portMAX_DELAY);
        camera_fb_t* fb = esp_camera_fb_get();
        xSemaphoreGive(sensorMtx);
        if (!fb) {
            if (++fails > 20) {
                log_e("camera: no frames, restarting");
                ESP.restart();
            }
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        fails = 0;
        // The first frames after a resolution change still have the old size
        if (frameSizeChanged) {
            frameSizeChanged = false;
            stale = FB_COUNT;
        }
        if (stale > 0) {
            stale--;
            esp_camera_fb_return(fb);
            lastGrab = 0;
            continue;
        }
        xSemaphoreTake(hubMtx, portMAX_DELAY);
        if (grow(hubBuf, hubCap, fb->len)) {
            memcpy(hubBuf, fb->buf, fb->len);
            hubLen = fb->len;
            w = fb->width;
            h = fb->height;
            hubSeq = hubSeq + 1;
        }
        xSemaphoreGive(hubMtx);
        esp_camera_fb_return(fb);

        windowFrames++;
        uint32_t now = millis();
        if (now - windowStart >= 2000) {
            measuredFps = windowFrames * 1000.0f / (now - windowStart);
            windowStart = now;
            windowFrames = 0;
        }
    }
}

bool begin() {
    hubMtx = xSemaphoreCreateMutex();
    sensorMtx = xSemaphoreCreateMutex();

    camera_config_t c = {};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer = LEDC_TIMER_0;
    c.pin_d0 = Y2_GPIO_NUM;
    c.pin_d1 = Y3_GPIO_NUM;
    c.pin_d2 = Y4_GPIO_NUM;
    c.pin_d3 = Y5_GPIO_NUM;
    c.pin_d4 = Y6_GPIO_NUM;
    c.pin_d5 = Y7_GPIO_NUM;
    c.pin_d6 = Y8_GPIO_NUM;
    c.pin_d7 = Y9_GPIO_NUM;
    c.pin_xclk = XCLK_GPIO_NUM;
    c.pin_pclk = PCLK_GPIO_NUM;
    c.pin_vsync = VSYNC_GPIO_NUM;
    c.pin_href = HREF_GPIO_NUM;
    c.pin_sccb_sda = SIOD_GPIO_NUM;
    c.pin_sccb_scl = SIOC_GPIO_NUM;
    c.pin_pwdn = PWDN_GPIO_NUM;
    c.pin_reset = RESET_GPIO_NUM;
    c.xclk_freq_hz = 20000000;  // the sensor drivers' timings assume 20 MHz (8 gave black frames)
    c.pixel_format = PIXFORMAT_JPEG;
    // Allocate for the largest size so later resolution changes need no re-init.
    // UXGA suits every sensor; a bigger one gets a second init below.
    c.frame_size = FRAMESIZE_UXGA;
    c.jpeg_quality = 10;
    c.fb_count = FB_COUNT;
    c.fb_location = CAMERA_FB_IN_PSRAM;
    // Capture only when a frame is taken: "latest" mode keeps the driver busy
    // with every sensor frame on the Wi-Fi core, which choked the Wi-Fi
    c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK) {
        // A second try after a power cycle of the sensor often helps
        log_e("camera init failed 0x%x, retrying", err);
        esp_camera_deinit();
        delay(300);
        err = esp_camera_init(&c);
    }
    if (err == ESP_OK) {
        sensor_t* s = esp_camera_sensor_get();
        camera_sensor_info_t* info = esp_camera_sensor_get_info(&s->id);
        if (info) {
            sensorName = info->name;
            // 3 MP at most: bigger frames would not fit the buffers or the Wi-Fi
            maxSize = min((int)info->max_size, (int)FRAMESIZE_QXGA);
        }
        if (maxSize > FRAMESIZE_UXGA) {
            esp_camera_deinit();
            delay(100);
            c.frame_size = (framesize_t)maxSize;
            err = esp_camera_init(&c);
        }
    }
    initOk = err == ESP_OK;
    if (!initOk) {
        log_e("camera init failed 0x%x", err);
        return false;
    }
    log_w("camera %s, up to frame size %d", sensorName, maxSize);
    apply(config::s.cam);
    xTaskCreatePinnedToCore(grabTask, "grab", 4096, nullptr, 5, nullptr, 1);
    return true;
}

bool ok() { return initOk; }
const char* sensor() { return sensorName; }
int maxFramesize() { return maxSetting(); }

void apply(const CameraSettings& k) {
    if (!initOk) return;
    xSemaphoreTake(sensorMtx, portMAX_DELAY);
    sensor_t* s = esp_camera_sensor_get();
    framesize_t fs = SIZES[constrain(k.framesize, 0, maxSetting())];
    if (s->status.framesize != fs) {
        s->set_framesize(s, (framesize_t)fs);
        frameSizeChanged = true;
    }
    s->set_quality(s, k.quality);
    s->set_brightness(s, k.brightness);
    s->set_contrast(s, k.contrast);
    s->set_saturation(s, k.saturation);
    s->set_special_effect(s, k.special);
    s->set_whitebal(s, k.awb);
    s->set_awb_gain(s, k.awbGain);
    s->set_wb_mode(s, k.wbMode);
    s->set_exposure_ctrl(s, k.aec);
    s->set_aec2(s, k.aec2);
    s->set_ae_level(s, k.aeLevel);
    s->set_aec_value(s, k.aecValue);
    s->set_gain_ctrl(s, k.agc);
    s->set_agc_gain(s, k.agcGain);
    s->set_gainceiling(s, (gainceiling_t)k.gainCeiling);
    s->set_bpc(s, k.bpc);
    s->set_wpc(s, k.wpc);
    s->set_raw_gma(s, k.rawGma);
    s->set_lenc(s, k.lenc);
    s->set_hmirror(s, k.hmirror);
    s->set_vflip(s, k.vflip);
    s->set_dcw(s, k.dcw);
    xSemaphoreGive(sensorMtx);
}

size_t copyLatest(uint8_t*& buf, size_t& cap, uint32_t& seq) {
    if (hubSeq == seq || hubLen == 0) return 0;
    size_t len = 0;
    xSemaphoreTake(hubMtx, portMAX_DELAY);
    if (grow(buf, cap, hubLen)) {
        memcpy(buf, hubBuf, hubLen);
        len = hubLen;
        seq = hubSeq;
    }
    xSemaphoreGive(hubMtx);
    return len;
}

size_t waitFrame(uint8_t*& buf, size_t& cap, uint32_t& seq, uint32_t timeoutMs) {
    touch();
    uint32_t start = millis();
    for (;;) {
        size_t n = copyLatest(buf, cap, seq);
        if (n || millis() - start > timeoutMs) return n;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void addViewer() { viewerCount = viewerCount + 1; }
void removeViewer() {
    if (viewerCount > 0) viewerCount = viewerCount - 1;
}
int viewers() { return viewerCount; }
void touch() { touchedAt = millis(); }
int width() { return w; }
int height() { return h; }
float fps() { return measuredFps; }

void setLamp(int percent) {
    if (!HAS_LAMP) return;
    static bool attached = false;
    if (!attached) {
        ledcAttachChannel(LAMP_PIN, 5000, 8, LAMP_CHANNEL);
        attached = true;
    }
    lampPct = constrain(percent, 0, 100);
    // Perceived brightness is roughly quadratic
    int duty = (lampPct * lampPct * 255) / 10000;
    ledcWrite(LAMP_PIN, duty);
}
int lamp() { return lampPct; }

void setStatusLed(bool on) {
    if (STATUS_LED_PIN < 0) return;
    static bool init = false;
    if (!init) {
        pinMode(STATUS_LED_PIN, OUTPUT);
        init = true;
    }
    digitalWrite(STATUS_LED_PIN, on ? STATUS_LED_ON : !STATUS_LED_ON);
}
}  // namespace cam
