#include "auth.h"

#include <Preferences.h>
#include <esp_heap_caps.h>
#include <esp_random.h>
#include <mbedtls/md.h>
#include <mbedtls/pkcs5.h>
#include <time.h>

#include "config.h"

namespace auth {
static const int MAX_SESSIONS = 8;
static const int MAX_HISTORY = 16;
// Hashes made by older firmware used 2000; they are redone on the next login
static const int ITERATIONS = 8000;
static const uint32_t SESSION_SECONDS = 30 * 86400;
static const uint32_t CONFIRM_MS = 10 * 60000;
static const int MAX_TRIES = 16;           // addresses with wrong passwords remembered
static const uint32_t GLOBAL_WINDOW_MS = 3600000;
static const int GLOBAL_MAX = 30;          // wrong passwords an hour, all addresses together

// Where a login came from. Fixed-size, so the lists are saved as NVS blobs.
struct Where {
    uint32_t at;  // epoch of the login, 0 = clock was unknown
    uint32_t id;  // the session it made (0 = wrong password)
    uint8_t remote;
    uint8_t count;  // wrong passwords from one address close together share an entry
    char ip[40];
    char place[48];
    char dev[24];  // "Chrome · Windows"
};
struct Session {
    Where w;  // ip and place: where it was used from last
    uint32_t seen;
    char tok[65];      // SHA-256 of the token, hex
    uint32_t sudoMs;   // millis() of the last password confirmation, 0 = none
};
// As saved by firmware before 1.3 (token in clear)
struct OldSession {
    Where w;
    uint32_t seen;
    char tok[41];
};
// Wrong passwords from one address (an IPv6 /64 counts as one)
struct Tries {
    char key[40];
    uint8_t fails;
    uint32_t until;  // millis() the lockout ends
    uint32_t last;   // millis() of the last wrong password
};

static Preferences prefs;
static String userName, hash, salt;
static int iterations = ITERATIONS;
static Session* sessions;  // newest first; in PSRAM
static Where* history;     // newest first
static uint32_t seq = 1;
static uint32_t sessionsSavedAt = 0, historySavedMs = 0;
static bool historyDirty = false;
static Tries tries[MAX_TRIES];
static uint32_t globalFrom[2] = {0, 0};  // [local, remote]
static int globalFails[2] = {0, 0};
static SemaphoreHandle_t mtx;

static String hex(const uint8_t* b, size_t n) {
    static const char* h = "0123456789abcdef";
    String s;
    s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) {
        s += h[b[i] >> 4];
        s += h[b[i] & 15];
    }
    return s;
}

static String derive(const String& pass, const String& saltHex, int iter) {
    uint8_t out[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
    mbedtls_pkcs5_pbkdf2_hmac(&ctx, (const uint8_t*)pass.c_str(), pass.length(), (const uint8_t*)saltHex.c_str(),
                              saltHex.length(), iter, sizeof(out), out);
    mbedtls_md_free(&ctx);
    return hex(out, sizeof(out));
}

static String sha256Hex(const String& s) {
    uint8_t out[32];
    mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t*)s.c_str(), s.length(), out);
    return hex(out, sizeof(out));
}

// Comparison that takes the same time whatever matches
static bool same(const String& a, const String& b) {
    if (a.length() != b.length()) return false;
    uint8_t d = 0;
    for (size_t i = 0; i < a.length(); i++) d |= a[i] ^ b[i];
    return d == 0;
}

static uint32_t now() {
    time_t t = time(nullptr);
    return t > 1700000000 ? (uint32_t)t : 0;
}

static void* psCalloc(size_t n, size_t size) {
    void* p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM);
    return p ? p : calloc(n, size);
}

// "Chrome · Windows" from a User-Agent
static void deviceOf(const String& ua, char* out, size_t n) {
    auto has = [&](const char* s) { return ua.indexOf(s) >= 0; };
    const char* os = has("iPhone")    ? "iPhone"
                     : has("iPad")    ? "iPad"
                     : has("Android") ? "Android"
                     : has("Windows") ? "Windows"
                     : has("CrOS")    ? "ChromeOS"
                     : has("Mac OS")  ? "Mac"
                     : has("Linux")   ? "Linux"
                                      : "";
    const char* br = has("Edg")                         ? "Edge"
                     : has("OPR/") || has("Opera")      ? "Opera"
                     : has("SamsungBrowser")            ? "Samsung Internet"
                     : has("YaBrowser")                 ? "Yandex"
                     : has("Firefox") || has("FxiOS")   ? "Firefox"
                     : has("Chrome") || has("CriOS")    ? "Chrome"
                     : has("Safari")                    ? "Safari"
                                                        : "";
    snprintf(out, n, "%s%s%s", br, *br && *os ? " · " : "", os);
}

static void fill(Where& w, const Client& c) {
    w.remote = c.remote;
    strlcpy(w.ip, c.ip.c_str(), sizeof(w.ip));
    strlcpy(w.place, c.place.c_str(), sizeof(w.place));
    // Never end on a cut "%xx"
    char* pct = strrchr(w.place, '%');
    if (pct && strlen(pct) < 3) *pct = 0;
}

static void saveSessions() {
    prefs.putBytes("sess3", sessions, sizeof(Session) * MAX_SESSIONS);
    sessionsSavedAt = now();
}

static void saveHistory() {
    prefs.putBytes("hist", history, sizeof(Where) * MAX_HISTORY);
    historySavedMs = millis();
    historyDirty = false;
}

// Wrong passwords can come fast: save those at most every 5 minutes
static void saveHistorySoon() {
    if (millis() - historySavedMs > 300000) saveHistory();
    else historyDirty = true;
}

static void addHistory(const Client& c, uint32_t id) {
    uint32_t t = now();
    Where& last = history[0];
    if (!id && last.at && !last.id && last.count < 255 && t - last.at < 900 && c.ip == last.ip) {
        last.count++;
        last.at = t;
    } else {
        memmove(&history[1], &history[0], sizeof(Where) * (MAX_HISTORY - 1));
        Where& w = history[0];
        memset(&w, 0, sizeof(w));
        w.at = t;
        w.id = id;
        w.count = 1;
        fill(w, c);
        deviceOf(c.ua, w.dev, sizeof(w.dev));
    }
    seq++;
    if (id) saveHistory();
    else saveHistorySoon();
}

void begin() {
    mtx = xSemaphoreCreateMutex();
    sessions = (Session*)psCalloc(MAX_SESSIONS, sizeof(Session));
    history = (Where*)psCalloc(MAX_HISTORY, sizeof(Where));
    prefs.begin("auth", false);
    userName = prefs.getString("user", "");
    hash = prefs.getString("hash", "");
    salt = prefs.getString("salt", "");
    iterations = prefs.getInt("iter", 2000);
    if (prefs.getBytesLength("hist") == sizeof(Where) * MAX_HISTORY)
        prefs.getBytes("hist", history, sizeof(Where) * MAX_HISTORY);
    if (prefs.getBytesLength("sess3") == sizeof(Session) * MAX_SESSIONS) {
        prefs.getBytes("sess3", sessions, sizeof(Session) * MAX_SESSIONS);
        for (int i = 0; i < MAX_SESSIONS; i++) sessions[i].sudoMs = 0;
        return;
    }
    // Sessions saved by older firmware kept the tokens in clear: keep their hashes
    if (prefs.getBytesLength("sess2") == sizeof(OldSession) * MAX_SESSIONS) {
        auto* old = (OldSession*)psCalloc(MAX_SESSIONS, sizeof(OldSession));
        if (old) {
            prefs.getBytes("sess2", old, sizeof(OldSession) * MAX_SESSIONS);
            for (int i = 0; i < MAX_SESSIONS; i++) {
                if (!old[i].tok[0]) continue;
                sessions[i].w = old[i].w;
                sessions[i].seen = old[i].seen;
                strlcpy(sessions[i].tok, sha256Hex(old[i].tok).c_str(), sizeof(sessions[i].tok));
            }
            free(old);
        }
    }
    saveSessions();
    prefs.remove("sess2");
    prefs.remove("sess");
}

bool configured() { return userName.length() && hash.length(); }
String user() { return userName; }

static void storeHash(const String& p) {
    uint8_t rnd[16];
    esp_fill_random(rnd, sizeof(rnd));
    salt = hex(rnd, sizeof(rnd));
    iterations = ITERATIONS;
    hash = derive(p, salt, iterations);
    prefs.putString("salt", salt);
    prefs.putString("hash", hash);
    prefs.putInt("iter", iterations);
}

void setCredentials(const String& u, const String& p) {
    userName = u;
    prefs.putString("user", userName);
    storeHash(p);
}

static bool passwordMatches(const String& p) { return configured() && same(derive(p, salt, iterations), hash); }

const char* passwordProblem(const String& p) {
    if (p.length() < 8) return "Пароль має містити щонайменше 8 символів";
    if (p.length() > 64) return "Пароль задовгий (до 64 символів)";
    // One repeated character, or a run like 12345678 / 87654321
    bool sameChar = true, up = true, down = true;
    for (size_t i = 1; i < p.length(); i++) {
        sameChar &= p[i] == p[0];
        up &= p[i] == p[i - 1] + 1;
        down &= p[i] == p[i - 1] - 1;
    }
    if (sameChar || up || down) return "Цей пароль дуже легко вгадати";
    static const char* COMMON[] = {
        "password", "password1", "qwertyui", "qwerty123", "qwertyuiop", "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx",
        "zaq12wsx", "asdfghjk", "iloveyou", "admin123", "administrator", "11223344", "12341234", "123123123",
        "88888888", "00000000", "abcd1234", "password123", "camera123", "qazwsxedc", "football", "sunshine",
        "princess", "superman", "baseball", "welcome1", "letmein1", "trustno1", "parol123", "kyiv2024",
        "ukraine1", "slavaukraini", "11111111", "12121212", "q1w2e3r4", "passw0rd", "123qweasd", "qweasdzxc",
    };
    String low = p;
    low.toLowerCase();
    for (const char* c : COMMON)
        if (low == c) return "Цей пароль дуже поширений — його легко вгадати";
    if (low == userName && userName.length()) return "Пароль не має збігатися з ім'ям користувача";
    return nullptr;
}

// ---------- wrong passwords ----------

// The address wrong passwords are counted for; an IPv6 /64 is one household
static String keyOf(const String& ip) {
    if (ip.indexOf(':') >= 0) {
        int colons = 0;
        for (int i = 0; i < (int)ip.length(); i++)
            if (ip[i] == ':' && ++colons == 4) return ip.substring(0, i);
    }
    return ip;
}

// Caller holds mtx
static Tries* triesOf(const String& key, bool create) {
    uint32_t t = millis();
    Tries* oldest = &tries[0];
    for (auto& e : tries) {
        // Forgiven a day after the last wrong password
        if (e.key[0] && t - e.last > 86400000) memset(&e, 0, sizeof(e));
        if (e.key[0] && key == e.key) return &e;
        if (!e.key[0] || (oldest->key[0] && e.last < oldest->last)) oldest = &e;
    }
    if (!create) return nullptr;
    memset(oldest, 0, sizeof(Tries));
    strlcpy(oldest->key, key.c_str(), sizeof(oldest->key));
    return oldest;
}

// Has this address logged in before? Caller holds mtx
static bool known(const Client& c) {
    String key = keyOf(c.ip);
    if (!key.length()) return false;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (sessions[i].tok[0] && keyOf(sessions[i].w.ip) == key) return true;
    for (int i = 0; i < MAX_HISTORY; i++)
        if (history[i].id && keyOf(history[i].ip) == key) return true;
    return false;
}

// Caller holds mtx
static uint32_t lockedFor(const Client& c) {
    uint32_t t = millis(), wait = 0;
    Tries* e = triesOf(keyOf(c.ip), false);
    if (e && (int32_t)(e->until - t) > 0) wait = (e->until - t + 999) / 1000;
    int g = c.remote;
    if (t - globalFrom[g] > GLOBAL_WINDOW_MS) globalFails[g] = 0;
    if (globalFails[g] >= GLOBAL_MAX && !known(c))
        wait = max(wait, (GLOBAL_WINDOW_MS - (t - globalFrom[g]) + 999) / 1000);
    return wait;
}

// Caller holds mtx
static void failed(const Client& c) {
    uint32_t t = millis();
    Tries* e = triesOf(keyOf(c.ip), true);
    if (e->fails < 255) e->fails++;
    e->last = t;
    // Every 5 wrong tries: wait 30 s, then 60 s, ... (up to 10 min)
    if (e->fails % 5 == 0) e->until = t + min(600, 30 * (e->fails / 5)) * 1000;
    int g = c.remote;
    if (!globalFails[g] || t - globalFrom[g] > GLOBAL_WINDOW_MS) {
        globalFrom[g] = t;
        globalFails[g] = 0;
    }
    globalFails[g]++;
    addHistory(c, 0);
}

// Caller holds mtx
static void succeeded(const Client& c) {
    Tries* e = triesOf(keyOf(c.ip), false);
    if (e) memset(e, 0, sizeof(Tries));
}

uint32_t lockoutSeconds(const Client& c) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    uint32_t w = lockedFor(c);
    xSemaphoreGive(mtx);
    return w;
}

// ---------- sessions ----------

// Caller holds mtx
static String addSession(const Client& c) {
    String tok = config::randomToken(40);
    // Newest first; the oldest session drops out
    memmove(&sessions[1], &sessions[0], sizeof(Session) * (MAX_SESSIONS - 1));
    Session& s = sessions[0];
    memset(&s, 0, sizeof(s));
    strlcpy(s.tok, sha256Hex(tok).c_str(), sizeof(s.tok));
    s.w.at = s.seen = now();
    s.w.id = esp_random() | 1;
    s.w.count = 1;
    fill(s.w, c);
    deviceOf(c.ua, s.w.dev, sizeof(s.w.dev));
    saveSessions();
    return tok;
}

// Caller holds mtx; nullptr if the token isn't a live session
static Session* sessionOf(const String& token) {
    if (token.length() != 40) return nullptr;
    String h = sha256Hex(token);
    uint32_t t = now();
    for (int i = 0; i < MAX_SESSIONS; i++) {
        Session& s = sessions[i];
        if (!s.tok[0] || !same(s.tok, h)) continue;
        if (s.w.at && t && t - s.w.at > SESSION_SECONDS) return nullptr;
        return &s;
    }
    return nullptr;
}

String login(const String& u, const String& p, const Client& c, bool& lockedOut) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    lockedOut = lockedFor(c) > 0;
    xSemaphoreGive(mtx);
    if (lockedOut) return "";
    // Always run the slow hash, so a wrong user name takes as long as a wrong password
    bool passOk = passwordMatches(p);
    xSemaphoreTake(mtx, portMAX_DELAY);
    if (!passOk || !u.equalsIgnoreCase(userName)) {
        failed(c);
        xSemaphoreGive(mtx);
        return "";
    }
    succeeded(c);
    String tok = addSession(c);
    addHistory(c, sessions[0].w.id);
    xSemaphoreGive(mtx);
    // A hash from older firmware: redo it with today's strength
    if (iterations < ITERATIONS) storeHash(p);
    return tok;
}

bool checkPassword(const String& p, const Client& c, bool& lockedOut) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    lockedOut = lockedFor(c) > 0;
    xSemaphoreGive(mtx);
    if (lockedOut) return false;
    bool ok = passwordMatches(p);
    xSemaphoreTake(mtx, portMAX_DELAY);
    if (ok) succeeded(c);
    else failed(c);
    xSemaphoreGive(mtx);
    return ok;
}

String newSession(const Client& c) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    String tok = addSession(c);
    xSemaphoreGive(mtx);
    return tok;
}

bool valid(const String& token, const Client* c) {
    if (token.length() != 40) return false;
    String h = sha256Hex(token);
    bool ok = false, dirty = false;
    uint32_t t = now();
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        Session& s = sessions[i];
        if (!s.tok[0] || !same(s.tok, h)) continue;
        // A session made while the clock was unknown gets its date now
        if (!s.w.at && t) {
            s.w.at = t;
            dirty = true;
        }
        if (s.w.at && t && t - s.w.at > SESSION_SECONDS) {
            memset(&s, 0, sizeof(s));
            dirty = true;
            continue;
        }
        ok = true;
        if (t) s.seen = t;
        if (c && (c->ip != s.w.ip || c->remote != s.w.remote)) {
            fill(s.w, *c);
            dirty = true;
        }
    }
    // Last-used times are only saved hourly
    if (dirty || (ok && t && t - sessionsSavedAt > 3600)) saveSessions();
    if (historyDirty && millis() - historySavedMs > 300000) saveHistory();
    xSemaphoreGive(mtx);
    return ok;
}

void logout(const String& token) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    Session* s = sessionOf(token);
    if (s) {
        memset(s, 0, sizeof(Session));
        saveSessions();
    }
    xSemaphoreGive(mtx);
}

void logoutAll() {
    xSemaphoreTake(mtx, portMAX_DELAY);
    memset(sessions, 0, sizeof(Session) * MAX_SESSIONS);
    saveSessions();
    xSemaphoreGive(mtx);
}

bool endSession(uint32_t id) {
    bool found = false;
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (!id || !sessions[i].tok[0] || sessions[i].w.id != id) continue;
        memset(&sessions[i], 0, sizeof(Session));
        found = true;
    }
    if (found) saveSessions();
    xSemaphoreGive(mtx);
    return found;
}

void confirm(const String& token) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    Session* s = sessionOf(token);
    if (s) s->sudoMs = millis() | 1;
    xSemaphoreGive(mtx);
}

uint32_t confirmedSeconds(const String& token) {
    uint32_t left = 0;
    xSemaphoreTake(mtx, portMAX_DELAY);
    Session* s = sessionOf(token);
    if (s && s->sudoMs) {
        uint32_t age = millis() - s->sudoMs;
        if (age < CONFIRM_MS) left = max<uint32_t>(1, (CONFIRM_MS - age) / 1000);
        else s->sudoMs = 0;
    }
    xSemaphoreGive(mtx);
    return left;
}

bool confirmed(const String& token) { return confirmedSeconds(token) > 0; }

void wipe() {
    xSemaphoreTake(mtx, portMAX_DELAY);
    memset(sessions, 0, sizeof(Session) * MAX_SESSIONS);
    memset(history, 0, sizeof(Where) * MAX_HISTORY);
    memset(tries, 0, sizeof(tries));
    saveSessions();
    saveHistory();
    seq++;
    xSemaphoreGive(mtx);
}

static void whereJson(JsonObject o, const Where& w) {
    o["at"] = w.at;
    o["ip"] = w.ip;
    if (w.place[0]) o["place"] = w.place;
    o["dev"] = w.dev;
    o["remote"] = (bool)w.remote;
}

void toJson(JsonObject o, const String& token) {
    String h = token.length() == 40 ? sha256Hex(token) : String();
    xSemaphoreTake(mtx, portMAX_DELAY);
    uint32_t t = now();
    JsonArray ss = o["sessions"].to<JsonArray>();
    for (int i = 0; i < MAX_SESSIONS; i++) {
        const Session& s = sessions[i];
        if (!s.tok[0] || (s.w.at && t && t - s.w.at > SESSION_SECONDS)) continue;
        JsonObject j = ss.add<JsonObject>();
        j["id"] = s.w.id;
        whereJson(j, s.w);
        j["seen"] = s.seen;
        if (h.length() && same(s.tok, h)) j["current"] = true;
    }
    JsonArray hs = o["history"].to<JsonArray>();
    for (int i = 0; i < MAX_HISTORY; i++) {
        const Where& w = history[i];
        if (!w.count) continue;
        JsonObject j = hs.add<JsonObject>();
        whereJson(j, w);
        j["ok"] = w.id != 0;
        if (w.id) j["id"] = w.id;
        if (w.count > 1) j["n"] = w.count;
    }
    xSemaphoreGive(mtx);
}

uint32_t historySeq() { return seq; }
}  // namespace auth
