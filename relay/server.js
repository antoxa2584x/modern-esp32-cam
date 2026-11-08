'use strict';
// Remote-access relay for ESP32 cameras.
//
// A camera keeps one WebSocket open to /cam-relay/ws (headers X-Cam-Id and
// X-Cam-Key). Browsers open https://<host>/cam/<id>/...; each request becomes a
// tunnel stream down that socket, and the camera forwards it to its own web
// server. The camera's login protects everything, as on the home network.
//
// Security model:
// - Serve this from its own subdomain (cam.example.com), never from a site
//   that has its own logins: camera pages run JavaScript on this origin.
// - Only cameras that know RELAY_TOKEN may register, so strangers can't use
//   the relay to host pages under the domain.
// - The first camera that registers an id owns it (key stored hashed).
// - Headers are allowlisted both ways; only the camera's own "sid" cookie
//   passes, locked to its /cam/<id>/ path.
// - Rate limits per client IP for camera connections and login attempts.
//
// Frames: [type u8][stream id u16 BE][payload]
//   1 OPEN (payload: port u16), 2 DATA, 3 CLOSE, 4 PAUSE, 5 RESUME

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Duplex } = require('stream');
const { WebSocketServer } = require('ws');

const PORT = +(process.env.PORT || 3040);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REGISTRY = path.join(DATA_DIR, 'devices.json');
const TOKENS = (process.env.RELAY_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_OPEN = process.env.ALLOW_OPEN === '1'; // development only
if (!TOKENS.length && !ALLOW_OPEN) {
    console.error('Set RELAY_TOKEN (registration code for cameras), or ALLOW_OPEN=1 for local testing.');
    process.exit(1);
}
const MAX_STREAMS = 16;
// Requests forwarded to a camera at once; more wait in a queue. Each one costs
// the camera two of its 16 TCP connections, and it takes 5 (src/remote.cpp):
// one less here, so a new request never beats the camera freeing the last one.
const CAM_STREAMS = 4;
// Live video never ends by itself: keep slots free for pages and buttons
const MAX_LIVE = 2;
const QUEUE_WAIT = 30000;
const CHUNK = 4093; // + 3 header bytes = the camera's 4 KB buffer
const T = { OPEN: 1, DATA: 2, CLOSE: 3, PAUSE: 4, RESUME: 5 };

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- registry: first camera to use an id owns it ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
let registry = {};
try { registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch (e) { /* first run */ }
let registryDirty = false;
function saveRegistry() {
    const tmp = REGISTRY + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 1));
    fs.renameSync(tmp, REGISTRY);
    registryDirty = false;
}
setInterval(() => { if (registryDirty) saveRegistry(); }, 60000).unref();

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function tokenOk(t) {
    if (!TOKENS.length) return true;
    const h = Buffer.from(sha256(String(t || '')), 'hex');
    return TOKENS.some(x => crypto.timingSafeEqual(h, Buffer.from(sha256(x), 'hex')));
}

// The origin only accepts Cloudflare's addresses, so its header is trustworthy
const clientIp = req => req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress;

// "City, Region, CC" (URL-encoded) from Cloudflare's visitor location headers (the country
// always; city and region with the "Add visitor location headers" transform)
function clientPlace(req) {
    const h = k => String(req.headers[k] || '').trim();
    const cc = /^[A-Z]{2}$/.test(h('cf-ipcountry')) && !['XX', 'T1'].includes(h('cf-ipcountry')) ? h('cf-ipcountry') : '';
    const parts = [h('cf-ipcity'), h('cf-region'), cc].filter(Boolean);
    // Cloudflare sends UTF-8 names as Latin-1 bytes
    let text = Buffer.from(parts.filter((p, i) => p !== parts[i - 1]).join(', '), 'latin1').toString('utf8');
    // URL-encoded, to fit the camera's 47 bytes
    while (encodeURIComponent(text).length > 47) text = text.slice(0, -1);
    return encodeURIComponent(text);
}

// Fixed-window counter per key
class Limiter {
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.hits = new Map();
        setInterval(() => {
            const now = Date.now();
            for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
        }, Math.min(windowMs, 3600000)).unref();
    }
    // Returns 0 if allowed, else seconds to wait
    take(key) {
        const now = Date.now();
        let e = this.hits.get(key);
        if (!e || e.reset < now) {
            e = { n: 0, reset: now + this.windowMs };
            this.hits.set(key, e);
        }
        e.n++;
        return e.n > this.max ? Math.ceil((e.reset - now) / 1000) : 0;
    }
}
const cameraConnects = new Limiter(20, 60000);   // reconnects are every ~10 s
const registrations = new Limiter(10, 86400000); // new camera ids per IP per day
const logins = new Limiter(10, 15 * 60000);      // login attempts per IP
function sameHash(a, b) {
    const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- devices and tunnels ----------

const devices = new Map(); // id -> Device

class Tunnel extends Duplex {
    constructor(dev, sid) {
        super({ allowHalfOpen: true });
        this.dev = dev;
        this.sid = sid;
        this.paused = false;
        this.remoteClosed = false;
        // http.ClientRequest treats this as its socket
        this.remoteAddress = '127.0.0.1';
    }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }

    _write(chunk, enc, cb) {
        let off = 0;
        const next = err => {
            if (err) return cb(err);
            if (off >= chunk.length) return cb();
            const part = chunk.subarray(off, off + CHUNK);
            off += part.length;
            this.dev.send(T.DATA, this.sid, part, next);
        };
        next();
    }
    _read() {
        if (this.paused) {
            this.paused = false;
            this.dev.send(T.RESUME, this.sid);
        }
    }
    fromCamera(buf) {
        if (!this.push(buf) && !this.paused) {
            this.paused = true;
            this.dev.send(T.PAUSE, this.sid);
        }
    }
    cameraClosed() {
        this.remoteClosed = true;
        this.push(null);
    }
    _destroy(err, cb) {
        if (!this.remoteClosed) this.dev.send(T.CLOSE, this.sid);
        this.dev.streams.delete(this.sid);
        if (this.live) this.dev.live--;
        this.dev.next();
        cb(err);
    }
}

class Device {
    constructor(id, ws, fw) {
        this.id = id;
        this.ws = ws;
        this.fw = fw;
        this.streams = new Map();
        this.nextSid = 1;
        this.queue = []; // requests waiting for a free stream: { run, fail }
        this.live = 0;   // of the streams, live video ones
        // Any frame counts as a sign of life: while the camera uploads a lot,
        // its answers to our pings can be late
        this.missed = 0;
        ws.on('message', (data, isBinary) => {
            this.missed = 0;
            if (isBinary) this.onFrame(data);
        });
        ws.on('pong', () => { this.missed = 0; });
    }
    send(type, sid, payload, cb) {
        if (this.ws.readyState !== 1) return cb && cb(new Error('camera offline'));
        const head = Buffer.from([type, sid >> 8, sid & 255]);
        this.ws.send(payload ? Buffer.concat([head, payload]) : head, { binary: true }, cb);
    }
    onFrame(buf) {
        if (buf.length < 3) return;
        const type = buf[0], sid = (buf[1] << 8) | buf[2];
        const t = this.streams.get(sid);
        if (!t) {
            if (type === T.DATA) this.send(T.CLOSE, sid);
            return;
        }
        if (type === T.DATA) t.fromCamera(buf.subarray(3));
        else if (type === T.CLOSE) t.cameraClosed();
    }
    open(port) {
        if (this.streams.size >= MAX_STREAMS) return null;
        let sid = this.nextSid;
        while (this.streams.has(sid)) sid = sid >= 65535 ? 1 : sid + 1;
        this.nextSid = sid >= 65535 ? 1 : sid + 1;
        const t = new Tunnel(this, sid);
        this.streams.set(sid, t);
        this.send(T.OPEN, sid, Buffer.from([port >> 8, port & 255]));
        return t;
    }
    // Closes the oldest live stream that has run a while; false if none may go
    makeRoomForLive() {
        while (this.live >= MAX_LIVE) {
            let oldest = null;
            for (const t of this.streams.values()) if (t.live && (!oldest || t.openedAt < oldest.openedAt)) oldest = t;
            if (!oldest || Date.now() - oldest.openedAt < 10000) return false;
            oldest.destroy();
        }
        return true;
    }
    // Runs `run` now if the camera has room, or later; `fail` if it never gets any
    whenFree(run, fail) {
        if (this.streams.size < CAM_STREAMS && !this.queue.length) {
            run();
            return null;
        }
        const entry = { run, fail, done: false };
        const timer = setTimeout(() => {
            if (entry.done) return;
            entry.done = true;
            fail();
        }, QUEUE_WAIT);
        entry.run = () => { clearTimeout(timer); run(); };
        entry.cancel = () => { entry.done = true; clearTimeout(timer); };
        this.queue.push(entry);
        return entry;
    }
    next() {
        while (this.queue.length && this.streams.size < CAM_STREAMS) {
            const e = this.queue.shift();
            if (e.done) continue;
            e.done = true;
            e.run();
        }
    }
    closeAll() {
        for (const t of this.streams.values()) {
            t.remoteClosed = true;
            t.destroy(new Error('camera disconnected'));
        }
        this.streams.clear();
        for (const e of this.queue.splice(0)) {
            if (e.done) continue;
            e.done = true;
            e.fail();
        }
    }
}

// ---------- camera connections ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function publicBase(req) {
    if (process.env.PUBLIC_BASE) return process.env.PUBLIC_BASE.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function onCamera(ws, req) {
    const id = String(req.headers['x-cam-id'] || '');
    const key = String(req.headers['x-cam-key'] || '');
    const fw = String(req.headers['x-cam-fw'] || '').replace(/[^\w.-]/g, '').slice(0, 20);
    const ip = clientIp(req);
    const reject = code => {
        log('camera rejected', id, code, ip);
        ws.send(JSON.stringify({ t: 'err', code }));
        setTimeout(() => ws.close(4001, code), 200);
    };
    if (!tokenOk(req.headers['x-cam-token'])) return reject('token');
    if (!/^[a-z0-9]{8,32}$/.test(id) || key.length < 16 || key.length > 128) return reject('key');
    const entry = registry[id];
    const hash = sha256(key);
    if (entry && !sameHash(entry.key, hash)) return reject('taken');
    if (!entry) {
        if (registrations.take(ip)) return reject('limit');
        registry[id] = { key: hash, created: new Date().toISOString() };
        saveRegistry();
        log('camera registered', id);
    }
    registry[id].lastSeen = new Date().toISOString();
    registry[id].fw = fw;
    registryDirty = true;

    const old = devices.get(id);
    if (old) {
        old.closeAll();
        old.ws.terminate();
    }
    const dev = new Device(id, ws, fw);
    devices.set(id, dev);
    log('camera online', id, fw, ip);
    ws.send(JSON.stringify({ t: 'ok', url: `${publicBase(req)}/cam/${id}/` }));
    ws.on('close', () => {
        if (devices.get(id) === dev) devices.delete(id);
        dev.closeAll();
        log('camera offline', id);
    });
    ws.on('error', () => {});
}

// Drop cameras that stopped answering pings
setInterval(() => {
    for (const dev of devices.values()) {
        // Two pings in a row unanswered, with nothing else heard: gone
        if (++dev.missed > 2) { dev.ws.terminate(); continue; }
        dev.ws.ping();
    }
}, 30000).unref();

// ---------- browser requests ----------

// Headers passed to the camera, and back to the browser. Everything else is
// dropped: a camera must not be able to set e.g. HSTS or domain-wide cookies.
const REQ_HEADERS = ['accept', 'accept-language', 'content-type', 'content-length', 'if-none-match',
    'if-modified-since', 'range', 'user-agent', 'x-requested-with'];
const RES_HEADERS = ['content-type', 'content-length', 'content-disposition', 'cache-control', 'etag',
    'last-modified', 'content-encoding', 'content-range', 'accept-ranges'];
const SECURITY_HEADERS = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    // The link itself is the camera's address: never leak it to other sites
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
};

// sid=<token>; ... -> sid=<token>; Path=/cam/<id>/; HttpOnly; SameSite=Strict; Secure
function cleanCookie(c, id) {
    const m = /^sid=([a-z0-9]{0,64})(?:;|$)/.exec(c);
    if (!m) return null;
    const age = /;\s*Max-Age=(\d+)/i.exec(c);
    return `sid=${m[1]}; Path=/cam/${id}/; HttpOnly; SameSite=Strict; Secure${age ? '; Max-Age=' + age[1] : ''}`;
}

// The relay's own pages, in the browser's language (Ukrainian or English)
const PAGES = {
    notfound: { uk: ['Сторінку не знайдено', 'Перевірте посилання на камеру.'], en: ['Page not found', 'Check the camera link.'] },
    offline: {
        uk: ['Камера не в мережі', 'Камера зараз не підключена до інтернету. Перевірте, що вона увімкнена і Wi-Fi працює, та спробуйте ще раз за хвилину.'],
        en: ['The camera is offline', 'The camera is not connected to the internet right now. Check that it is switched on and its Wi-Fi works, then try again in a minute.'],
    },
    busy: {
        uk: ['Камера зайнята', 'Забагато одночасних переглядів. Закрийте інші вкладки з камерою та спробуйте ще раз.'],
        en: ['The camera is busy', 'Too many people are watching at once. Close other tabs with the camera and try again.'],
    },
    timeout: {
        uk: ['Камера не відповідає', 'Камера на зв\'язку, але не відповіла вчасно. Спробуйте ще раз.'],
        en: ['The camera isn\'t answering', 'The camera is online but didn\'t answer in time. Try again.'],
    },
    reload: { uk: ['Оновити сторінку'], en: ['Reload the page'] },
};
function langOf(req) {
    for (const part of String(req.headers['accept-language'] || '').split(',')) {
        const code = part.trim().slice(0, 2).toLowerCase();
        if (code === 'uk' || code === 'ru') return 'uk';
        if (code === 'en') return 'en';
    }
    return 'uk';
}

function page(req, res, code, key) {
    const lang = langOf(req);
    const [title, text] = PAGES[key][lang];
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f3ecff;background:linear-gradient(160deg,#4b3478,#2a1a4a 55%,#1d1236);padding:16px;box-sizing:border-box}
.c{max-width:420px;background:rgb(58 36 104/72%);border:1px solid rgb(212 194 245/14%);border-radius:20px;padding:28px;text-align:center;box-shadow:0 10px 30px rgb(10 4 30/35%)}
h1{font-size:1.4rem;margin:0 0 10px}p{color:#c3b3e6;margin:0 0 20px;line-height:1.5}a{display:inline-block;padding:13px 22px;border-radius:14px;background:#b39ddb;color:#1f1238;font-weight:600;text-decoration:none}</style></head>
<body><div class="c"><h1>${title}</h1><p>${text}</p><a href="">${PAGES.reload[lang][0]}</a></div></body></html>`;
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
}

function handle(req, res) {
    const m = /^\/cam\/([a-z0-9]{8,32})(\/.*)?$/.exec(req.url.split('?')[0]);
    if (!m) return page(req, res, 404, 'notfound');
    const id = m[1];
    if (!m[2]) {
        res.writeHead(301, { Location: `/cam/${id}/` + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') });
        return res.end();
    }
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const sub = m[2];
    const dev = devices.get(id);
    const isApi = sub.startsWith('/api/');
    const json = (code, obj) => {
        res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
    };
    // Guessing passwords: a few tries per address, on top of the camera's own lockout
    if (sub === '/api/login' && req.method === 'POST') {
        const wait = logins.take(clientIp(req));
        if (wait) return json(429, { error: 'locked', wait });
    }
    if (!dev) {
        if (isApi) return json(503, { error: 'offline', message: 'Камера не в мережі' });
        return page(req, res, 503, 'offline');
    }
    const busy = () => {
        if (res.headersSent || res.destroyed) return;
        if (isApi) return json(503, { error: 'busy', message: 'Камера зайнята, спробуйте ще раз' });
        page(req, res, 503, 'busy');
    };
    const live = sub === '/stream';
    // A viewer that went away can stay connected for a minute (Cloudflare keeps
    // the request open), so the newest viewer takes the oldest one's place
    if (live && !dev.makeRoomForLive()) return busy();
    const queued = dev.whenFree(forward, busy);
    if (queued) res.on('close', () => { if (!queued.done) queued.cancel(); });

    function forward() {
        if (res.destroyed) return;
        const port = sub === '/stream' || sub === '/snapshot' ? 81 : 80;
        if (live && !dev.makeRoomForLive()) return busy();
        const tunnel = dev.open(port);
        if (!tunnel) return page(req, res, 503, 'busy');
        if (live) {
            tunnel.live = true;
            tunnel.openedAt = Date.now();
            dev.live++;
        }

        // Only the camera's own session cookie goes to the camera
        const headers = {};
        for (const k of REQ_HEADERS) if (req.headers[k] !== undefined) headers[k] = req.headers[k];
        const sid = (req.headers.cookie || '').split(/;\s*/).find(c => /^sid=[a-z0-9]{1,64}$/.test(c));
        if (sid) headers.cookie = sid;
        headers.host = 'camera';
        headers.connection = 'close';
        // Who is visiting, for the camera's login history
        headers['x-client-ip'] = String(clientIp(req) || '').slice(0, 39);
        const place = clientPlace(req);
        if (place) headers['x-client-place'] = place;

        const preq = http.request({ method: req.method, path: sub + query, headers, createConnection: () => tunnel });
        const firstByte = setTimeout(() => preq.destroy(new Error('timeout')), 30000);
        preq.on('response', pres => {
            clearTimeout(firstByte);
            const out = { ...SECURITY_HEADERS };
            for (const k of RES_HEADERS) if (pres.headers[k] !== undefined) out[k] = pres.headers[k];
            const cookies = (pres.headers['set-cookie'] || []).map(c => cleanCookie(c, id)).filter(Boolean);
            if (cookies.length) out['set-cookie'] = cookies;
            // Only redirects within this camera (the camera's own may name LAN addresses)
            const loc = pres.headers.location;
            if (loc) out.location = /^\/(?!\/)/.test(loc) ? `/cam/${id}${loc}` : `/cam/${id}/`;
            out['x-accel-buffering'] = 'no';
            res.writeHead(pres.statusCode, out);
            pres.pipe(res);
            pres.on('error', () => res.destroy());
        });
        preq.on('error', err => {
            clearTimeout(firstByte);
            tunnel.destroy();
            if (!res.headersSent) {
                if (isApi) {
                    json(504, { error: 'timeout', message: 'Камера не відповідає' });
                } else {
                    page(req, res, 504, 'timeout');
                }
            } else {
                res.destroy();
            }
        });
        res.on('close', () => {
            clearTimeout(firstByte);
            preq.destroy();
            tunnel.destroy();
        });
        req.pipe(preq);
    }
}

const server = http.createServer(handle);
server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/cam-relay/ws') return socket.destroy();
    if (cameraConnects.take(clientIp(req))) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        return;
    }
    wss.handleUpgrade(req, socket, head, ws => onCamera(ws, req));
});
server.keepAliveTimeout = 65000;
server.requestTimeout = 0; // streams run for hours
server.listen(PORT, HOST, () => log(`relay listening on ${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (registryDirty) saveRegistry();
        process.exit(0);
    });
}
