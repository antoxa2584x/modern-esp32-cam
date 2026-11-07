// Minimal MJPEG AVI writer/reader. Files play in VLC and most desktop players;
// the web UI reads single frames through the idx1 index for its own player.
//
// Layout: fixed 512-byte header (RIFF/hdrl/JUNK), LIST movi at 512, then idx1.
#pragma once
#include <Arduino.h>
#include <FS.h>

namespace avi {
static const uint32_t MOVI_LIST = 512;  // offset of "LIST....movi"

class Writer {
  public:
    bool begin(fs::FS& fs, const String& path, int width, int height, int fps);
    bool addFrame(const uint8_t* jpg, size_t len);
    // realFps: frames / real seconds, so playback runs at the recorded speed
    bool finish(float realFps);
    void abort();
    uint32_t frames() const { return count; }
    bool isOpen() const { return (bool)file; }

  private:
    bool writeHeader(float fps);
    fs::File file;
    int w = 0, h = 0;
    uint32_t count = 0;
    uint32_t moviBytes = 4;  // the "movi" fourcc
    uint32_t maxFrame = 0;
    uint32_t* index = nullptr;  // pairs of (offset, size)
    uint32_t indexCap = 0;
};

struct Info {
    uint32_t frames = 0;
    float fps = 0;
    int width = 0, height = 0;
    uint32_t idx1 = 0;  // file offset of the idx1 entries (after the chunk header)
};

bool readInfo(fs::File& f, Info& info);
// File offset and size of frame n's JPEG data.
bool frameAt(fs::File& f, const Info& info, uint32_t n, uint32_t& offset, uint32_t& size);
// Rebuilds the index and header of a file whose recording was cut off.
// Returns the number of frames recovered.
uint32_t repair(fs::FS& fs, const String& path, int fps);
}  // namespace avi
