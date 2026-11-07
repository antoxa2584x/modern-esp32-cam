#include "storage.h"

#include <SD_MMC.h>
#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <vector>

#include "board.h"

namespace store {
static const char* MOUNT = "/sdcard";
static bool isMounted = false;
static uint64_t total = 0, used = 0;
static SemaphoreHandle_t mtx;

bool begin() {
    mtx = xSemaphoreCreateRecursiveMutex();
    // The board's own pull-ups on CMD/CLK/D0 are too weak for some card
    // slots: the card then never answers (0x107). Help with the internal ones.
    pinMode(SD_CMD_PIN, INPUT_PULLUP);
    pinMode(SD_CLK_PIN, INPUT_PULLUP);
    pinMode(SD_D0_PIN, INPUT_PULLUP);
#if SOC_SDMMC_USE_GPIO_MATRIX
    SD_MMC.setPins(SD_CLK_PIN, SD_CMD_PIN, SD_D0_PIN);  // the ESP32-S3 can route SDMMC to any pins
#endif
    // 1-bit mode leaves GPIO4 free for the flash lamp
    bool ok = SD_MMC.begin(MOUNT, true);
    if (!ok) {
        SD_MMC.end();
        delay(200);
        ok = SD_MMC.begin(MOUNT, true, false, SDMMC_FREQ_PROBING);
    }
    if (!ok) {
        log_w("no SD card");
        return false;
    }
    log_w("SD card %llu MB", SD_MMC.cardSize() >> 20);
    if (SD_MMC.cardType() == CARD_NONE) return false;
    isMounted = true;
    if (!SD_MMC.exists("/rec")) SD_MMC.mkdir("/rec");
    total = SD_MMC.totalBytes();
    refreshUsage();
    return true;
}

bool mounted() { return isMounted; }
fs::FS& fs() { return SD_MMC; }
uint64_t totalBytes() { return total; }
uint64_t usedBytes() { return used; }
void refreshUsage() {
    if (isMounted) used = SD_MMC.usedBytes();
}

static bool allDigits(const String& s, int from, int len) {
    if ((int)s.length() < from + len) return false;
    for (int i = from; i < from + len; i++)
        if (!isdigit((unsigned char)s[i])) return false;
    return true;
}

static bool validFile(const String& f) {
    // HHMMSS_<1-5 digits>_<m|r>.avi
    if (!allDigits(f, 0, 6) || f.length() < 14 || f[6] != '_') return false;
    int u = f.indexOf('_', 7);
    if (u < 8 || u > 12 || !allDigits(f, 7, u - 7)) return false;
    String rest = f.substring(u + 1);
    return rest == "m.avi" || rest == "r.avi";
}

bool validName(const String& rel) {
    if (rel.length() < 23 || rel[8] != '/' || !allDigits(rel, 0, 8)) return false;
    return validFile(rel.substring(9));
}

String pathOf(const String& rel) { return "/rec/" + rel; }

static std::vector<String> listDir(const String& vfsPath, bool dirs) {
    std::vector<String> out;
    DIR* d = opendir(vfsPath.c_str());
    if (!d) return out;
    while (struct dirent* e = readdir(d)) {
        String n = e->d_name;
        bool isDir = e->d_type == DT_DIR;
        if (dirs && isDir && n.length() == 8 && allDigits(n, 0, 8)) out.push_back(n);
        if (!dirs && !isDir && validFile(n)) out.push_back(n);
    }
    closedir(d);
    std::sort(out.begin(), out.end(), [](const String& a, const String& b) { return a < b; });
    return out;
}

static std::vector<String> days() { return listDir(String(MOUNT) + "/rec", true); }
static std::vector<String> files(const String& day) { return listDir(String(MOUNT) + "/rec/" + day, false); }

static void addEntry(JsonArray out, const String& day, const String& f) {
    JsonObject o = out.add<JsonObject>();
    o["f"] = day + "/" + f;
    o["d"] = day;
    o["t"] = f.substring(0, 6);
    int u = f.indexOf('_', 7);
    o["dur"] = f.substring(7, u).toInt();
    o["k"] = String(f[u + 1]);
}

void listDays(JsonArray out) {
    if (!isMounted) return;
    xSemaphoreTakeRecursive(mtx, portMAX_DELAY);
    auto ds = days();
    for (auto it = ds.rbegin(); it != ds.rend(); ++it) {
        auto fl = files(*it);
        if (fl.empty()) continue;
        JsonObject o = out.add<JsonObject>();
        o["d"] = *it;
        o["n"] = fl.size();
    }
    xSemaphoreGiveRecursive(mtx);
}

void listDay(const String& day, JsonArray out) {
    if (!isMounted || day.length() != 8 || !allDigits(day, 0, 8)) return;
    xSemaphoreTakeRecursive(mtx, portMAX_DELAY);
    auto fl = files(day);
    for (auto it = fl.rbegin(); it != fl.rend(); ++it) addEntry(out, day, *it);
    xSemaphoreGiveRecursive(mtx);
}

void recent(int n, JsonArray out) {
    if (!isMounted) return;
    xSemaphoreTakeRecursive(mtx, portMAX_DELAY);
    auto ds = days();
    for (auto d = ds.rbegin(); d != ds.rend() && n > 0; ++d) {
        auto fl = files(*d);
        for (auto it = fl.rbegin(); it != fl.rend() && n > 0; ++it, --n) addEntry(out, *d, *it);
    }
    xSemaphoreGiveRecursive(mtx);
}

static uint32_t fileSize(const String& vfsPath) {
    struct stat st;
    return stat(vfsPath.c_str(), &st) == 0 ? st.st_size : 0;
}

bool remove(const String& rel) {
    if (!isMounted || !validName(rel)) return false;
    xSemaphoreTakeRecursive(mtx, portMAX_DELAY);
    String vfs = String(MOUNT) + "/rec/" + rel;
    uint32_t sz = fileSize(vfs);
    bool ok = ::remove(vfs.c_str()) == 0;
    if (ok) {
        used = used > sz ? used - sz : 0;
        // Fails (harmlessly) while the day still has files: cheaper than listing it
        rmdir((String(MOUNT) + "/rec/" + rel.substring(0, 8)).c_str());
    }
    xSemaphoreGiveRecursive(mtx);
    return ok;
}

uint64_t freeBytes() { return used >= total ? 0 : total - used; }

// "Delete all" runs in its own task: thousands of files take a while, and
// neither the web server nor the recorder may stall meanwhile
static volatile bool clearRunning = false;
static volatile int clearedCount = 0;

static void clearTask(void*) {
    int n = 0;
    for (auto& d : days())
        for (auto& f : files(d))
            if (remove(d + "/" + f)) clearedCount = ++n;  // locks per file
    refreshUsage();
    log_i("cleared %d recordings", n);
    clearRunning = false;
    vTaskDelete(nullptr);
}

bool startClear() {
    if (!isMounted || clearRunning) return false;
    clearRunning = true;
    clearedCount = 0;
    if (xTaskCreatePinnedToCore(clearTask, "clear", 6144, nullptr, 2, nullptr, 0) != pdPASS) {
        clearRunning = false;
        return false;
    }
    return true;
}

bool clearing() { return clearRunning; }
int clearedSoFar() { return clearedCount; }

int ensureSpace(const String& keep) {
    if (!isMounted || !total || clearRunning) return 0;
    // Keep 5% of the card (at least 100 MB) free for the next clips
    uint64_t need = std::max<uint64_t>(total / 20, 100ULL * 1024 * 1024);
    if (freeBytes() >= need) return 0;
    int deleted = 0;
    // Oldest first; days named 0000xxxx (clock unknown) sort first.
    // remove() locks per file, so listings stay responsive meanwhile.
    for (auto& d : days()) {
        for (auto& f : files(d)) {
            if (freeBytes() >= need) break;
            String rel = d + "/" + f;
            if (pathOf(rel) == keep) continue;
            if (remove(rel)) {
                deleted++;
                log_i("deleted old recording %s", rel.c_str());
            }
        }
        if (freeBytes() >= need) break;
    }
    // The estimate ignores cluster rounding: read the real figure
    if (deleted) refreshUsage();
    if (freeBytes() < need) log_w("card still low on space after deleting %d recordings", deleted);
    return deleted;
}
}  // namespace store
