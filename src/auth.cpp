#include "auth.h"

#include <Preferences.h>
#include <esp_random.h>
#include <mbedtls/md.h>
#include <mbedtls/pkcs5.h>
#include <time.h>

#include "config.h"

namespace auth {
static const int MAX_SESSIONS = 8;
static const int ITERATIONS = 2000;
static const uint32_t SESSION_SECONDS = 30 * 86400;
static Preferences prefs;
static String userName, hash, salt;
static String sessions[MAX_SESSIONS];
static uint32_t issued[MAX_SESSIONS];  // epoch, 0 = clock was unknown
static int fails[2] = {0, 0};          // [local, remote]
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

static void saveSessions() {
    String all;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (sessions[i].length()) all += sessions[i] + ":" + String(issued[i]) + ",";
    prefs.putString("sess", all);
}

void begin() {
    mtx = xSemaphoreCreateMutex();
    prefs.begin("auth", false);
    userName = prefs.getString("user", "");
    hash = prefs.getString("hash", "");
    salt = prefs.getString("salt", "");
    String all = prefs.getString("sess", "");
    int i = 0, from = 0;
    while (i < MAX_SESSIONS) {
        int c = all.indexOf(',', from);
        if (c < 0) break;
        String item = all.substring(from, c);
        int colon = item.indexOf(':');
        sessions[i] = colon < 0 ? item : item.substring(0, colon);
        issued[i] = colon < 0 ? 0 : item.substring(colon + 1).toInt();
        i++;
        from = c + 1;
    }
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

String login(const String& u, const String& p, bool remote, bool& lockedOut) {
    lockedOut = lockoutSeconds(remote) > 0;
    if (lockedOut) return "";
    // Always run the slow hash, so a wrong user name takes as long as a wrong password
    bool passOk = checkPassword(p);
    if (!passOk || !u.equalsIgnoreCase(userName)) {
        // Every 5 wrong tries: wait 30 s, then 60 s, ... (up to 10 min)
        int& f = fails[remote];
        if (++f % 5 == 0) lockedUntil[remote] = millis() + min(600, 30 * (f / 5)) * 1000;
        return "";
    }
    fails[remote] = 0;
    String tok = config::randomToken(40);
    xSemaphoreTake(mtx, portMAX_DELAY);
    // Newest first; the oldest session drops out
    for (int i = MAX_SESSIONS - 1; i > 0; i--) {
        sessions[i] = sessions[i - 1];
        issued[i] = issued[i - 1];
    }
    sessions[0] = tok;
    issued[0] = now();
    saveSessions();
    xSemaphoreGive(mtx);
    return tok;
}

bool valid(const String& token) {
    if (token.length() != 40) return false;
    bool ok = false, expired = false;
    uint32_t t = now();
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (!sessions[i].length() || !same(sessions[i], token)) continue;
        // A session made while the clock was unknown gets its date now
        if (!issued[i] && t) {
            issued[i] = t;
            saveSessions();
        }
        if (issued[i] && t && t - issued[i] > SESSION_SECONDS) {
            sessions[i] = "";
            expired = true;
        } else {
            ok = true;
        }
    }
    if (expired) saveSessions();
    xSemaphoreGive(mtx);
    return ok;
}

void logout(const String& token) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (auto& s : sessions)
        if (s == token) s = "";
    saveSessions();
    xSemaphoreGive(mtx);
}

void logoutAll() {
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (auto& s : sessions) s = "";
    saveSessions();
    xSemaphoreGive(mtx);
}
}  // namespace auth
