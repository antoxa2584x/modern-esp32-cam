#include "streamsrv.h"

#include <Arduino.h>
#include <lwip/sockets.h>
#include <time.h>

#include "auth.h"
#include "camera.h"

namespace streamsrv {
static const int MAX_CLIENTS = 4;
static volatile int clients = 0;
// Accepted connections for the workers. A task per request leaked ~550 bytes of
// internal RAM each time (2 blocks the task's deletion left behind): through the
// relay, a few minutes of snapshots ran the camera out and Wi-Fi and both web
// servers froze until a reboot. The workers live for good instead.
static QueueHandle_t pending;
static volatile uint32_t pausedAt = 0;  // 0: not paused

// An upload that broke off never says it ended
static bool paused() { return pausedAt && millis() - pausedAt < 30000; }

static bool sendAll(int fd, const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*)data;
    while (len) {
        int n = send(fd, p, len, 0);
        if (n <= 0) return false;
        p += n;
        len -= n;
    }
    return true;
}

static void reply(int fd, const char* status, const char* body) {
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
                     "HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", status,
                     (int)strlen(body), body);
    sendAll(fd, buf, n);
}

// A request header's value, "" if absent (the name is matched case-insensitively)
static String headerValue(const String& req, const char* name) {
    String lower = req;
    lower.toLowerCase();
    String key = String("\n") + name + ":";
    key.toLowerCase();
    int h = lower.indexOf(key);
    if (h < 0) return "";
    int end = req.indexOf('\r', h);
    String v = req.substring(h + key.length(), end < 0 ? req.length() : end);
    v.trim();
    return v;
}

// "http://192.168.0.208" or "192.168.0.208:81" -> "192.168.0.208"
static String hostPart(String s) {
    int scheme = s.indexOf("://");
    if (scheme >= 0) s = s.substring(scheme + 3);
    int colon = s.indexOf(':');
    if (colon >= 0) s = s.substring(0, colon);
    s.toLowerCase();
    return s;
}

static String cookieValue(const String& req, const char* name) {
    int h = req.indexOf("\nCookie:");
    if (h < 0) h = req.indexOf("\ncookie:");
    if (h < 0) return "";
    int end = req.indexOf('\r', h);
    String line = req.substring(h + 8, end < 0 ? req.length() : end);
    String key = String(name) + "=";
    int k = line.indexOf(key);
    while (k > 0 && line[k - 1] != ' ' && line[k - 1] != ';') k = line.indexOf(key, k + 1);
    if (k < 0) return "";
    int stop = line.indexOf(';', k);
    return line.substring(k + key.length(), stop < 0 ? line.length() : stop);
}

static int queryInt(const String& path, const char* name, int def) {
    String key = String(name) + "=";
    int q = path.indexOf('?');
    if (q < 0) return def;
    int k = path.indexOf(key, q);
    if (k < 0) return def;
    return path.substring(k + key.length()).toInt();
}

// The web UI (port 80) reads the stream and snapshots from here (port 81),
// another origin: let it, but only the camera's own page
static String corsHeaders(const String& req) {
    String origin = headerValue(req, "Origin");
    if (!origin.length() || origin.length() >= 100 || hostPart(origin) != hostPart(headerValue(req, "Host"))) return "";
    return "Access-Control-Allow-Origin: " + origin + "\r\nAccess-Control-Allow-Credentials: true\r\nVary: Origin\r\n";
}

static void stream(int fd, int maxFps, const String& req) {
    String head =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
        "Cache-Control: no-store\r\n"
        "X-Accel-Buffering: no\r\n" +
        corsHeaders(req) + "Connection: close\r\n\r\n";
    if (!sendAll(fd, head.c_str(), head.length())) return;
    uint8_t* buf = nullptr;
    size_t cap = 0;
    uint32_t seq = 0;
    uint32_t minGap = 1000 / constrain(maxFps, 1, 15);
    uint32_t last = 0;
    cam::addViewer();
    while (!paused()) {
        uint32_t since = millis() - last;
        if (since < minGap) vTaskDelay(pdMS_TO_TICKS(minGap - since));
        size_t len = cam::waitFrame(buf, cap, seq, 3000);
        if (!len) {
            // No camera frames: probe the connection so a gone viewer is noticed
            if (send(fd, "\r\n", 2, 0) <= 0) break;
            continue;
        }
        last = millis();
        char part[96];
        int n = snprintf(part, sizeof(part), "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
                         (unsigned)len);
        if (!sendAll(fd, part, n) || !sendAll(fd, buf, len) || !sendAll(fd, "\r\n", 2)) break;
    }
    cam::removeViewer();
    free(buf);
}

static void snapshot(int fd, const String& req) {
    uint8_t* buf = nullptr;
    size_t cap = 0;
    uint32_t seq = 0;
    size_t len = cam::waitFrame(buf, cap, seq, 3000);
    if (!len) {
        reply(fd, "503 Service Unavailable", "camera not ready");
        free(buf);
        return;
    }
    char name[40] = "camera.jpg";
    time_t now = time(nullptr);
    if (now > 1700000000) {
        struct tm t;
        localtime_r(&now, &t);
        strftime(name, sizeof(name), "camera_%Y-%m-%d_%H-%M-%S.jpg", &t);
    }
    String cors = corsHeaders(req);
    char head[400];
    int n = snprintf(head, sizeof(head),
                     "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n"
                     "Content-Disposition: attachment; filename=\"%s\"\r\n%sCache-Control: no-store\r\nConnection: close\r\n\r\n",
                     (unsigned)len, name, cors.c_str());
    if (sendAll(fd, head, n)) sendAll(fd, buf, len);
    free(buf);
}

static void serve(int fd) {
    struct timeval tv = {5, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    // Read the request head
    String req;
    char b[256];
    while (req.length() < 3072 && req.indexOf("\r\n\r\n") < 0) {
        int n = recv(fd, b, sizeof(b) - 1, 0);
        if (n <= 0) break;
        b[n] = 0;
        req += b;
    }
    int sp1 = req.indexOf(' '), sp2 = req.indexOf(' ', sp1 + 1);
    String path = sp1 > 0 && sp2 > sp1 ? req.substring(sp1 + 1, sp2) : "";
    String base = path.substring(0, path.indexOf('?') < 0 ? path.length() : path.indexOf('?'));

    if (!req.startsWith("GET ")) {
        reply(fd, "405 Method Not Allowed", "");
    } else if (auth::configured() && !auth::valid(cookieValue(req, "sid"))) {
        reply(fd, "401 Unauthorized", "login required");
    } else if (paused()) {
        reply(fd, "503 Service Unavailable", "updating");
    } else if (base == "/stream") {
        stream(fd, queryInt(path, "fps", 15), req);
    } else if (base == "/snapshot") {
        snapshot(fd, req);
    } else {
        reply(fd, "404 Not Found", "");
    }
    shutdown(fd, SHUT_RDWR);
    close(fd);
}

static void workerTask(void*) {
    for (;;) {
        int fd;
        if (xQueueReceive(pending, &fd, portMAX_DELAY) != pdTRUE) continue;
        serve(fd);
        clients = clients - 1;
    }
}

static void acceptTask(void*) {
    int ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int one = 1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a = {};
    a.sin_family = AF_INET;
    a.sin_port = htons(PORT);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(ls, (struct sockaddr*)&a, sizeof(a)) != 0 || listen(ls, 4) != 0) {
        log_e("stream server: bind failed");
        vTaskDelete(nullptr);
        return;
    }
    for (;;) {
        int fd = accept(ls, nullptr, nullptr);
        if (fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        int nd = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nd, sizeof(nd));
        if (clients >= MAX_CLIENTS) {
            reply(fd, "503 Service Unavailable", "too many viewers");
            close(fd);
            continue;
        }
        clients = clients + 1;
        xQueueSend(pending, &fd, portMAX_DELAY);  // never full: at most MAX_CLIENTS are out
    }
}

void pause(bool on) { pausedAt = on ? millis() | 1 : 0; }

void begin() {
    pending = xQueueCreate(MAX_CLIENTS, sizeof(int));
    for (int i = 0; i < MAX_CLIENTS; i++) xTaskCreatePinnedToCore(workerTask, "view", 4096, nullptr, 2, nullptr, 0);
    xTaskCreatePinnedToCore(acceptTask, "streamsrv", 3072, nullptr, 2, nullptr, 0);
}
}  // namespace streamsrv
