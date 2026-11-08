// Live video on port 81: /stream (MJPEG) and /snapshot (one JPEG download).
// A small blocking server, a worker task per viewer; the async server on port
// 80 can't pace a stream well. Uses the same login cookie as port 80.
#pragma once

namespace streamsrv {
static const int PORT = 81;
void begin();
// No live video while the firmware is updated (see webserver.cpp): call for
// every part of the upload; video comes back 30 s after the last one
void pause(bool on);
}  // namespace streamsrv
