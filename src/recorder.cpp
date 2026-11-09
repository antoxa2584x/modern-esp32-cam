#include "recorder.h"

#include <Preferences.h>
#include <time.h>

#include "avi.h"
#include "camera.h"
#include "config.h"
#include "motion.h"
#include "storage.h"

namespace rec {
static volatile bool isRecording = false;
static volatile bool manualOn = false;
static volatile uint32_t clipStart = 0;
static String lastError;
static Preferences prefs;

// Frames from before the motion: one PSRAM block used as a ring
class PreRing {
  public:
    struct Entry {
        uint32_t off, len, ms;
    };
    bool alloc() {
        if (!data) data = (uint8_t*)ps_malloc(CAP);
        return data != nullptr;
    }
    void clear() { count = 0; }
    void push(const uint8_t* jpg, uint32_t len, uint32_t ms, uint32_t keepMs) {
        if (!data || len > CAP / 4) return;
        if (wpos + len > CAP) wpos = 0;
        // Drop the oldest frames that the new one overwrites, or that are too old
        while (count && (overlaps(at(0), wpos, len) || ms - at(0).ms > keepMs || count == MAXE)) pop();
        memcpy(data + wpos, jpg, len);
        ents[(head + count) % MAXE] = {wpos, len, ms};
        count++;
        wpos += len;
    }
    int size() const { return count; }
    const Entry& at(int i) const { return ents[(head + i) % MAXE]; }
    const uint8_t* ptr(const Entry& e) const { return data + e.off; }

  private:
    static const uint32_t CAP = 1536 * 1024;
    static const int MAXE = 96;
    static bool overlaps(const Entry& e, uint32_t off, uint32_t len) { return e.off < off + len && e.off + e.len > off; }
    void pop() {
        head = (head + 1) % MAXE;
        count--;
    }
    uint8_t* data = nullptr;
    Entry ents[MAXE];
    int head = 0, count = 0;
    uint32_t wpos = 0;
};

bool clockKnown() { return time(nullptr) > 1700000000; }

// Day folder and time of day for a clip that started `agoMs` ago
static void clipName(uint32_t agoMs, String& day, String& hms) {
    char d[16], t[16];
    if (clockKnown()) {
        time_t now = time(nullptr) - agoMs / 1000;
        struct tm tmv;
        localtime_r(&now, &tmv);
        strftime(d, sizeof(d), "%Y%m%d", &tmv);
        strftime(t, sizeof(t), "%H%M%S", &tmv);
    } else {
        // No clock: "0000" + boot number, and time since power-on
        uint32_t s = (millis() - agoMs) / 1000;
        snprintf(d, sizeof(d), "0000%04u", (unsigned)(config::bootCount() % 10000));
        snprintf(t, sizeof(t), "%02u%02u%02u", (unsigned)(s / 3600 % 100), (unsigned)(s / 60 % 60), (unsigned)(s % 60));
    }
    day = d;
    hms = t;
}

// A clip cut off by a power loss or crash: rebuild its index, give it a name
static void recoverOpenClip() {
    String part = prefs.getString("open", "");
    if (!part.length()) return;
    prefs.remove("open");
    if (!store::mounted() || !store::fs().exists(part)) return;
    int fps = config::s.motion.fps;
    uint32_t frames = avi::repair(store::fs(), part, fps);
    if (!frames) {
        store::fs().remove(part);
        return;
    }
    String final = part.substring(0, part.length() - 5) + "_" + String(max<uint32_t>(1, frames / fps)) + "_m.avi";
    store::fs().rename(part, final);
    log_i("recovered %s (%u frames)", final.c_str(), frames);
}

static void task(void*) {
    recoverOpenClip();
    avi::Writer writer;
    PreRing ring;
    uint8_t* buf = nullptr;
    size_t cap = 0;
    uint32_t seq = 0;
    char kind = 'm';
    String partPath, finalBase;
    uint32_t firstMs = 0, lastMs = 0;
    uint32_t lastHousekeeping = 0;
    int lampBefore = 0;

    auto stop = [&]() {
        float secs = (lastMs - firstMs) / 1000.0f;
        uint32_t frames = writer.frames();
        float realFps = secs > 0.5f && frames > 1 ? (frames - 1) / secs : config::s.motion.fps;
        bool ok = writer.finish(realFps);
        prefs.remove("open");
        isRecording = false;
        if (config::s.motion.lampOnRecord) cam::setLamp(lampBefore);
        cam::setStatusLed(false);
        if (!ok || frames == 0) {
            store::fs().remove(partPath);
            if (!ok) lastError = "Не вдалося зберегти запис на карту пам'яті";
            return;
        }
        String final = finalBase + "_" + String((int)(secs + 0.5f)) + "_" + kind + ".avi";
        store::fs().rename(partPath, final);
        store::refreshUsage();
        log_i("saved %s, %u frames", final.c_str(), frames);
    };

    auto start = [&](char k) -> bool {
        if (!store::mounted()) {
            lastError = "Немає карти пам'яті";
            return false;
        }
        store::ensureSpace();
        uint32_t oldest = ring.size() ? ring.at(0).ms : millis();
        String day, hms;
        clipName(millis() - oldest, day, hms);
        String dir = "/rec/" + day;
        if (!store::fs().exists(dir)) store::fs().mkdir(dir);
        finalBase = dir + "/" + hms;
        // Two clips in the same second (a long clip was split): bump the name
        for (int i = 1; store::fs().exists(finalBase + ".part") && i < 60; i++) {
            String d2, h2;
            clipName(millis() - oldest - i * 1000, d2, h2);
            finalBase = dir + "/" + h2;
        }
        partPath = finalBase + ".part";
        int w = cam::width(), h = cam::height();
        if (!writer.begin(store::fs(), partPath, w, h, config::s.motion.fps)) {
            lastError = "Не вдалося створити файл на карті пам'яті";
            return false;
        }
        prefs.putString("open", partPath);
        kind = k;
        lastError = "";
        isRecording = true;
        clipStart = millis();
        firstMs = 0;
        if (config::s.motion.lampOnRecord) {
            lampBefore = cam::lamp();
            cam::setLamp(100);
        }
        if (config::s.statusLed) cam::setStatusLed(true);
        // Frames from before the motion
        for (int i = 0; i < ring.size(); i++) {
            const auto& e = ring.at(i);
            if (!firstMs) firstMs = e.ms;
            lastMs = e.ms;
            writer.addFrame(ring.ptr(e), e.len);
        }
        ring.clear();
        return true;
    };

    for (;;) {
        int fps = constrain(config::s.motion.fps, 2, 15);
        vTaskDelay(pdMS_TO_TICKS(1000 / fps));
        uint32_t now = millis();

        if (now - lastHousekeeping > 30000) {
            lastHousekeeping = now;
            store::refreshUsage();
            store::ensureSpace(isRecording ? partPath : "");
        }

        bool securityOn = motion::running();
        bool motionWants = securityOn && (isRecording && kind == 'm'
                                              ? now - motion::lastMotionMs() < (uint32_t)config::s.motion.postSeconds * 1000
                                              : motion::active());
        bool want = manualOn || motionWants;
        if (!cam::ok()) want = false;

        size_t len = cam::copyLatest(buf, cap, seq);

        if (!isRecording) {
            int pre = config::s.motion.preSeconds;
            if (securityOn && pre > 0 && len && ring.alloc()) ring.push(buf, len, now, pre * 1000 + 200);
            if (!securityOn) ring.clear();
            // Wait for the first frame, so the file gets the right picture size
            if (want && cam::width() > 0) start(manualOn ? 'r' : 'm');
            continue;
        }

        if (len) {
            if (!firstMs) firstMs = now;
            lastMs = now;
            if (!writer.addFrame(buf, len)) {
                lastError = "Карта пам'яті переповнена або пошкоджена";
                stop();
                manualOn = false;
                continue;
            }
        }
        // A manual recording that started during a motion clip takes it over
        if (manualOn) kind = 'r';
        if (!want) {
            stop();
        } else if (now - clipStart > (uint32_t)config::s.motion.maxClipSeconds * 1000) {
            stop();  // split long clips; the next loop starts a new one
        }
    }
}

void begin() {
    prefs.begin("rec", false);
    xTaskCreatePinnedToCore(task, "rec", 8192, nullptr, 4, nullptr, 1);
}
bool recording() { return isRecording; }
bool manual() { return manualOn; }
void setManual(bool on) { manualOn = on; }
uint32_t elapsedMs() { return isRecording ? millis() - clipStart : 0; }
String error() { return lastError; }
}  // namespace rec
