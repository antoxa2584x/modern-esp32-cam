#include "avi.h"

namespace avi {
static void put32(uint8_t* p, uint32_t v) {
    p[0] = v;
    p[1] = v >> 8;
    p[2] = v >> 16;
    p[3] = v >> 24;
}
static void put16(uint8_t* p, uint16_t v) {
    p[0] = v;
    p[1] = v >> 8;
}
static uint32_t get32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static void fourcc(uint8_t* p, const char* s) { memcpy(p, s, 4); }

// Fills the 524-byte prefix (header + "LIST size movi").
static void buildHeader(uint8_t* hd, int w, int h, float fps, uint32_t frames, uint32_t maxFrame,
                        uint32_t moviBytes, uint32_t riffSize) {
    memset(hd, 0, MOVI_LIST + 12);
    if (fps <= 0) fps = 1;
    uint32_t usPerFrame = (uint32_t)(1000000.0f / fps);
    uint32_t rate = (uint32_t)(fps * 1000.0f + 0.5f);

    fourcc(hd + 0, "RIFF");
    put32(hd + 4, riffSize);
    fourcc(hd + 8, "AVI ");
    fourcc(hd + 12, "LIST");
    put32(hd + 16, 192);
    fourcc(hd + 20, "hdrl");
    // avih
    fourcc(hd + 24, "avih");
    put32(hd + 28, 56);
    put32(hd + 32, usPerFrame);
    put32(hd + 36, (uint32_t)(maxFrame * fps));
    put32(hd + 40, 0);
    put32(hd + 44, 0x10);  // AVIF_HASINDEX
    put32(hd + 48, frames);
    put32(hd + 52, 0);
    put32(hd + 56, 1);
    put32(hd + 60, maxFrame);
    put32(hd + 64, w);
    put32(hd + 68, h);
    // LIST strl
    fourcc(hd + 88, "LIST");
    put32(hd + 92, 116);
    fourcc(hd + 96, "strl");
    // strh
    fourcc(hd + 100, "strh");
    put32(hd + 104, 56);
    fourcc(hd + 108, "vids");
    fourcc(hd + 112, "MJPG");
    put32(hd + 116, 0);
    put32(hd + 120, 0);
    put32(hd + 124, 0);
    put32(hd + 128, 1000);  // scale
    put32(hd + 132, rate);  // rate: fps = rate / scale
    put32(hd + 136, 0);
    put32(hd + 140, frames);
    put32(hd + 144, maxFrame);
    put32(hd + 148, 0xFFFFFFFF);
    put32(hd + 152, 0);
    put16(hd + 160, w);
    put16(hd + 162, h);
    // strf (BITMAPINFOHEADER)
    fourcc(hd + 164, "strf");
    put32(hd + 168, 40);
    put32(hd + 172, 40);
    put32(hd + 176, w);
    put32(hd + 180, h);
    put16(hd + 184, 1);
    put16(hd + 186, 24);
    fourcc(hd + 188, "MJPG");
    put32(hd + 192, w * h * 3);
    // JUNK up to the movi list
    fourcc(hd + 212, "JUNK");
    put32(hd + 216, MOVI_LIST - 212 - 8);
    fourcc(hd + MOVI_LIST, "LIST");
    put32(hd + MOVI_LIST + 4, moviBytes);
    fourcc(hd + MOVI_LIST + 8, "movi");
}

bool Writer::begin(fs::FS& fs, const String& path, int width, int height, int fps) {
    file = fs.open(path, FILE_WRITE);
    if (!file) return false;
    w = width;
    h = height;
    count = 0;
    moviBytes = 4;
    maxFrame = 0;
    if (!index) {
        indexCap = 4096;
        index = (uint32_t*)ps_malloc(indexCap * 8);
        if (!index) {
            file.close();
            return false;
        }
    }
    return writeHeader(fps);
}

bool Writer::writeHeader(float fps) {
    uint8_t hd[MOVI_LIST + 12];
    uint32_t riff = MOVI_LIST + 8 + moviBytes + 8 + count * 16 - 8;
    buildHeader(hd, w, h, fps, count, maxFrame, moviBytes, riff);
    file.seek(0);
    return file.write(hd, sizeof(hd)) == sizeof(hd);
}

bool Writer::addFrame(const uint8_t* jpg, size_t len) {
    if (!file) return false;
    if (count >= indexCap) {
        uint32_t ncap = indexCap * 2;
        uint32_t* ni = (uint32_t*)heap_caps_realloc(index, ncap * 8, MALLOC_CAP_SPIRAM);
        if (!ni) return false;
        index = ni;
        indexCap = ncap;
    }
    uint32_t pad = len & 1;
    uint8_t ch[8];
    fourcc(ch, "00dc");
    put32(ch + 4, len);
    if (file.write(ch, 8) != 8) return false;
    if (file.write(jpg, len) != len) return false;
    if (pad) {
        uint8_t z = 0;
        file.write(&z, 1);
    }
    index[count * 2] = moviBytes;  // offset from the "movi" fourcc
    index[count * 2 + 1] = len;
    moviBytes += 8 + len + pad;
    if (len > maxFrame) maxFrame = len;
    count++;
    return true;
}

bool Writer::finish(float realFps) {
    if (!file) return false;
    bool ok = true;
    uint8_t hd[8];
    fourcc(hd, "idx1");
    put32(hd + 4, count * 16);
    file.seek(MOVI_LIST + 8 + moviBytes);
    ok &= file.write(hd, 8) == 8;
    uint8_t e[16 * 32];
    uint32_t i = 0;
    while (i < count && ok) {
        uint32_t n = 0;
        for (; n < 32 && i < count; n++, i++) {
            fourcc(e + n * 16, "00dc");
            put32(e + n * 16 + 4, 0x10);  // keyframe
            put32(e + n * 16 + 8, index[i * 2]);
            put32(e + n * 16 + 12, index[i * 2 + 1]);
        }
        ok &= file.write(e, n * 16) == n * 16;
    }
    ok &= writeHeader(realFps);
    file.close();
    return ok;
}

void Writer::abort() {
    if (file) file.close();
}

bool readInfo(fs::File& f, Info& info) {
    uint8_t hd[MOVI_LIST + 12];
    f.seek(0);
    if (f.read(hd, sizeof(hd)) != sizeof(hd)) return false;
    if (memcmp(hd, "RIFF", 4) || memcmp(hd + 8, "AVI ", 4) || memcmp(hd + MOVI_LIST + 8, "movi", 4)) return false;
    info.frames = get32(hd + 48);
    info.width = get32(hd + 64);
    info.height = get32(hd + 68);
    uint32_t scale = get32(hd + 128), rate = get32(hd + 132);
    info.fps = scale ? (float)rate / scale : 10;
    uint32_t movi = get32(hd + MOVI_LIST + 4);
    info.idx1 = MOVI_LIST + 8 + movi + 8;
    return info.frames > 0 && info.idx1 + info.frames * 16 <= f.size();
}

bool frameAt(fs::File& f, const Info& info, uint32_t n, uint32_t& offset, uint32_t& size) {
    if (n >= info.frames) return false;
    uint8_t e[16];
    f.seek(info.idx1 + n * 16);
    if (f.read(e, 16) != 16) return false;
    offset = MOVI_LIST + 8 + get32(e + 8) + 8;
    size = get32(e + 12);
    return offset + size <= f.size();
}

uint32_t repair(fs::FS& fs, const String& path, int fps) {
    fs::File f = fs.open(path, "r+");
    if (!f) return 0;
    uint32_t fileSize = f.size();
    uint32_t pos = MOVI_LIST + 12;
    uint32_t cap = 4096, count = 0, maxFrame = 0;
    uint32_t* idx = (uint32_t*)ps_malloc(cap * 8);
    if (!idx) {
        f.close();
        return 0;
    }
    uint8_t ch[8];
    while (pos + 8 <= fileSize) {
        f.seek(pos);
        if (f.read(ch, 8) != 8 || memcmp(ch, "00dc", 4)) break;
        uint32_t len = get32(ch + 4);
        if (pos + 8 + len > fileSize) break;
        if (count >= cap) {
            uint32_t* ni = (uint32_t*)heap_caps_realloc(idx, cap * 2 * 8, MALLOC_CAP_SPIRAM);
            if (!ni) break;
            idx = ni;
            cap *= 2;
        }
        idx[count * 2] = pos - (MOVI_LIST + 8);
        idx[count * 2 + 1] = len;
        if (len > maxFrame) maxFrame = len;
        count++;
        pos += 8 + len + (len & 1);
    }
    if (count) {
        uint32_t moviBytes = pos - (MOVI_LIST + 8);
        uint8_t hd[8];
        fourcc(hd, "idx1");
        put32(hd + 4, count * 16);
        f.seek(pos);
        f.write(hd, 8);
        uint8_t e[16];
        for (uint32_t i = 0; i < count; i++) {
            fourcc(e, "00dc");
            put32(e + 4, 0x10);
            put32(e + 8, idx[i * 2]);
            put32(e + 12, idx[i * 2 + 1]);
            f.write(e, 16);
        }
        // Width/height come from the old header (written at the start)
        uint8_t old[72];
        f.seek(0);
        f.read(old, sizeof(old));
        uint8_t full[MOVI_LIST + 12];
        uint32_t riff = pos + 8 + count * 16 - 8;
        buildHeader(full, get32(old + 64), get32(old + 68), fps, count, maxFrame, moviBytes, riff);
        f.seek(0);
        f.write(full, sizeof(full));
    }
    free(idx);
    f.close();
    return count;
}
}  // namespace avi
