// Wi-Fi: joins the home network; opens its own access point for the first
// setup, when the home network can't be reached, or in recovery mode
// (RST pressed three times in a row).
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace net {
void begin();
void loop();

bool setupMode();     // no Wi-Fi configured yet
bool recoveryMode();  // triple reset: login and Wi-Fi may be set again
bool apActive();
bool staConnected();
String apSsid();
String hostname();  // camera-xxxx (mDNS: camera-xxxx.local)
String ip();

// Tries new credentials; the result shows in connectState().
void connect(const String& ssid, const String& pass, bool save);
// "idle" | "connecting" | "ok" | "fail"
const char* connectState();

void startScan();
// Returns false while a scan is still running.
bool scanResults(JsonArray out);

void status(JsonObject o);
void endRecovery();
void applyTimezone();
}  // namespace net
