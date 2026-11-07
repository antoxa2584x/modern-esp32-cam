// Web UI and JSON API on port 80 (see streamsrv for live video on port 81).
#pragma once
#include <Arduino.h>

namespace web {
void begin();
void loop();  // handles delayed reboots
}  // namespace web
