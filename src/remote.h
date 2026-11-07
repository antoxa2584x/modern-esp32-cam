// Remote access through a relay server (relay/ in this repo). The camera keeps
// one outgoing WebSocket open to wss://<host>/cam-relay/ws; the relay sends
// browser requests down it and the camera forwards each one to its own web
// servers on 127.0.0.1 (80 UI/API, 81 video), so everything works remotely exactly as on the LAN.
//
// Binary frames: [type u8][stream id u16 BE][payload]
//   1 OPEN (payload: local port u16 BE), 2 DATA, 3 CLOSE (both ways), 4 PAUSE, 5 RESUME (relay -> camera)
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace remote {
void begin();
void restart();  // settings changed
void status(JsonObject o);
}  // namespace remote
