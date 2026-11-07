'use strict';
// Demo camera: answers the web UI's API in the browser, so the interface can
// be tried without an ESP32. Loaded before app.js by scripts/build_demo.py.
//
// The "camera" shows a drawn yard. Someone walks past every 30 seconds; with
// security mode on that becomes a recording in Записи. Picture settings
// (brightness, effects, mirror, lamp...) change the drawing live.
(function () {
    const STORE = 'camDemo.v1';
    const PERIOD = 30000; // a passer-by every 30 s
    const WALK = 9000;    // ...visible for 9 s
    const DEMO_USER = 'admin', DEMO_PASS = 'demo1234';

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const pad = n => String(n).padStart(2, '0');
    const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const hms = d => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

    function storageGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
    function storageSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
    function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function sessionSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }

    function defaults() {
        const recs = [];
        const now = new Date();
        // A few days of history
        for (const [daysAgo, times] of [[0, ['081512', '093044', '121805', '154230']], [1, ['071102', '083356', '130419', '171522', '194408']], [3, ['100230', '183012']]]) {
            const d = new Date(now.getTime() - daysAgo * 86400000);
            times.forEach((t, i) => {
                // Today's only if already in the past
                if (daysAgo === 0 && +t.slice(0, 2) > now.getHours()) return;
                recs.push({ d: ymd(d), t, dur: 12 + ((i * 7 + daysAgo * 3) % 20), k: i === 2 ? 'r' : 'm', seed: daysAgo * 10 + i });
            });
        }
        return {
            configured: true,
            user: DEMO_USER,
            password: DEMO_PASS,
            recs,
            settings: {
                name: 'Подвір\'я', tz: 'EET-2EEST,M3.5.0/3,M10.5.0/4', security: true, statusLed: true,
                camera: { framesize: 9, quality: 12, brightness: 0, contrast: 0, saturation: 0, special: 0, awb: true, awbGain: true, wbMode: 0, aec: true, aec2: false, aeLevel: 0, aecValue: 300, agc: true, agcGain: 0, gainCeiling: 2, bpc: false, wpc: true, rawGma: true, lenc: true, hmirror: false, vflip: false, dcw: true, rotate: 0 },
                motion: { sensitivity: 3, postSeconds: 10, preSeconds: 3, maxClipSeconds: 300, fps: 10, lampOnRecord: false },
                remote: { enabled: true, host: 'cam.example.com', tls: true, insecure: false, id: 'k3v9x2m7qa', tokenSet: true },
            },
        };
    }

    let state = storageGet(STORE) || defaults();
    const save = () => storageSet(STORE, state);
    let lamp = 0;
    let liveStart = Date.now();
    let rec = null; // { start, manual, lastMotion }
    let setupAt = 0;
    const bootAt = Date.now();

    // ---------- the picture ----------

    const SIZES = { 5: [320, 240], 8: [640, 480], 9: [800, 600], 10: [1024, 768], 11: [1280, 720], 13: [1600, 1200] };
    const SHIRTS = ['#3f7fd0', '#d0503f', '#3fa36b', '#9b59b6', '#e0a030', '#2c3e50'];

    // Colour/geometry from the camera settings, as SVG filter + transform
    function look(c) {
        const parts = [];
        const b = c.brightness * 0.07 + (c.aec ? c.aeLevel * 0.05 : (c.aecValue - 300) / 3000);
        const k = 1 + c.contrast * 0.18;
        parts.push(`<feComponentTransfer><feFuncR type="linear" slope="${k}" intercept="${b + 0.5 - k / 2}"/><feFuncG type="linear" slope="${k}" intercept="${b + 0.5 - k / 2}"/><feFuncB type="linear" slope="${k}" intercept="${b + 0.5 - k / 2}"/></feComponentTransfer>`);
        parts.push(`<feColorMatrix type="saturate" values="${Math.max(0, 1 + c.saturation * 0.35)}"/>`);
        const FX = {
            1: '<feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>',
            2: '<feColorMatrix type="saturate" values="0"/>',
            3: '<feColorMatrix type="matrix" values="0.6 0.4 0.2 0 0.1  0.15 0.3 0.1 0 0  0.15 0.2 0.3 0 0  0 0 0 1 0"/>',
            4: '<feColorMatrix type="matrix" values="0.3 0.2 0.1 0 0  0.3 0.6 0.3 0 0.05  0.1 0.2 0.3 0 0  0 0 0 1 0"/>',
            5: '<feColorMatrix type="matrix" values="0.3 0.2 0.1 0 0  0.1 0.3 0.2 0 0  0.3 0.4 0.6 0 0.1  0 0 0 1 0"/>',
            6: '<feColorMatrix type="matrix" values="0.39 0.77 0.19 0 0  0.35 0.69 0.17 0 0  0.27 0.53 0.13 0 0  0 0 0 1 0"/>',
        };
        if (FX[c.special]) parts.push(FX[c.special]);
        const sx = c.hmirror ? -1 : 1, sy = c.vflip ? -1 : 1;
        return {
            filter: `<filter id="f" color-interpolation-filters="sRGB">${parts.join('')}</filter>`,
            transform: `translate(${c.hmirror ? 800 : 0} ${c.vflip ? 600 : 0}) scale(${sx} ${sy})`,
        };
    }

    function person(color, x, walking) {
        const legs = walking
            ? `<line x1="0" y1="0" x2="-9" y2="44" stroke="#2b2b3a" stroke-width="9" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="-18;18;-18" dur="0.9s" repeatCount="indefinite"/></line>
               <line x1="0" y1="0" x2="9" y2="44" stroke="#2b2b3a" stroke-width="9" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="18;-18;18" dur="0.9s" repeatCount="indefinite"/></line>`
            : `<line x1="0" y1="0" x2="-8" y2="44" stroke="#2b2b3a" stroke-width="9" stroke-linecap="round"/><line x1="0" y1="0" x2="8" y2="44" stroke="#2b2b3a" stroke-width="9" stroke-linecap="round"/>`;
        return `<g transform="translate(${x} 430)">
            <g transform="translate(0 0)">${legs}</g>
            <rect x="-16" y="-62" width="32" height="66" rx="13" fill="${color}"/>
            <circle cx="0" cy="-80" r="15" fill="#e7b896"/>
            <path d="M-15 -84 a15 15 0 0 1 30 0 z" fill="#4a3426"/>
        </g>`;
    }

    // `walker`: null, or {color, x} for a still frame, or {color, live:true}
    function scene(opts) {
        const c = state.settings.camera;
        const [w, h] = SIZES[c.framesize] || [800, 600];
        const { filter, transform } = look(c);
        const cloudShift = opts.cloud || 0;
        const clouds = [[120, 90, 1], [470, 60, 0.8], [690, 120, 1.1]].map(([x, y, s], i) => {
            const cx = ((x + cloudShift * (0.6 + i * 0.2)) % 960) - 80;
            const anim = opts.live ? `<animateTransform attributeName="transform" type="translate" from="${cx} ${y}" to="${cx + 140} ${y}" dur="${60 + i * 20}s" repeatCount="indefinite"/>` : '';
            return `<g transform="translate(${cx} ${y})">${anim}<g transform="scale(${s})"><ellipse cx="0" cy="0" rx="46" ry="20" fill="#fff" opacity=".9"/><ellipse cx="30" cy="-10" rx="32" ry="20" fill="#fff" opacity=".9"/><ellipse cx="-30" cy="-6" rx="26" ry="15" fill="#fff" opacity=".9"/></g></g>`;
        }).join('');
        let walker = '';
        if (opts.walker && opts.walker.live) {
            // Walks across once per PERIOD, starting a moment after the stream opens
            walker = `<g transform="translate(-200 0)">
                <animateTransform attributeName="transform" type="translate" values="-140 0;-140 0;960 0;960 0" keyTimes="0;0.02;${(WALK / PERIOD + 0.02).toFixed(3)};1" dur="${PERIOD / 1000}s" repeatCount="indefinite"/>
                ${person(opts.walker.color, 0, true)}</g>`;
        } else if (opts.walker) {
            walker = person(opts.walker.color, opts.walker.x, true);
        }
        const glow = lamp > 0 ? `<rect width="800" height="600" fill="url(#lamp)" opacity="${(lamp / 100) * 0.55}"/>` : '';
        const stamp = opts.stamp ? `<rect x="560" y="14" width="226" height="30" rx="6" fill="#000" opacity=".45"/><text x="673" y="35" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="17" fill="#fff" text-anchor="middle">${opts.stamp}</text>` : '';
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">
<defs>${filter}
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fbde6"/><stop offset="1" stop-color="#dcebf7"/></linearGradient>
<linearGradient id="grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#79a85a"/><stop offset="1" stop-color="#557d3c"/></linearGradient>
<radialGradient id="lamp" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#fff6d8"/><stop offset="1" stop-color="#fff6d8" stop-opacity="0"/></radialGradient>
<radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${state.settings.camera.lenc ? 0.18 : 0.45}"/></radialGradient>
</defs>
<g filter="url(#f)"><g transform="${transform}">
<rect width="800" height="360" fill="url(#sky)"/>
<circle cx="690" cy="80" r="34" fill="#fff4c2"/>
${clouds}
<rect y="340" width="800" height="260" fill="url(#grass)"/>
<path d="M330 600 L390 380 L450 380 L560 600 Z" fill="#cdb995"/>
<g transform="translate(250 170)">
  <rect width="320" height="210" fill="#efe3cf"/>
  <path d="M-25 8 L160 -95 L345 8 Z" fill="#9b5544"/>
  <rect x="135" y="95" width="56" height="115" rx="4" fill="#7a5238"/><circle cx="180" cy="155" r="4" fill="#e3c27a"/>
  <rect x="30" y="60" width="70" height="60" fill="#a9cbe6" stroke="#fff" stroke-width="6"/>
  <rect x="225" y="60" width="70" height="60" fill="#a9cbe6" stroke="#fff" stroke-width="6"/>
</g>
<g fill="#b98e5e">${[...Array(14)].map((_, i) => `<rect x="${i * 20 + (i < 7 ? 0 : 530)}" y="360" width="13" height="80" rx="3"/>`).join('')}
  <rect x="0" y="380" width="270" height="9"/><rect x="530" y="380" width="270" height="9"/></g>
<g transform="translate(110 250)"><rect x="-10" y="40" width="20" height="120" fill="#6b4a2f"/><circle cx="0" cy="20" r="62" fill="#4f8a3d"/><circle cx="-40" cy="50" r="40" fill="#5b9846"/><circle cx="38" cy="48" r="44" fill="#4a8238"/></g>
${walker}
</g></g>
${glow}
<rect width="800" height="600" fill="url(#vig)"/>
${stamp}
</svg>`;
    }

    const svgUrl = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    // Live pictures handed out, so settings changes can redraw them
    const liveImgs = new Set();
    function liveSvg() {
        liveStart = Date.now();
        return svgUrl(scene({ live: true, walker: { live: true, color: SHIRTS[Math.floor(Date.now() / PERIOD) % SHIRTS.length] } }));
    }
    function redrawLive() {
        const url = liveSvg();
        for (const img of document.querySelectorAll('img')) if (liveImgs.has(img.getAttribute('src'))) img.src = url;
        liveImgs.add(url);
    }

    function clipFrame(clip, n, frames) {
        const t = frames > 1 ? n / (frames - 1) : 0;
        const start = new Date(+clip.d.slice(0, 4), +clip.d.slice(4, 6) - 1, +clip.d.slice(6), +clip.t.slice(0, 2), +clip.t.slice(2, 4), +clip.t.slice(4, 6));
        const at = new Date(start.getTime() + (n / 10) * 1000);
        const stamp = `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
        // Motion clips: the person walks through; manual ones: an empty yard
        const dir = clip.seed % 2 ? 1 : -1;
        const x = dir > 0 ? -60 + t * 920 : 860 - t * 920;
        const walker = clip.k === 'm' ? { color: SHIRTS[clip.seed % SHIRTS.length], x } : null;
        return scene({ walker, stamp, cloud: clip.seed * 97 + n * 2 });
    }

    // ---------- status simulation ----------

    function phase() { return (Date.now() - liveStart) % PERIOD; }
    function personVisible() { const p = phase(); return p > PERIOD * 0.02 + 600 && p < PERIOD * 0.02 + WALK - 400; }
    let lastMotion = 0;

    function finishClip() {
        const now = Date.now();
        const start = new Date(rec.start);
        const clip = { d: ymd(start), t: hms(start), dur: Math.max(1, Math.round((now - rec.start) / 1000)), k: rec.manual ? 'r' : 'm', seed: Math.floor(Math.random() * 1000) };
        state.recs.push(clip);
        save();
        rec = null;
    }

    setInterval(() => {
        const s = state.settings;
        const motion = s.security && personVisible();
        if (motion) lastMotion = Date.now();
        if (!rec && motion) rec = { start: Date.now() - s.motion.preSeconds * 1000, manual: false };
        if (rec && !rec.manual && !motion && Date.now() - lastMotion > s.motion.postSeconds * 1000) finishClip();
        if (rec && !rec.manual && !s.security) finishClip();
    }, 500);

    function status() {
        const s = state.settings;
        const used = 9.6e9 + state.recs.length * 2.1e7;
        return {
            name: s.name, fw: '1.0.0-demo', security: s.security, camera: true,
            width: (SIZES[s.camera.framesize] || SIZES[9])[0], height: (SIZES[s.camera.framesize] || SIZES[9])[1],
            fps: 12.5, viewers: 1, lamp, rotate: s.camera.rotate, theme: s.theme || 'purple',
            motion: { active: s.security && personVisible(), level: personVisible() ? 70 : 3, ago: lastMotion ? Math.floor((Date.now() - lastMotion) / 1000) : -1 },
            rec: { on: !!rec, manual: !!(rec && rec.manual), sec: rec ? Math.floor((Date.now() - rec.start) / 1000) : 0, error: '' },
            sd: { ok: true, total: 31914983424, used },
            wifi: { connected: true, ssid: 'Дім_2.4', rssi: -58, ip: '192.168.1.57', host: 'camera-a1b2.local', ap: false, apSsid: 'ESP32-Camera-A1B2', mac: '24:0A:C4:00:A1:B2' },
            remote: { enabled: s.remote.enabled, state: s.remote.enabled ? 'online' : 'off', url: `https://${s.remote.host}/cam/${s.remote.id}/` },
            clock: true, time: Math.floor(Date.now() / 1000), uptime: Math.floor((Date.now() - bootAt) / 1000) + 7342, heap: 141000, psram: 3400000,
        };
    }

    // ---------- the API ----------

    const fname = c => `${c.d}/${c.t}_${c.dur}_${c.k}.avi`;
    const item = c => ({ f: fname(c), d: c.d, t: c.t, dur: c.dur, k: c.k });
    const findClip = f => state.recs.find(c => fname(c) === f);
    const sorted = () => state.recs.slice().sort((a, b) => (b.d + b.t).localeCompare(a.d + a.t));
    const authed = () => sessionGet('camDemo.auth') === '1';
    const setupOpen = () => !state.configured;

    function merge(dst, src) {
        for (const [k, v] of Object.entries(src)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) merge(dst[k] = dst[k] || {}, v);
            else dst[k] = v;
        }
    }

    const COMMON = ['password', '12345678', 'qwertyui', 'qwerty123', '11111111', '87654321', '1q2w3e4r', 'admin123', 'password1'];
    function pwProblem(p) {
        if (p.length < 8) return 'Пароль має містити щонайменше 8 символів';
        if (COMMON.includes(p.toLowerCase())) return 'Цей пароль дуже поширений — його легко вгадати';
        return null;
    }

    async function handle(path, q, method, body) {
        const post = method === 'POST';
        const ok = (obj = { ok: true }) => [200, obj];
        if (path === 'state') return ok({ configured: state.configured, wifi: state.configured, setup: setupOpen(), recovery: false, authed: authed(), name: state.settings.name, ap: setupOpen(), apSsid: 'ESP32-Camera-A1B2', streamPort: 81, fw: '1.0.0-demo', user: state.user, theme: state.settings.theme || 'purple' });
        if (path === 'login' && post) {
            if (body.user !== state.user || body.password !== state.password) return [403, { error: 'wrong', wait: 0 }];
            sessionSet('camDemo.auth', '1');
            return ok();
        }
        if (path === 'logout' || path === 'logout-all') { sessionSet('camDemo.auth', null); return ok(); }
        if (path === 'time') return ok();
        if (path === 'wifi/scan') {
            if (!authed() && !setupOpen()) return [401, { error: 'auth' }];
            if (q.has('start')) return ok({ busy: true, networks: [] });
            await sleep(900);
            return ok({ busy: false, networks: [{ ssid: 'Дім_2.4', rssi: -48, lock: true }, { ssid: 'TP-Link_5E21', rssi: -63, lock: true }, { ssid: 'Сусіди', rssi: -79, lock: true }, { ssid: 'Кав\'ярня Free', rssi: -84, lock: false }] });
        }
        if (path === 'setup' && post) {
            if (!setupOpen()) return [401, { error: 'auth' }];
            const p = pwProblem(body.password || '');
            if (p) return [400, { error: 'password', message: p }];
            state.user = body.user;
            state.password = body.password;
            state.configured = true;
            save();
            sessionSet('camDemo.auth', '1');
            setupAt = Date.now();
            return ok();
        }
        if (path === 'setup/status') return ok({ state: Date.now() - setupAt > 3500 ? 'ok' : 'connecting', ip: '192.168.1.57', host: 'camera-a1b2.local', ssid: 'Дім_2.4' });
        if (!authed()) return [401, { error: 'auth' }];

        if (path === 'status') return ok(status());
        if (path === 'settings') {
            if (post) {
                if (body.remote && body.remote.token) { delete body.remote.token; state.settings.remote.tokenSet = true; }
                merge(state.settings, body);
                save();
                if (body.camera) redrawLive();
            }
            return ok(state.settings);
        }
        if (path === 'security' && post) { state.settings.security = !!body.on; save(); return ok(); }
        if (path === 'lamp' && post) { lamp = body.level | 0; redrawLive(); return ok(); }
        if (path === 'record' && post) {
            if (body.on && !rec) rec = { start: Date.now(), manual: true };
            else if (body.on && rec) rec.manual = true;
            else if (!body.on && rec && rec.manual) finishClip();
            return ok();
        }
        if (path === 'rec/days') {
            const days = {};
            for (const c of state.recs) days[c.d] = (days[c.d] || 0) + 1;
            return ok({ days: Object.keys(days).sort().reverse().map(d => ({ d, n: days[d] })) });
        }
        if (path === 'rec/list') return ok({ items: sorted().filter(c => c.d === q.get('d')).map(item) });
        if (path === 'rec/recent') return ok({ items: sorted().slice(0, +q.get('n') || 4).map(item) });
        if (path === 'rec/info') {
            const c = findClip(q.get('f'));
            return c ? ok({ frames: c.dur * 10, fps: 10, width: 800, height: 600, size: c.dur * 4e5 }) : [404, { error: 'missing' }];
        }
        if (path === 'rec/delete' && post) {
            const files = body.files || [body.f];
            const before = state.recs.length;
            state.recs = state.recs.filter(c => !files.includes(fname(c)));
            save();
            return ok({ deleted: before - state.recs.length });
        }
        if (path === 'rec/clear' && post) { const n = state.recs.length; state.recs = []; save(); return ok({ deleted: n }); }
        if (path === 'account' && post) {
            if (body.current !== state.password) return [403, { error: 'current', message: 'Поточний пароль невірний' }];
            const p = pwProblem(body.password || '');
            if (p) return [400, { error: 'password', message: p }];
            state.user = body.user;
            state.password = body.password;
            save();
            return ok();
        }
        if (path === 'remote/new-id' && post) { state.settings.remote.id = Math.random().toString(36).slice(2, 12).padEnd(10, '0'); save(); return ok(); }
        if (path === 'wifi' && post) return ok();
        if (path === 'reboot' && post) return ok();
        return [404, { error: 'notfound' }];
    }

    const realFetch = window.fetch.bind(window);
    window.fetch = async function (input, init = {}) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const m = /\/api\/(.+)$/.exec(url.pathname) || (typeof input === 'string' && /^api\/([^?]+)/.exec(input));
        if (!m) return realFetch(input, init);
        const path = m[1];
        const method = (init.method || 'GET').toUpperCase();
        await sleep(60 + Math.random() * 120);
        if (path === 'rec/frame') {
            const c = findClip(url.searchParams.get('f'));
            if (!c) return new Response('', { status: 404 });
            return new Response(new Blob([clipFrame(c, +url.searchParams.get('n'), c.dur * 10)], { type: 'image/svg+xml' }), { status: 200 });
        }
        let body = {};
        try { body = init.body ? JSON.parse(init.body) : {}; } catch (e) { /* not JSON */ }
        const [code, obj] = await handle(path, url.searchParams, method, body);
        return new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });
    };

    // Firmware upload: pretend to flash
    window.XMLHttpRequest = class {
        constructor() { this.upload = {}; this.status = 0; }
        open() {}
        setRequestHeader() {}
        async send() {
            for (let i = 1; i <= 20; i++) {
                await sleep(100);
                this.upload.onprogress && this.upload.onprogress({ lengthComputable: true, loaded: i, total: 20 });
            }
            this.status = 200;
            this.onload && this.onload();
        }
    };

    // Pictures the UI puts straight into <img>/<a>
    window.CAM_DEMO = {
        src(p) {
            if (p === 'stream') {
                const u = liveSvg();
                liveImgs.add(u);
                return u;
            }
            if (p === 'snapshot') return svgUrl(scene({ walker: personVisible() ? { color: SHIRTS[0], x: 400 } : null, stamp: new Date().toLocaleString('uk-UA') }));
            const m = /^api\/rec\/(frame|file)\?f=([^&]+)/.exec(p);
            if (m) {
                const c = findClip(decodeURIComponent(m[2]));
                if (!c) return 'data:,';
                // Thumbnail: a moment with the person in view
                if (m[1] === 'frame') return svgUrl(clipFrame(c, Math.round(c.dur * 10 * 0.4), c.dur * 10));
                const msg = typeof t === 'function' ? t('Це демо. На справжній камері тут завантажиться відео {x}, яке відкривається у VLC або іншому плеєрі.', { x: fname(c).split('/')[1] }) : fname(c);
                return 'data:text/plain;charset=utf-8,' + encodeURIComponent(msg);
            }
            return p;
        },
    };

    // ---------- demo bar ----------

    function bar() {
        const css = document.createElement('style');
        css.textContent = `
            body { padding-top: 34px; }
            .topbar { top: 34px !important; }
            @media (min-width: 900px) { .tabbar { top: 34px !important; height: calc(100vh - 34px) !important; } }
            .live.fs { top: 34px !important; height: calc(100dvh - 34px) !important; }
            #demo-bar { position: fixed; top: 0; left: 0; right: 0; height: 34px; z-index: 1000; display: flex; align-items: center; justify-content: center; gap: 8px;
                font: 600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f1238; background: linear-gradient(90deg, #ffd27a, #f7b8d2); padding: 0 12px; white-space: nowrap; overflow-x: auto; }
            #demo-bar button { font: inherit; color: #1f1238; background: rgb(255 255 255 / 55%); border: 0; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
            #demo-bar button:hover { background: #fff; }
            #demo-bar .hint { font-weight: 500; opacity: .85; }`;
        document.head.append(css);
        const el = document.createElement('div');
        el.id = 'demo-bar';
        const tr = typeof t === 'function' ? t : x => x;
        el.innerHTML = '';
        const span = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; el.append(s); };
        span(tr('Демо'));
        span(tr('вхід: admin / demo1234'), 'hint');
        const btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; el.append(b); };
        btn(tr('Майстер'), () => {
            state.configured = false;
            save();
            sessionSet('camDemo.auth', null);
            location.hash = '';
            location.reload();
        });
        btn(tr('Скинути'), () => {
            try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
            sessionSet('camDemo.auth', null);
            location.hash = '';
            location.reload();
        });
        document.body.prepend(el);
    }
    if (document.body) bar(); else document.addEventListener('DOMContentLoaded', bar);

    // The setup wizard ends with a link to the camera's LAN address: stay in the demo
    document.addEventListener('click', e => {
        const a = e.target.closest && e.target.closest('a[href^="http://192.168."]');
        if (!a) return;
        e.preventDefault();
        location.hash = '';
        location.reload();
    }, true);
})();
