#include "netmgr.h"

#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_system.h>
#include <time.h>

#include "auth.h"
#include "config.h"

namespace net {
static DNSServer dns;
static bool dnsOn = false;
static bool apOn = false;
static bool recovery = false;
static String apName, host;
static enum { IDLE, CONNECTING, OK, FAIL } cstate = IDLE;
static uint32_t connectStarted = 0;
static uint32_t lastConnectedMs = 0;
static uint32_t apStopAt = 0;  // keep the AP a little after a successful setup
static String pendingSsid, pendingPass;
static bool pendingSave = false;
static bool mdnsOn = false;
static Preferences rp;

static void startAp() {
    if (apOn) return;
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
    WiFi.softAP(apName.c_str());  // open: the web UI still asks for the login
    dns.setErrorReplyCode(DNSReplyCode::NoError);
    dnsOn = dns.start(53, "*", IPAddress(192, 168, 4, 1));
    apOn = true;
    log_i("AP %s started", apName.c_str());
}

static void stopAp() {
    if (!apOn) return;
    if (dnsOn) dns.stop();
    dnsOn = false;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    apOn = false;
    log_i("AP stopped");
}

static void startMdns() {
    if (mdnsOn) return;
    if (MDNS.begin(host.c_str())) {
        MDNS.addService("http", "tcp", 80);
        mdnsOn = true;
    }
}

void applyTimezone() {
    config::lock();
    String tz = config::s.tz;
    config::unlock();
    configTzTime(tz.c_str(), "pool.ntp.org", "time.google.com", "time.cloudflare.com");
}

// Three resets within ~10 s of each other enter recovery mode. Only the RST
// button and power-on count: a brownout or crash loop must not open setup.
static void checkTripleReset() {
    rp.begin("rst", false);
    esp_reset_reason_t why = esp_reset_reason();
    if (why != ESP_RST_POWERON && why != ESP_RST_EXT) {
        rp.putUInt("n", 0);
        return;
    }
    uint32_t n = rp.getUInt("n", 0) + 1;
    rp.putUInt("n", n);
    if (n >= 3) {
        recovery = true;
        rp.putUInt("n", 0);
        log_w("recovery mode");
    }
}

void begin() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char suffix[8];
    snprintf(suffix, sizeof(suffix), "%02x%02x", mac[4], mac[5]);
    apName = String("ESP32-Camera-") + suffix;
    apName.toUpperCase();
    apName.replace("ESP32-CAMERA-", "ESP32-Camera-");
    host = String("camera-") + suffix;

    checkTripleReset();
    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.setHostname(host.c_str());
    WiFi.setSleep(false);  // much smoother streaming

    String ssid = config::wifiSsid();
    if (!ssid.length() || recovery) startAp();
    if (ssid.length()) {
        WiFi.mode(apOn ? WIFI_AP_STA : WIFI_STA);
        WiFi.begin(ssid.c_str(), config::wifiPass().c_str());
        cstate = CONNECTING;
        connectStarted = millis();
    }
    applyTimezone();
}

void connect(const String& ssid, const String& pass, bool save) {
    pendingSsid = ssid;
    pendingPass = pass;
    pendingSave = save;
    if (!apOn) WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, false);
    delay(50);
    WiFi.begin(ssid.c_str(), pass.c_str());
    cstate = CONNECTING;
    connectStarted = millis();
}

void loop() {
    if (dnsOn) dns.processNextRequest();
    uint32_t now = millis();

    // Clear the triple-reset counter once the device has run for a while
    static bool rstCleared = false;
    if (!rstCleared && now > 10000) {
        rstCleared = true;
        if (!recovery) rp.putUInt("n", 0);
    }

    bool up = WiFi.status() == WL_CONNECTED;
    if (up) {
        lastConnectedMs = now;
        startMdns();
        if (cstate == CONNECTING) {
            cstate = OK;
            if (pendingSave && pendingSsid.length()) {
                config::setWifi(pendingSsid, pendingPass);
                pendingSave = false;
            }
            // Leave the AP up for a few minutes, so the setup page can show
            // the new address to the phone that is still connected to it
            if (apOn) apStopAt = now + 180000;
            // Warning level, so it shows in the default serial log: a weak
            // signal (below about -75 dBm) is the usual cause of a slow camera
            log_w("connected, ip %s, signal %d dBm, channel %d", WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
        }
        // The AP was only a fallback: close it a minute after the home network
        // is back, once nobody is connected to it
        if (apOn && !setupMode() && !recovery) {
            if (!apStopAt) apStopAt = now + 60000;
            if (now > apStopAt) {
                if (WiFi.softAPgetStationNum() == 0) {
                    stopAp();
                    apStopAt = 0;
                } else {
                    apStopAt = now + 60000;
                }
            }
        }
    } else {
        if (cstate == CONNECTING && now - connectStarted > 25000) {
            cstate = FAIL;
            // Go back to the saved network if the new one didn't work
            if (pendingSsid.length()) {
                pendingSsid = "";
                String saved = config::wifiSsid();
                if (saved.length()) WiFi.begin(saved.c_str(), config::wifiPass().c_str());
            }
        }
        // Home network gone for a minute: open the AP so the camera can be reached
        if (!apOn && config::wifiSsid().length() && now - lastConnectedMs > 60000 && now > 60000) {
            startAp();
        }
        apStopAt = 0;
    }
}

bool setupMode() { return config::wifiSsid().length() == 0 || !auth::configured(); }
bool recoveryMode() { return recovery; }
void endRecovery() { recovery = false; }
bool apActive() { return apOn; }
bool staConnected() { return WiFi.status() == WL_CONNECTED; }
String apSsid() { return apName; }
String hostname() { return host; }
String ip() { return staConnected() ? WiFi.localIP().toString() : String(""); }

const char* connectState() {
    switch (cstate) {
        case CONNECTING: return "connecting";
        case OK: return "ok";
        case FAIL: return "fail";
        default: return "idle";
    }
}

void startScan() {
    if (WiFi.scanComplete() == WIFI_SCAN_RUNNING) return;
    if (WiFi.getMode() == WIFI_AP) WiFi.mode(WIFI_AP_STA);
    WiFi.scanNetworks(true, false);
}

bool scanResults(JsonArray out) {
    int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING) return false;
    if (n == WIFI_SCAN_FAILED) {
        startScan();
        return false;
    }
    // Strongest first, one entry per network name
    for (int i = 0; i < n; i++) {
        String s = WiFi.SSID(i);
        if (!s.length()) continue;
        bool dup = false;
        for (JsonObject o : out)
            if (o["ssid"] == s) dup = true;
        if (dup) continue;
        JsonObject o = out.add<JsonObject>();
        o["ssid"] = s;
        o["rssi"] = WiFi.RSSI(i);
        o["lock"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    }
    WiFi.scanDelete();
    return true;
}

void status(JsonObject o) {
    o["connected"] = staConnected();
    o["ssid"] = staConnected() ? WiFi.SSID() : config::wifiSsid();
    o["rssi"] = staConnected() ? WiFi.RSSI() : 0;
    o["ip"] = ip();
    o["host"] = host + ".local";
    o["ap"] = apOn;
    o["apSsid"] = apName;
    o["mac"] = WiFi.macAddress();
}
}  // namespace net
