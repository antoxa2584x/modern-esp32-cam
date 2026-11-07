// microSD card: recordings live in /rec/<YYYYMMDD>/<HHMMSS>_<seconds>_<m|r>.avi
// (m = motion, r = recorded by hand). The oldest are deleted automatically
// when the card runs low.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <FS.h>

namespace store {
bool begin();
bool mounted();
fs::FS& fs();

uint64_t totalBytes();
uint64_t usedBytes();  // cached, refreshed by refreshUsage()
void refreshUsage();
// Deletes the oldest recordings until enough space is free. `keep` is a path
// that must not be touched (the clip being written). Returns files deleted.
int ensureSpace(const String& keep = "");

// "20261103/143025_37_m.avi" -> true; rejects anything else (no "..", etc.)
bool validName(const String& rel);
String pathOf(const String& rel);  // "/rec/" + rel

void listDays(JsonArray out);
void listDay(const String& day, JsonArray out);
void recent(int n, JsonArray out);
bool remove(const String& rel);
uint64_t freeBytes();
// Deletes every recording in the background; false if already running
bool startClear();
bool clearing();
int clearedSoFar();
}  // namespace store
