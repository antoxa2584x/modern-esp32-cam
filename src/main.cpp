// ESP32-CAM home security camera: live view, motion recording to microSD,
// Ukrainian web UI, setup over its own Wi-Fi, remote access through a relay.
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_ota_ops.h>
#include <mbedtls/platform.h>

#include "auth.h"
#include "board.h"
#include "camera.h"
#include "config.h"
#include "faces.h"
#include "motion.h"
#include "netmgr.h"
#include "recorder.h"
#include "remote.h"
#include "storage.h"
#include "streamsrv.h"
#include "webserver.h"

// TLS (remote access) memory in PSRAM. This Arduino build keeps it in internal
// RAM (~40 KB per connection), which Wi-Fi also needs: when it ran out, Wi-Fi
// dropped most packets and the web servers froze.
static void* tlsCalloc(size_t n, size_t size) {
    void* p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

void setup() {
    if (psramFound()) {
        mbedtls_platform_set_calloc_free(tlsCalloc, heap_caps_free);
        // Anything over 512 bytes goes to PSRAM too (by default up to 4 KB stays internal)
        heap_caps_malloc_extmem_enable(PSRAM_ALLOC_MIN);
    }
    Serial.begin(115200);
    log_i("ESP32 camera " FW_VERSION);
    config::begin();
    auth::begin();
    cam::setStatusLed(false);
    if (!cam::begin()) log_e("camera not found");
    store::begin();
    cam::setLamp(0);  // after the SD card, which shares GPIO4 in 4-bit mode
    net::begin();
    motion::begin();
    rec::begin();
    faces::begin();
    web::begin();
    streamsrv::begin();
    remote::begin();
    // Booted fine: keep this firmware (rolls back otherwise, if enabled)
    esp_ota_mark_app_valid_cancel_rollback();
}

void loop() {
    net::loop();
    web::loop();
    delay(10);
}
