#include "motion.h"

#include <JPEGDEC.h>

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
    int imgW, imgH;
    uint32_t sum[CELLS];
    uint16_t cnt[CELLS];
};

static JPEGDEC* jpeg = nullptr;  // ~17 KB of state: kept in PSRAM

// Blocks of RGB565 pixels of the 1/8 scale picture
static int drawBlock(JPEGDRAW* d) {
    Grid* g = (Grid*)d->pUser;
    int cw = min(d->iWidth, g->imgW - d->x), ch = min(d->iHeight, g->imgH - d->y);
    for (int j = 0; j < ch; j++) {
        int cy = (d->y + j) * GH / g->imgH;
        const uint16_t* p = d->pPixels + j * d->iWidth;
        for (int i = 0; i < cw; i++) {
            int c = cy * GW + (d->x + i) * GW / g->imgW;
            uint16_t v = p[i];
            // Luma-ish: R and B 5 bits, G 6 bits, each scaled to 0..255
            g->sum[c] += (((v >> 8) & 0xF8) + 2 * ((v >> 3) & 0xFC) + ((v << 3) & 0xF8)) >> 2;
            g->cnt[c]++;
        }
    }
    return 1;
}

// JPEGDEC, not esp_jpg_decode: Arduino 3's camera library no longer exports
// it, and the S3's ROM decoder rejected the OV3660's JPEGs
static bool decode(Grid& g, const uint8_t* jpg, size_t len) {
    if (!jpeg) {
        void* mem = ps_malloc(sizeof(JPEGDEC));
        if (!mem) return false;
        jpeg = new (mem) JPEGDEC();
    }
    if (!jpeg->openRAM((uint8_t*)jpg, len, drawBlock)) return false;
    g.imgW = jpeg->getWidth() >> 3;
    g.imgH = jpeg->getHeight() >> 3;
    if (g.imgW < GW || g.imgH < GH) {
        jpeg->close();
        return false;
    }
    jpeg->setPixelType(RGB565_LITTLE_ENDIAN);
    jpeg->setUserPointer(&g);
    int ok = jpeg->decode(0, 0, JPEG_SCALE_EIGHTH);
    jpeg->close();
    return ok == 1;
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
        if (!decode(g, buf, len)) continue;

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
