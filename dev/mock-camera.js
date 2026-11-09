'use strict';
// Development stand-in for the camera firmware: serves web/ and a fake API on
// PORT (default 8080) and MJPEG on PORT+1, like the ESP32 does on 80 and 81.
// With RELAY=ws://127.0.0.1:3040 it also connects to the relay as a camera,
// forwarding tunnel streams exactly like src/remote.cpp.
//
//   node dev/mock-camera.js            # open http://localhost:8080 (admin / 123456)
//   SETUP=1 node dev/mock-camera.js    # start in the first-setup wizard
//   SENSOR=OV3660 node dev/mock-camera.js  # a 3 MP sensor (sizes up to 2048×1536)
//   FACES=1 node dev/mock-camera.js    # an ESP32-S3 board with face recognition

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = +(process.env.PORT || 8080);
const WEB = path.join(__dirname, '..', 'web');
const SENSOR = process.env.SENSOR === 'OV3660' ? { sensor: 'OV3660', maxFramesize: 17 } : { sensor: 'OV2640', maxFramesize: 13 };
const FACES = !!process.env.FACES;
const FRAMES = fs.readdirSync(path.join(__dirname, 'frames')).sort().map(f => fs.readFileSync(path.join(__dirname, 'frames', f)));

let configured = !process.env.SETUP;
let user = 'admin', password = '123456';
const sessions = new Set();
const confirmedUntil = new Map(); // sid -> ms the password confirmation lasts until
let lamp = 0, manual = false, recStart = 0;
let clockSet = true;
const settings = {
    name: 'Подвір\'я', tz: 'EET-2EEST,M3.5.0/3,M10.5.0/4', security: true, statusLed: true,
    camera: { framesize: 9, quality: 12, brightness: 0, contrast: 0, saturation: 0, special: 0, awb: true, awbGain: true, wbMode: 0, aec: true, aec2: false, aeLevel: 0, aecValue: 300, agc: true, agcGain: 0, gainCeiling: 2, bpc: false, wpc: true, rawGma: true, lenc: true, hmirror: false, vflip: false, dcw: true, rotate: 0 },
    motion: { sensitivity: 3, postSeconds: 10, preSeconds: 3, maxClipSeconds: 300, fps: 10, lampOnRecord: false },
    remote: { enabled: true, host: 'localhost:3040', tls: false, insecure: false, id: 'k3v9x2m7qa', tokenSet: true },
};
if (FACES) settings.faces = { enabled: true, accuracy: 2 };

// Fake faces: remembered people, sightings, and an enrolment that succeeds after a few seconds
const people = [{ uid: 101, name: 'Мама' }, { uid: 102, name: 'Мама' }, { uid: 103, name: 'Тарас' }];
let faceSeq = 500;
const faceEvents = [['Тарас', 300], ['', 1500], ['Мама', 4000], ['', 9000], ['Мама', 90000]].map(([name, ago]) => ({ n: faceSeq++, name, ago, time: Math.floor(Date.now() / 1000) - ago }));
let enroll = { state: 'idle', name: '', at: 0 };
function enrollState() {
    if (!['look', 'far'].includes(enroll.state)) return enroll.state;
    const t = Date.now() - enroll.at;
    if (t > 4500) {
        people.push({ uid: Math.floor(Math.random() * 1e9), name: enroll.name });
        enroll.state = 'done';
    } else {
        enroll.state = t > 2000 ? 'look' : 'far';
    }
    return enroll.state;
}

// Fake recordings: today, yesterday, a week ago
const recs = {};
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
for (const [ago, n] of [[0, 5], [1, 7], [6, 3]]) {
    const d = new Date(Date.now() - ago * 86400000);
    recs[ymd(d)] = [...Array(n)].map((_, i) => {
        const hh = String(20 - i * 2).padStart(2, '0');
        return `${hh}${String(10 + i * 7).padStart(2, '0')}${String(i * 6).padStart(2, '0')}_${4 + i * 3}_${i % 3 === 2 ? 'r' : 'm'}.avi`;
    });
}

function json(res, code, obj, extra = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
}
const cookieSid = req => ((req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/) || [])[1];
const authed = req => sessions.has(cookieSid(req));
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });

function merge(dst, src) {
    for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) merge(dst[k] = dst[k] || {}, v);
        else dst[k] = v;
    }
}

// Login history and logged-in devices, like src/auth.cpp
const nowS = () => Math.floor(Date.now() / 1000);
const loginHistory = [
    { at: nowS() - 2 * 3600, ip: '185.12.33.7', place: encodeURIComponent('Amsterdam, North Holland, NL'), dev: 'Firefox · Linux', remote: true, ok: false, n: 4 },
    { at: nowS() - 5 * 3600, ip: '93.170.44.12', place: encodeURIComponent('Lviv, Lviv Oblast, UA'), dev: 'Chrome · Android', remote: true, ok: true, id: 7 },
    { at: nowS() - 3 * 86400, ip: '192.168.1.23', dev: 'Safari · iPhone', remote: false, ok: true, id: 3 },
];
const sessionInfo = new Map([['phone'.padEnd(40, 'p'), { id: 7, at: nowS() - 5 * 3600, seen: nowS() - 1800, ip: '93.170.44.12', place: loginHistory[1].place, dev: 'Chrome · Android', remote: true }],
    ['ipad'.padEnd(40, 'i'), { id: 3, at: nowS() - 3 * 86400, seen: nowS() - 86400, ip: '192.168.1.23', dev: 'Safari · iPhone', remote: false }]]);
for (const t of sessionInfo.keys()) sessions.add(t);
let loginSeq = 1;
function deviceOf(ua = '') {
    const os = /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg/.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
    return [br, os].filter(Boolean).join(' · ');
}
function recordLogin(req, ok, token) {
    const e = { at: nowS(), ip: req.socket.remoteAddress.replace(/^::ffff:/, ''), dev: deviceOf(req.headers['user-agent']), remote: false, ok };
    if (ok) {
        e.id = Math.floor(Math.random() * 1e9) + 1;
        sessionInfo.set(token, { id: e.id, at: e.at, seen: e.at, ip: e.ip, dev: e.dev, remote: false });
    }
    loginHistory.unshift(e);
    loginHistory.splice(16);
    loginSeq++;
}

function status() {
    const recOn = manual || (settings.security && Math.floor(Date.now() / 20000) % 3 === 0);
    if (recOn && !recStart) recStart = Date.now();
    if (!recOn) recStart = 0;
    return {
        name: settings.name, fw: '1.0.0-mock', security: settings.security, camera: true, width: 800, height: 600, fps: 12.4, viewers: 1, lamp,
        rotate: settings.camera.rotate,
        // -1: no motion since the (pretend) restart; the page falls back on the newest clip
        motion: { active: settings.security && recOn, level: 40, ago: -1 },
        logins: loginSeq,
        rec: { on: recOn, manual, sec: recStart ? Math.floor((Date.now() - recStart) / 1000) : 0, error: '' },
        sd: { ok: true, total: 31914983424, used: 12884901888 },
        wifi: { connected: true, ssid: 'Дім_2.4', rssi: -58, ip: '192.168.1.57', host: 'camera-a1b2.local', ap: false, apSsid: 'ESP32-Camera-A1B2', mac: '24:0A:C4:00:A1:B2' },
        remote: { enabled: settings.remote.enabled, state: settings.remote.enabled ? (relayUp ? 'online' : 'connecting') : 'off', url: `http://${settings.remote.host}/cam/${settings.remote.id}/` },
        faces: FACES ? { enabled: settings.faces.enabled, on: settings.faces.enabled, seq: faceSeq } : undefined,
        clock: clockSet, time: Math.floor(Date.now() / 1000), uptime: 3725, heap: 142000, psram: 3500000,
    };
}

async function api(req, res, url) {
    const p = url.pathname;
    const post = req.method === 'POST';
    if (post && req.headers['x-requested-with'] !== 'cam') return json(res, 403, { error: 'csrf' });
    const setupOpen = !configured;
    const need = (lvl) => {
        if (lvl === 'public' || authed(req) || (lvl === 'setup' && setupOpen)) return true;
        json(res, 401, { error: 'auth' });
        return false;
    };
    if (p === '/api/state') return json(res, 200, { configured, wifi: configured, setup: setupOpen, recovery: false, authed: authed(req), name: settings.name, ap: !configured, apSsid: 'ESP32-Camera-A1B2', streamPort: PORT + 1, fw: '1.0.0-mock', user, faces: FACES });
    if (p === '/api/login' && post) {
        const b = await body(req);
        if (b.user !== user || b.password !== password) { recordLogin(req, false); return json(res, 403, { error: 'wrong', wait: 0 }); }
        const t = Math.random().toString(36).slice(2).padEnd(40, 'x').slice(0, 40);
        sessions.add(t);
        recordLogin(req, true, t);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
    }
    if (p === '/api/logout' && post) { sessions.delete(cookieSid(req)); sessionInfo.delete(cookieSid(req)); return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
    if (p === '/api/time' && post) { if (need('setup')) json(res, 200, { ok: true }); return; }
    if (p === '/api/wifi/scan') {
        if (!need('setup')) return;
        if (url.searchParams.has('start')) return json(res, 200, { busy: true, networks: [] });
        return json(res, 200, { busy: false, networks: [{ ssid: 'Дім_2.4', rssi: -48, lock: true }, { ssid: 'TP-Link_5E21', rssi: -63, lock: true }, { ssid: 'Сусіди', rssi: -79, lock: true }, { ssid: 'Free WiFi', rssi: -84, lock: false }] });
    }
    if (p === '/api/setup' && post) {
        if (!need('setup')) return;
        const b = await body(req);
        user = b.user; password = b.password; configured = true;
        const t = 'setup'.padEnd(40, 's');
        sessions.add(t);
        setupAt = Date.now();
        return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=${t}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === '/api/setup/status') return json(res, 200, { state: Date.now() - setupAt > 4000 ? 'ok' : 'connecting', ip: '192.168.1.57', host: 'camera-a1b2.local', ssid: 'Дім_2.4' });
    if (!need('user')) return;
    if (p === '/api/status') return json(res, 200, status());
    if (p === '/api/logins/end' && post) {
        const b = await body(req);
        for (const [t, s] of sessionInfo) if (s.id === b.id) { sessionInfo.delete(t); sessions.delete(t); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: 'missing' });
    }
    if (p === '/api/logins') {
        const mine = cookieSid(req);
        if (sessionInfo.has(mine)) sessionInfo.get(mine).seen = nowS();
        const list = [...sessionInfo].sort((a, b) => b[1].at - a[1].at).map(([t, s]) => ({ ...s, current: t === mine || undefined }));
        return json(res, 200, { sessions: list, history: loginHistory });
    }
    // The password again before risky changes, like the camera (10 minutes)
    if (p === '/api/confirm') {
        if (!post) return json(res, 200, { left: Math.max(0, Math.round((confirmedUntil.get(cookieSid(req)) || 0) - Date.now()) / 1000 | 0) });
        if ((await body(req)).password !== password) return json(res, 403, { error: 'wrong', wait: 0 });
        confirmedUntil.set(cookieSid(req), Date.now() + 600000);
        return json(res, 200, { ok: true });
    }
    const confirmed = () => (confirmedUntil.get(cookieSid(req)) || 0) > Date.now();
    if (p === '/api/settings') {
        if (post) {
            const b = await body(req);
            if (b.remote && !confirmed()) return json(res, 403, { error: 'confirm', message: 'Підтвердіть паролем' });
            if (b.remote && b.remote.token) { delete b.remote.token; settings.remote.tokenSet = true; }
            merge(settings, b);
        }
        return json(res, 200, { ...settings, ...SENSOR, apSsid: 'ESP32-Camera-A1B2', apPassword: 'k7mq4xr2tw' });
    }
    if (p === '/api/security' && post) { settings.security = !!(await body(req)).on; return json(res, 200, { ok: true }); }
    if (p === '/api/lamp' && post) { lamp = (await body(req)).level | 0; return json(res, 200, { ok: true }); }
    if (p === '/api/record' && post) { manual = !!(await body(req)).on; return json(res, 200, { ok: true }); }
    if (p === '/api/rec/days') return json(res, 200, { days: Object.keys(recs).filter(d => recs[d].length).sort().reverse().map(d => ({ d, n: recs[d].length })) });
    const item = (d, f) => { const u = f.indexOf('_', 7); return { f: `${d}/${f}`, d, t: f.slice(0, 6), dur: +f.slice(7, u), k: f[u + 1] }; };
    if (p === '/api/rec/list') { const d = url.searchParams.get('d'); return json(res, 200, { items: (recs[d] || []).slice().sort().reverse().map(f => item(d, f)) }); }
    if (p === '/api/rec/recent') {
        const out = [];
        for (const d of Object.keys(recs).sort().reverse()) for (const f of recs[d].slice().sort().reverse()) if (out.length < (+url.searchParams.get('n') || 4)) out.push(item(d, f));
        return json(res, 200, { items: out });
    }
    if (p === '/api/rec/info') { const f = url.searchParams.get('f'); const dur = +f.split('_')[1]; return json(res, 200, { frames: dur * 10, fps: 10, width: 800, height: 600, size: 1e6 }); }
    if (p === '/api/rec/frame') {
        const n = +url.searchParams.get('n');
        const seed = url.searchParams.get('f').length;
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800, immutable' });
        return setTimeout(() => res.end(FRAMES[(n + seed * 3) % FRAMES.length]), 30);
    }
    if (p === '/api/rec/file') {
        const f = url.searchParams.get('f');
        const n = +f.split('_')[1] * 10, seed = f.length;
        const avi = mjpegAvi(Array.from({ length: n }, (_, k) => FRAMES[(k + seed * 3) % FRAMES.length]), 10);
        res.writeHead(200, { 'Content-Type': 'video/x-msvideo', 'Content-Length': avi.length, 'Content-Disposition': 'attachment; filename="camera.avi"' });
        return res.end(avi);
    }
    if (p === '/api/rec/delete' && post) {
        const b = await body(req);
        const files = b.files || [b.f];
        let n = 0;
        for (const f of files) { const [d, name] = f.split('/'); const i = (recs[d] || []).indexOf(name); if (i >= 0) { recs[d].splice(i, 1); n++; } }
        return json(res, 200, { deleted: n });
    }
    if (p === '/api/rec/clear' && post) { let n = 0; for (const d of Object.keys(recs)) { n += recs[d].length; recs[d] = []; } return json(res, 200, { deleted: n }); }
    if (p === '/api/faces') {
        enrollState();
        return json(res, 200, { available: FACES, enabled: settings.faces.enabled, running: true, max: 16, people, enroll, seq: faceSeq, events: faceEvents });
    }
    if (p === '/api/faces/live') {
        // A face drifting across the picture, a stranger now and then
        const k = (Date.now() / 4000) % 1;
        const faces = [{ x: 200 + Math.round(k * 400), y: 220, w: 160, h: 210, known: enroll.state !== 'look' && enroll.state !== 'far', name: 'Мама' }];
        if (Math.floor(Date.now() / 6000) % 2) faces.push({ x: 720, y: 300, w: 110, h: 140, known: false });
        return json(res, 200, { age: 120, running: true, faces });
    }
    if (p === '/api/faces/enroll' && post) {
        const b = await body(req);
        if (!(b.name || '').trim()) return json(res, 400, { error: 'name', message: 'Вкажіть ім\'я' });
        enroll = { state: 'far', name: b.name.trim(), at: Date.now() };
        return json(res, 200, { ok: true });
    }
    if (p === '/api/faces/cancel' && post) { enroll.state = 'idle'; return json(res, 200, { ok: true }); }
    if (p === '/api/faces/forget' && post) {
        const b = await body(req);
        const uids = b.uids || [b.uid];
        let n = 0;
        for (const u of uids) { const i = people.findIndex(x => x.uid === u); if (i >= 0) { people.splice(i, 1); n++; } }
        return json(res, 200, { deleted: n });
    }
    if (p === '/api/faces/photo' || p === '/api/faces/event') {
        const n = +(url.searchParams.get('u') || url.searchParams.get('n'));
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(FRAMES[n % FRAMES.length]);
    }
    if (p === '/api/account' && post) {
        const b = await body(req);
        if (b.current !== password) return json(res, 403, { error: 'current', message: 'Поточний пароль невірний' });
        user = b.user; password = b.password;
        return json(res, 200, { ok: true });
    }
    if (p === '/api/remote/new-id' && post) { settings.remote.id = Math.random().toString(36).slice(2, 12); return json(res, 200, { ok: true }); }
    if (p === '/api/wifi' && post) return confirmed() ? json(res, 200, { ok: true }) : json(res, 403, { error: 'confirm', message: 'Підтвердіть паролем' });
    if (p === '/api/reboot' && post) return json(res, 200, { ok: true });
    json(res, 404, { error: 'notfound' });
}
let setupAt = 0;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => { console.error(e); json(res, 500, {}); });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const fp = path.join(WEB, path.basename(file));
    if (!fs.existsSync(fp)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log(`mock camera on http://localhost:${PORT}`));

// A Motion-JPEG AVI shaped like src/avi.cpp writes them: RIFF, hdrl with avih
// and strh (rate/scale), then the frames as '00dc' chunks in the movi list
function mjpegAvi(frames, fps) {
    const chunk = (id, data) => {
        const head = Buffer.alloc(8);
        head.write(id, 0, 'latin1');
        head.writeUInt32LE(data.length, 4);
        return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
    };
    const list = (type, parts) => chunk('LIST', Buffer.concat([Buffer.from(type, 'latin1'), ...parts]));
    const avih = Buffer.alloc(56);
    avih.writeUInt32LE(Math.round(1e6 / fps), 0);
    avih.writeUInt32LE(frames.length, 16);
    const strh = Buffer.alloc(56);
    strh.write('vidsMJPG', 0, 'latin1');
    strh.writeUInt32LE(1000, 20);
    strh.writeUInt32LE(fps * 1000, 24);
    const body = Buffer.concat([Buffer.from('AVI ', 'latin1'), list('hdrl', [chunk('avih', avih), list('strl', [chunk('strh', strh)])]), list('movi', frames.map(f => chunk('00dc', f)))]);
    return chunk('RIFF', body);
}

// MJPEG on PORT+1
http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!authed(req)) { res.writeHead(401); return res.end('login required'); }
    // Like src/streamsrv.cpp: the UI on PORT may read the stream and snapshots
    const origin = req.headers.origin;
    const cors = origin && new URL(origin).hostname === req.headers.host.split(':')[0] ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {};
    if (url.pathname === '/snapshot') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="camera.jpg"', ...cors });
        return res.end(FRAMES[0]);
    }
    if (url.pathname !== '/stream') { res.writeHead(404); return res.end(); }
    const fps = Math.min(15, +(url.searchParams.get('fps') || 15));
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', ...cors });
    let i = 0;
    const t = setInterval(() => {
        const f = FRAMES[i++ % FRAMES.length];
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
        res.write(f);
        res.write('\r\n');
    }, 1000 / fps);
    req.on('close', () => clearInterval(t));
}).listen(PORT + 1);

// ---------- optional: act as the camera's tunnel client ----------

let relayUp = false;
if (process.env.RELAY) {
    const WebSocket = require(path.join(__dirname, '..', 'relay', 'node_modules', 'ws'));
    const KEY = process.env.KEY || 'mock-secret-key-0123456789abcdef';
    const connect = () => {
        const ws = new WebSocket(`${process.env.RELAY}/cam-relay/ws`, { headers: { 'X-Cam-Id': settings.remote.id, 'X-Cam-Key': KEY, 'X-Cam-Fw': 'mock', 'X-Cam-Token': process.env.TOKEN || '' } });
        const streams = new Map();
        const frame = (type, id, payload) => {
            const head = Buffer.from([type, id >> 8, id & 255]);
            if (ws.readyState === 1) ws.send(payload ? Buffer.concat([head, payload]) : head);
        };
        ws.on('message', (data, bin) => {
            if (!bin) {
                const m = JSON.parse(data);
                relayUp = m.t === 'ok';
                console.log('relay says', m);
                return;
            }
            const type = data[0], id = (data[1] << 8) | data[2];
            let s = streams.get(id);
            if (type === 1) {
                const port = data.length >= 5 ? (data[3] << 8) | data[4] : 80;
                const sock = net.connect(port === 81 ? PORT + 1 : PORT, '127.0.0.1');
                streams.set(id, sock);
                sock.on('data', chunk => { for (let o = 0; o < chunk.length; o += 4093) frame(2, id, chunk.subarray(o, o + 4093)); });
                sock.on('close', () => { if (streams.get(id) === sock) { streams.delete(id); frame(3, id); } });
                sock.on('error', () => {});
            } else if (type === 2 && s) s.write(data.subarray(3));
            else if (type === 3 && s) { streams.delete(id); s.destroy(); }
            else if (type === 4 && s) s.pause();
            else if (type === 5 && s) s.resume();
        });
        ws.on('close', () => { relayUp = false; for (const s of streams.values()) s.destroy(); setTimeout(connect, 2000); });
        ws.on('error', () => {});
    };
    connect();
}
