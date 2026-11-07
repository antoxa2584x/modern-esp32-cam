#include "motion.h"

#include <esp_jpg_decode.h>

#include "camera.h"
#include "config.h"

namespace motion {
static const int GW = 16, GH = 12, CELLS = GW * GH;
static const int SAMPLE_MS = 250;
static const int WARMUP_SAMPLES = 8;

static volatile bool isActive = false;
static volatile uint32_t lastMs = 0;
static volatile int lvl = 0;
static volatile bool resetReq = true;

// Decoder state: accumulates luminance per grid cell
struct Grid {
    uint16_t imgW, imgH;
    uint32_t sum[CELLS];
    uint16_t cnt[CELLS];
    const uint8_t* jpg;
    size_t jpgLen;
};

static size_t reader(void* arg, size_t index, uint8_t* buf, size_t len) {
    Grid* g = (Grid*)arg;
    if (index + len > g->jpgLen) len = g->jpgLen - index;
    if (buf) memcpy(buf, g->jpg + index, len);
    return len;
}

static bool writer(void* arg, uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint8_t* data) {
    Grid* g = (Grid*)arg;
    if (!data) {
        if (x == 0 && y == 0) {
            g->imgW = w;
            g->imgH = h;
        }
        return true;
    }
    if (!g->imgW || !g->imgH) return false;
    for (int j = 0; j < h; j++) {
        int py = y + j;
        int cy = py * GH / g->imgH;
        if (cy >= GH) cy = GH - 1;
        const uint8_t* p = data + j * w * 3;
        for (int i = 0; i < w; i++, p += 3) {
            int cx = (x + i) * GW / g->imgW;
            if (cx >= GW) cx = GW - 1;
            int c = cy * GW + cx;
            // Channel order doesn't matter: R and B get the same weight
            g->sum[c] += (p[0] + 2 * p[1] + p[2]) >> 2;
            g->cnt[c]++;
        }
    }
    return true;
}

static void task(void*) {
    static Grid g;
    static float bg[CELLS];
    uint8_t* buf = nullptr;
    size_t cap = 0;
    uint32_t seq = 0;
    int warm = 0, hits = 0;
    float cur[CELLS];

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_MS));
        if (!running()) {
            isActive = false;
            lvl = 0;
            warm = 0;
            continue;
        }
        if (resetReq) {
            resetReq = false;
            warm = 0;
        }
        cam::touch();
        size_t len = cam::copyLatest(buf, cap, seq);
        if (!len) continue;

        memset(&g, 0, sizeof(g));
        g.jpg = buf;
        g.jpgLen = len;
        if (esp_jpg_decode(len, JPG_SCALE_8X, reader, writer, &g) != ESP_OK) continue;

        float meanDiff = 0;
        for (int c = 0; c < CELLS; c++) {
            cur[c] = g.cnt[c] ? (float)g.sum[c] / g.cnt[c] : 0;
            meanDiff += cur[c] - bg[c];
        }
        if (warm < WARMUP_SAMPLES) {
            // Learn the background quickly, report nothing
            for (int c = 0; c < CELLS; c++) bg[c] = warm == 0 ? cur[c] : bg[c] * 0.5f + cur[c] * 0.5f;
            warm++;
            isActive = false;
            lvl = 0;
            continue;
        }
        meanDiff /= CELLS;

        // Sensitivity 1..5: per-cell brightness change and number of cells needed
        static const float THRESH[5] = {30, 22, 16, 12, 9};
        static const int MIN_CELLS[5] = {14, 9, 6, 4, 2};
        int si = constrain(config::s.motion.sensitivity, 1, 5) - 1;
        int changed = 0;
        for (int c = 0; c < CELLS; c++) {
            // Remove the global shift (auto exposure, clouds, the lamp)
            float d = fabsf(cur[c] - bg[c] - meanDiff);
            if (d > THRESH[si]) changed++;
        }
        lvl = min(100, changed * 100 / (MIN_CELLS[si] * 2));
        bool hit = changed >= MIN_CELLS[si];
        hits = hit ? hits + 1 : 0;
        if (hits >= 2) {  // two samples in a row: ignores single-frame noise
            isActive = true;
            lastMs = millis();
        } else if (!hit) {
            isActive = false;
        }
        // Adapt: fast while quiet, slowly while moving so a lasting change
        // (a door left open) becomes background within a minute or so
        float a = hit ? 0.01f : 0.08f;
        for (int c = 0; c < CELLS; c++) bg[c] += (cur[c] - bg[c]) * a;
    }
}

void begin() { xTaskCreatePinnedToCore(task, "motion", 6144, nullptr, 3, nullptr, 1); }
bool running() { return config::s.security && cam::ok(); }
bool active() { return isActive; }
uint32_t lastMotionMs() { return lastMs; }
int level() { return lvl; }
void reset() { resetReq = true; }
}  // namespace motion
