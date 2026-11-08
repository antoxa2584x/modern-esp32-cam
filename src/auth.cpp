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
static const int ITERATIONS = 2000;
static const uint32_t SESSION_SECONDS = 30 * 86400;

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
    char tok[41];
};

static Preferences prefs;
static String userName, hash, salt;
static Session* sessions;  // newest first; in PSRAM
static Where* history;     // newest first
static uint32_t seq = 1;
static uint32_t sessionsSavedAt = 0, historySavedMs = 0;
static bool historyDirty = false;
static int fails[2] = {0, 0};  // [local, remote]
static uint32_t lockedUntil[2] = {0, 0};
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

static String derive(const String& pass, const String& saltHex) {
    uint8_t out[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
    mbedtls_pkcs5_pbkdf2_hmac(&ctx, (const uint8_t*)pass.c_str(), pass.length(), (const uint8_t*)saltHex.c_str(),
                              saltHex.length(), ITERATIONS, sizeof(out), out);
    mbedtls_md_free(&ctx);
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
    prefs.putBytes("sess2", sessions, sizeof(Session) * MAX_SESSIONS);
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
    if (prefs.getBytesLength("hist") == sizeof(Where) * MAX_HISTORY)
        prefs.getBytes("hist", history, sizeof(Where) * MAX_HISTORY);
    if (prefs.getBytesLength("sess2") == sizeof(Session) * MAX_SESSIONS) {
        prefs.getBytes("sess2", sessions, sizeof(Session) * MAX_SESSIONS);
        return;
    }
    // Sessions saved by older firmware: "token:issued,..."
    String all = prefs.getString("sess", "");
    int i = 0, from = 0;
    while (i < MAX_SESSIONS) {
        int c = all.indexOf(',', from);
        if (c < 0) break;
        String item = all.substring(from, c);
        int colon = item.indexOf(':');
        String tok = colon < 0 ? item : item.substring(0, colon);
        if (tok.length() == 40) {
            Session& s = sessions[i++];
            strlcpy(s.tok, tok.c_str(), sizeof(s.tok));
            s.w.at = colon < 0 ? 0 : item.substring(colon + 1).toInt();
            s.w.id = esp_random() | 1;
        }
        from = c + 1;
    }
    saveSessions();
    prefs.remove("sess");
}

bool configured() { return userName.length() && hash.length(); }
String user() { return userName; }

void setCredentials(const String& u, const String& p) {
    uint8_t rnd[16];
    esp_fill_random(rnd, sizeof(rnd));
    salt = hex(rnd, sizeof(rnd));
    hash = derive(p, salt);
    userName = u;
    prefs.putString("user", userName);
    prefs.putString("salt", salt);
    prefs.putString("hash", hash);
}

bool checkPassword(const String& p) { return configured() && same(derive(p, salt), hash); }

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

uint32_t lockoutSeconds(bool remote) {
    uint32_t t = millis(), until = lockedUntil[remote];
    return until > t ? (until - t + 999) / 1000 : 0;
}

// Caller holds mtx
static String addSession(const Client& c) {
    String tok = config::randomToken(40);
    // Newest first; the oldest session drops out
    memmove(&sessions[1], &sessions[0], sizeof(Session) * (MAX_SESSIONS - 1));
    Session& s = sessions[0];
    memset(&s, 0, sizeof(s));
    strlcpy(s.tok, tok.c_str(), sizeof(s.tok));
    s.w.at = s.seen = now();
    s.w.id = esp_random() | 1;
    s.w.count = 1;
    fill(s.w, c);
    deviceOf(c.ua, s.w.dev, sizeof(s.w.dev));
    saveSessions();
    return tok;
}

String login(const String& u, const String& p, const Client& c, bool& lockedOut) {
    lockedOut = lockoutSeconds(c.remote) > 0;
    if (lockedOut) return "";
    // Always run the slow hash, so a wrong user name takes as long as a wrong password
    bool passOk = checkPassword(p);
    xSemaphoreTake(mtx, portMAX_DELAY);
    if (!passOk || !u.equalsIgnoreCase(userName)) {
        // Every 5 wrong tries: wait 30 s, then 60 s, ... (up to 10 min)
        int& f = fails[c.remote];
        if (++f % 5 == 0) lockedUntil[c.remote] = millis() + min(600, 30 * (f / 5)) * 1000;
        addHistory(c, 0);
        xSemaphoreGive(mtx);
        return "";
    }
    fails[c.remote] = 0;
    String tok = addSession(c);
    addHistory(c, sessions[0].w.id);
    xSemaphoreGive(mtx);
    return tok;
}

String newSession(const Client& c) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    String tok = addSession(c);
    xSemaphoreGive(mtx);
    return tok;
}

bool valid(const String& token, const Client* c) {
    if (token.length() != 40) return false;
    bool ok = false, dirty = false;
    uint32_t t = now();
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        Session& s = sessions[i];
        if (!s.tok[0] || !same(s.tok, token)) continue;
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
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (token.length() == 40 && same(sessions[i].tok, token)) memset(&sessions[i], 0, sizeof(Session));
    saveSessions();
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

static void whereJson(JsonObject o, const Where& w) {
    o["at"] = w.at;
    o["ip"] = w.ip;
    if (w.place[0]) o["place"] = w.place;
    o["dev"] = w.dev;
    o["remote"] = (bool)w.remote;
}

void toJson(JsonObject o, const String& token) {
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
        if (token.length() == 40 && same(s.tok, token)) j["current"] = true;
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
