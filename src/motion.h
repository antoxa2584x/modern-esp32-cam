// Motion detector: compares a coarse brightness grid of each frame with a
// slowly adapting background. Runs only while security mode is on.
#pragma once
#include <Arduino.h>

namespace motion {
void begin();
bool running();          // security mode on and detector active
bool active();           // motion right now
uint32_t lastMotionMs(); // millis() of the last detected motion (0 = never)
int level();             // changed cells in the last sample, 0..100 (% of the trigger level)
void reset();            // re-learn the background (after camera changes)
}  // namespace motion
