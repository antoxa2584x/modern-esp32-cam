#include "webserver.h"

#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <Update.h>
#include <WiFi.h>
#include <esp_core_dump.h>
#include <esp_heap_caps.h>
#include <sys/time.h>

#include "auth.h"
#include "avi.h"
#include "board.h"
#include "camera.h"
#include "config.h"
#include "faces.h"
#include "motion.h"
#include "netmgr.h"
#include "recorder.h"
#include "remote.h"
#include "storage.h"
#include "streamsrv.h"
#include "web_assets.h"

namespace web {
static AsyncWebServer server(80);
static uint32_t rebootAt = 0;
static const size_t MAX_BODY = 4096;

// ---------- helpers ----------

static String cookie(AsyncWebServerRequest* r, const char* name) {
    const AsyncWebHeader* h = r->getHeader("Cookie");
    if (!h) return "";
    String line = h->value();
    String key = String(name) + "=";
    int k = line.indexOf(key);
    while (k > 0 && line[k - 1] != ' ' && line[k - 1] != ';') k = line.indexOf(key, k + 1);
    if (k < 0) return "";
    int stop = line.indexOf(';', k);
    return line.substring(k + key.length(), stop < 0 ? line.length() : stop);
}

static bool authed(AsyncWebServerRequest* r) { return auth::valid(cookie(r, "sid")); }

// The relay tunnel connects from 127.0.0.1: those requests come from the internet
static bool viaRelay(AsyncWebServerRequest* r) {
    return r->client() && r->client()->remoteIP() == IPAddress(127, 0, 0, 1);
}

// The setup wizard may run without a login until a user exists, and in
// recovery mode (RST pressed three times)
static bool setupOpen() { return !auth::configured() || net::recoveryMode(); }

// Blocks cross-site form posts: browsers can't add this header without CORS
static bool sameSite(AsyncWebServerRequest* r) {
    const AsyncWebHeader* h = r->getHeader("X-Requested-With");
    return h && h->value() == "cam";
}

static void sendJson(AsyncWebServerRequest* r, JsonDocument& doc, int code = 200) {
    String out;
    serializeJson(doc, out);
    AsyncWebServerResponse* res = r->beginResponse(code, "application/json", out);
    res->addHeader("Cache-Control", "no-store");
    r->send(res);
}

static void sendError(AsyncWebServerRequest* r, int code, const char* err, const char* msg = nullptr) {
    JsonDocument d;
    d["error"] = err;
    if (msg) d["message"] = msg;
    sendJson(r, d, code);
}

static void sendOk(AsyncWebServerRequest* r) {
    JsonDocument d;
    d["ok"] = true;
    sendJson(r, d);
}

static void setSessionCookie(AsyncWebServerResponse* res, const String& token) {
    String c = "sid=" + token + "; Path=/; HttpOnly; SameSite=Strict";
    c += token.length() ? "; Max-Age=2592000" : "; Max-Age=0";
    res->addHeader("Set-Cookie", c);
}

enum Access { PUBLIC, SETUP, USER };

static bool allowed(AsyncWebServerRequest* r, Access a) {
    if (a == PUBLIC) return true;
    if (authed(r)) return true;
    // Login-free setup never works through the relay
    if (a == SETUP && setupOpen() && !viaRelay(r)) return true;
    sendError(r, 401, "auth");
    return false;
}

using JsonHandler = std::function<void(AsyncWebServerRequest*, JsonObjectConst)>;

static void collectBody(AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total) {
    if (total > MAX_BODY) return;
    if (index == 0) r->_tempObject = calloc(total + 1, 1);
    if (r->_tempObject) memcpy((uint8_t*)r->_tempObject + index, data, len);
}

// POST with a JSON body
static void postJson(const char* uri, Access a, JsonHandler fn) {
    server.on(
        uri, HTTP_POST,
        [a, fn](AsyncWebServerRequest* r) {
            if (!sameSite(r)) return sendError(r, 403, "csrf");
            if (!allowed(r, a)) return;
            JsonDocument doc;
            if (r->_tempObject) deserializeJson(doc, (const char*)r->_tempObject);
            fn(r, doc.is<JsonObject>() ? doc.as<JsonObjectConst>() : JsonObjectConst());
        },
        nullptr, collectBody);
}

static void get(const char* uri, Access a, ArRequestHandlerFunction fn) {
    server.on(uri, HTTP_GET, [a, fn](AsyncWebServerRequest* r) {
        if (allowed(r, a)) fn(r);
    });
}

static String param(AsyncWebServerRequest* r, const char* name) {
    return r->hasParam(name) ? r->getParam(name)->value() : String();
}

// Streams part of an SD card file
static void sendFilePart(AsyncWebServerRequest* r, fs::File f, uint32_t offset, uint32_t size, const char* type,
                         const String& disposition, const char* cache) {
    AsyncWebServerResponse* res =
        r->beginResponse(type, size, [f, offset, size](uint8_t* buf, size_t maxLen, size_t index) mutable -> size_t {
            if (index >= size) return 0;
            size_t n = min((size_t)(size - index), maxLen);
            f.seek(offset + index);
            return f.read(buf, n);
        });
    if (disposition.length()) res->addHeader("Content-Disposition", disposition);
    res->addHeader("Cache-Control", cache);
    r->send(res);
}

// Sends a JPEG copied out of memory
static void sendJpeg(AsyncWebServerRequest* r, std::shared_ptr<std::vector<uint8_t>> data) {
    if (!data) return sendError(r, 404, "missing");
    AsyncWebServerResponse* res =
        r->beginResponse("image/jpeg", data->size(), [data](uint8_t* buf, size_t maxLen, size_t index) -> size_t {
            if (index >= data->size()) return 0;
            size_t n = min(maxLen, data->size() - index);
            memcpy(buf, data->data() + index, n);
            return n;
        });
    // Photo ids are never reused, so the browser may keep them
    res->addHeader("Cache-Control", "private, max-age=604800, immutable");
    r->send(res);
}

// ---------- status ----------

// Where the crash that caused this start happened, from the core dump the
// camera saved: "task pc backtrace..." (decode with addr2line and that
// build's firmware.elf). Erased once read, so it never shows an old crash.
static String lastCrash;

static void readLastCrash() {
    auto* cs = (esp_core_dump_summary_t*)ps_malloc(sizeof(esp_core_dump_summary_t));
    if (cs && esp_core_dump_get_summary(cs) == ESP_OK) {
        lastCrash = cs->exc_task;
        char hex[12];
        snprintf(hex, sizeof(hex), " %08x", (unsigned)cs->exc_pc);
        lastCrash += hex;
        for (uint32_t i = 0; i < cs->exc_bt_info.depth && i < 16; i++) {
            snprintf(hex, sizeof(hex), " %08x", (unsigned)cs->exc_bt_info.bt[i]);
            lastCrash += hex;
        }
        esp_core_dump_image_erase();
    }
    free(cs);
}

static void fillStatus(JsonObject o) {
    o["name"] = config::s.name;
    o["fw"] = FW_VERSION;
    o["security"] = config::s.security;
    o["camera"] = cam::ok();
    o["width"] = cam::width();
    o["height"] = cam::height();
    o["fps"] = cam::fps();
    o["viewers"] = cam::viewers();
    o["lamp"] = cam::lamp();
    o["rotate"] = config::s.cam.rotate;
    o["theme"] = config::s.theme;
    JsonObject m = o["motion"].to<JsonObject>();
    m["active"] = motion::active();
    m["level"] = motion::level();
    uint32_t lm = motion::lastMotionMs();
    m["ago"] = lm ? (millis() - lm) / 1000 : -1;
    JsonObject rc = o["rec"].to<JsonObject>();
    rc["on"] = rec::recording();
    rc["manual"] = rec::manual();
    rc["sec"] = rec::elapsedMs() / 1000;
    rc["error"] = rec::error();
    JsonObject sd = o["sd"].to<JsonObject>();
    sd["ok"] = store::mounted();
    sd["total"] = store::totalBytes();
    sd["used"] = store::usedBytes();
    sd["clearing"] = store::clearing();
    sd["cleared"] = store::clearedSoFar();
    net::status(o["wifi"].to<JsonObject>());
    remote::status(o["remote"].to<JsonObject>());
    if (HAS_FACES) {
        JsonObject fc = o["faces"].to<JsonObject>();
        fc["enabled"] = config::s.faces.enabled;
        fc["on"] = faces::running();
        fc["seq"] = faces::eventSeq();
    }
    o["clock"] = rec::clockKnown();
    o["time"] = (uint32_t)time(nullptr);
    o["uptime"] = millis() / 1000;
    o["heap"] = ESP.getFreeHeap();
    o["psram"] = ESP.getFreePsram();
    if (lastCrash.length()) o["lastCrash"] = lastCrash;
}

// ---------- routes ----------

static void routesAuth() {
    get("/api/state", PUBLIC, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        d["configured"] = auth::configured();
        d["wifi"] = config::wifiSsid().length() > 0;
        d["setup"] = setupOpen() && !viaRelay(r);
        d["recovery"] = net::recoveryMode();
        d["authed"] = authed(r);
        d["name"] = config::s.name;
        d["ap"] = net::apActive();
        d["apSsid"] = net::apSsid();
        d["streamPort"] = streamsrv::PORT;
        d["theme"] = config::s.theme;
        d["fw"] = FW_VERSION;
        d["lamp"] = HAS_LAMP;
        d["statusLed"] = STATUS_LED_PIN >= 0;
        d["faces"] = (bool)HAS_FACES;
        if (d["authed"]) d["user"] = auth::user();
        sendJson(r, d);
    });

    postJson("/api/login", PUBLIC, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        bool locked = false, remote = viaRelay(r);
        String tok = auth::login(b["user"] | "", b["password"] | "", remote, locked);
        if (!tok.length()) {
            JsonDocument d;
            d["error"] = locked ? "locked" : "wrong";
            d["wait"] = auth::lockoutSeconds(remote);
            return sendJson(r, d, locked ? 429 : 403);
        }
        JsonDocument d;
        d["ok"] = true;
        String out;
        serializeJson(d, out);
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json", out);
        setSessionCookie(res, tok);
        r->send(res);
    });

    postJson("/api/logout", PUBLIC, [](AsyncWebServerRequest* r, JsonObjectConst) {
        auth::logout(cookie(r, "sid"));
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json", "{\"ok\":true}");
        setSessionCookie(res, "");
        r->send(res);
    });

    postJson("/api/logout-all", USER, [](AsyncWebServerRequest* r, JsonObjectConst) {
        auth::logoutAll();
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json", "{\"ok\":true}");
        setSessionCookie(res, "");
        r->send(res);
    });

    // First setup / recovery: Wi-Fi and the login in one go
    postJson("/api/setup", SETUP, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        String user = b["user"] | "";
        String pass = b["password"] | "";
        String ssid = b["ssid"] | "";
        String wpass = b["wifiPassword"] | "";
        user.trim();
        bool needUser = !auth::configured() || net::recoveryMode();
        if (needUser && (user.length() < 1 || user.length() > 32))
            return sendError(r, 400, "user", "Вкажіть ім'я користувача");
        if (needUser && auth::passwordProblem(pass)) return sendError(r, 400, "password", auth::passwordProblem(pass));
        // The first setup and recovery only work on the camera's own Wi-Fi or at home
        if (viaRelay(r)) return sendError(r, 403, "remote", "Налаштування доступне лише вдома");
        if (!ssid.length() && !config::wifiSsid().length()) return sendError(r, 400, "ssid", "Оберіть мережу Wi-Fi");

        String tok;
        if (needUser) {
            auth::setCredentials(user, pass);
            auth::logoutAll();
            bool locked;
            tok = auth::login(user, pass, false, locked);
        }
        if (ssid.length()) net::connect(ssid, wpass, true);
        if (net::recoveryMode()) net::endRecovery();
        String out = "{\"ok\":true}";
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json", out);
        if (tok.length()) setSessionCookie(res, tok);
        r->send(res);
    });

    get("/api/setup/status", PUBLIC, [](AsyncWebServerRequest* r) {
        if ((!net::apActive() || viaRelay(r)) && !authed(r)) return sendError(r, 401, "auth");
        JsonDocument d;
        d["state"] = net::connectState();
        d["ip"] = net::ip();
        d["host"] = net::hostname() + ".local";
        d["ssid"] = WiFi.SSID();
        sendJson(r, d);
    });

    get("/api/wifi/scan", SETUP, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        JsonArray list = d["networks"].to<JsonArray>();
        if (r->hasParam("start")) {
            net::startScan();
            d["busy"] = true;
        } else {
            d["busy"] = !net::scanResults(list);
        }
        sendJson(r, d);
    });

    postJson("/api/wifi", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        String ssid = b["ssid"] | "";
        if (!ssid.length()) return sendError(r, 400, "ssid", "Оберіть мережу Wi-Fi");
        net::connect(ssid, b["password"] | "", true);
        sendOk(r);
    });

    postJson("/api/account", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        if (!auth::checkPassword(b["current"] | "")) return sendError(r, 403, "current", "Поточний пароль невірний");
        String user = b["user"] | "";
        String pass = b["password"] | "";
        user.trim();
        if (!user.length() || user.length() > 32) return sendError(r, 400, "user", "Вкажіть ім'я користувача");
        if (auth::passwordProblem(pass)) return sendError(r, 400, "password", auth::passwordProblem(pass));
        auth::setCredentials(user, pass);
        // Other devices must log in again; this one stays in
        auth::logoutAll();
        bool locked;
        String tok = auth::login(user, pass, viaRelay(r), locked);
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json", "{\"ok\":true}");
        setSessionCookie(res, tok);
        r->send(res);
    });

    // Without internet there is no NTP: the browser offers its clock
    postJson("/api/time", SETUP, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        uint32_t epoch = b["epoch"] | 0;
        if (!rec::clockKnown() && epoch > 1700000000) {
            struct timeval tv = {(time_t)epoch, 0};
            settimeofday(&tv, nullptr);
        }
        sendOk(r);
    });
}

static void routesCamera() {
    get("/api/status", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        fillStatus(d.to<JsonObject>());
        sendJson(r, d);
    });

    postJson("/api/security", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        config::s.security = b["on"] | false;
        config::save();
        motion::reset();
        sendOk(r);
    });

    postJson("/api/lamp", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        cam::setLamp(b["level"] | 0);
        sendOk(r);
    });

    postJson("/api/record", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        bool on = b["on"] | false;
        if (on && !store::mounted()) return sendError(r, 409, "nosd", "Вставте карту пам'яті microSD");
        rec::setManual(on);
        sendOk(r);
    });

    get("/api/settings", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        config::toJson(d.to<JsonObject>(), false);
        d["sensor"] = cam::sensor();
        d["maxFramesize"] = cam::maxFramesize();
        sendJson(r, d);
    });

    postJson("/api/settings", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        uint32_t ch = config::fromJson(b);
        if (ch & config::CH_CAMERA) {
            cam::apply(config::s.cam);
            motion::reset();
        }
        if (ch & config::CH_REMOTE) remote::restart();
        if (ch & config::CH_TIME) net::applyTimezone();
        if (ch & config::CH_OTHER) motion::reset();
        if (ch & config::CH_FACES) faces::applySettings();
        if (ch) config::save();
        JsonDocument d;
        config::toJson(d.to<JsonObject>(), false);
        sendJson(r, d);
    });

    postJson("/api/remote/new-id", USER, [](AsyncWebServerRequest* r, JsonObjectConst) {
        config::lock();
        config::s.remoteId = config::randomToken(10);
        config::s.remoteKey = config::randomToken(32);
        config::unlock();
        config::save();
        remote::restart();
        sendOk(r);
    });

    postJson("/api/reboot", USER, [](AsyncWebServerRequest* r, JsonObjectConst) {
        rebootAt = millis() + 1000;
        sendOk(r);
    });

    // Firmware update: multipart upload of firmware.bin
    server.on(
        "/api/update", HTTP_POST,
        [](AsyncWebServerRequest* r) {
            if (!sameSite(r) || !authed(r)) return sendError(r, 401, "auth");
            if (Update.hasError() || !Update.isFinished()) {
                Update.abort();
                streamsrv::pause(false);
                return sendError(r, 400, "update", "Файл не підходить або пошкоджений");
            }
            rebootAt = millis() + 1500;
            sendOk(r);
        },
        [](AsyncWebServerRequest* r, const String&, size_t index, uint8_t* data, size_t len, bool final) {
            if (!sameSite(r) || !authed(r)) return;
            if (index == 0) {
                // Stop writing to the card while flashing
                rec::setManual(false);
                // Update's 4 KB flash-write buffer must be in internal RAM: the
                // flash can't be written from PSRAM ("file is damaged")
                if (psramFound()) heap_caps_malloc_extmem_enable(8192);
                bool ok = Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH);
                if (psramFound()) heap_caps_malloc_extmem_enable(PSRAM_ALLOC_MIN);
                if (!ok) return;
            }
            if (!Update.isRunning()) return;
            // The upload arrives faster than the flash takes it, and this task
            // (priority 10 on core 0) then never gave core 0's idle task a turn:
            // the task watchdog restarted the camera a third of the way through.
            // So: no video meanwhile (encrypting it for the relay added to the
            // load), and a short break every 32 KB.
            streamsrv::pause(true);
            if (Update.write(data, len) != len) return;
            if ((index + len) / 32768 != index / 32768) vTaskDelay(pdMS_TO_TICKS(5));
            if (final) Update.end(true);
        });
}

static void routesRecordings() {
    get("/api/rec/days", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        store::listDays(d["days"].to<JsonArray>());
        sendJson(r, d);
    });

    get("/api/rec/list", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        store::listDay(param(r, "d"), d["items"].to<JsonArray>());
        sendJson(r, d);
    });

    get("/api/rec/recent", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        store::recent(constrain(param(r, "n").toInt(), 1, 24), d["items"].to<JsonArray>());
        sendJson(r, d);
    });

    get("/api/rec/info", USER, [](AsyncWebServerRequest* r) {
        String f = param(r, "f");
        if (!store::validName(f)) return sendError(r, 400, "name");
        fs::File file = store::fs().open(store::pathOf(f), "r");
        avi::Info info;
        if (!file || !avi::readInfo(file, info)) return sendError(r, 404, "missing");
        JsonDocument d;
        d["frames"] = info.frames;
        d["fps"] = info.fps;
        d["width"] = info.width;
        d["height"] = info.height;
        d["size"] = file.size();
        sendJson(r, d);
    });

    get("/api/rec/frame", USER, [](AsyncWebServerRequest* r) {
        String f = param(r, "f");
        if (!store::validName(f)) return sendError(r, 400, "name");
        fs::File file = store::fs().open(store::pathOf(f), "r");
        avi::Info info;
        uint32_t off, size;
        if (!file || !avi::readInfo(file, info) || !avi::frameAt(file, info, param(r, "n").toInt(), off, size))
            return sendError(r, 404, "missing");
        sendFilePart(r, file, off, size, "image/jpeg", "", "private, max-age=604800, immutable");
    });

    get("/api/rec/file", USER, [](AsyncWebServerRequest* r) {
        String f = param(r, "f");
        if (!store::validName(f)) return sendError(r, 400, "name");
        fs::File file = store::fs().open(store::pathOf(f), "r");
        if (!file) return sendError(r, 404, "missing");
        // camera_2026-11-03_14-30-25.avi
        String name = "camera_" + f.substring(0, 4) + "-" + f.substring(4, 6) + "-" + f.substring(6, 8) + "_" +
                      f.substring(9, 11) + "-" + f.substring(11, 13) + "-" + f.substring(13, 15) + ".avi";
        sendFilePart(r, file, 0, file.size(), "video/x-msvideo", "attachment; filename=\"" + name + "\"", "no-store");
    });

    postJson("/api/rec/delete", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        int n = 0;
        if (b["files"].is<JsonArrayConst>()) {
            for (JsonVariantConst v : b["files"].as<JsonArrayConst>())
                if (store::remove(v | "")) n++;
        } else if (store::remove(b["f"] | "")) {
            n = 1;
        }
        JsonDocument d;
        d["deleted"] = n;
        sendJson(r, d);
    });

    // Runs in the background; progress shows in /api/status (sd.clearing)
    postJson("/api/rec/clear", USER, [](AsyncWebServerRequest* r, JsonObjectConst) {
        if (!store::mounted()) return sendError(r, 409, "nosd", "Вставте карту пам'яті microSD");
        store::startClear();
        JsonDocument d;
        d["queued"] = true;
        sendJson(r, d);
    });
}

static void routesFaces() {
    // Polled by the live view to draw names over the picture
    get("/api/faces/live", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        faces::live(d.to<JsonObject>());
        sendJson(r, d);
    });

    postJson("/api/faces/enroll", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        if (!faces::available()) return sendError(r, 409, "faces", "Розпізнавання облич недоступне");
        String name = b["name"] | "";
        name.trim();
        if (!name.length()) return sendError(r, 400, "name", "Вкажіть ім'я");
        if (name.length() > 47) return sendError(r, 400, "name", "Занадто довге ім'я");
        faces::startEnroll(name);
        sendOk(r);
    });

    postJson("/api/faces/cancel", USER, [](AsyncWebServerRequest* r, JsonObjectConst) {
        faces::cancelEnroll();
        sendOk(r);
    });

    postJson("/api/faces/forget", USER, [](AsyncWebServerRequest* r, JsonObjectConst b) {
        int n = 0;
        if (b["uids"].is<JsonArrayConst>()) {
            for (JsonVariantConst v : b["uids"].as<JsonArrayConst>())
                if (faces::forget(v | 0u)) n++;
        } else if (faces::forget(b["uid"] | 0u)) {
            n = 1;
        }
        JsonDocument d;
        d["deleted"] = n;
        sendJson(r, d);
    });

    get("/api/faces/photo", USER, [](AsyncWebServerRequest* r) {
        sendJpeg(r, faces::photo(strtoul(param(r, "u").c_str(), nullptr, 10)));
    });

    get("/api/faces/event", USER, [](AsyncWebServerRequest* r) {
        sendJpeg(r, faces::eventFrame(strtoul(param(r, "n").c_str(), nullptr, 10)));
    });

    // Last: the server also matches "/api/faces" for every "/api/faces/..." URL,
    // so registered first it would answer the photo and live requests
    get("/api/faces", USER, [](AsyncWebServerRequest* r) {
        JsonDocument d;
        faces::info(d.to<JsonObject>());
        sendJson(r, d);
    });
}

static void routesStatic() {
    for (size_t i = 0; i < WEB_ASSET_COUNT; i++) {
        const WebAsset* a = &WEB_ASSETS[i];
        auto handler = [a](AsyncWebServerRequest* r) {
            const AsyncWebHeader* inm = r->getHeader("If-None-Match");
            if (inm && inm->value() == WEB_ETAG) return r->send(304);
            AsyncWebServerResponse* res = r->beginResponse(200, a->mime, a->data, a->len);
            res->addHeader("Content-Encoding", "gzip");
            res->addHeader("ETag", WEB_ETAG);
            res->addHeader("Cache-Control", "no-cache");
            r->send(res);
        };
        if (strcmp(a->path, "/index.html") == 0) server.on("/", HTTP_GET, handler);
        server.on(a->path, HTTP_GET, handler);
    }

    server.onNotFound([](AsyncWebServerRequest* r) {
        // Captive portal: phones probing for internet land on the setup page
        if (net::apActive()) {
            String host = r->host();
            if (host != "192.168.4.1" && host != WiFi.localIP().toString() && !host.startsWith(net::hostname())) {
                r->redirect("http://192.168.4.1/");
                return;
            }
        }
        if (r->url().startsWith("/api/")) return sendError(r, 404, "notfound");
        r->redirect("/");
    });
}

void begin() {
    readLastCrash();
    routesAuth();
    routesCamera();
    routesRecordings();
    routesFaces();
    routesStatic();
    DefaultHeaders::Instance().addHeader("X-Content-Type-Options", "nosniff");
    server.begin();
}

void loop() {
    if (rebootAt && millis() > rebootAt) {
        rec::setManual(false);
        delay(200);
        ESP.restart();
    }
}
}  // namespace web
