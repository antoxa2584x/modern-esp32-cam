// Persistent settings (NVS). Everything the web UI can change lives in one
// Settings struct, stored as JSON so new fields get their defaults on upgrade.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif
// Relay server and its registration code; both can be baked in at build time
// (RELAY_HOST / RELAY_TOKEN environment variables, see platformio.ini) or
// typed in the UI.
#ifndef RELAY_TOKEN
#define RELAY_TOKEN ""
#endif
#ifndef RELAY_HOST
#define RELAY_HOST ""
#endif

struct CameraSettings {
    int framesize = 9;     // FRAMESIZE_SVGA (800x600)
    int quality = 12;      // JPEG 4..40, lower = better
    int brightness = 0;    // -2..2
    int contrast = 0;      // -2..2
    int saturation = 0;    // -2..2
    int special = 0;       // 0 none .. 6 sepia
    bool awb = true;
    bool awbGain = true;
    int wbMode = 0;        // 0 auto, 1 sunny, 2 cloudy, 3 office, 4 home
    bool aec = true;
    bool aec2 = false;     // night (DSP) exposure
    int aeLevel = 0;       // -2..2
    int aecValue = 300;    // 0..1200, manual exposure
    bool agc = true;
    int agcGain = 0;       // 0..30, manual gain
    int gainCeiling = 2;   // 0..6 (2x..128x)
    bool bpc = false;
    bool wpc = true;
    bool rawGma = true;
    bool lenc = true;
    bool hmirror = false;
    bool vflip = false;
    bool dcw = true;
    int rotate = 0;        // 0/90/180/270, applied by the browser
};

struct MotionSettings {
    int sensitivity = 3;   // 1..5
    int postSeconds = 10;  // keep recording after the last motion
    int preSeconds = 3;    // seconds kept from before the motion
    int maxClipSeconds = 300;
    int fps = 10;          // recording frame rate
    bool lampOnRecord = false;
};

struct FaceSettings {
    bool enabled = false;  // look for faces (boards with HAS_FACES only)
    int accuracy = 2;      // 1 recognises more readily .. 3 is strict
};

struct Settings {
    String name = "Камера";
    String tz = "EET-2EEST,M3.5.0/3,M10.5.0/4";  // Kyiv
    bool security = false;
    CameraSettings cam;
    MotionSettings motion;
    FaceSettings faces;
    bool remoteEnabled = false;
    String remoteHost = RELAY_HOST;
    String remoteToken = RELAY_TOKEN;  // write-only from the UI
    bool remoteTls = true;
    bool remoteInsecure = false;  // skip TLS certificate check
    String remoteId;              // random, the path of the remote link
    String remoteKey;             // secret that proves this camera to the server
    bool statusLed = true;
    String theme = "purple";  // web UI colour scheme
};

namespace config {
extern Settings s;

void begin();          // load from NVS (and fill in a remote id/key if missing)
void save();           // write to NVS
void lock();           // guards the String fields shared between tasks
void unlock();

void toJson(JsonObject o, bool withSecrets);
// Merges the given fields; returns flags of what changed.
enum Changed : uint32_t { CH_CAMERA = 1, CH_MOTION = 2, CH_REMOTE = 4, CH_TIME = 8, CH_OTHER = 16, CH_FACES = 32 };
uint32_t fromJson(JsonObjectConst o);

String randomToken(size_t chars);  // [a-z0-9]

// Wi-Fi credentials
String wifiSsid();
String wifiPass();
void setWifi(const String& ssid, const String& pass);

// Counts boots in quick succession (for the triple-reset recovery mode).
uint32_t bootCount();
}  // namespace config
