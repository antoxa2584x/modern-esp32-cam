// Live video on port 81: /stream (MJPEG) and /snapshot (one JPEG download).
// A small blocking server with one task per viewer; the async server on port
// 80 can't pace a stream well. Uses the same login cookie as port 80.
#pragma once

namespace streamsrv {
static const int PORT = 81;
void begin();
}  // namespace streamsrv
