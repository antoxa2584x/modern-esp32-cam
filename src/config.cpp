#include "config.h"

#include <Preferences.h>
#include <bootloader_random.h>
#include <esp_random.h>

namespace config {
Settings s;

static Preferences prefs;
static SemaphoreHandle_t mtx;
static uint32_t boots = 0;

void lock() { xSemaphoreTakeRecursive(mtx, portMAX_DELAY); }
void unlock() { xSemaphoreGiveRecursive(mtx); }

String randomToken(size_t chars) {
    static const char abc[] = "abcdefghijklmnopqrstuvwxyz0123456789";
    String out;
    out.reserve(chars);
    for (size_t i = 0; i < chars; i++) out += abc[esp_random() % 36];
    return out;
}

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

void toJson(JsonObject o, bool withSecrets) {
    lock();
    o["name"] = s.name;
    o["tz"] = s.tz;
    o["security"] = s.security;
    o["statusLed"] = s.statusLed;
    o["theme"] = s.theme;
    JsonObject c = o["camera"].to<JsonObject>();
    c["framesize"] = s.cam.framesize;
    c["quality"] = s.cam.quality;
    c["brightness"] = s.cam.brightness;
    c["contrast"] = s.cam.contrast;
    c["saturation"] = s.cam.saturation;
    c["special"] = s.cam.special;
    c["awb"] = s.cam.awb;
    c["awbGain"] = s.cam.awbGain;
    c["wbMode"] = s.cam.wbMode;
    c["aec"] = s.cam.aec;
    c["aec2"] = s.cam.aec2;
    c["aeLevel"] = s.cam.aeLevel;
    c["aecValue"] = s.cam.aecValue;
    c["agc"] = s.cam.agc;
    c["agcGain"] = s.cam.agcGain;
    c["gainCeiling"] = s.cam.gainCeiling;
    c["bpc"] = s.cam.bpc;
    c["wpc"] = s.cam.wpc;
    c["rawGma"] = s.cam.rawGma;
    c["lenc"] = s.cam.lenc;
    c["hmirror"] = s.cam.hmirror;
    c["vflip"] = s.cam.vflip;
    c["dcw"] = s.cam.dcw;
    c["rotate"] = s.cam.rotate;
    JsonObject m = o["motion"].to<JsonObject>();
    m["sensitivity"] = s.motion.sensitivity;
    m["postSeconds"] = s.motion.postSeconds;
    m["preSeconds"] = s.motion.preSeconds;
    m["maxClipSeconds"] = s.motion.maxClipSeconds;
    m["fps"] = s.motion.fps;
    m["lampOnRecord"] = s.motion.lampOnRecord;
    JsonObject f = o["faces"].to<JsonObject>();
    f["enabled"] = s.faces.enabled;
    f["accuracy"] = s.faces.accuracy;
    JsonObject r = o["remote"].to<JsonObject>();
    r["enabled"] = s.remoteEnabled;
    r["host"] = s.remoteHost;
    r["tls"] = s.remoteTls;
    r["insecure"] = s.remoteInsecure;
    r["id"] = s.remoteId;
    r["tokenSet"] = s.remoteToken.length() > 0;
    if (withSecrets) {
        r["key"] = s.remoteKey;
        r["token"] = s.remoteToken;
    }
    unlock();
}

// Copies o[key] into dst if present and different; sets `changed`.
template <typename T>
static void take(JsonObjectConst o, const char* key, T& dst, bool& changed) {
    JsonVariantConst v = o[key];
    if (v.isNull() || !v.is<T>()) return;
    T nv = v.as<T>();
    if (!(nv == dst)) {
        dst = nv;
        changed = true;
    }
}
static void takeInt(JsonObjectConst o, const char* key, int& dst, int lo, int hi, bool& changed) {
    JsonVariantConst v = o[key];
    if (v.isNull() || !(v.is<int>() || v.is<float>())) return;
    int nv = clampi(v.as<int>(), lo, hi);
    if (nv != dst) {
        dst = nv;
        changed = true;
    }
}
static void takeStr(JsonObjectConst o, const char* key, String& dst, size_t maxLen, bool& changed) {
    JsonVariantConst v = o[key];
    if (!v.is<const char*>()) return;
    String nv = v.as<const char*>();
    nv.trim();
    if (nv.length() > maxLen) nv = nv.substring(0, maxLen);
    if (nv != dst) {
        dst = nv;
        changed = true;
    }
}

uint32_t fromJson(JsonObjectConst o) {
    uint32_t ch = 0;
    bool c = false;
    lock();
    takeStr(o, "name", s.name, 40, c);
    take(o, "security", s.security, c);
    take(o, "statusLed", s.statusLed, c);
    {
        String th = s.theme;
        bool tc = false;
        takeStr(o, "theme", th, 16, tc);
        static const char* THEMES[] = {"purple", "green", "blue", "amber", "graphite", "light"};
        for (const char* t : THEMES)
            if (tc && th == t) {
                s.theme = th;
                c = true;
            }
    }
    if (c) ch |= CH_OTHER;
    c = false;
    takeStr(o, "tz", s.tz, 60, c);
    if (c) ch |= CH_TIME;

    JsonObjectConst cam = o["camera"];
    if (!cam.isNull()) {
        c = false;
        CameraSettings& k = s.cam;
        takeInt(cam, "framesize", k.framesize, 5, 17, c);  // QVGA..QXGA, capped to the sensor in cam::apply
        takeInt(cam, "quality", k.quality, 4, 40, c);
        takeInt(cam, "brightness", k.brightness, -2, 2, c);
        takeInt(cam, "contrast", k.contrast, -2, 2, c);
        takeInt(cam, "saturation", k.saturation, -2, 2, c);
        takeInt(cam, "special", k.special, 0, 6, c);
        take(cam, "awb", k.awb, c);
        take(cam, "awbGain", k.awbGain, c);
        takeInt(cam, "wbMode", k.wbMode, 0, 4, c);
        take(cam, "aec", k.aec, c);
        take(cam, "aec2", k.aec2, c);
        takeInt(cam, "aeLevel", k.aeLevel, -2, 2, c);
        takeInt(cam, "aecValue", k.aecValue, 0, 1200, c);
        take(cam, "agc", k.agc, c);
        takeInt(cam, "agcGain", k.agcGain, 0, 30, c);
        takeInt(cam, "gainCeiling", k.gainCeiling, 0, 6, c);
        take(cam, "bpc", k.bpc, c);
        take(cam, "wpc", k.wpc, c);
        take(cam, "rawGma", k.rawGma, c);
        take(cam, "lenc", k.lenc, c);
        take(cam, "hmirror", k.hmirror, c);
        take(cam, "vflip", k.vflip, c);
        take(cam, "dcw", k.dcw, c);
        int rot = k.rotate;
        takeInt(cam, "rotate", rot, 0, 270, c);
        k.rotate = (rot / 90) * 90;
        if (c) ch |= CH_CAMERA;
    }
    JsonObjectConst mo = o["motion"];
    if (!mo.isNull()) {
        c = false;
        takeInt(mo, "sensitivity", s.motion.sensitivity, 1, 5, c);
        takeInt(mo, "postSeconds", s.motion.postSeconds, 3, 120, c);
        takeInt(mo, "preSeconds", s.motion.preSeconds, 0, 5, c);
        takeInt(mo, "maxClipSeconds", s.motion.maxClipSeconds, 30, 1800, c);
        takeInt(mo, "fps", s.motion.fps, 2, 15, c);
        take(mo, "lampOnRecord", s.motion.lampOnRecord, c);
        if (c) ch |= CH_MOTION;
    }
    JsonObjectConst fa = o["faces"];
    if (!fa.isNull()) {
        c = false;
        take(fa, "enabled", s.faces.enabled, c);
        takeInt(fa, "accuracy", s.faces.accuracy, 1, 3, c);
        if (c) ch |= CH_FACES;
    }
    JsonObjectConst r = o["remote"];
    if (!r.isNull()) {
        c = false;
        take(r, "enabled", s.remoteEnabled, c);
        String host = s.remoteHost;
        takeStr(r, "host", host, 120, c);
        // Accept a pasted URL: keep only host[:port]
        host.replace("https://", "");
        host.replace("http://", "");
        int slash = host.indexOf('/');
        if (slash >= 0) host = host.substring(0, slash);
        s.remoteHost = host;
        takeStr(r, "token", s.remoteToken, 128, c);
        take(r, "tls", s.remoteTls, c);
        take(r, "insecure", s.remoteInsecure, c);
        if (c) ch |= CH_REMOTE;
    }
    unlock();
    return ch;
}

void save() {
    JsonDocument doc;
    toJson(doc.to<JsonObject>(), true);
    String out;
    serializeJson(doc, out);
    prefs.putString("cfg", out);
}

void begin() {
    mtx = xSemaphoreCreateRecursiveMutex();
    prefs.begin("cam", false);
    String raw = prefs.getString("cfg", "");
    if (raw.length()) {
        JsonDocument doc;
        if (!deserializeJson(doc, raw)) {
            fromJson(doc.as<JsonObjectConst>());
            JsonObjectConst r = doc["remote"];
            if (r["id"].is<const char*>()) s.remoteId = r["id"].as<const char*>();
            if (r["key"].is<const char*>()) s.remoteKey = r["key"].as<const char*>();
            if (r["token"].is<const char*>()) s.remoteToken = r["token"].as<const char*>();
        }
    }
    bool dirty = false;
    // Wi-Fi isn't running yet, and without it esp_random() isn't fed by the
    // radio's noise: the remote key must not be guessable
    bootloader_random_enable();
    if (s.remoteId.length() < 8) {
        s.remoteId = randomToken(10);
        dirty = true;
    }
    if (s.remoteKey.length() < 16) {
        s.remoteKey = randomToken(32);
        dirty = true;
    }
    if (!apPassword().length()) newApPassword();
    bootloader_random_disable();
    if (dirty) save();
    boots = prefs.getUInt("boots", 0) + 1;
    prefs.putUInt("boots", boots);
}

uint32_t bootCount() { return boots; }

String wifiSsid() { return prefs.getString("ssid", ""); }
String wifiPass() { return prefs.getString("wpass", ""); }
void setWifi(const String& ssid, const String& pass) {
    prefs.putString("ssid", ssid);
    prefs.putString("wpass", pass);
}

String apPassword() { return prefs.getString("appass", ""); }

void newApPassword() {
    // Easy to type on a phone: no look-alike characters (0/o, 1/l)
    static const char abc[] = "abcdefghijkmnpqrstuvwxyz23456789";
    String p;
    for (int i = 0; i < 10; i++) p += abc[esp_random() % 32];
    prefs.putString("appass", p);
}
}  // namespace config
