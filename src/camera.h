// Camera driver wrapper (OV2640, OV3660, ...) and the frame hub: one task grabs
// JPEG frames and every consumer (live streams, motion detector, recorder)
// copies the latest one.
#pragma once
#include <Arduino.h>

#include "config.h"

namespace cam {
bool begin();
bool ok();
const char* sensor();  // "OV2640", "OV3660", ... ("" before init)
int maxFramesize();    // largest framesize_t usable with this sensor
void apply(const CameraSettings& c);  // push settings to the sensor

// Copies the newest frame if it is newer than `seq`. Grows `buf` (PSRAM) as
// needed. Returns the frame length, or 0 when there is no newer frame yet.
size_t copyLatest(uint8_t*& buf, size_t& cap, uint32_t& seq);
// Waits up to `timeoutMs` for a frame newer than `seq`, then copies it.
size_t waitFrame(uint8_t*& buf, size_t& cap, uint32_t& seq, uint32_t timeoutMs);

// Consumers announce that they need frames; the grabber idles otherwise.
void addViewer();
void removeViewer();
int viewers();
void touch();  // a one-off frame is wanted soon (snapshot, motion warm-up)

int width();
int height();
float fps();  // measured grab rate

void setLamp(int percent);  // flash LED (no-op on boards without one)
int lamp();
void setStatusLed(bool on);  // red status LED, if the board has one
}  // namespace cam
