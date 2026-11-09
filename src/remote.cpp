#include "remote.h"

#include <WiFi.h>
#include <esp_websocket_client.h>
#include <lwip/sockets.h>

#include "certs.h"
#include "config.h"

namespace remote {
enum : uint8_t { T_OPEN = 1, T_DATA = 2, T_CLOSE = 3, T_PAUSE = 4, T_RESUME = 5 };
// Each tunnel stream is two TCP connections on the camera (to and from its own
// web server), and lwIP here has 16 in all: 8 used them up and the web servers
// stopped accepting. The relay queues requests beyond what the camera takes.
static const int MAX_STREAMS = 5;
static const int CHUNK = 4096;
// The relay pings every 30 s and answers ours (every 15 s): this long without
// a word from it, the connection is dead even if TCP hasn't noticed
static const uint32_t SILENT_MS = 70000;
// Not registered for this long (stuck connecting or failing): start afresh
static const uint32_t STUCK_MS = 180000;

struct Stream {
    int fd = -1;
    uint16_t id = 0;
    bool paused = false;
};

static esp_websocket_client_handle_t client = nullptr;
static SemaphoreHandle_t mtx;
static Stream streams[MAX_STREAMS];
static volatile bool restartReq = true;
static volatile bool wsUp = false;
static volatile bool registered = false;
static volatile uint32_t lastRx = 0;  // millis() of the last frame from the relay
static String state = "off";  // shown in the UI
static String publicUrl;
static String uri, headers;
static uint8_t* rx = nullptr;  // reassembly of fragmented frames
static int rxLen = 0;

static void setState(const String& s) {
    config::lock();
    state = s;
    config::unlock();
}

static void sendFrame(uint8_t type, uint16_t id, const uint8_t* data, int len) {
    if (!client || !wsUp) return;
    uint8_t hdr[3 + 512];
    if (len <= 512) {
        hdr[0] = type;
        hdr[1] = id >> 8;
        hdr[2] = id;
        if (len) memcpy(hdr + 3, data, len);
        esp_websocket_client_send_bin(client, (const char*)hdr, len + 3, pdMS_TO_TICKS(10000));
    }
}

static void closeStream(Stream& s, bool tell) {
    if (s.fd >= 0) {
        shutdown(s.fd, SHUT_RDWR);
        close(s.fd);
    }
    if (tell) sendFrame(T_CLOSE, s.id, nullptr, 0);
    s.fd = -1;
    s.paused = false;
}

static void closeAll() {
    xSemaphoreTake(mtx, portMAX_DELAY);
    for (auto& s : streams)
        if (s.fd >= 0) closeStream(s, false);
    xSemaphoreGive(mtx);
}

static Stream* find(uint16_t id) {
    for (auto& s : streams)
        if (s.fd >= 0 && s.id == id) return &s;
    return nullptr;
}

static void openStream(uint16_t id, uint16_t port) {
    if (port != 80 && port != 81) port = 80;
    Stream* slot = nullptr;
    for (auto& s : streams)
        if (s.fd < 0) slot = &s;
    if (!slot) {
        sendFrame(T_CLOSE, id, nullptr, 0);
        return;
    }
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd < 0) {
        sendFrame(T_CLOSE, id, nullptr, 0);
        return;
    }
    struct sockaddr_in a = {};
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr*)&a, sizeof(a)) != 0) {
        close(fd);
        sendFrame(T_CLOSE, id, nullptr, 0);
        return;
    }
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    struct timeval tv = {5, 0};
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    slot->fd = fd;
    slot->id = id;
    slot->paused = false;
}

static void handleFrame(const uint8_t* d, int len) {
    if (len < 3) return;
    uint8_t type = d[0];
    uint16_t id = (d[1] << 8) | d[2];
    xSemaphoreTake(mtx, portMAX_DELAY);
    Stream* s = find(id);
    switch (type) {
        case T_OPEN:
            if (s) closeStream(*s, false);
            // Payload: the local port (80 web UI, 81 live video)
            openStream(id, len >= 5 ? (d[3] << 8) | d[4] : 80);
            break;
        case T_DATA:
            if (s) {
                const uint8_t* p = d + 3;
                int left = len - 3;
                while (left > 0) {
                    int n = send(s->fd, p, left, 0);
                    if (n <= 0) {
                        closeStream(*s, true);
                        break;
                    }
                    p += n;
                    left -= n;
                }
            }
            break;
        case T_CLOSE:
            if (s) closeStream(*s, false);
            break;
        case T_PAUSE:
            if (s) s->paused = true;
            break;
        case T_RESUME:
            if (s) s->paused = false;
            break;
    }
    xSemaphoreGive(mtx);
}

static void onText(const char* d, int len) {
    JsonDocument doc;
    if (deserializeJson(doc, d, len)) return;
    String t = doc["t"] | "";
    if (t == "ok") {
        registered = true;
        config::lock();
        publicUrl = doc["url"] | "";
        // Shown as a link in the UI: only a web address may get there
        if (!publicUrl.startsWith("https://") && !publicUrl.startsWith("http://")) publicUrl = "";
        config::unlock();
        setState("online");
    } else if (t == "err") {
        registered = false;
        setState(String("error:") + (doc["code"] | "unknown"));
    }
}

static void onEvent(void*, esp_event_base_t, int32_t id, void* data) {
    auto* e = (esp_websocket_event_data_t*)data;
    switch (id) {
        case WEBSOCKET_EVENT_CONNECTED:
            lastRx = millis();
            wsUp = true;
            setState("connecting");
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            wsUp = false;
            registered = false;
            closeAll();
            if (state == "online" || state == "connecting") setState("reconnecting");
            break;
        case WEBSOCKET_EVENT_ERROR:
            wsUp = false;
            registered = false;
            setState("unreachable");
            break;
        case WEBSOCKET_EVENT_DATA: {
            lastRx = millis();  // pings and pongs too
            if (e->op_code != 1 && e->op_code != 2 && e->op_code != 0) break;
            if (e->payload_len > CHUNK + 16) break;  // never sent by the relay
            if (e->payload_offset == 0) rxLen = 0;
            if (rxLen + e->data_len > CHUNK + 16) break;
            memcpy(rx + rxLen, e->data_ptr, e->data_len);
            rxLen += e->data_len;
            if (e->payload_offset + e->data_len < e->payload_len) break;  // more to come
            if (e->op_code == 1)
                onText((const char*)rx, rxLen);
            else
                handleFrame(rx, rxLen);
            rxLen = 0;
            break;
        }
    }
}

static void stopClient() {
    if (!client) return;
    esp_websocket_client_stop(client);
    esp_websocket_client_destroy(client);
    client = nullptr;
    wsUp = false;
    registered = false;
    closeAll();
}

static void startClient() {
    config::lock();
    bool tls = config::s.remoteTls;
    bool insecure = config::s.remoteInsecure;
    uri = String(tls ? "wss://" : "ws://") + config::s.remoteHost + "/cam-relay/ws";
    headers = "X-Cam-Id: " + config::s.remoteId + "\r\nX-Cam-Key: " + config::s.remoteKey + "\r\nX-Cam-Fw: " FW_VERSION "\r\n";
    if (config::s.remoteToken.length()) headers += "X-Cam-Token: " + config::s.remoteToken + "\r\n";
    config::unlock();

    esp_websocket_client_config_t c = {};
    c.uri = uri.c_str();
    c.headers = headers.c_str();
    c.buffer_size = CHUNK + 16;
    c.task_stack = 6144;
    c.task_prio = 4;
    c.ping_interval_sec = 15;
    // While a big upload fills the link, the client task can't read the relay's
    // PONGs in time; a dead link is found by TCP keep-alive instead (~25 s)
    c.disable_pingpong_discon = true;
    c.keep_alive_enable = true;
    c.keep_alive_idle = 10;
    c.keep_alive_interval = 5;
    c.keep_alive_count = 3;
    c.user_agent = "esp32-camera/" FW_VERSION;
    if (tls && !insecure) c.cert_pem = REMOTE_ROOT_CAS;
    if (tls) c.skip_cert_common_name_check = insecure;
    client = esp_websocket_client_init(&c);
    if (!client) {
        setState("error:init");
        return;
    }
    esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, onEvent, nullptr);
    esp_websocket_client_start(client);
    setState("connecting");
}

// Moves responses from the local web server up to the relay
static void pumpTask(void*) {
    uint8_t* buf = (uint8_t*)malloc(CHUNK);
    uint32_t downSince = 0;
    for (;;) {
        // While video streams up, unsent data is always queued, so TCP keep-alive
        // never runs and a dropped link went unnoticed: the camera stayed
        // offline until a reboot
        uint32_t now = millis();
        if (client && wsUp && now - lastRx > SILENT_MS) {
            log_w("remote: relay silent for %u s, reconnecting", (unsigned)((now - lastRx) / 1000));
            restartReq = true;
        }
        if (!client || registered) {
            downSince = 0;
        } else if (!downSince) {
            downSince = now;
        } else if (now - downSince > STUCK_MS) {
            log_w("remote: not online for %u s, starting afresh", (unsigned)(STUCK_MS / 1000));
            restartReq = true;
        }
        if (restartReq) {
            restartReq = false;
            downSince = 0;
            stopClient();
            config::lock();
            bool on = config::s.remoteEnabled && config::s.remoteHost.length();
            config::unlock();
            if (on && WiFi.status() == WL_CONNECTED) {
                startClient();
            } else {
                setState(on ? "waiting" : "off");
                if (on) restartReq = true;  // try again once Wi-Fi is up
                vTaskDelay(pdMS_TO_TICKS(2000));
                continue;
            }
        }
        fd_set rs;
        FD_ZERO(&rs);
        int maxfd = -1;
        xSemaphoreTake(mtx, portMAX_DELAY);
        for (auto& s : streams)
            if (s.fd >= 0 && !s.paused) {
                FD_SET(s.fd, &rs);
                if (s.fd > maxfd) maxfd = s.fd;
            }
        xSemaphoreGive(mtx);
        if (maxfd < 0) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        struct timeval tv = {0, 20000};
        if (select(maxfd + 1, &rs, nullptr, nullptr, &tv) <= 0) continue;

        uint16_t ended[MAX_STREAMS];
        int nEnded = 0;
        xSemaphoreTake(mtx, portMAX_DELAY);
        for (auto& s : streams) {
            if (s.fd < 0 || !FD_ISSET(s.fd, &rs)) continue;
            int n = recv(s.fd, buf + 3, CHUNK - 3, MSG_DONTWAIT);
            if (n > 0) {
                buf[0] = T_DATA;
                buf[1] = s.id >> 8;
                buf[2] = s.id;
                uint16_t id = s.id;
                // Send without holding the lock: a slow upload must not block
                // the relay's frames (PAUSE, CLOSE) handled in the event task
                xSemaphoreGive(mtx);
                int sent = wsUp ? esp_websocket_client_send_bin(client, (const char*)buf, n + 3, pdMS_TO_TICKS(15000)) : -1;
                xSemaphoreTake(mtx, portMAX_DELAY);
                Stream* again = find(id);
                if (sent < 0 && again) closeStream(*again, false);
            } else if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
                ended[nEnded++] = s.id;
                closeStream(s, false);
            }
        }
        xSemaphoreGive(mtx);
        // Tell the relay only now: sending takes the client's lock, and its task
        // holds that lock while it waits for ours (handleFrame), so sending with
        // `mtx` held deadlocked the two for 10 s and dropped the connection
        while (nEnded) sendFrame(T_CLOSE, ended[--nEnded], nullptr, 0);
    }
}

void begin() {
    mtx = xSemaphoreCreateMutex();
    rx = (uint8_t*)malloc(CHUNK + 16);
    xTaskCreatePinnedToCore(pumpTask, "remote", 6144, nullptr, 3, nullptr, 0);
}

void restart() { restartReq = true; }

void status(JsonObject o) {
    config::lock();
    o["enabled"] = config::s.remoteEnabled;
    o["state"] = state;
    String url = publicUrl;
    if (!url.length()) url = String(config::s.remoteTls ? "https://" : "http://") + config::s.remoteHost + "/cam/" + config::s.remoteId + "/";
    o["url"] = url;
    config::unlock();
}
}  // namespace remote
