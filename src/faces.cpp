#include "faces.h"

#include "board.h"

#if HAS_FACES
#include <JPEGDEC.h>
#include <esp_partition.h>
#include <esp_random.h>
#include <img_converters.h>
#include <time.h>

#include "camera.h"
#include "config.h"
#include "face_recognition_112_v1_s8.hpp"
#include "human_face_detect_mnp01.hpp"
#include "human_face_detect_msr01.hpp"
#include "motion.h"

namespace faces {
static const int MAX_SIDE = 512;     // frames are decoded at most this big for the models
static const int INTERVAL_MS = 300;  // between analysed frames
static const int MAX_FACES = 3;      // recognised per frame (each takes ~100 ms)
static const int MIN_ENROLL_PX = 40; // face width needed to remember it
static const uint32_t ENROLL_TIMEOUT_MS = 25000;
static const int EMB = 512;          // embedding length of the 112 v1 model
static const int THUMB = 96;         // remembered face photo, square
static const int THUMB_MAX = 4096;   // its JPEG size limit
static const int MAX_EVENTS = 20;
static const uint32_t KNOWN_REPEAT_MS = 60000;    // same person logged again after
static const uint32_t UNKNOWN_REPEAT_MS = 30000;  // a stranger logged again after
static const uint32_t MAGIC = 0x45434146;         // "FACE"

// One remembered photo; the "faces" partition holds a Header and these
struct Record {
    uint32_t uid;
    char name[48];
    uint16_t jpgLen;
    uint16_t reserved;
    float emb[EMB];
    uint8_t jpg[THUMB_MAX];
};
struct Header {
    uint32_t magic;
    uint16_t version;
    uint16_t count;
    uint8_t pad[24];
};

struct Event {
    uint32_t seq;
    time_t when;  // 0 without a clock
    uint32_t ms;
    char name[48];  // "" for a stranger
    uint8_t* jpg;
    size_t len;
};

struct Seen {
    int x, y, w, h;  // 0..1000 of the picture
    String name;
    bool known;
};

static SemaphoreHandle_t mtx;
static const esp_partition_t* part = nullptr;
// Slots stay in place: the recogniser may keep pointers to their embeddings
static Record* slots = nullptr;
static bool used[MAX_PEOPLE];
static int libId[MAX_PEOPLE];
static std::vector<int> toDelete;  // recogniser ids of forgotten slots
static volatile bool saveReq = false;
static volatile bool threshReq = true;
static volatile bool isRunning = false;

static String enrollState = "idle";  // look, many, far, done, timeout, full, error
static String enrollName;
static uint32_t enrollAt = 0;
static volatile bool enrolling = false;

static Event events[MAX_EVENTS];
static volatile uint32_t nextSeq = 0;

static std::vector<Seen> liveFaces;
static uint32_t liveAt = 0;

static void lock() { xSemaphoreTake(mtx, portMAX_DELAY); }
static void unlock() { xSemaphoreGive(mtx); }

// ---------- JPEG -> BGR888, the models' input ----------
// JPEGDEC, not esp_jpg_decode: the S3's ROM decoder rejects the OV3660's
// JPEGs ("Data format error") on every frame.

struct Img {
    uint8_t* px;
    size_t cap;
    int w, h;
};

static JPEGDEC* jpeg = nullptr;  // ~17 KB of state: kept in PSRAM

// Blocks of RGB565 pixels -> BGR888 rows of the picture
static int drawBlock(JPEGDRAW* d) {
    Img* m = (Img*)d->pUser;
    int cw = min(d->iWidth, m->w - d->x), ch = min(d->iHeight, m->h - d->y);
    for (int j = 0; j < ch; j++) {
        const uint16_t* s = d->pPixels + j * d->iWidth;
        uint8_t* o = m->px + ((d->y + j) * m->w + d->x) * 3;
        for (int i = 0; i < cw; i++, o += 3) {
            uint16_t p = s[i];
            o[0] = (p << 3) & 0xF8;          // blue
            o[1] = (p >> 3) & 0xFC;          // green
            o[2] = (p >> 8) & 0xF8;          // red
        }
    }
    return 1;
}

static bool decode(Img& m, const uint8_t* jpg, size_t len) {
    if (!jpeg) {
        void* mem = ps_malloc(sizeof(JPEGDEC));
        if (!mem) return false;
        jpeg = new (mem) JPEGDEC();
    }
    if (!jpeg->openRAM((uint8_t*)jpg, len, drawBlock)) return false;
    int fw = jpeg->getWidth(), fh = jpeg->getHeight();
    int s = 0;
    while ((max(fw, fh) >> s) > MAX_SIDE && s < 3) s++;
    static const int SCALE[4] = {0, JPEG_SCALE_HALF, JPEG_SCALE_QUARTER, JPEG_SCALE_EIGHTH};
    int w = fw >> s, h = fh >> s;
    size_t need = (size_t)w * h * 3;
    if (need > m.cap) {
        free(m.px);
        m.px = (uint8_t*)ps_malloc(need);
        m.cap = m.px ? need : 0;
    }
    if (!m.px) {
        jpeg->close();
        return false;
    }
    m.w = w;
    m.h = h;
    jpeg->setPixelType(RGB565_LITTLE_ENDIAN);
    jpeg->setUserPointer(&m);
    int ok = jpeg->decode(0, 0, SCALE[s]);
    jpeg->close();
    return ok == 1;
}

// A square crop around the face, scaled to THUMB x THUMB and JPEG-encoded
static size_t thumbnail(const Img& m, const std::vector<int>& box, uint8_t* out) {
    int cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    int side = max(box[2] - box[0], box[3] - box[1]) * 3 / 2;
    side = min(side, min(m.w, m.h));
    int x0 = constrain(cx - side / 2, 0, m.w - side), y0 = constrain(cy - side / 2, 0, m.h - side);
    uint8_t* sq = (uint8_t*)ps_malloc(THUMB * THUMB * 3);
    if (!sq) return 0;
    for (int j = 0; j < THUMB; j++)
        for (int i = 0; i < THUMB; i++)
            memcpy(sq + (j * THUMB + i) * 3, m.px + ((y0 + j * side / THUMB) * m.w + x0 + i * side / THUMB) * 3, 3);
    size_t n = 0;
    for (int q : {80, 50}) {
        uint8_t* jpg = nullptr;
        size_t jl = 0;
        if (fmt2jpg(sq, THUMB * THUMB * 3, THUMB, THUMB, PIXFORMAT_RGB888, q, &jpg, &jl) && jl <= THUMB_MAX) {
            memcpy(out, jpg, jl);
            n = jl;
        }
        free(jpg);
        if (n) break;
    }
    free(sq);
    return n;
}

// ---------- flash ----------

static void save() {
    if (!part) return;
    Header h = {};
    h.magic = MAGIC;
    h.version = 1;
    bool keep[MAX_PEOPLE];
    lock();
    memcpy(keep, used, sizeof(keep));
    unlock();
    if (esp_partition_erase_range(part, 0, part->size) != ESP_OK) return;
    size_t off = sizeof(Header);
    for (int i = 0; i < MAX_PEOPLE; i++) {
        if (!keep[i]) continue;
        esp_partition_write(part, off, &slots[i], sizeof(Record));
        off += sizeof(Record);
        h.count++;
    }
    esp_partition_write(part, 0, &h, sizeof(h));
}

static void restore(FaceRecognition112V1S8& rec) {
    Header h;
    if (!part || esp_partition_read(part, 0, &h, sizeof(h)) != ESP_OK) return;
    if (h.magic != MAGIC || h.version != 1 || h.count > MAX_PEOPLE) return;
    for (int i = 0; i < h.count; i++) {
        if (esp_partition_read(part, sizeof(Header) + i * sizeof(Record), &slots[i], sizeof(Record)) != ESP_OK) break;
        slots[i].name[sizeof(slots[i].name) - 1] = 0;
        dl::Tensor<float> emb;
        emb.set_element(slots[i].emb, false).set_shape({EMB});
        libId[i] = rec.enroll_id(emb, slots[i].name, false);
        used[i] = true;
    }
    log_i("faces: %d remembered", h.count);
}

// ---------- sightings ----------

static void logEvent(const String& name, const uint8_t* jpg, size_t len) {
    uint8_t* copy = (uint8_t*)ps_malloc(len);
    if (!copy) return;
    memcpy(copy, jpg, len);
    lock();
    Event& e = events[nextSeq % MAX_EVENTS];
    free(e.jpg);
    e.seq = nextSeq++;
    time_t now = time(nullptr);
    e.when = now > 1700000000 ? now : 0;
    e.ms = millis();
    strlcpy(e.name, name.c_str(), sizeof(e.name));
    e.jpg = copy;
    e.len = len;
    unlock();
    log_i("faces: saw %s", name.length() ? name.c_str() : "a stranger");
}

// When each person (or any stranger, under "") was last logged
static uint32_t lastLogged(const String& name, bool update) {
    static String names[MAX_PEOPLE + 1];
    static uint32_t at[MAX_PEOPLE + 1];
    int slot = -1, oldest = 0;
    for (int i = 0; i <= MAX_PEOPLE; i++) {
        if (at[i] && names[i] == name) slot = i;
        if (at[i] < at[oldest]) oldest = i;
    }
    if (!update) return slot >= 0 ? at[slot] : 0;
    if (slot < 0) slot = oldest;
    names[slot] = name;
    at[slot] = millis() | 1;
    return at[slot];
}

// ---------- the task ----------

static float threshold() {
    static const float T[3] = {0.45f, 0.55f, 0.65f};
    return T[constrain(config::s.faces.accuracy, 1, 3) - 1];
}

static bool wanted() {
    if (!cam::ok()) return false;
    if (enrolling) return true;
    return config::s.faces.enabled && (motion::running() || cam::viewers() > 0);
}

static void finishEnroll(const char* state) {
    lock();
    enrollState = state;
    enrolling = false;
    unlock();
}

static void enroll(FaceRecognition112V1S8& rec, Img& m, std::list<dl::detect::result_t>& found) {
    if (millis() - enrollAt > ENROLL_TIMEOUT_MS) return finishEnroll("timeout");
    lock();
    int slot = -1;
    for (int i = 0; i < MAX_PEOPLE && slot < 0; i++)
        if (!used[i]) slot = i;
    String name = enrollName;
    unlock();
    if (slot < 0) return finishEnroll("full");

    const char* hint = "look";
    if (found.size() > 1) hint = "many";
    else if (found.size() == 1 && found.front().box[2] - found.front().box[0] < MIN_ENROLL_PX) hint = "far";
    if (found.size() != 1 || strcmp(hint, "look") != 0) {
        lock();
        enrollState = hint;
        unlock();
        return;
    }

    auto& f = found.front();
    dl::Tensor<uint8_t> img;
    img.set_element(m.px, false).set_shape({m.h, m.w, 3});
    int id = rec.enroll_id(img, f.keypoint, name.c_str(), false);
    dl::Tensor<float>& emb = rec.get_face_emb(id);
    if (id < 0 || emb.get_size() != EMB) {
        log_e("faces: enroll failed (id %d, size %d)", id, emb.get_size());
        if (id >= 0) rec.delete_id(id, false);
        return finishEnroll("error");
    }
    Record& r = slots[slot];
    memset(&r, 0, sizeof(r));
    r.uid = esp_random() | 1;
    strlcpy(r.name, name.c_str(), sizeof(r.name));
    memcpy(r.emb, emb.get_element_ptr(), EMB * sizeof(float));
    r.jpgLen = thumbnail(m, f.box, r.jpg);
    lock();
    used[slot] = true;
    libId[slot] = id;
    unlock();
    save();
    log_i("faces: remembered %s", r.name);
    finishEnroll("done");
}

static void task(void*) {
    auto* s1 = new HumanFaceDetectMSR01(0.1F, 0.5F, 10, 0.2F);
    auto* s2 = new HumanFaceDetectMNP01(0.5F, 0.3F, 5);
    auto* rec = new FaceRecognition112V1S8();
    restore(*rec);

    Img m = {};
    uint8_t* jpg = nullptr;
    size_t cap = 0;
    uint32_t seq = 0;
    int strangerStreak = 0;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(INTERVAL_MS));

        // Changes asked for by the web pages
        lock();
        std::vector<int> del;
        del.swap(toDelete);
        bool doSave = saveReq;
        saveReq = false;
        unlock();
        for (int id : del) rec->delete_id(id, false);
        if (doSave) save();
        if (threshReq) {
            threshReq = false;
            rec->set_thresh(threshold());
        }

        if (!wanted()) {
            if (isRunning) {
                lock();
                liveFaces.clear();
                unlock();
            }
            isRunning = false;
            strangerStreak = 0;
            continue;
        }
        isRunning = true;
        if (enrolling) cam::touch();
        size_t len = cam::copyLatest(jpg, cap, seq);
        if (!len || !decode(m, jpg, len)) continue;

        std::vector<int> shape = {m.h, m.w, 3};
        auto& candidates = s1->infer(m.px, shape);
        auto& found = s2->infer(m.px, shape, candidates);

        // Biggest faces first: they are the closest and the most recognisable
        found.sort([](const dl::detect::result_t& a, const dl::detect::result_t& b) {
            return (a.box[2] - a.box[0]) > (b.box[2] - b.box[0]);
        });
        std::vector<Seen> seen;
        for (auto& f : found) {
            Seen s;
            s.x = constrain(f.box[0], 0, m.w) * 1000 / m.w;
            s.y = constrain(f.box[1], 0, m.h) * 1000 / m.h;
            s.w = constrain(f.box[2], 0, m.w) * 1000 / m.w - s.x;
            s.h = constrain(f.box[3], 0, m.h) * 1000 / m.h - s.y;
            s.known = false;
            seen.push_back(s);
        }

        if (enrolling) {
            lock();
            liveFaces = seen;
            liveAt = millis();
            unlock();
            enroll(*rec, m, found);
            continue;
        }

        dl::Tensor<uint8_t> img;
        img.set_element(m.px, false).set_shape({m.h, m.w, 3});
        bool anyPeople = rec->get_enrolled_id_num() > 0;
        int i = 0;
        for (auto& f : found) {
            Seen& s = seen[i++];
            if (anyPeople && i <= MAX_FACES && f.keypoint.size() >= 10) {
                face_info_t r = rec->recognize(img, f.keypoint);
                if (r.id >= 0) {
                    lock();
                    for (int k = 0; k < MAX_PEOPLE; k++)
                        if (used[k] && libId[k] == r.id) {
                            s.name = slots[k].name;
                            s.known = true;
                        }
                    unlock();
                }
            }
        }
        lock();
        liveFaces = seen;
        liveAt = millis();
        unlock();

        // The log: each person once a minute; strangers once they stay two frames
        bool stranger = false;
        for (size_t k = 0; k < seen.size() && k < MAX_FACES; k++) {  // the rest weren't checked
            const Seen& s = seen[k];
            if (!s.known) {
                stranger = true;
                continue;
            }
            uint32_t last = lastLogged(s.name, false);
            if (!last || millis() - last > KNOWN_REPEAT_MS) {
                lastLogged(s.name, true);
                logEvent(s.name, jpg, len);
            }
        }
        strangerStreak = stranger ? strangerStreak + 1 : 0;
        if (strangerStreak >= 2) {
            uint32_t last = lastLogged("", false);
            if (!last || millis() - last > UNKNOWN_REPEAT_MS) {
                lastLogged("", true);
                logEvent("", jpg, len);
            }
        }
    }
}

// ---------- API ----------

void begin() {
    mtx = xSemaphoreCreateMutex();
    part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "faces");
    if (!part) log_w("faces: no \"faces\" partition, flash over USB to add it");
    slots = (Record*)ps_calloc(MAX_PEOPLE, sizeof(Record));
    if (!slots || !psramFound()) {
        log_e("faces: needs PSRAM");
        part = nullptr;
        return;
    }
    nextSeq = esp_random() & 0xffffff;  // event photo URLs differ after a reboot
    // Core 1 with the camera and recorder, below them: recording comes first
    xTaskCreatePinnedToCore(task, "faces", 16384, nullptr, 2, nullptr, 1);
}

bool available() { return part != nullptr; }
bool running() { return isRunning; }
void applySettings() { threshReq = true; }
uint32_t eventSeq() { return nextSeq; }

void startEnroll(const String& name) {
    lock();
    enrollName = name;
    enrollState = "look";
    enrollAt = millis();
    enrolling = true;
    unlock();
}

void cancelEnroll() {
    lock();
    enrolling = false;
    enrollState = "idle";
    unlock();
}

bool forget(uint32_t uid) {
    bool found = false;
    lock();
    for (int i = 0; i < MAX_PEOPLE; i++)
        if (used[i] && slots[i].uid == uid) {
            used[i] = false;
            toDelete.push_back(libId[i]);
            found = true;
        }
    if (found) saveReq = true;
    unlock();
    return found;
}

void info(JsonObject o) {
    o["available"] = available();
    o["enabled"] = config::s.faces.enabled;
    o["running"] = running();
    o["max"] = MAX_PEOPLE;
    lock();
    JsonArray people = o["people"].to<JsonArray>();
    for (int i = 0; i < MAX_PEOPLE; i++) {
        if (!used[i]) continue;
        JsonObject p = people.add<JsonObject>();
        p["uid"] = slots[i].uid;
        p["name"] = slots[i].name;
    }
    JsonObject en = o["enroll"].to<JsonObject>();
    en["state"] = enrollState;
    en["name"] = enrollName;
    JsonArray ev = o["events"].to<JsonArray>();
    uint32_t now = millis();
    for (int k = 1; k <= MAX_EVENTS; k++) {
        const Event& e = events[(nextSeq - k) % MAX_EVENTS];
        if (!e.jpg || e.seq != nextSeq - k) continue;
        JsonObject j = ev.add<JsonObject>();
        j["n"] = e.seq;
        j["name"] = e.name;
        j["ago"] = (now - e.ms) / 1000;
        j["time"] = (uint32_t)e.when;
    }
    o["seq"] = nextSeq;
    unlock();
}

void live(JsonObject o) {
    lock();
    o["age"] = liveAt ? millis() - liveAt : 999999;
    o["running"] = running();
    JsonArray a = o["faces"].to<JsonArray>();
    for (auto& s : liveFaces) {
        JsonObject f = a.add<JsonObject>();
        f["x"] = s.x;
        f["y"] = s.y;
        f["w"] = s.w;
        f["h"] = s.h;
        f["known"] = s.known;
        if (s.known) f["name"] = s.name;
    }
    unlock();
}

std::shared_ptr<std::vector<uint8_t>> photo(uint32_t uid) {
    std::shared_ptr<std::vector<uint8_t>> out;
    lock();
    for (int i = 0; i < MAX_PEOPLE; i++)
        if (used[i] && slots[i].uid == uid && slots[i].jpgLen)
            out = std::make_shared<std::vector<uint8_t>>(slots[i].jpg, slots[i].jpg + slots[i].jpgLen);
    unlock();
    return out;
}

std::shared_ptr<std::vector<uint8_t>> eventFrame(uint32_t seq) {
    std::shared_ptr<std::vector<uint8_t>> out;
    lock();
    const Event& e = events[seq % MAX_EVENTS];
    if (e.jpg && e.seq == seq) out = std::make_shared<std::vector<uint8_t>>(e.jpg, e.jpg + e.len);
    unlock();
    return out;
}
}  // namespace faces

#else  // no face recognition on this board

namespace faces {
void begin() {}
bool available() { return false; }
bool running() { return false; }
void applySettings() {}
uint32_t eventSeq() { return 0; }
void startEnroll(const String&) {}
void cancelEnroll() {}
bool forget(uint32_t) { return false; }
void info(JsonObject o) { o["available"] = false; }
void live(JsonObject o) { o["faces"].to<JsonArray>(); }
std::shared_ptr<std::vector<uint8_t>> photo(uint32_t) { return nullptr; }
std::shared_ptr<std::vector<uint8_t>> eventFrame(uint32_t) { return nullptr; }
}  // namespace faces
#endif
