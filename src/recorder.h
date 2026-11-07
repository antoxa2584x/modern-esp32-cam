// Records MJPEG AVI clips to the SD card: on motion while security mode is on
// (with a few seconds from before the motion), or by hand from the live view.
#pragma once
#include <Arduino.h>

namespace rec {
void begin();
bool recording();
bool manual();
void setManual(bool on);
uint32_t elapsedMs();  // length of the current clip
String error();        // last problem in plain words ("" = fine)
// Lets the time be set from the browser when there is no internet (NTP).
bool clockKnown();
}  // namespace rec
