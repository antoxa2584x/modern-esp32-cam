'use strict';

// ---------- helpers ----------

// Served from the camera itself, or through the relay at /cam/<id>/
const REMOTE = /^\/cam\/[a-z0-9]+\//.test(location.pathname);
// The demo build (demo/demo.js) plays the camera in the browser and supplies
// the pictures; on a real camera this is null and paths are used as they are.
const DEMO = window.CAM_DEMO || null;
const res = p => (DEMO ? DEMO.src(p) : p);

// ---------- colour schemes ----------

const THEMES = [
    ['purple', t('Фіолетова'), '#4b3478', '#b39ddb'],
    ['green', t('Смарагдова'), '#2b6a45', '#7fd49b'],
    ['blue', t('Океан'), '#24508a', '#8cc0f5'],
    ['amber', t('Бурштин'), '#6e4a1f', '#f4b860'],
    ['graphite', t('Графіт'), '#2c2e36', '#a9b4cf'],
    ['light', t('Світла'), '#f3effa', '#7a55c7'],
];

function applyTheme(name) {
    if (!THEMES.some(th => th[0] === name)) name = 'purple';
    const root = document.documentElement;
    if (name === 'purple') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', name);
    try { localStorage.setItem('theme', name); } catch (e) { /* private mode */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#2a1a4a';
}
// The camera's choice arrives with /api/state; until then use the last one seen
try { applyTheme(localStorage.getItem('theme') || 'purple'); } catch (e) { /* ignore */ }

function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
            else el.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const kid of kids.flat()) {
        if (kid == null || kid === false) continue;
        el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

function icon(name, cls = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i ' + cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class ApiError extends Error {
    constructor(status, data) {
        super(data && data.message ? t(data.message) : t('Помилка {x}', { x: status }));
        this.status = status;
        this.data = data || {};
    }
}

let onAuthLost = () => {};

async function api(path, body, opts = {}) {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Requested-With': 'cam' }, credentials: 'same-origin' };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
        if (res.status === 401 && !opts.noAuthRedirect) onAuthLost();
        if (res.status === 403 && data && data.error === 'confirm' && !opts.confirmed && await askPassword())
            return api(path, body, { ...opts, confirmed: true });
        throw new ApiError(res.status, data);
    }
    return data;
}

// Risky changes (firmware, Wi-Fi, remote access, deleting every recording)
// need the password again; the camera then trusts this device for 10 minutes.
// Resolves to true once confirmed, false if cancelled.
function askPassword() {
    return new Promise(resolve => {
        let ok = false;
        const pw = passwordInput({ required: true });
        const err = h('div', { class: 'form-error hidden', role: 'alert' });
        const btn = h('button', { class: 'btn primary', type: 'submit' }, t('Підтвердити'));
        const form = h('form', {
            class: 'stack', onsubmit: async e => {
                e.preventDefault();
                btn.disabled = true;
                err.classList.add('hidden');
                try {
                    await api('api/confirm', { password: pw.input.value }, { confirmed: true });
                    ok = true;
                    close();
                } catch (ex) {
                    const d = ex.data || {};
                    err.textContent = d.error === 'locked' ? t('Забагато невдалих спроб. Спробуйте через {n} с.', { n: d.wait })
                        : d.error === 'wrong' ? t('Невірний пароль') : ex.message;
                    err.classList.remove('hidden');
                    btn.disabled = false;
                }
            }
        }, field(t('Пароль'), pw.el), err,
            h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => close() }, t('Скасувати')), btn));
        const d = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
            h('h2', { text: t('Підтвердіть паролем') }),
            h('p', { class: 'muted', text: t('Це важлива зміна, тому камера просить пароль ще раз.') }),
            form);
        const close = overlay(d, { onClose: () => resolve(ok) });
        pw.input.focus();
    });
}

// Asks for the password first if the camera would (for uploads, which
// shouldn't be sent only to be refused)
async function ensureConfirmed() {
    const c = await api('api/confirm');
    return c.left > 60 || askPassword();
}

function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtGB(bytes) {
    const gb = bytes / 1073741824;
    if (gb < 1) return (bytes / 1048576).toLocaleString(LOCALE, { maximumFractionDigits: 0 }) + t(' МБ');
    return gb.toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + t(' ГБ');
}

function fmtAgo(sec) {
    if (sec < 0) return t('ще не було');
    if (sec < 60) return t('щойно');
    const m = Math.floor(sec / 60);
    if (m < 60) return t('{n} {u} тому', { n: m, u: pl(m, 'min') });
    const hr = Math.floor(m / 60);
    if (hr < 24) return t('{n} {u} тому', { n: hr, u: pl(hr, 'hour') });
    const d = Math.floor(hr / 24);
    return t('{n} {u} тому', { n: d, u: pl(d, 'day') });
}

function signalText(rssi) {
    if (!rssi) return '—';
    if (rssi > -55) return t('Відмінний');
    if (rssi > -67) return t('Добрий');
    if (rssi > -75) return t('Задовільний');
    return t('Слабкий');
}

function signalBars(rssi) {
    const n = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -75 ? 2 : 1;
    return h('span', { class: 'sig', 'aria-label': signalText(rssi) }, [1, 2, 3, 4].map(i => h('i', { class: i <= n ? 'on' : '' })));
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// "20261103" -> "Сьогодні" / "Вчора" / "Понеділок, 3 листопада"
function dayLabel(d) {
    if (d.startsWith('0000')) return t('Без дати (увімкнення №{n})', { n: +d.slice(4) });
    const date = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - date) / 86400000);
    if (diff === 0) return t('Сьогодні');
    if (diff === 1) return t('Вчора');
    const o = { weekday: 'long', day: 'numeric', month: 'long' };
    if (date.getFullYear() !== today.getFullYear()) o.year = 'numeric';
    return cap(date.toLocaleDateString(LOCALE, o));
}

const fmtTime = t => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;

// Restarts a CSS entrance animation on `el`
function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
}

// Removes a toast after its exit animation
function dismiss(el) {
    if (!el.isConnected || el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
}

function toast(msg, bad = false) {
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, icon(bad ? 'alert' : 'check', 'sm'), msg);
    document.getElementById('toasts').append(el);
    setTimeout(() => dismiss(el), bad ? 4500 : 2200);
}

// A toast that stays up while something slow runs: set() changes its text
function progressToast(msg) {
    const text = h('span', { text: msg });
    const el = h('div', { class: 'toast' }, h('span', { class: 'spinner sm' }), text);
    document.getElementById('toasts').append(el);
    return { set: s => { text.textContent = s; }, done: () => dismiss(el) };
}

// ---------- saving files ----------

// Live views that are streaming; a saved file restarts them (see saveBlob)
const liveViews = new Set();

// Saves without leaving the page. Following a download link makes iPhone
// browsers stop the page's streams (live view, player frames) for good.
function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    // iOS may still stall the MJPEG picture while its download sheet is up
    setTimeout(() => liveViews.forEach(v => v.restart()), 1500);
}

// Browsers save a file only shortly after a tap. When the file took longer to
// make (a long recording), ask for one more tap.
function offerSave(blob, name) {
    const ua = navigator.userActivation;
    if (!ua || ua.isActive) return saveBlob(blob, name);
    const el = h('div', { class: 'toast toast-action' }, icon('check', 'sm'), h('span', { text: t('Відео готове') }),
        h('button', { class: 'btn primary sm', onclick: () => { dismiss(el); saveBlob(blob, name); } }, t('Зберегти')));
    document.getElementById('toasts').append(el);
    setTimeout(() => dismiss(el), 60000);
}

let savingRec = false;

// The recording as MP4 (H.264) where the browser can make one, else the AVI
async function saveRecording(f) {
    if (DEMO) {
        const a = h('a', { href: res(`api/rec/file?f=${encodeURIComponent(f)}`), download: '' });
        document.body.append(a);
        a.click();
        a.remove();
        return;
    }
    if (savingRec) return;
    savingRec = true;
    const p = progressToast(t('Завантаження з камери…'));
    const pct = (msg, x) => p.set(x >= 0 ? `${msg} ${Math.round(x * 100)}%` : msg);
    try {
        const avi = await fetchBlob(`api/rec/file?f=${encodeURIComponent(f)}`, x => pct(t('Завантаження з камери…'), x));
        let mp4 = null;
        const buf = await avi.arrayBuffer();
        const conv = x => pct(t('Перетворення у MP4…'), x);
        for (const make of [canMakeMp4() ? aviToMp4 : null, recordMp4]) {
            if (!make || mp4) continue;
            conv(0);
            try {
                mp4 = await make(buf, conv);
            } catch (e) { console.warn('mp4:', e); }
        }
        p.done();
        if (mp4) offerSave(mp4, recName(f, 'mp4'));
        else {
            offerSave(avi, recName(f, 'avi'));
            toast(t('Цей браузер не вміє робити MP4, тому відео збережено як AVI'));
        }
    } catch (e) {
        p.done();
        toast(t('Не вдалося завантажити відео'), true);
    } finally {
        savingRec = false;
    }
}

// "20261103_143025..." -> "camera_2026-11-03_14-30-25.<ext>"
function recName(f, ext) {
    return `camera_${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}_${f.slice(9, 11)}-${f.slice(11, 13)}-${f.slice(13, 15)}.${ext}`;
}

// Downloads with progress (0..1, or -1 when the size is unknown)
async function fetchBlob(url, onProgress, opts = {}) {
    const r = await fetch(url, { credentials: opts.credentials || 'same-origin' });
    if (!r.ok) throw new ApiError(r.status);
    const total = +r.headers.get('Content-Length') || 0;
    if (!r.body || !r.body.getReader) return r.blob();
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (onProgress) onProgress(total ? got / total : -1);
    }
    return new Blob(parts, { type: r.headers.get('Content-Type') || '' });
}

// ---------- AVI (Motion JPEG) to MP4 (H.264) ----------
// Phones don't play the camera's AVI files, so the browser re-encodes them with
// its own H.264 encoder (WebCodecs) and wraps the result in a minimal MP4.

const canMakeMp4 = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function' && typeof createImageBitmap === 'function';

// The JPEG frames ('00dc' chunks of the movi list) and the frame rate
function parseAvi(buf) {
    const dv = new DataView(buf);
    const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'AVI ') throw new Error('not avi');
    let fps = 0;
    const frames = [];
    const walk = (start, end) => {
        for (let o = start; o + 8 <= end;) {
            const id = tag(o), size = dv.getUint32(o + 4, true);
            const body = o + 8;
            if (id === 'LIST') {
                // A recording still being written has no list size yet
                walk(body + 4, size ? Math.min(end, body + size) : end);
                if (!size) break;
            } else if (id === 'avih' && size >= 4) { const us = dv.getUint32(body, true); if (us) fps = 1e6 / us; }
            else if (id === 'strh' && size >= 32) {
                const scale = dv.getUint32(body + 20, true), rate = dv.getUint32(body + 24, true);
                if (scale && rate) fps = rate / scale;
            } else if (id === '00dc' && size > 0 && body + size <= buf.byteLength) frames.push(new Uint8Array(buf, body, size));
            o = body + size + (size & 1);
        }
    };
    walk(12, buf.byteLength);
    return { frames, fps: fps > 0 && fps < 120 ? fps : 10 };
}

// Picks an H.264 profile and level the browser can encode at this size
async function avcConfig(width, height, fps) {
    const bitrate = Math.max(800000, Math.min(8000000, Math.round(width * height * fps * 0.12)));
    const px = width * height;
    // Baseline 3.1 up to 1280x720, High 4.0 up to 2048x1024, High 5.0 above
    const codecs = px <= 921600 ? ['avc1.42001f', 'avc1.4d001f', 'avc1.640028'] : px <= 2097152 ? ['avc1.640028', 'avc1.4d0028'] : ['avc1.640032', 'avc1.4d0032'];
    for (const codec of codecs) {
        const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
        try {
            const s = await VideoEncoder.isConfigSupported(cfg);
            if (s.supported) return cfg;
        } catch (e) { /* try the next one */ }
    }
    return null;
}

async function aviToMp4(buf, onProgress) {
    const { frames, fps } = parseAvi(buf);
    if (!frames.length) throw new Error('no frames');
    const first = await createImageBitmap(new Blob([frames[0]], { type: 'image/jpeg' }));
    const width = first.width & ~1, height = first.height & ~1;  // H.264 needs even sizes
    first.close();
    const cfg = await avcConfig(width, height, fps);
    if (!cfg) return null;

    const chunks = [];
    let avcC = null, failure = null;
    const enc = new VideoEncoder({
        output: (chunk, meta) => {
            const d = meta && meta.decoderConfig && meta.decoderConfig.description;
            if (d) avcC = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
        },
        error: e => { failure = e; },
    });
    enc.configure(cfg);
    const step = 1e6 / fps, gop = Math.max(1, Math.round(fps * 2));
    for (let n = 0; n < frames.length; n++) {
        if (failure) throw failure;
        let bmp;
        try {
            bmp = await createImageBitmap(new Blob([frames[n]], { type: 'image/jpeg' }));
        } catch (e) { continue; }  // a damaged frame: skip it
        const init = { timestamp: Math.round(n * step), duration: Math.round(step) };
        if (bmp.width !== width || bmp.height !== height) init.visibleRect = { x: 0, y: 0, width, height };
        const vf = new VideoFrame(bmp, init);
        enc.encode(vf, { keyFrame: n % gop === 0 });
        vf.close();
        bmp.close();
        while (enc.encodeQueueSize > 4) await sleep(5);
        if (onProgress && n % 5 === 0) onProgress(n / frames.length);
    }
    await enc.flush();
    enc.close();
    if (failure) throw failure;
    if (!avcC || !chunks.length) throw new Error('encoder gave nothing');
    return muxMp4(chunks, avcC, width, height, fps);
}

// WebCodecs exists only on https pages, and on the home network the camera is
// http. There the browser's recorder makes the MP4 instead, by playing the
// frames onto a canvas: as slow as the clip is long.
function recorderType() {
    if (typeof MediaRecorder !== 'function' || !HTMLCanvasElement.prototype.captureStream) return '';
    return ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function recordMp4(buf, onProgress) {
    const type = recorderType();
    if (!type) return null;
    const { frames, fps } = parseAvi(buf);
    if (!frames.length) throw new Error('no frames');
    const decode = n => createImageBitmap(new Blob([frames[n]], { type: 'image/jpeg' })).catch(() => null);
    const first = await decode(0);
    if (!first) throw new Error('bad frame');
    const canvas = h('canvas', { width: first.width & ~1, height: first.height & ~1 });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(first, 0, 0);
    first.close();

    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const manual = typeof track.requestFrame === 'function';
    const rec = new MediaRecorder(manual ? stream : canvas.captureStream(fps), {
        mimeType: type,
        videoBitsPerSecond: Math.max(800000, Math.min(8000000, Math.round(canvas.width * canvas.height * fps * 0.12))),
    });
    const parts = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(1000);
    const step = 1000 / fps, t0 = performance.now();
    let next = decode(0);
    for (let n = 0; n < frames.length; n++) {
        const bmp = await next;
        if (n + 1 < frames.length) next = decode(n + 1);
        const wait = t0 + n * step - performance.now();
        if (wait > 0) await sleep(wait);
        if (bmp) {
            ctx.drawImage(bmp, 0, 0);
            bmp.close();
        }
        if (manual) track.requestFrame();
        if (onProgress && n % 5 === 0) onProgress(n / frames.length);
    }
    await sleep(step);
    rec.stop();
    await stopped;
    stream.getTracks().forEach(tr => tr.stop());
    return parts.length ? new Blob(parts, { type: 'video/mp4' }) : null;
}

// One video track, all samples in one chunk, moov before mdat (plays while loading).
// Samples come in decode order with presentation times in µs; an encoder may
// drop frames or reorder them (B-frames), so the tables are built from those.
function muxMp4(samples, avcC, width, height, fps) {
    const TS = 90000;
    const frame = Math.round(TS / fps);
    const pts = samples.map(s => Math.round(s.ts * TS / 1e6));
    const dts = [...pts].sort((a, b) => a - b);
    const deltas = dts.map((d, n) => (n + 1 < dts.length ? dts[n + 1] - d : frame));
    const duration = dts[dts.length - 1] - dts[0] + frame;
    const runs = [];
    for (const d of deltas) {
        if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++;
        else runs.push([1, d]);
    }
    const offsets = pts.map((p, n) => p - dts[n]);
    const reordered = offsets.some(o => o !== 0);
    const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const u16 = v => [(v >>> 8) & 255, v & 255];
    const str = s => [...s].map(c => c.charCodeAt(0));
    const box = (type, ...parts) => {
        const body = parts.flat(Infinity);
        return [...u32(body.length + 8), ...str(type), ...body];
    };
    const full = (type, ver, flags, ...parts) => box(type, ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255, ...parts);
    const matrix = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
    const zeros = n => new Array(n).fill(0);

    const keys = [];
    samples.forEach((s, n) => { if (s.key) keys.push(n + 1); });
    const sizes = samples.map(s => s.data.length);

    const moov = offset => box('moov',
        full('mvhd', 0, 0, u32(0), u32(0), u32(TS), u32(duration), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2)),
        box('trak',
            full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width << 16), u32(height << 16)),
            box('mdia',
                full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(duration), u16(0x55c4), u16(0)),
                full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('VideoHandler'), 0),
                box('minf',
                    full('vmhd', 0, 1, zeros(8)),
                    box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
                    box('stbl',
                        full('stsd', 0, 0, u32(1),
                            box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff),
                                box('avcC', [...avcC]))),
                        full('stts', 0, 0, u32(runs.length), runs.map(([c, d]) => [u32(c), u32(d)])),
                        reordered ? full('ctts', 1, 0, u32(samples.length), offsets.map(o => [u32(1), u32(o)])) : [],
                        full('stss', 0, 0, u32(keys.length), keys.map(u32)),
                        full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
                        full('stsz', 0, 0, u32(0), u32(samples.length), sizes.map(u32)),
                        full('stco', 0, 0, u32(1), u32(offset)))))));

    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const moovLen = moov(0).length;
    const mdatData = sizes.reduce((a, b) => a + b, 0);
    const head = new Uint8Array([...ftyp, ...moov(ftyp.length + moovLen + 8), ...u32(mdatData + 8), ...str('mdat')]);
    return new Blob([head, ...samples.map(s => s.data)], { type: 'video/mp4' });
}

// The clipboard API exists only on https pages, and the camera is opened over
// http (and often in a captive-portal browser), so fall back to execCommand.
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* try the old way */ }
    }
    const ta = h('textarea', { readonly: '', style: 'position:fixed;top:0;left:0;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* not supported */ }
    ta.remove();
    return ok;
}

// Selects an element's text so it can be copied by hand
function selectText(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
}

function showError(e) {
    if (e instanceof ApiError && (e.status === 401 || e.data.error === 'confirm')) return;
    toast(e instanceof ApiError ? e.message : t('Немає зв\'язку з камерою'), true);
}

// ---------- dialogs ----------

const openOverlays = [];

function overlay(content, { cls = '', onClose } = {}) {
    const ov = h('div', { class: 'overlay ' + cls });
    const close = () => {
        if (!ov.isConnected || ov.classList.contains('closing')) return;
        ov.classList.add('closing');
        setTimeout(() => ov.remove(), 160);
        openOverlays.splice(openOverlays.indexOf(close), 1);
        if (!openOverlays.length) document.body.classList.remove('locked');
        document.removeEventListener('keydown', onKey);
        onClose && onClose();
    };
    const onKey = e => { if (e.key === 'Escape' && openOverlays[openOverlays.length - 1] === close) close(); };
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    ov.append(content);
    document.body.append(ov);
    document.body.classList.add('locked');
    openOverlays.push(close);
    return close;
}

function confirmDialog({ title, text, ok = t('Так'), cancel = t('Скасувати'), danger = false }) {
    return new Promise(resolve => {
        let result = false;
        const okBtn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { result = true; close(); } }, ok);
        const d = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
            h('h2', { text: title }),
            text && h('p', { class: 'muted', text }),
            h('div', { class: 'actions' },
                h('button', { class: 'btn', onclick: () => close() }, cancel),
                okBtn));
        const close = overlay(d, { onClose: () => resolve(result) });
        okBtn.focus();
    });
}

// ---------- form bits ----------

function passwordInput(attrs) {
    const input = h('input', { type: 'password', autocomplete: 'current-password', ...attrs });
    const btn = h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': t('Показати пароль'),
        onclick: () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.replaceChildren(icon(show ? 'eye-off' : 'eye'));
            btn.setAttribute('aria-label', show ? t('Сховати пароль') : t('Показати пароль'));
        }
    }, icon('eye'));
    return { el: h('div', { class: 'pw-wrap' }, input, btn), input };
}

function field(label, control) {
    return h('label', { class: 'field' }, h('span', { text: label }), control);
}

function switchEl(checked, onchange, label) {
    const input = h('input', { type: 'checkbox', checked, role: 'switch', 'aria-label': label, onchange: () => onchange(input.checked) });
    // On phones people slide a switch, and a slide isn't a tap
    let x0 = null;
    input.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    input.addEventListener('touchend', e => {
        const dx = x0 === null ? 0 : e.changedTouches[0].clientX - x0;
        x0 = null;
        if (Math.abs(dx) < 12) return;  // a tap: the browser toggles it
        e.preventDefault();
        if ((dx > 0) !== input.checked && !input.disabled) input.click();
    });
    return { el: h('span', { class: 'switch' }, input, h('span', { class: 'track' })), input };
}

function rangeFill(input) {
    const min = +input.min, max = +input.max;
    input.style.setProperty('--fill', ((input.value - min) / (max - min)) * 100 + '%');
}

// УКР | ENG switch; the choice is kept per browser
function langSwitch() {
    return h('div', { class: 'lang-switch', role: 'group', 'aria-label': t('Мова') },
        [['uk', 'УКР'], ['en', 'ENG']].map(([id, label]) => h('button', {
            type: 'button', class: id === LANG ? 'on' : '', 'aria-pressed': String(id === LANG),
            onclick: () => { if (id !== LANG) setLang(id); },
        }, label)));
}

// ---------- Wi-Fi picker (setup wizard and settings) ----------

function wifiPicker({ allowKeep = false } = {}) {
    let selected = null; // { ssid, lock }
    let manual = false;
    const list = h('div', { class: 'net-list', role: 'listbox', 'aria-label': t('Мережі Wi-Fi') });
    const status = h('div', { class: 'row muted small' });
    const pw = passwordInput({ placeholder: t('Пароль мережі'), autocomplete: 'off' });
    const pwField = field(t('Пароль Wi-Fi'), pw.el);
    const ssidInput = h('input', { type: 'text', placeholder: t('Назва мережі'), autocapitalize: 'off', autocomplete: 'off' });
    const ssidField = field(t('Назва мережі (SSID)'), ssidInput);
    pwField.classList.add('hidden');
    ssidField.classList.add('hidden');

    function select(net, btn) {
        selected = net;
        manual = false;
        list.querySelectorAll('.net').forEach(b => { b.classList.remove('sel'); b.setAttribute('aria-selected', 'false'); });
        if (btn) { btn.classList.add('sel'); btn.setAttribute('aria-selected', 'true'); }
        ssidField.classList.add('hidden');
        pwField.classList.toggle('hidden', !net || !net.lock);
        if (net && net.lock) setTimeout(() => pw.input.focus(), 50);
    }

    async function scan() {
        list.replaceChildren();
        status.replaceChildren(h('div', { class: 'spinner sm' }), t('Шукаємо мережі…'));
        try {
            await api('api/wifi/scan?start=1');
            let res;
            for (let i = 0; i < 20; i++) {
                await sleep(1000);
                res = await api('api/wifi/scan');
                if (!res.busy) break;
            }
            const nets = (res && res.networks) || [];
            status.replaceChildren(nets.length ? t('Знайдено {n} {u}', { n: nets.length, u: pl(nets.length, 'net') }) : t('Мереж не знайдено'));
            for (const n of nets) {
                const btn = h('button', { type: 'button', class: 'net', role: 'option', 'aria-selected': 'false', onclick: () => select(n, btn) },
                    signalBars(n.rssi), h('span', { class: 'name', text: n.ssid }), n.lock ? icon('lock', 'sm') : null);
                list.append(btn);
            }
        } catch (e) {
            status.replaceChildren(t('Не вдалося знайти мережі. Спробуйте ще раз.'));
        }
    }

    const el = h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, status),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Оновити список'), onclick: scan }, icon('refresh'))),
        list,
        h('div', { class: 'row wrap' },
            h('button', {
                type: 'button', class: 'btn ghost', onclick: () => {
                    select(null);
                    manual = true;
                    ssidField.classList.remove('hidden');
                    pwField.classList.remove('hidden');
                    ssidInput.focus();
                }
            }, t('Ввести назву вручну')),
            allowKeep ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { select({ keep: true }); } }, t('Залишити поточну мережу')) : null),
        ssidField, pwField,
        h('p', { class: 'tip' }, icon('alert', 'sm'), t('Камера працює лише з мережами 2,4 ГГц.')));
    scan();
    return {
        el,
        value() {
            if (manual) return { ssid: ssidInput.value.trim(), password: pw.input.value };
            if (!selected) return null;
            if (selected.keep) return { ssid: '', password: '' };
            return { ssid: selected.ssid, password: selected.lock ? pw.input.value : '' };
        }
    };
}

// ---------- boot ----------

let info = null;

async function boot() {
    const app = document.getElementById('app');
    try {
        info = await api('api/state', undefined, { noAuthRedirect: true });
    } catch (e) {
        app.replaceChildren(h('div', { class: 'auth-page' }, h('div', { class: 'card auth-card center stack' },
            h('h1', { text: t('Камера недоступна') }),
            h('p', { class: 'muted', text: t('Не вдалося з\'єднатися з камерою. Перевірте, що вона увімкнена.') }),
            h('button', { class: 'btn primary', onclick: boot }, icon('refresh'), t('Спробувати ще раз')))));
        return;
    }
    document.title = info.name || t('Камера');
    if (info.theme) applyTheme(info.theme);
    if (info.authed || info.setup) sendClock();
    if (!info.authed && info.setup) return wizard(app);
    if (!info.authed) return loginPage(app);
    shell(app);
}

// Without internet the camera has no clock: lend it the browser's
function sendClock() {
    api('api/time', { epoch: Math.floor(Date.now() / 1000) }, { noAuthRedirect: true }).catch(() => {});
}

let authLost = false;
onAuthLost = () => {
    if (authLost) return;
    authLost = true;
    stopAll();
    boot().finally(() => { authLost = false; });
};

// ---------- login ----------

function loginPage(app) {
    const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', required: true, value: localStorageGet('lastUser') || '' });
    const pw = passwordInput({ required: true });
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Увійти'));
    const form = h('form', {
        class: 'stack', onsubmit: async e => {
            e.preventDefault();
            btn.disabled = true;
            err.classList.add('hidden');
            try {
                await api('api/login', { user: user.value.trim(), password: pw.input.value }, { noAuthRedirect: true });
                localStorageSet('lastUser', user.value.trim());
                boot();
            } catch (ex) {
                const d = ex.data || {};
                err.textContent = d.error === 'locked'
                    ? t('Забагато невдалих спроб. Спробуйте через {n} с.', { n: d.wait })
                    : d.error === 'wrong' ? t('Невірне ім\'я користувача або пароль.') : t('Немає зв\'язку з камерою.');
                err.classList.remove('hidden');
                btn.disabled = false;
            }
        }
    }, field(t('Ім\'я користувача'), user), field(t('Пароль'), pw.el), err, btn);
    app.replaceChildren(h('div', { class: 'auth-page' }, h('div', { class: 'card auth-card' },
        langSwitch(),
        h('img', { class: 'auth-logo', src: 'icon.svg', alt: '' }),
        h('h1', { text: info.name || t('Камера') }),
        h('p', { class: 'lead', text: t('Увійдіть, щоб побачити камеру') }),
        form,
        h('details', { class: 'fold' },
            h('summary', null, icon('chevron', 'sm'), t('Забули пароль?')),
            h('p', { class: 'muted small', text: t('Натисніть кнопку RST на камері тричі поспіль, з паузою приблизно в секунду. Камера на 15 хвилин увімкне власну мережу Wi-Fi «{x}» без пароля. Підключіться до неї та задайте новий пароль. Записи збережуться, а запам\'ятовані обличчя, входи на інших пристроях і посилання для віддаленого доступу буде скинуто.', { x: info.apSsid || 'ESP32-Camera-…' }) })))));
    (user.value ? pw.input : user).focus();
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

// ---------- setup wizard ----------

function wizard(app) {
    const recovery = info.recovery && info.configured;
    const w = { ssid: '', wifiPassword: '', user: 'admin', password: '' };
    const card = h('div', { class: 'card auth-card' });
    app.replaceChildren(h('div', { class: 'auth-page' }, card));
    const STEPS = 4;
    const dots = n => h('div', { class: 'steps', 'aria-label': t('Крок {n} з {m}', { n, m: STEPS }) }, [...Array(STEPS)].map((_, i) => h('span', { class: i < n ? 'on' : '' })));

    function welcome() {
        card.replaceChildren(langSwitch(), dots(1),
            h('img', { class: 'auth-logo', src: 'icon.svg', alt: '' }),
            h('h1', { text: recovery ? t('Відновлення доступу') : t('Вітаємо!') }),
            h('p', { class: 'lead', text: recovery ? t('Тут можна задати новий логін і пароль та змінити мережу Wi-Fi. Записи на карті пам\'яті збережуться, а запам\'ятовані обличчя, входи на інших пристроях і посилання для віддаленого доступу буде скинуто. Завершіть протягом {n} хв.', { n: Math.max(1, Math.ceil((info.recoveryLeft || 0) / 60)) }) : t('Налаштуймо вашу камеру. Це займе кілька хвилин.') }),
            h('ol', { class: 'howto' },
                h('li', { text: t('Підключимо камеру до домашнього Wi-Fi') }),
                h('li', { text: t('Створимо логін і пароль для входу') }),
                h('li', { text: t('Покажемо адресу, за якою відкривати камеру') })),
            h('div', { style: { height: '22px' } }),
            h('button', { class: 'btn primary block', onclick: wifiStep }, t('Почати')));
    }

    function wifiStep() {
        const picker = wifiPicker({ allowKeep: info.wifi });
        const err = h('div', { class: 'form-error hidden', role: 'alert' });
        card.replaceChildren(dots(2),
            h('h1', { text: 'Wi-Fi' }),
            h('p', { class: 'lead', text: t('Оберіть домашню мережу, до якої підключити камеру.') }),
            picker.el, err,
            h('div', { class: 'actions row', style: { marginTop: '20px' } },
                h('button', { class: 'btn', onclick: welcome }, icon('back', 'sm'), t('Назад')),
                h('button', {
                    class: 'btn primary grow', onclick: () => {
                        const v = picker.value();
                        if (!v || (!v.ssid && !info.wifi)) {
                            err.textContent = t('Оберіть мережу зі списку.');
                            return err.classList.remove('hidden');
                        }
                        w.ssid = v.ssid;
                        w.wifiPassword = v.password;
                        accountStep();
                    }
                }, t('Далі'))));
    }

    function accountStep() {
        const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', value: w.user });
        const p1 = passwordInput({ autocomplete: 'new-password' });
        const p2 = passwordInput({ autocomplete: 'new-password' });
        const err = h('div', { class: 'form-error hidden', role: 'alert' });
        const fail = msg => { err.textContent = msg; err.classList.remove('hidden'); };
        card.replaceChildren(dots(3),
            h('h1', { text: t('Захист доступу') }),
            h('p', { class: 'lead', text: t('Придумайте ім\'я та пароль. Їх питатиме камера під час входу.') }),
            h('form', {
                class: 'stack', onsubmit: e => {
                    e.preventDefault();
                    if (!user.value.trim()) return fail(t('Вкажіть ім\'я користувача.'));
                    if (p1.input.value.length < 8) return fail(t('Пароль має містити щонайменше 8 символів.'));
                    if (p1.input.value !== p2.input.value) return fail(t('Паролі не збігаються.'));
                    w.user = user.value.trim();
                    w.password = p1.input.value;
                    connectStep();
                }
            },
                field(t('Ім\'я користувача'), user),
                field(t('Пароль (щонайменше 8 символів)'), p1.el),
                field(t('Повторіть пароль'), p2.el),
                err,
                h('p', { class: 'tip' }, icon('lock', 'sm'), t('Не використовуйте прості паролі на кшталт 12345678: камеру можна буде відкрити з інтернету. Запишіть пароль у надійному місці.')),
                h('div', { class: 'row', style: { marginTop: '8px' } },
                    h('button', { type: 'button', class: 'btn', onclick: wifiStep }, icon('back', 'sm'), t('Назад')),
                    h('button', { type: 'submit', class: 'btn primary grow' }, t('Далі')))));
        user.focus();
    }

    async function connectStep() {
        const msg = h('p', { class: 'lead', text: w.ssid ? t('Підключаємося до «{x}»…', { x: w.ssid }) : t('Зберігаємо…') });
        const hint = h('p', { class: 'tip hidden' }, icon('wifi', 'sm'), t('Якщо телефон відключився від мережі «{x}», підключіться до неї знову — сторінка продовжить сама.', { x: info.apSsid }));
        card.replaceChildren(dots(4), h('div', { class: 'center', style: { padding: '10px 0 18px' } }, h('div', { class: 'spinner', style: { margin: '0 auto' } })),
            h('h1', { text: t('Майже готово') }), msg, hint);
        try {
            await api('api/setup', { ssid: w.ssid, wifiPassword: w.wifiPassword, user: w.user, password: w.password }, { noAuthRedirect: true });
        } catch (e) {
            card.replaceChildren(h('h1', { text: t('Не вдалося зберегти') }),
                h('p', { class: 'lead', text: e.message }),
                h('button', { class: 'btn primary block', onclick: accountStep }, t('Назад')));
            return;
        }
        if (!w.ssid) return done(null);
        const started = Date.now();
        let errors = 0;
        for (;;) {
            await sleep(1500);
            let st;
            try {
                st = await api('api/setup/status', undefined, { noAuthRedirect: true });
                errors = 0;
            } catch (e) {
                // The camera's own network blinks while it joins the home one
                if (++errors > 4) hint.classList.remove('hidden');
                if (Date.now() - started > 120000) return failed();
                continue;
            }
            if (st.state === 'ok') return done(st);
            if (st.state === 'fail' || Date.now() - started > 60000) return failed();
        }
    }

    function failed() {
        card.replaceChildren(
            h('div', { class: 'success-ico', style: { background: 'var(--danger-bg)', color: 'var(--danger)' } }, icon('wifi', 'lg')),
            h('h1', { text: t('Не вдалося підключитися') }),
            h('p', { class: 'lead', text: t('Камера не змогла підключитися до «{x}». Найчастіше причина — неправильний пароль або мережа 5 ГГц.', { x: w.ssid }) }),
            h('button', { class: 'btn primary block', onclick: wifiStep }, t('Спробувати ще раз')));
    }

    function done(st) {
        const url = st && st.ip ? `http://${st.ip}/` : null;
        const addr = h('div', { class: 'big-addr', text: url });
        card.replaceChildren(
            h('div', { class: 'success-ico' }, icon('check', 'lg')),
            h('h1', { text: t('Готово!') }),
            st ? h('p', { class: 'lead', text: t('Камера підключена до мережі «{x}».', { x: st.ssid }) }) : h('p', { class: 'lead', text: t('Налаштування збережено.') }),
            url ? h('div', { class: 'stack' },
                h('p', { class: 'muted center', text: t('Адреса вашої камери:') }),
                addr,
                h('p', { class: 'faint center', text: t('або {x}', { x: `http://${st.host}/` }) }),
                h('ol', { class: 'howto' },
                    h('li', { text: t('Підключіть телефон назад до домашнього Wi-Fi.') }),
                    h('li', { text: t('Відкрийте цю адресу в браузері.') }),
                    h('li', { text: t('Додайте сторінку в закладки або на головний екран.') })),
                h('button', {
                    class: 'btn block', onclick: () => {
                        copyText(url).then(ok => {
                            if (ok) return toast(t('Адресу скопійовано'));
                            selectText(addr);
                            toast(t('Скопіюйте адресу вручну'), true);
                        });
                    }
                }, icon('copy', 'sm'), t('Скопіювати адресу')),
                h('a', { class: 'btn primary block', href: url }, t('Відкрити камеру'))) : h('button', { class: 'btn primary block', onclick: () => location.reload() }, t('Продовжити')));
    }

    welcome();
}

// ---------- app shell ----------

let status = null;
let pollTimer = null;
const pages = {};
let current = null;
const stopFns = new Set();

function stopAll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    for (const fn of stopFns) fn();
    if (current && pages[current]) pages[current].leave();
    current = null;
}

function streamUrl(fps) {
    if (DEMO) return DEMO.src('stream');
    const q = fps ? `?fps=${fps}` : '';
    if (REMOTE) return 'stream' + q;
    return `${location.protocol}//${location.hostname}:${info.streamPort}/stream${q}`;
}

function snapshotUrl() {
    if (DEMO) return DEMO.src('snapshot');
    return REMOTE ? 'snapshot' : `${location.protocol}//${location.hostname}:${info.streamPort}/snapshot`;
}

function shell(app) {
    const navItems = [
        ['', 'home', t('Головна')],
        ['rec', 'film', t('Записи')],
        ['settings', 'gear', t('Налаштування')],
    ];
    const tabs = navItems.map(([id, ic, label]) => h('a', { class: 'tab', href: '#/' + id, 'data-page': id || 'home' }, h('span', { class: 'tab-ico' }, icon(ic)), label));
    const topPill = h('span', { class: 'pill' });
    const sideInfo = h('div', { class: 'faint small' });
    const main = h('main', { class: 'content', id: 'main' });

    app.replaceChildren(h('div', { class: 'layout' },
        h('header', { class: 'topbar' },
            h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('span', { class: 'brand-name', text: info.name })),
            topPill),
        h('nav', { class: 'tabbar', 'aria-label': t('Розділи') },
            h('div', { class: 'brand side-brand' }, h('img', { src: 'icon.svg', alt: '' }), h('span', { class: 'brand-name', text: info.name })),
            tabs,
            h('div', { class: 'side-foot' }, sideInfo)),
        main));

    pages.home = homePage();
    pages.rec = recordingsPage();
    pages.settings = settingsPage();
    for (const p of Object.values(pages)) { p.el.classList.add('hidden'); main.append(p.el); }

    function route() {
        const id = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'home';
        const next = pages[id] ? id : 'home';
        if (next === current) return;
        if (current) { pages[current].leave(); pages[current].el.classList.add('hidden'); }
        current = next;
        pages[next].el.classList.remove('hidden');
        replay(pages[next].el, 'page-in');
        tabs.forEach(tab => {
            const on = tab.dataset.page === next;
            tab.classList.toggle('on', on);
            if (on) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
        });
        window.scrollTo(0, 0);
        pages[next].enter();
        poll();
    }

    function updateShell(st) {
        topPill.className = 'pill' + (st.rec.on ? ' bad' : st.security ? ' on' : '');
        topPill.replaceChildren(h('span', { class: 'dot' }), st.rec.on ? t('Запис') : st.security ? t('Охорона') : t('Охорону вимкнено'));
        sideInfo.textContent = t('Версія {x}', { x: st.fw });
        // The name and colours can change in Налаштування → Пристрій
        if (st.theme && st.theme !== info.theme) { info.theme = st.theme; applyTheme(st.theme); }
        info.name = st.name;
        app.querySelectorAll('.brand-name').forEach(n => { n.textContent = st.name; });
        document.title = st.name || t('Камера');
    }

    async function poll() {
        clearTimeout(pollTimer);
        if (document.hidden) return;
        try {
            status = await api('api/status');
            updateShell(status);
            for (const p of Object.values(pages)) p.update && p.update(status);
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) return;
        }
        // Through the relay every request shares the camera's one slow link
        pollTimer = setTimeout(poll, (current === 'home' ? 2000 : 6000) * (REMOTE ? 2 : 1));
    }

    window.addEventListener('hashchange', route);
    const onVis = () => {
        if (document.hidden) {
            clearTimeout(pollTimer);
            if (current) pages[current].leave();
        } else if (current) {
            pages[current].enter();
            poll();
        }
    };
    document.addEventListener('visibilitychange', onVis);
    stopFns.add(() => {
        window.removeEventListener('hashchange', route);
        document.removeEventListener('visibilitychange', onVis);
    });
    shellApi.poll = poll;
    route();
}

const shellApi = { poll: () => {} };

// ---------- live view (home page and settings preview) ----------

function liveView({ fps, controls = false }) {
    const img = h('img', { alt: t('Відео з камери наживо') });
    const placeholder = h('div', { class: 'placeholder' });
    const badges = h('div', { class: 'live-badges' });
    const closeFs = h('button', { class: 'icon-btn fs-close', 'aria-label': t('Вийти з повноекранного режиму'), onclick: () => setFs(false) }, icon('x'));
    // Frames around faces, laid exactly over the picture
    const faceLayer = h('div', { class: 'face-layer hidden', 'aria-hidden': 'true' });
    const box = h('div', { class: 'live' }, placeholder, img, faceLayer, badges, closeFs);
    let running = false, checkTimer = null, retryTimer = null, rotate = 0;
    // The stream is read with fetch where the browser can, so the page sees
    // every frame and reconnects when they stop: a stream ended by the camera
    // or the relay (slow phone network) or cut by iOS otherwise just freezes
    // Browsers that never hand over the parts of this kind of stream fall back to
    // a plain <img> after two connections without a single frame
    // iPhone and iPad browsers (all WebKit) never hand them over through the relay
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let readable = !DEMO && !ios && typeof ReadableStream === 'function' && typeof AbortController === 'function';
    // Through the relay an iPhone takes the first frame of the stream and then
    // stops reading it, so there it fetches one snapshot after another instead
    const polling = !DEMO && ios && REMOTE && typeof AbortController === 'function';
    let reading = null, lastFrame = 0, shown = '', watchdog = null, gotFrame = false, emptyTries = 0;
    function noFrames(ctl) {
        // An answer like "busy" or "log in" says nothing about the browser
        if (gotFrame || !ctl || ctl.refused) return;
        if (++emptyTries >= 2) {
            readable = false;
            clearInterval(watchdog);
            if (reading) reading.abort();
            reading = null;
        }
    }

    function showWait() {
        placeholder.replaceChildren(h('div', { class: 'spinner' }), h('span', { text: t('Підключення до камери…') }));
        placeholder.classList.remove('hidden');
    }
    function showFail() {
        placeholder.replaceChildren(icon('camera', 'lg'), h('span', { text: t('Не вдалося отримати відео') }),
            h('button', { class: 'btn', onclick: () => { stop(); start(); } }, icon('refresh', 'sm'), t('Ще раз')));
        placeholder.classList.remove('hidden');
        img.classList.add('hidden');
    }
    function start() {
        if (running) return;
        running = true;
        showWait();
        img.classList.remove('hidden');
        img.onerror = () => {
            if (!running || readable || polling) return;
            showFail();
            running = false;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => { if (!document.hidden && box.isConnected && box.offsetParent) start(); }, 4000);
        };
        liveViews.add(self);
        open();
        // MJPEG doesn't fire "load" reliably: watch for the first frame
        clearInterval(checkTimer);
        checkTimer = setInterval(() => {
            if (img.naturalWidth > 0) {
                placeholder.classList.add('hidden');
                layout();
                clearInterval(checkTimer);
            }
        }, 250);
    }
    function open() {
        const u = streamUrl(fps);
        // A fresh query defeats caches of an old stream
        const url = DEMO ? u : u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();
        if (polling) {
            if (reading) reading.abort();
            pollFrames(reading = new AbortController());
            return;
        }
        if (!readable) {
            img.src = url;
            return;
        }
        if (reading) reading.abort();
        const ctl = reading = new AbortController();
        lastFrame = Date.now();
        gotFrame = false;
        clearInterval(watchdog);
        watchdog = setInterval(() => {
            if (running && Date.now() - lastFrame > 6000 && !document.hidden) {
                noFrames(reading);
                open();
            }
        }, 2000);
        readFrames(url, ctl).catch(() => {}).finally(() => {
            // Ended or failed: try again shortly (the watchdog covers a hang)
            if (running && reading === ctl) {
                noFrames(ctl);
                if (!readable) return open();
                clearTimeout(retryTimer);
                retryTimer = setTimeout(() => { if (running && reading === ctl) open(); }, 2000);
            }
        });
    }
    async function pollFrames(ctl) {
        while (running && reading === ctl) {
            const t0 = Date.now();
            try {
                const r = await fetch(snapshotUrl() + '?t=' + t0, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
                if (!r.ok) throw new Error(r.status);
                const jpeg = await r.blob();
                if (reading !== ctl) return;
                showFrame(jpeg);
            } catch (e) {
                if (ctl.signal.aborted) return;
                await sleep(2000);
                continue;
            }
            await sleep(Math.max(0, 1000 / fps - (Date.now() - t0)));
        }
    }
    // multipart/x-mixed-replace: each part has a Content-Length header, then the JPEG
    async function readFrames(url, ctl) {
        const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
        if (!r.ok || !r.body) {
            ctl.refused = true;
            throw new Error(r.status);
        }
        const reader = r.body.getReader();
        const ascii = new TextDecoder('latin1');
        let buf = new Uint8Array(0);
        for (;;) {
            const { done, value } = await reader.read();
            if (done || ctl.signal.aborted) return;
            const next = new Uint8Array(buf.length + value.length);
            next.set(buf);
            next.set(value, buf.length);
            buf = next;
            for (;;) {
                let end = -1;
                for (let i = 0; i + 3 < buf.length && i < 400; i++) {
                    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) { end = i; break; }
                }
                if (end < 0) {
                    if (buf.length > 400) buf = buf.slice(buf.length - 3);  // no header here: skip junk
                    break;
                }
                const m = /content-length:\s*(\d+)/i.exec(ascii.decode(buf.subarray(0, end)));
                if (!m) {
                    buf = buf.slice(end + 4);  // the camera's keep-alive blank lines
                    continue;
                }
                const len = +m[1], start = end + 4;
                if (buf.length < start + len) break;
                if (reading === ctl) showFrame(buf.slice(start, start + len));
                buf = buf.slice(start + len);
            }
        }
    }
    function showFrame(jpeg) {
        lastFrame = Date.now();
        gotFrame = true;
        emptyTries = 0;
        const old = shown;
        shown = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
        img.src = shown;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
    }
    // Reconnects in place: the last picture stays up until the next one arrives
    function restart() {
        if (running && !DEMO) open();
    }
    function stop() {
        running = false;
        liveViews.delete(self);
        clearInterval(checkTimer);
        clearTimeout(retryTimer);
        clearInterval(watchdog);
        if (reading) reading.abort();
        reading = null;
        if (shown) URL.revokeObjectURL(shown);
        shown = '';
        img.onerror = null;
        // Dropping src closes the stream connection
        img.removeAttribute('src');
        img.src = 'data:,';
        setFaces([]);
    }
    // faces: [{x, y, w, h (0..1000 of the picture), known, name}]
    // `labels` off: plain frames (while remembering a face nobody is a stranger)
    function setFaces(faces, labels = true) {
        const show = running && faces.length > 0 && img.naturalWidth > 0;
        faceLayer.classList.toggle('hidden', !show);
        if (!show) return faceLayer.replaceChildren();
        faceLayer.replaceChildren(...faces.map(f => h('div', {
            class: 'face-box' + (f.known ? ' known' : ''),
            style: { left: f.x / 10 + '%', top: f.y / 10 + '%', width: f.w / 10 + '%', height: f.h / 10 + '%' },
        }, labels ? h('span', { text: f.known ? f.name : t('Незнайомець') }) : null)));
    }
    function layout() {
        const r = ((rotate % 360) + 360) % 360;
        const side = r === 90 || r === 270;
        const nw = img.naturalWidth || 4, nh = img.naturalHeight || 3;
        const fs = box.classList.contains('fs') || document.fullscreenElement === box;
        box.style.aspectRatio = fs ? '' : side ? `${nh} / ${nw}` : `${nw} / ${nh}`;
        fitInside(img, box, r);
        faceLayer.style.width = img.style.width;
        faceLayer.style.height = img.style.height;
        faceLayer.style.transform = img.style.transform;
    }
    function setRotate(r) {
        rotate = r;
        layout(); // also picks up a new picture size after a resolution change
    }
    if (window.ResizeObserver) new ResizeObserver(() => layout()).observe(box);
    window.addEventListener('orientationchange', () => setTimeout(layout, 300));

    // The page's own full screen: used on iPhone, and wherever the browser
    // refuses the real one (many in-app browsers)
    // The box moves to <body> meanwhile: inside the card (blurred backdrop,
    // clipped corners) a fixed-position box is positioned and cut off by the
    // card instead of covering the screen
    let home = null;
    function pageFs(on) {
        if (on && !home) {
            home = { parent: box.parentNode, next: box.nextSibling };
            document.body.append(box);
        } else if (!on && home) {
            home.parent.insertBefore(box, home.next);
            home = null;
        }
        box.classList.toggle('fs', on);
        document.body.classList.toggle('locked', on);
        setTimeout(layout, 50);
    }
    function setFs(on) {
        const native = box.requestFullscreen && !/iPhone|iPad|iPod/.test(navigator.userAgent);
        if (!on) {
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            pageFs(false);
            return;
        }
        if (native) box.requestFullscreen().then(() => setTimeout(layout, 100), () => pageFs(true));
        else pageFs(true);
    }
    document.addEventListener('fullscreenchange', () => {
        box.classList.toggle('fs', document.fullscreenElement === box);
        setTimeout(layout, 100);
    });

    const self = { el: box, img, badges, start, stop, restart, setRotate, setFs, setFaces, isFs: () => box.classList.contains('fs') || document.fullscreenElement === box };
    return self;
}

// Sizes an absolutely centred <img> to fit `box` without distortion (and
// turned by `rotate` degrees). Done by hand: some phone browsers ignore
// object-fit for streams and SVG, which stretched the picture.
function fitInside(img, box, rotate = 0) {
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    const side = rotate === 90 || rotate === 270;
    const nw = img.naturalWidth || 4, nh = img.naturalHeight || 3;
    const vw = side ? nh : nw, vh = side ? nw : nh; // as seen on screen
    const k = Math.min(bw / vw, bh / vh);
    const w = Math.round(vw * k), hh = Math.round(vh * k);
    img.style.width = (side ? hh : w) + 'px';
    img.style.height = (side ? w : hh) + 'px';
    img.style.transform = `translate(-50%, -50%) rotate(${rotate}deg)`;
}

// ---------- recordings: shared bits ----------

function clipCard(item, onOpen) {
    const enc = encodeURIComponent(item.f);
    const kindM = item.k === 'm';
    return h('button', { class: 'clip', 'data-k': item.k, onclick: () => onOpen(item), 'aria-label': t('Запис о {t}, {d}', { t: fmtTime(item.t), d: fmtDur(item.dur) }) },
        h('div', { class: 'thumb' }, icon('film', 'lg'),
            h('img', { loading: 'lazy', alt: '', src: res(`api/rec/frame?f=${enc}&n=0`), onerror: e => e.target.remove() }),
            h('span', { class: 'dur', text: fmtDur(item.dur) })),
        h('div', { class: 'meta' },
            h('span', { class: 'time', text: fmtTime(item.t) }),
            h('span', { class: 'kind' + (kindM ? ' m' : '') }, icon(kindM ? 'motion' : 'hand', 'sm'), kindM ? t('Рух') : t('Вручну'))));
}

const recEvents = new EventTarget();

// ---------- faces: shared bits ----------

const faceName = e => e.name || t('Незнайомець');

// "14:05" today, else "3 лист., 14:05"
function fmtWhen(epoch) {
    const d = new Date(epoch * 1000);
    const today = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(LOCALE, today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function faceWhen(e) {
    return e.time ? fmtWhen(e.time) : fmtAgo(e.ago);
}

function faceEventCard(e) {
    return h('button', { class: 'clip face', onclick: () => openFaceEvent(e), 'aria-label': `${faceName(e)}, ${faceWhen(e)}` },
        h('div', { class: 'thumb' }, icon('face', 'lg'),
            h('img', { loading: 'lazy', alt: '', src: res(`api/faces/event?n=${e.n}`), onerror: ev => ev.target.remove() })),
        h('div', { class: 'meta' },
            h('span', { class: 'time', text: faceName(e) }),
            h('span', { class: 'kind' + (e.name ? '' : ' m'), text: faceWhen(e) })));
}

function openFaceEvent(e) {
    const d = h('div', { class: 'dialog face-photo', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'dialog-head' }, h('h2', { text: faceName(e) }), h('button', { class: 'icon-btn', 'aria-label': t('Закрити'), onclick: () => close() }, icon('x'))),
        h('img', { src: res(`api/faces/event?n=${e.n}`), alt: faceName(e) }),
        h('p', { class: 'muted small', text: faceWhen(e) }));
    const close = overlay(d);
}

function faceEventsDialog(list) {
    const d = h('div', { class: 'dialog face-log', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'dialog-head' }, h('h2', { text: t('Хто був у кадрі') }), h('button', { class: 'icon-btn', 'aria-label': t('Закрити'), onclick: () => close() }, icon('x'))),
        h('div', { class: 'clips' }, list.map(e => faceEventCard(e))),
        h('p', { class: 'tip', style: { marginTop: '14px' } }, icon('clock', 'sm'), t('Камера пам\'ятає останні 100 появ. З картою пам\'яті вони зберігаються й після перезавантаження.')));
    const close = overlay(d);
}

// ---------- logins: shared bits ----------

// The relay sends "City, Region, CC" (URL-encoded); at home there is no place
function placeText(e) {
    if (!e.remote) return t('Домашня мережа');
    let parts = [];
    try { parts = decodeURIComponent(e.place || '').split(', ').filter(Boolean); } catch (ex) { /* cut short */ }
    const cc = parts[parts.length - 1];
    if (cc && /^[A-Z]{2}$/.test(cc)) {
        try { parts[parts.length - 1] = new Intl.DisplayNames([LOCALE], { type: 'region' }).of(cc); } catch (ex) { /* old browser */ }
    }
    return parts.length ? parts.join(', ') : t('Через інтернет');
}

// One login (history) or one logged-in device (session)
function loginRow(e, { current, action } = {}) {
    const bad = e.ok === false;
    const title = bad ? (e.n > 1 ? t('Невірний пароль ({n} {u})', { n: e.n, u: pl(e.n, 'try') }) : t('Невірний пароль')) : (e.dev || t('Невідомий пристрій'));
    const when = e.seen !== undefined
        ? (current ? t('зараз') : e.seen ? t('востаннє {x}', { x: fmtWhen(e.seen) }) : '')
        : (e.at ? fmtWhen(e.at) : '');
    return h('div', { class: 'login' + (bad ? ' bad' : '') },
        h('span', { class: 'ico' }, icon(bad ? 'alert' : e.remote ? 'globe' : 'home')),
        h('div', { class: 'grow' },
            h('div', { class: 'value' }, title, current ? h('span', { class: 'pill on', text: t('Цей пристрій') }) : null),
            h('div', { class: 'faint small', text: [bad ? e.dev : '', placeText(e), e.ip, when].filter(Boolean).join(' · ') })),
        action || null);
}

function openPlayer(item, list) {
    let idx = list ? list.findIndex(x => x.f === item.f) : -1;
    let alive = true;
    let session = 0;

    const img = h('img', { alt: t('Кадр запису') });
    const spinner = h('div', { class: 'spinner' });
    const view = h('div', { class: 'player-view' }, img, spinner);
    const titleB = h('b');
    const titleS = h('span', { class: 'faint' });
    const seek = h('input', { type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': t('Позиція у записі') });
    const tCur = h('span', { text: '0:00' });
    const tAll = h('span', { text: '0:00' });
    const playBtn = h('button', { class: 'icon-btn play', 'aria-label': t('Відтворити') }, icon('play'));
    const speedBtn = h('button', { class: 'speed', 'aria-label': t('Швидкість відтворення'), text: '1×' });
    const prevBtn = h('button', { class: 'icon-btn', 'aria-label': t('Попередній запис') }, icon('back'));
    const nextBtn = h('button', { class: 'icon-btn', 'aria-label': t('Наступний запис') }, icon('chevron'));
    const dl = h('button', { class: 'icon-btn', 'aria-label': t('Завантажити відео'), title: t('Завантажити відео'), onclick: () => saveWhilePaused() }, icon('download'));
    const del = h('button', { class: 'icon-btn', 'aria-label': t('Видалити запис'), title: t('Видалити запис') }, icon('trash'));

    const player = h('div', { class: 'player', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Перегляд запису') },
        h('div', { class: 'player-top' },
            h('div', { class: 'title' }, titleB, titleS),
            dl, del,
            h('button', { class: 'icon-btn', 'aria-label': t('Закрити'), onclick: () => close() }, icon('x'))),
        view,
        h('div', { class: 'player-bar' },
            seek,
            h('div', { class: 'player-time' }, tCur, tAll),
            // Three columns, so play/pause sits in the exact middle whatever the sides hold
            h('div', { class: 'player-btns' },
                h('div', { class: 'side' }, prevBtn, speedBtn),
                h('div', { class: 'mid' },
                    h('button', { class: 'icon-btn', 'aria-label': t('Назад на 5 секунд'), onclick: () => jump(-5) }, icon('step-back')),
                    playBtn,
                    h('button', { class: 'icon-btn', 'aria-label': t('Вперед на 5 секунд'), onclick: () => jump(5) }, icon('step-fwd'))),
                h('div', { class: 'side end' }, nextBtn))));
    // Keep the frame's proportions (see fitInside)
    img.addEventListener('load', () => fitInside(img, view));
    if (window.ResizeObserver) new ResizeObserver(() => fitInside(img, view)).observe(view);

    let frames = 0, fps = 10, i = 0, playing = false, speed = 1;
    let cache = new Map();
    let f = '';

    const frameUrl = n => `api/rec/frame?f=${encodeURIComponent(f)}&n=${n}`;
    function getFrame(n) {
        if (!cache.has(n)) {
            // A request the browser silently dropped (iPhone, after a download)
            // must not hang playback: give up on it after a while
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 8000);
            const p = fetch(frameUrl(n), { credentials: 'same-origin', signal: ctl.signal })
                .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
                .finally(() => clearTimeout(timer))
                .then(b => URL.createObjectURL(b));
            p.catch(() => cache.delete(n));
            cache.set(n, p);
        }
        return cache.get(n);
    }
    function trimCache() {
        for (const [n, p] of cache) {
            if (n < i - 15 || n > i + 40) {
                cache.delete(n);
                p.then(u => URL.revokeObjectURL(u), () => {});
            }
        }
    }
    function clearCache() {
        for (const p of cache.values()) p.then(u => URL.revokeObjectURL(u), () => {});
        cache = new Map();
    }
    function updateTime() {
        tCur.textContent = fmtDur(i / fps);
        seek.value = i;
        rangeFill(seek);
    }
    async function show(n) {
        const s = session;
        try {
            const u = await getFrame(n);
            if (s !== session || !alive) return;
            img.src = u;
            spinner.classList.add('hidden');
        } catch (e) { /* skip a broken frame */ }
    }
    function setPlaying(p) {
        playing = p;
        playBtn.replaceChildren(icon(p ? 'pause' : 'play'));
        playBtn.setAttribute('aria-label', p ? t('Пауза') : t('Відтворити'));
        if (p) loop();
    }
    async function loop() {
        const s = session;
        if (loop.running === s) return;
        loop.running = s;
        while (alive && playing && s === session) {
            const t0 = performance.now();
            await show(i);
            if (!alive || s !== session) break;
            updateTime();
            for (let k = 1; k <= 4; k++) if (i + k * speed < frames) getFrame(i + k * speed);
            trimCache();
            const wait = 1000 / fps - (performance.now() - t0);
            if (wait > 0) await sleep(wait);
            if (!playing || s !== session) break;
            if (i + speed >= frames) {
                i = frames - 1;
                updateTime();
                setPlaying(false);
                break;
            }
            i += speed;
        }
        if (loop.running === s) loop.running = null;
    }
    // Playback fetches a frame at a time from the same camera: while it ran,
    // the file came down several times slower
    async function saveWhilePaused() {
        if (savingRec) return;
        const s = session, was = playing;
        setPlaying(false);
        await saveRecording(f);
        if (was && alive && s === session && !playing) setPlaying(true);
    }
    function jump(sec) {
        i = Math.max(0, Math.min(frames - 1, i + Math.round(sec * fps)));
        updateTime();
        if (!playing) show(i);
    }

    seek.addEventListener('input', () => {
        i = +seek.value;
        updateTime();
        if (!playing) show(i);
    });
    playBtn.onclick = () => {
        if (!playing && i >= frames - 1) i = 0;
        setPlaying(!playing);
    };
    speedBtn.onclick = () => {
        speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
        speedBtn.textContent = speed + '×';
    };
    prevBtn.onclick = () => { if (list && idx < list.length - 1) load(list[++idx]); };
    nextBtn.onclick = () => { if (list && idx > 0) load(list[--idx]); };
    del.onclick = async () => {
        const ok = await confirmDialog({ title: t('Видалити запис?'), text: t('Його не можна буде відновити.'), ok: t('Видалити'), danger: true });
        if (!ok) return;
        try {
            await api('api/rec/delete', { f });
            toast(t('Запис видалено'));
            recEvents.dispatchEvent(new CustomEvent('changed'));
            if (list) {
                list.splice(idx, 1);
                if (list.length) return load(list[Math.min(idx, list.length - 1)]);
            }
            close();
        } catch (e) { showError(e); }
    };

    async function load(it) {
        session++;
        setPlaying(false);
        clearCache();
        f = it.f;
        if (list) idx = list.findIndex(x => x.f === f);
        prevBtn.disabled = !list || idx >= list.length - 1;
        nextBtn.disabled = !list || idx <= 0;
        prevBtn.style.visibility = list ? '' : 'hidden';
        nextBtn.style.visibility = list ? '' : 'hidden';
        titleB.textContent = `${dayLabel(it.d)}, ${fmtTime(it.t)}`;
        titleS.textContent = it.k === 'm' ? t('Запис руху') : t('Записано вручну');
        spinner.classList.remove('hidden');
        img.removeAttribute('src');
        i = 0;
        const s = session;
        try {
            const inf = await api(`api/rec/info?f=${encodeURIComponent(f)}`);
            if (s !== session) return;
            frames = inf.frames;
            fps = inf.fps > 0 ? inf.fps : 10;
            seek.max = Math.max(0, frames - 1);
            tAll.textContent = fmtDur(frames / fps);
            updateTime();
            setPlaying(true);
        } catch (e) {
            spinner.classList.add('hidden');
            if (s === session) toast(t('Не вдалося відкрити запис'), true);
        }
    }

    const onKey = e => {
        if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
        if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); jump(-5); }
        if (e.key === 'ArrowRight') { e.preventDefault(); jump(5); }
    };
    document.addEventListener('keydown', onKey);
    const close = overlay(player, {
        cls: 'player-overlay', onClose: () => {
            alive = false;
            session++;
            clearCache();
            document.removeEventListener('keydown', onKey);
        }
    });
    load(item);
}

// ---------- home ----------

function homePage() {
    const banners = h('div');
    const live = liveView({ fps: REMOTE ? 5 : 15, controls: true });
    const liveBadge = h('span', { class: 'badge' }, h('span', { class: 'dot' }), t('НАЖИВО'));
    const recBadge = h('span', { class: 'badge rec hidden' }, h('span', { class: 'dot' }), h('span', { text: t('ЗАПИС') }));
    const motionBadge = h('span', { class: 'badge motion hidden' }, icon('motion', 'sm'), t('Рух'));
    live.badges.append(liveBadge, recBadge, motionBadge);

    let lampLevel = +(localStorageGet('lamp') || 100);
    const lampRange = h('input', { type: 'range', min: 5, max: 100, step: 5, value: lampLevel, 'aria-label': t('Яскравість ліхтарика') });
    rangeFill(lampRange);
    const lampRow = h('div', { class: 'lamp-row hidden' }, icon('lamp', 'sm'), h('span', { class: 'small muted', text: t('Яскравість') }), lampRange);
    let lampTimer;
    lampRange.addEventListener('input', () => {
        rangeFill(lampRange);
        lampLevel = +lampRange.value;
        localStorageSet('lamp', lampLevel);
        clearTimeout(lampTimer);
        lampTimer = setTimeout(() => api('api/lamp', { level: lampLevel }).catch(showError), 120);
    });

    const ctl = (ic, label, onclick) => {
        const lbl = h('span', { text: label });
        const b = h('button', { class: 'ctl', onclick }, icon(ic), lbl);
        b.lbl = lbl;
        return b;
    };
    const lampBtn = ctl('lamp', t('Ліхтарик'), async () => {
        const on = !(status && status.lamp > 0);
        try {
            await api('api/lamp', { level: on ? lampLevel : 0 });
            lampBtn.classList.toggle('on', on);
            lampRow.classList.toggle('hidden', !on);
            if (status) status.lamp = on ? lampLevel : 0;
        } catch (e) { showError(e); }
    });
    const snapBtn = ctl('camera', t('Знімок'), async () => {
        if (DEMO) {
            const a = h('a', { href: snapshotUrl(), download: '' });
            document.body.append(a);
            a.click();
            a.remove();
            return toast(t('Знімок зберігається…'));
        }
        try {
            // The snapshot comes from the stream port, another origin on the LAN
            const blob = await fetchBlob(snapshotUrl(), null, { credentials: 'include' });
            const d = new Date(), p2 = n => String(n).padStart(2, '0');
            const name = `camera_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.jpg`;
            saveBlob(blob, name);
            toast(t('Знімок збережено'));
        } catch (e) { toast(t('Не вдалося зробити знімок'), true); }
    });
    const recBtn = ctl('rec', t('Записати'), async () => {
        const on = !(status && status.rec.manual);
        try {
            await api('api/record', { on });
            toast(on ? t('Запис розпочато') : t('Запис зупинено'));
            shellApi.poll();
        } catch (e) { showError(e); }
    });
    const fsBtn = ctl('expand', t('Весь екран'), () => live.setFs(!live.isFs()));

    const liveCard = h('section', { class: 'card live-card', 'aria-label': t('Відео наживо') },
        live.el,
        // Some boards have no flash lamp
        info.lamp === false
            ? h('div', { class: 'live-controls', style: { gridTemplateColumns: 'repeat(3, 1fr)' } }, snapBtn, recBtn, fsBtn)
            : h('div', { class: 'live-controls' }, lampBtn, snapBtn, recBtn, fsBtn),
        info.lamp === false ? null : lampRow);

    // Security
    // A status poll that answers before the camera has switched must not flip
    // the switch back (over the relay that looked like a missed tap)
    let secBusy = false;
    const secSwitch = switchEl(false, async on => {
        secBusy = true;
        secSwitch.input.disabled = true;
        try {
            await api('api/security', { on });
            toast(on ? t('Охорону увімкнено') : t('Охорону вимкнено'));
        } catch (e) {
            secSwitch.input.checked = !on;
            showError(e);
        } finally {
            secBusy = false;
            secSwitch.input.disabled = false;
            shellApi.poll();
        }
    }, t('Охорона'));
    secSwitch.el.classList.add('big');
    const secTitle = h('h2');
    const secText = h('p');
    const secShield = h('div', { class: 'shield' }, icon('shield', 'lg'));
    const secBox = h('div', { class: 'security' }, secShield, h('div', { class: 'grow' }, secTitle, secText), secSwitch.el);
    // The whole card is the switch: easier to hit with a thumb
    secBox.addEventListener('click', e => {
        if (e.target !== secSwitch.input && !secSwitch.input.disabled) secSwitch.input.click();
    });
    const secCard = h('section', { class: 'card' }, secBox);

    // Stats
    const sdVal = h('div', { class: 'value' }), sdBar = h('div', { class: 'bar' }, h('div'));
    const wifiVal = h('div', { class: 'value' });
    const remoteVal = h('div', { class: 'value' });
    const motionVal = h('div', { class: 'value' });
    const remoteRow = h('div', { class: 'stat' }, h('span', { class: 'ico' }, icon('globe')), h('div', { class: 'grow' }, h('div', { class: 'label', text: t('Віддалений доступ') }), remoteVal));
    const statsCard = h('section', { class: 'card' },
        h('div', { class: 'stat-list' },
            h('div', { class: 'stat' }, h('span', { class: 'ico' }, icon('sd')), h('div', { class: 'grow' }, h('div', { class: 'label', text: t('Карта пам\'яті') }), sdVal, sdBar)),
            h('div', { class: 'stat' }, h('span', { class: 'ico' }, icon('motion')), h('div', { class: 'grow' }, h('div', { class: 'label', text: t('Останній рух') }), motionVal)),
            h('div', { class: 'stat' }, h('span', { class: 'ico' }, icon('wifi')), h('div', { class: 'grow' }, h('div', { class: 'label', text: 'Wi-Fi' }), wifiVal)),
            remoteRow));

    // Faces: frames over the live picture, and who was seen lately
    const facesStrip = h('div', { class: 'strip' });
    const facesAll = h('button', { class: 'btn ghost hidden', onclick: () => faceEventsDialog(faceEvents) }, t('Усі'), icon('chevron', 'sm'));
    const facesCard = h('section', { class: 'card hidden' },
        h('div', { class: 'card-head' }, h('h2', { text: t('Хто був у кадрі') }), facesAll),
        facesStrip);
    let faceEvents = [], faceKey = null, faceAt = 0, faceTimer = null, facesOn = false;
    async function loadFaceEvents(key) {
        faceKey = key;
        faceAt = Date.now();
        try {
            const r = await api('api/faces');
            faceEvents = r.events || [];
            facesCard.classList.toggle('hidden', !(r.enabled || faceEvents.length));
            facesAll.classList.toggle('hidden', faceEvents.length <= 4);
            facesStrip.replaceChildren(...(faceEvents.length ? faceEvents.slice(0, 4).map(e => faceEventCard(e)) :
                [h('p', { class: 'muted small', style: { gridColumn: '1 / -1' }, text: t('Поки нікого. Тут з\'являться люди, яких побачить камера.') })]));
        } catch (e) { faceKey = null; }
    }
    async function pollFaces() {
        clearTimeout(faceTimer);
        faceTimer = null;
        if (!facesOn || el.classList.contains('hidden') || document.hidden) return live.setFaces([]);
        try {
            const r = await api('api/faces/live');
            live.setFaces(r.age < 2000 ? r.faces : []);
        } catch (e) { live.setFaces([]); }
        faceTimer = setTimeout(pollFaces, REMOTE ? 1500 : 700);
    }

    // Logins of the last day from other devices
    const loginList = h('div', { class: 'login-list' });
    const loginsCard = h('section', { class: 'card hidden' },
        h('div', { class: 'card-head' }, h('h2', { text: t('Нещодавні входи') }),
            h('a', { class: 'btn ghost', href: '#/settings', onclick: () => localStorageSet('settingsSection', 'account') }, t('Усі'), icon('chevron', 'sm'))),
        loginList);
    let loginKey = null, loginAt = 0;
    async function loadLogins(key) {
        loginKey = key;
        loginAt = Date.now();
        try {
            const r = await api('api/logins');
            const mine = (r.sessions.find(x => x.current) || {}).id;
            const since = Date.now() / 1000 - 86400;
            const list = r.history.filter(e => e.at > since && !(e.id && e.id === mine)).slice(0, 3);
            loginsCard.classList.toggle('hidden', !list.length);
            loginList.replaceChildren(...list.map(e => loginRow(e)));
        } catch (e) { loginKey = null; }
    }

    // Recent recordings
    const strip = h('div', { class: 'strip' });
    const recentCard = h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: t('Останні записи') }), h('a', { class: 'btn ghost', href: '#/rec' }, t('Усі'), icon('chevron', 'sm'))),
        strip);
    let recentList = [];
    let recentKey = null; // null: unknown, must be loaded
    let recentAt = 0;
    // Listing the card is slow-ish: refresh on changes, else every 30 s
    async function loadRecent(force) {
        if (!force && recentKey !== null && Date.now() - recentAt < 30000) return;
        recentAt = Date.now();
        try {
            const r = await api('api/rec/recent?n=4');
            const key = r.items.map(x => x.f).join();
            if (key === recentKey) return;
            recentKey = key;
            recentList = r.items;
            strip.replaceChildren(...(recentList.length ? recentList.map(it => clipCard(it, x => openPlayer(x, recentList))) :
                [h('p', { class: 'muted small', style: { gridColumn: '1 / -1' }, text: t('Записів поки немає. Увімкніть охорону, і камера запише відео, коли побачить рух.') })]));
        } catch (e) { /* shown by status */ }
    }
    recEvents.addEventListener('changed', () => { recentKey = null; });

    const el = h('div', null,
        h('div', { class: 'page-head' }, h('h1', { text: t('Головна') })),
        banners,
        h('div', { class: 'home-grid' },
            h('div', { class: 'home-main' }, liveCard, facesCard, recentCard),
            h('div', { class: 'home-side' }, secCard, loginsCard, statsCard)));

    // Seconds since the last motion. The camera forgets it on restart: then
    // the end of the newest motion clip counts.
    function motionAgo(st) {
        if (st.motion.ago >= 0 || !st.clock) return st.motion.ago;
        const m = recentList.find(x => x.k === 'm');
        if (!m) return -1;
        const end = new Date(+m.d.slice(0, 4), +m.d.slice(4, 6) - 1, +m.d.slice(6, 8), +m.t.slice(0, 2), +m.t.slice(2, 4), +m.t.slice(4, 6) + m.dur);
        return Math.max(0, Math.floor((st.time * 1000 - end.getTime()) / 1000));
    }

    let lastRecOn = false;
    function update(st) {
        live.setRotate(st.rotate || 0);
        // Banners
        const b = [];
        if (!st.camera) b.push(['bad', t('Камеру не знайдено'), t('Перевірте, чи щільно вставлений шлейф камери, і перезавантажте пристрій.')]);
        if (!st.sd.ok) b.push(['', t('Немає карти пам\'яті'), t('Вставте карту microSD, щоб зберігати записи. Без неї працює лише перегляд наживо.')]);
        if (st.rec.error) b.push(['bad', t('Проблема із записом'), t(st.rec.error)]);
        if (!st.clock) b.push(['', t('Час не встановлено'), t('Камера не має доступу до інтернету, тому записи будуть без дати.')]);
        banners.replaceChildren(...b.map(([cls, t, d]) => h('div', { class: 'banner ' + cls, role: 'alert' }, icon('alert'), h('div', null, h('b', { text: t }), h('p', { text: d })))));

        // Badges
        recBadge.classList.toggle('hidden', !st.rec.on);
        recBadge.lastChild.textContent = t('ЗАПИС {x}', { x: fmtDur(st.rec.sec) });
        motionBadge.classList.toggle('hidden', !(st.security && st.motion.active));

        // Controls
        lampBtn.classList.toggle('on', st.lamp > 0);
        lampRow.classList.toggle('hidden', !(st.lamp > 0));
        recBtn.classList.toggle('rec-on', st.rec.manual);
        recBtn.replaceChildren(icon(st.rec.manual ? 'stop' : 'rec'), recBtn.lbl);
        recBtn.lbl.textContent = st.rec.manual ? t('Зупинити') : t('Записати');

        // Security
        if (!secBusy) secSwitch.input.checked = st.security;
        secBox.classList.toggle('on', st.security);
        secShield.replaceChildren(icon(st.security ? 'shield-check' : 'shield', 'lg'));
        secTitle.textContent = st.security ? t('Охорона увімкнена') : t('Охорона вимкнена');
        secText.textContent = st.security
            ? (st.rec.on && !st.rec.manual ? t('Бачу рух — іде запис.') : t('Камера запише відео, коли побачить рух.'))
            : t('Увімкніть, щоб камера записувала відео, коли бачить рух.');

        // Stats
        if (st.sd.ok) {
            const pct = st.sd.total ? (st.sd.used / st.sd.total) * 100 : 0;
            sdVal.textContent = t('Вільно {a} з {b}', { a: fmtGB(st.sd.total - st.sd.used), b: fmtGB(st.sd.total) });
            sdBar.classList.remove('hidden');
            sdBar.classList.toggle('warn', pct > 90);
            sdBar.firstChild.style.width = pct.toFixed(1) + '%';
        } else {
            sdVal.textContent = t('Не вставлено');
            sdBar.classList.add('hidden');
        }
        motionVal.textContent = st.security ? (st.motion.active ? t('Зараз') : fmtAgo(motionAgo(st))) : t('Охорону вимкнено');
        wifiVal.textContent = st.wifi.connected ? t('{x} · {s} сигнал', { x: st.wifi.ssid, s: signalText(st.wifi.rssi) }) : t('Не підключено');
        remoteRow.classList.toggle('hidden', !st.remote.enabled);
        remoteVal.textContent = remoteStateText(st.remote.state);

        if (st.rec.on !== lastRecOn) { lastRecOn = st.rec.on; if (!st.rec.on) recentKey = null; }
        loadRecent(recentKey === null);

        // A new login attempt; else every 5 minutes, so old ones drop off
        if (st.logins !== undefined && (st.logins !== loginKey || Date.now() - loginAt > 300000)) loadLogins(st.logins);

        if (info.faces && st.faces) {
            // A new sighting, switched on or off; else once a minute for "… ago"
            const key = `${st.faces.seq}/${st.faces.enabled}`;
            if (key !== faceKey || Date.now() - faceAt > 60000) loadFaceEvents(key);
            facesOn = st.faces.on;
            if (facesOn && !faceTimer) pollFaces();
        }
    }

    return {
        el,
        enter() { live.start(); loadRecent(true); },
        leave() { live.stop(); clearTimeout(faceTimer); faceTimer = null; },
        update,
    };
}

function remoteStateText(s) {
    if (!s) return '';
    if (s === 'online') return t('Підключено');
    if (s === 'connecting') return t('Підключення…');
    if (s === 'reconnecting') return t('Перепідключення…');
    if (s === 'unreachable') return t('Сервер недоступний');
    if (s === 'waiting') return t('Очікує підключення до Wi-Fi');
    if (s === 'off') return t('Вимкнено');
    if (s === 'error:taken') return t('Це посилання вже зайняте іншою камерою');
    if (s === 'error:key') return t('Сервер не прийняв камеру');
    if (s === 'error:token') return t('Невірний код підключення');
    if (s === 'error:limit') return t('Сервер тимчасово відхиляє нові камери');
    return t('Помилка підключення');
}

// ---------- recordings page ----------

function recordingsPage() {
    let filter = 'all';
    const chips = [['all', t('Усі')], ['m', t('Рух')], ['r', t('Вручну')]].map(([k, label]) =>
        h('button', { class: 'chip' + (k === filter ? ' on' : ''), 'aria-pressed': String(k === filter), onclick: () => setFilter(k) }, label));
    const body = h('div');
    const el = h('div', null,
        h('div', { class: 'page-head' }, h('h1', { text: t('Записи') }),
            h('button', { class: 'icon-btn', 'aria-label': t('Оновити'), onclick: () => load() }, icon('refresh'))),
        h('div', { class: 'chips', role: 'group', 'aria-label': t('Фільтр') }, chips),
        body);
    let loadedAt = 0;
    let observer = null;

    function setFilter(k) {
        filter = k;
        chips.forEach((c, i) => { const on = ['all', 'm', 'r'][i] === k; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
        applyFilter();
    }
    function applyFilter() {
        body.querySelectorAll('.day').forEach(sec => {
            let visible = 0;
            sec.querySelectorAll('.clip').forEach(c => {
                const show = filter === 'all' || c.dataset.k === filter;
                c.classList.toggle('hidden', !show);
                if (show) visible++;
            });
            // Only days whose clips have arrived can be known to be empty
            sec.classList.toggle('hidden', sec.dataset.done === '1' && visible === 0);
        });
    }

    async function loadDay(sec, day) {
        if (sec.dataset.loaded) return;
        sec.dataset.loaded = '1';
        const grid = sec.querySelector('.clips');
        try {
            const r = await api(`api/rec/list?d=${day.d}`);
            const items = r.items;
            grid.replaceChildren(...items.map(it => clipCard(it, x => openPlayer(x, items))));
            sec.querySelector('.count').textContent = `${items.length} ${pl(items.length, 'rec')}`;
            sec.items = items;
            sec.dataset.done = '1';
            applyFilter();
        } catch (e) {
            sec.dataset.loaded = '';
            grid.replaceChildren(h('p', { class: 'muted', text: t('Не вдалося завантажити.') }));
        }
    }

    async function load() {
        loadedAt = Date.now();
        if (observer) observer.disconnect();
        body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
        let days;
        try {
            if (status && !status.sd.ok) {
                body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big-ico' }, icon('sd', 'lg')),
                    h('h2', { text: t('Карту пам\'яті не вставлено') }),
                    h('p', { text: t('Вставте карту microSD у камеру та перезавантажте її.') })));
                return;
            }
            days = (await api('api/rec/days')).days;
        } catch (e) {
            body.replaceChildren(h('div', { class: 'empty' }, h('p', { text: t('Не вдалося завантажити записи.') }),
                h('button', { class: 'btn', onclick: load }, t('Спробувати ще раз'))));
            return;
        }
        if (!days.length) {
            body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big-ico' }, icon('film', 'lg')),
                h('h2', { text: t('Записів поки немає') }),
                h('p', { text: t('Увімкніть охорону на головній сторінці — камера запише відео, коли побачить рух.') })));
            return;
        }
        observer = new IntersectionObserver(entries => {
            for (const en of entries) if (en.isIntersecting) { observer.unobserve(en.target); loadDay(en.target, en.target.day); }
        }, { rootMargin: '600px' });
        const secs = days.map(day => {
            const sec = h('section', { class: 'day' },
                h('div', { class: 'day-head' },
                    h('h2', { text: dayLabel(day.d) }),
                    h('span', { class: 'faint count', text: `${day.n} ${pl(day.n, 'rec')}` }),
                    h('button', { class: 'icon-btn', 'aria-label': t('Видалити записи за цей день'), title: t('Видалити записи за цей день'), onclick: () => deleteDay(sec, day) }, icon('trash', 'sm'))),
                h('div', { class: 'clips' }, h('div', { class: 'spinner sm' })));
            sec.day = day;
            observer.observe(sec);
            return sec;
        });
        body.replaceChildren(...secs);
    }

    async function deleteDay(sec, day) {
        const ok = await confirmDialog({ title: t('Видалити записи за цей день?'), text: t('{d}: {n} {u}. Їх не можна буде відновити.', { d: dayLabel(day.d), n: day.n, u: pl(day.n, 'rec') }), ok: t('Видалити'), danger: true });
        if (!ok) return;
        try {
            let files = sec.items ? sec.items.map(x => x.f) : (await api(`api/rec/list?d=${day.d}`)).items.map(x => x.f);
            // Small batches keep each request body short
            for (let i = 0; i < files.length; i += 40) await api('api/rec/delete', { files: files.slice(i, i + 40) });
            toast(t('Записи видалено'));
            recEvents.dispatchEvent(new CustomEvent('changed'));
        } catch (e) { showError(e); }
    }

    recEvents.addEventListener('changed', () => { if (!el.classList.contains('hidden')) load(); else loadedAt = 0; });

    return {
        el,
        enter() { if (Date.now() - loadedAt > 20000) load(); },
        leave() {},
    };
}

// ---------- settings ----------

function settingsPage() {
    let S = null; // settings from the camera
    const el = h('div', null, h('div', { class: 'page-head' }, h('h1', { text: t('Налаштування') })));
    // One section at a time: a menu (left on desktop, a scrollable row on phones)
    const nav = h('nav', { class: 'set-nav', 'aria-label': t('Розділи налаштувань') });
    const panel = h('div', { class: 'set-panel' });
    el.append(h('div', { class: 'settings-layout' }, nav, panel));
    const refreshers = [];
    let savedToastAt = 0;
    let preview = null;

    async function save(patch) {
        try {
            S = await api('api/settings', patch);
            refresh();
            if (Date.now() - savedToastAt > 2500) { savedToastAt = Date.now(); toast(t('Збережено')); }
        } catch (e) { showError(e); }
    }
    function refresh() { for (const fn of refreshers) fn(); }

    // Row builders. `get` reads from S, `patch(v)` builds the change.
    function row(title, desc, control, show) {
        const r = h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', { text: title }), desc ? h('span', { text: desc }) : null), control);
        if (show) refreshers.push(() => r.classList.toggle('hidden', !show()));
        return r;
    }
    function toggle(title, desc, get, patch, show) {
        const sw = switchEl(false, v => save(patch(v)), title);
        refreshers.push(() => { sw.input.checked = !!get(); });
        // The whole row is the button: the switch alone is a small target on a phone
        const r = row(title, desc, sw.el, show);
        r.classList.add('tap');
        r.addEventListener('click', e => { if (e.target !== sw.input && !sw.input.disabled) sw.input.click(); });
        return r;
    }
    function select(title, desc, options, get, patch, show) {
        const s = h('select', { 'aria-label': title, onchange: () => save(patch(isNaN(+s.value) ? s.value : +s.value)) },
            options.map(([v, label]) => h('option', { value: v, text: label })));
        refreshers.push(() => { s.value = String(get()); });
        return row(title, desc, s, show);
    }
    function range(title, desc, min, max, step, labels, get, patch, show, map = { to: v => v, from: v => v }) {
        const input = h('input', { type: 'range', min, max, step, 'aria-label': title });
        const val = h('span', { class: 'faint' });
        let timer;
        input.addEventListener('input', () => {
            rangeFill(input);
            if (labels.value) val.textContent = labels.value(+input.value);
            clearTimeout(timer);
            timer = setTimeout(() => save(patch(map.from(+input.value))), 350);
        });
        refreshers.push(() => {
            if (document.activeElement === input) return;
            input.value = map.to(get());
            rangeFill(input);
            if (labels.value) val.textContent = labels.value(+input.value);
        });
        const r = h('div', { class: 'set-row col' },
            h('div', { class: 'row' }, h('div', { class: 'txt' }, h('b', { text: title }), desc ? h('span', { text: desc }) : null), val),
            input,
            labels.ends ? h('div', { class: 'range-labels' }, h('span', { text: labels.ends[0] }), h('span', { text: labels.ends[1] })) : null);
        if (show) refreshers.push(() => r.classList.toggle('hidden', !show()));
        return r;
    }
    function seg(title, desc, options, get, patch) {
        const btns = options.map(([v, label]) => h('button', { type: 'button', onclick: () => save(patch(v)) }, label));
        refreshers.push(() => btns.forEach((b, i) => { const on = options[i][0] === get(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }));
        return h('div', { class: 'set-row col' }, h('div', { class: 'txt' }, h('b', { text: title }), desc ? h('span', { text: desc }) : null), h('div', { class: 'seg', role: 'group', 'aria-label': title }, btns));
    }
    function card(ic, title, ...kids) {
        return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('span', { class: 'ico' }, icon(ic)), h('h2', { text: title })), ...kids);
    }
    const cam = (k, v) => ({ camera: { [k]: v } });
    const mo = (k, v) => ({ motion: { [k]: v } });

    // --- security
    const SENS = [t('Дуже низька'), t('Низька'), t('Середня'), t('Висока'), t('Дуже висока')];
    const secCard = card('shield', t('Охорона та запис'),
        range(t('Чутливість до руху'), t('Висока помічає дрібні рухи, але частіше спрацьовує даремно (тіні, дерева за вікном).'), 1, 5, 1,
            { value: v => SENS[v - 1], ends: [t('Низька'), t('Висока')] }, () => S.motion.sensitivity, v => mo('sensitivity', v)),
        select(t('Записувати після руху'), t('Скільки ще писати, коли рух закінчився'), [[5, t('5 секунд')], [10, t('10 секунд')], [20, t('20 секунд')], [30, t('30 секунд')], [60, t('1 хвилину')]],
            () => S.motion.postSeconds, v => mo('postSeconds', v)),
        select(t('Запис до появи руху'), t('Додає кілька секунд перед рухом'), [[0, t('Ні')], [1, t('1 секунда')], [2, t('2 секунди')], [3, t('3 секунди')], [5, t('5 секунд')]],
            () => S.motion.preSeconds, v => mo('preSeconds', v)),
        select(t('Найдовший запис'), t('Довгі записи діляться на частини'), [[60, t('1 хвилина')], [120, t('2 хвилини')], [300, t('5 хвилин')], [600, t('10 хвилин')], [900, t('15 хвилин')]],
            () => S.motion.maxClipSeconds, v => mo('maxClipSeconds', v)),
        select(t('Плавність запису'), t('Більше кадрів — плавніше, але більше місця'), [[5, t('5 кадрів/с')], [8, t('8 кадрів/с')], [10, t('10 кадрів/с')], [15, t('15 кадрів/с')]],
            () => S.motion.fps, v => mo('fps', v)),
        info.lamp === false ? null : toggle(t('Ліхтарик під час запису'), t('Допомагає вночі, але його видно ззовні'), () => S.motion.lampOnRecord, v => mo('lampOnRecord', v)),
        info.statusLed === false ? null : toggle(t('Червоний індикатор під час запису'), t('Світлодіод на звороті плати'), () => S.statusLed, v => ({ statusLed: v })),
        h('p', { class: 'tip', style: { marginTop: '8px' } }, icon('sd', 'sm'), t('Коли карта пам\'яті заповнюється, найстаріші записи видаляються автоматично.')));

    // --- faces (ESP32-S3 boards)
    const people = h('div', { class: 'people' });
    const addPersonBtn = h('button', { class: 'btn', onclick: () => enrollDialog() }, icon('plus', 'sm'), t('Додати'));
    const peopleHint = h('span');
    const noPartition = h('div', { class: 'banner hidden', role: 'alert' }, icon('alert'),
        h('div', null, h('b', { text: t('Потрібне оновлення через USB') }),
            h('p', { text: t('Щоб камера могла запам\'ятовувати обличчя, прошийте її один раз через USB-кабель (оновлення через сторінку тут не допоможе).') })));
    let F = null; // /api/faces
    async function loadPeople() {
        try { F = await api('api/faces'); } catch (e) { return; }
        noPartition.classList.toggle('hidden', F.available !== false);
        const full = F.people.length >= F.max;
        addPersonBtn.disabled = !F.available || full;
        peopleHint.textContent = full ? t('Пам\'ять заповнена: видаліть когось, щоб додати нових.')
            : t('Камера підписуватиме їх у відео. Решта — «Незнайомець».');
        // Several photos of one person show as one row
        const byName = new Map();
        for (const p of F.people) {
            if (!byName.has(p.name)) byName.set(p.name, []);
            byName.get(p.name).push(p.uid);
        }
        people.replaceChildren(...(byName.size ? [...byName].map(([name, uids]) => h('div', { class: 'person' },
            h('div', { class: 'faces-row' }, uids.slice(0, 3).map(u => h('span', { class: 'face-thumb' }, icon('user', 'sm'),
                h('img', { alt: '', src: res(`api/faces/photo?u=${u}`), onerror: e => e.target.remove() })))),
            h('div', { class: 'txt grow' }, h('b', { text: name }), h('span', { text: t('{n} фото', { n: uids.length }) })),
            h('button', {
                class: 'icon-btn', title: t('Додати ще одне фото'), 'aria-label': t('Додати ще одне фото'),
                disabled: full || !F.available, onclick: () => enrollDialog(name),
            }, icon('plus', 'sm')),
            h('button', {
                class: 'icon-btn', title: t('Забути'), 'aria-label': t('Забути {x}', { x: name }), onclick: async () => {
                    if (!await confirmDialog({ title: t('Забути {x}?', { x: name }), text: t('Камера більше не впізнаватиме цю людину.'), ok: t('Забути'), danger: true })) return;
                    try { await api('api/faces/forget', { uids }); toast(t('Готово')); } catch (e) { showError(e); }
                    loadPeople();
                },
            }, icon('trash', 'sm'))))
            : [h('p', { class: 'muted small', text: t('Ще нікого не додано.') })]));
    }

    const ENROLL_TEXT = {
        look: t('Подивіться прямо в камеру з відстані 0,5–2 м…'),
        many: t('У кадрі кілька облич. Залиште одне.'),
        far: t('Обличчя замале. Підійдіть ближче до камери.'),
        timeout: t('Обличчя не знайдено. Спробуйте ще раз, увімкнувши світло.'),
        full: t('Пам\'ять заповнена: видаліть когось, щоб додати нових.'),
        error: t('Не вдалося запам\'ятати. Спробуйте ще раз.'),
    };
    function enrollDialog(presetName) {
        const nameIn = h('input', { type: 'text', maxLength: 24, value: presetName || '', placeholder: t('Наприклад, Мама'), autocomplete: 'off' });
        const pv = liveView({ fps: 8 });
        const msg = h('p', { class: 'enroll-msg muted', text: t('Людина стає перед камерою. Натисніть «Запам\'ятати» — камера сама зробить фото обличчя.') });
        const goLabel = h('span', { text: t('Запам\'ятати') });
        const goBtn = h('button', { class: 'btn primary' }, icon('face', 'sm'), goLabel);
        const d = h('div', { class: 'dialog enroll', role: 'dialog', 'aria-modal': 'true' },
            h('div', { class: 'dialog-head' },
                h('h2', { text: presetName ? t('Ще одне фото: {x}', { x: presetName }) : t('Додати людину') }),
                h('button', { class: 'icon-btn', 'aria-label': t('Закрити'), onclick: () => close() }, icon('x'))),
            h('div', { class: 'enroll-view' }, pv.el),
            presetName ? null : field(t('Ім\'я'), nameIn),
            msg,
            h('p', { class: 'tip' }, icon('alert', 'sm'), t('Порада: додайте 2–3 фото кожної людини — прямо, трохи збоку, в окулярах і без.')),
            h('div', { class: 'actions' }, goBtn));
        let timer = null, active = false;
        const close = overlay(d, {
            onClose: () => {
                pv.stop();
                clearTimeout(timer);
                if (active) api('api/faces/cancel', {}).catch(() => {});
                loadPeople();
            },
        });
        pv.start();
        pv.setRotate(S.camera.rotate || 0);
        goBtn.onclick = async () => {
            const name = nameIn.value.trim();
            if (!name) { msg.textContent = t('Вкажіть ім\'я.'); return nameIn.focus(); }
            try { await api('api/faces/enroll', { name }); } catch (e) { return showError(e); }
            active = true;
            goBtn.disabled = true;
            msg.textContent = ENROLL_TEXT.look;
            poll();
        };
        async function poll() {
            if (!d.isConnected) return;
            try {
                const [r, lv] = await Promise.all([api('api/faces'), api('api/faces/live')]);
                pv.setFaces(lv.age < 2000 ? lv.faces : [], false);
                const st = r.enroll.state;
                if (st === 'done') {
                    active = false;
                    toast(t('{x}: обличчя запам\'ятовано', { x: r.enroll.name }));
                    return close();
                }
                msg.textContent = ENROLL_TEXT[st] || ENROLL_TEXT.look;
                if (st !== 'look' && st !== 'many' && st !== 'far') {
                    active = false;
                    goBtn.disabled = false;
                    goLabel.textContent = t('Ще раз');
                    return;
                }
            } catch (e) { /* keep trying */ }
            timer = setTimeout(poll, 600);
        }
    }

    const facesCard = card('face', t('Обличчя'),
        noPartition,
        toggle(t('Розпізнавати обличчя'), t('Камера підписує знайомих у відео й запам\'ятовує, хто з\'являвся в кадрі. Працює, коли ви дивитеся відео або увімкнено охорону.'),
            () => S.faces && S.faces.enabled, v => ({ faces: { enabled: v } })),
        seg(t('Впізнавання'), t('Якщо камера плутає людей — оберіть «Суворе». Якщо часто не впізнає знайомих — «М\'яке».'),
            [[1, t('М\'яке')], [2, t('Звичайне')], [3, t('Суворе')]], () => S.faces && S.faces.accuracy, v => ({ faces: { accuracy: v } })),
        h('div', { class: 'set-row col' },
            h('div', { class: 'row' }, h('div', { class: 'txt grow' }, h('b', { text: t('Знайомі люди') }), peopleHint), addPersonBtn),
            people),
        h('p', { class: 'tip', style: { marginTop: '8px' } }, icon('lock', 'sm'), t('Фото облич зберігаються лише в пам\'яті камери й нікуди не надсилаються.')));

    // --- image
    const previewBox = h('div', { class: 'preview' });
    const sizeRow = select(t('Якість відео'), t('Вища якість — більше місця на карті та повільніше передається'), [
        [5, t('Низька · 320×240')], [8, t('Звичайна · 640×480')], [9, t('Хороша · 800×600')], [10, t('Висока · 1024×768')], [11, 'HD · 1280×720'], [13, '1600×1200'], [17, '2048×1536']],
        () => Math.min(S.camera.framesize, S.maxFramesize || 13), v => cam('framesize', v));
    // Offer only what the sensor can do (OV2640 up to 1600×1200, OV3660 up to 2048×1536)
    refreshers.push(() => {
        const max = S.maxFramesize || 13;
        for (const o of sizeRow.querySelectorAll('option')) {
            const v = +o.value;
            o.hidden = o.disabled = v > max;
            if (v >= 13) o.textContent = (v === max ? t('Максимальна') : t('Дуже висока')) + (v === 13 ? ' · 1600×1200' : ' · 2048×1536');
        }
    });
    const imgCard = card('image', t('Зображення'),
        previewBox,
        sizeRow,
        range(t('Чіткість'), null, 4, 40, 1, { ends: [t('Менші файли'), t('Більше деталей')] }, () => S.camera.quality, v => cam('quality', v), null,
            { to: q => 44 - q, from: v => 44 - v }),
        range(t('Яскравість'), null, -2, 2, 1, { ends: [t('Темніше'), t('Світліше')] }, () => S.camera.brightness, v => cam('brightness', v)),
        range(t('Контраст'), null, -2, 2, 1, { ends: [t('Менше'), t('Більше')] }, () => S.camera.contrast, v => cam('contrast', v)),
        range(t('Насиченість кольорів'), null, -2, 2, 1, { ends: [t('Блідіше'), t('Яскравіше')] }, () => S.camera.saturation, v => cam('saturation', v)),
        toggle(t('Віддзеркалити'), t('Поміняти ліву та праву сторони'), () => S.camera.hmirror, v => cam('hmirror', v)),
        toggle(t('Перевернути'), t('Якщо камера висить догори дриґом'), () => S.camera.vflip, v => cam('vflip', v)),
        seg(t('Поворот на екрані'), null, [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], () => S.camera.rotate, v => cam('rotate', v)),
        h('details', { class: 'fold' },
            h('summary', null, icon('chevron', 'sm'), t('Додаткові налаштування камери')),
            select(t('Ефект'), null, [[0, t('Без ефекту')], [1, t('Негатив')], [2, t('Чорно-білий')], [3, t('Червоний відтінок')], [4, t('Зелений відтінок')], [5, t('Синій відтінок')], [6, t('Сепія')]],
                () => S.camera.special, v => cam('special', v)),
            toggle(t('Автоматичний баланс білого'), t('Природні кольори за будь-якого освітлення'), () => S.camera.awb, v => cam('awb', v)),
            toggle(t('Підсилення балансу білого'), null, () => S.camera.awbGain, v => cam('awbGain', v)),
            select(t('Освітлення'), t('Підказка для балансу білого'), [[0, t('Автоматично')], [1, t('Сонячно')], [2, t('Хмарно')], [3, t('Офіс')], [4, t('Вдома')]],
                () => S.camera.wbMode, v => cam('wbMode', v), () => S.camera.awbGain),
            toggle(t('Автоматична експозиція'), t('Камера сама підбирає витримку'), () => S.camera.aec, v => cam('aec', v)),
            range(t('Рівень експозиції'), null, -2, 2, 1, { ends: [t('Темніше'), t('Світліше')] }, () => S.camera.aeLevel, v => cam('aeLevel', v), () => S.camera.aec),
            range(t('Витримка'), null, 0, 1200, 10, { ends: [t('Коротка'), t('Довга')] }, () => S.camera.aecValue, v => cam('aecValue', v), () => !S.camera.aec),
            toggle(t('Нічний режим експозиції'), t('Краще при слабкому світлі'), () => S.camera.aec2, v => cam('aec2', v)),
            toggle(t('Автоматичне підсилення'), null, () => S.camera.agc, v => cam('agc', v)),
            select(t('Межа підсилення'), t('Вище — світліше вночі, але більше шуму'), [[0, '2×'], [1, '4×'], [2, '8×'], [3, '16×'], [4, '32×'], [5, '64×'], [6, '128×']],
                () => S.camera.gainCeiling, v => cam('gainCeiling', v), () => S.camera.agc),
            range(t('Підсилення'), null, 0, 30, 1, { ends: ['0', '30'] }, () => S.camera.agcGain, v => cam('agcGain', v), () => !S.camera.agc),
            toggle(t('Корекція чорних точок'), null, () => S.camera.bpc, v => cam('bpc', v)),
            toggle(t('Корекція білих точок'), null, () => S.camera.wpc, v => cam('wpc', v)),
            toggle(t('Гамма-корекція'), null, () => S.camera.rawGma, v => cam('rawGma', v)),
            toggle(t('Корекція об\'єктива'), t('Вирівнює яскравість по краях кадру'), () => S.camera.lenc, v => cam('lenc', v)),
            toggle(t('Масштабування кадру (DCW)'), null, () => S.camera.dcw, v => cam('dcw', v)),
            h('div', { style: { paddingTop: '12px' } }, h('button', {
                class: 'btn block', onclick: async () => {
                    if (!await confirmDialog({ title: t('Скинути налаштування зображення?'), text: t('Буде повернено стандартні значення.'), ok: t('Скинути') })) return;
                    save({ camera: { framesize: 9, quality: 12, brightness: 0, contrast: 0, saturation: 0, special: 0, awb: true, awbGain: true, wbMode: 0, aec: true, aec2: false, aeLevel: 0, aecValue: 300, agc: true, agcGain: 0, gainCeiling: 2, bpc: false, wpc: true, rawGma: true, lenc: true, hmirror: false, vflip: false, dcw: true, rotate: 0 } });
                }
            }, icon('refresh', 'sm'), t('Скинути до стандартних')))));

    // --- Wi-Fi
    const wifiInfo = h('div', { class: 'stack' });
    const wifiCard = card('wifi', 'Wi-Fi', wifiInfo,
        h('button', { class: 'btn block', style: { marginTop: '14px' }, onclick: changeWifi }, t('Змінити мережу Wi-Fi')));
    function changeWifi() {
        const picker = wifiPicker();
        const err = h('div', { class: 'form-error hidden', role: 'alert' });
        const d = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
            h('div', { class: 'dialog-head' }, h('h2', { text: t('Нова мережа Wi-Fi') }), h('button', { class: 'icon-btn', 'aria-label': t('Закрити'), onclick: () => close() }, icon('x'))),
            picker.el, err,
            h('div', { class: 'actions' }, h('button', {
                class: 'btn primary', onclick: async () => {
                    const v = picker.value();
                    if (!v || !v.ssid) { err.textContent = t('Оберіть мережу.'); return err.classList.remove('hidden'); }
                    try {
                        await api('api/wifi', { ssid: v.ssid, password: v.password });
                        close();
                        confirmDialog({
                            title: t('Підключаємося…'),
                            text: t('Камера переходить на мережу «{x}». Якщо вийде, вона буде доступна за адресою {a} у новій мережі. Якщо ні — повернеться до старої мережі за хвилину.', { x: v.ssid, a: `http://${status ? status.wifi.host : ''}/` }),
                            ok: t('Зрозуміло'), cancel: t('Закрити')
                        });
                    } catch (e) { showError(e); }
                }
            }, t('Підключити'))));
        const close = overlay(d);
    }

    // --- remote
    const hostInput = h('input', { type: 'text', autocapitalize: 'off', autocomplete: 'off', spellcheck: false, placeholder: t('наприклад, cam.example.com'), 'aria-label': t('Адреса сервера') });
    const tokenInput = h('input', { type: 'password', autocomplete: 'off', 'aria-label': t('Код підключення') });
    const tokenHint = h('span');
    const remoteState = h('span', { class: 'pill' });
    const linkText = h('span', { class: 'mono' });
    const linkBox = h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('b', { class: 'grow', text: t('Ваше посилання') }), remoteState),
        h('div', { class: 'link-box' }, linkText,
            h('button', {
                class: 'icon-btn', 'aria-label': t('Скопіювати посилання'), onclick: () => {
                    copyText(linkText.textContent).then(ok => {
                        if (ok) return toast(t('Посилання скопійовано'));
                        selectText(linkText);
                        toast(t('Скопіюйте посилання вручну'), true);
                    });
                }
            }, icon('copy', 'sm')),
            h('a', { class: 'icon-btn', target: '_blank', rel: 'noopener', 'aria-label': t('Відкрити посилання'), href: '#' }, icon('link', 'sm'))),
        h('p', { class: 'tip' }, icon('lock', 'sm'), t('Відкрийте посилання на телефоні з будь-якого місця. Вхід — тим самим ім\'ям і паролем.')));
    refreshers.push(() => {
        if (document.activeElement !== hostInput) hostInput.value = S.remote.host;
        tokenInput.placeholder = S.remote.tokenSet ? t('••••••••  (збережено)') : t('Код від адміністратора сервера');
        tokenHint.textContent = S.remote.tokenSet ? t('Код збережено. Щоб змінити, введіть новий.') : t('Без коду сервер не прийме камеру');
        linkBox.classList.toggle('hidden', !S.remote.enabled);
    });
    const remoteCard = card('globe', t('Віддалений доступ'),
        toggle(t('Доступ через інтернет'), t('Дивитися камеру, коли ви не вдома'), () => S.remote.enabled, v => ({ remote: { enabled: v } })),
        h('div', { class: 'set-row col' },
            h('div', { class: 'txt' }, h('b', { text: t('Сервер') }), h('span', { text: t('Ваш сервер, через який камера стає доступною з інтернету') })),
            h('div', { class: 'row' }, hostInput, h('button', { class: 'btn', onclick: () => save({ remote: { host: hostInput.value.trim() } }) }, t('Зберегти')))),
        h('div', { class: 'set-row col' },
            h('div', { class: 'txt' }, h('b', { text: t('Код підключення') }), tokenHint),
            h('div', { class: 'row' }, tokenInput, h('button', {
                class: 'btn', onclick: async () => {
                    if (!tokenInput.value.trim()) return;
                    await save({ remote: { token: tokenInput.value.trim() } });
                    tokenInput.value = '';
                }
            }, t('Зберегти')))),
        linkBox,
        h('details', { class: 'fold' },
            h('summary', null, icon('chevron', 'sm'), t('Додатково')),
            toggle(t('Захищене з\'єднання (HTTPS)'), t('Не вимикайте: без нього відео та паролі йдуть інтернетом відкрито'), () => S.remote.tls, v => ({ remote: { tls: v } })),
            toggle(t('Не перевіряти сертифікат сервера'), t('Небезпечно: лише для власного сертифіката'), () => S.remote.insecure, v => ({ remote: { insecure: v } }), () => S.remote.tls),
            h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', { text: t('Нове посилання') }), h('span', { text: t('Старе посилання перестане працювати') })),
                h('button', {
                    class: 'btn', onclick: async () => {
                        if (!await confirmDialog({ title: t('Створити нове посилання?'), text: t('Старе посилання перестане працювати. Усім, з ким ви ним ділилися, доведеться надіслати нове.'), ok: t('Створити') })) return;
                        try { await api('api/remote/new-id', {}); S = await api('api/settings'); refresh(); shellApi.poll(); toast(t('Нове посилання створено')); } catch (e) { showError(e); }
                    }
                }, t('Створити')))));

    // --- account
    const curPw = passwordInput({ autocomplete: 'current-password' });
    const newUser = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off' });
    const newPw = passwordInput({ autocomplete: 'new-password' });
    const newPw2 = passwordInput({ autocomplete: 'new-password' });
    const accErr = h('div', { class: 'form-error hidden', role: 'alert' });
    const accountCard = card('user', t('Обліковий запис'),
        h('details', { class: 'fold', style: { borderTop: 0, marginTop: 0 } },
            h('summary', { style: { paddingTop: '0' } }, icon('chevron', 'sm'), t('Змінити ім\'я або пароль')),
            h('form', {
                class: 'stack', style: { paddingTop: '10px' }, onsubmit: async e => {
                    e.preventDefault();
                    accErr.classList.add('hidden');
                    const fail = m => { accErr.textContent = m; accErr.classList.remove('hidden'); };
                    if (newPw.input.value.length < 8) return fail(t('Новий пароль має містити щонайменше 8 символів.'));
                    if (newPw.input.value !== newPw2.input.value) return fail(t('Нові паролі не збігаються.'));
                    try {
                        await api('api/account', { current: curPw.input.value, user: newUser.value.trim(), password: newPw.input.value });
                        [curPw.input, newPw.input, newPw2.input].forEach(i => { i.value = ''; });
                        toast(t('Пароль змінено'));
                    } catch (ex) { fail(ex.message); }
                }
            },
                field(t('Поточний пароль'), curPw.el),
                field(t('Ім\'я користувача'), newUser),
                field(t('Новий пароль'), newPw.el),
                field(t('Повторіть новий пароль'), newPw2.el),
                accErr,
                h('p', { class: 'faint', text: t('Після зміни інші пристрої мають увійти знову.') }),
                h('button', { class: 'btn primary', type: 'submit' }, t('Зберегти')))),
        h('div', { class: 'row wrap', style: { marginTop: '16px' } },
            h('button', { class: 'btn grow', onclick: async () => { await api('api/logout', {}).catch(() => {}); stopAll(); boot(); } }, icon('logout', 'sm'), t('Вийти')),
            h('button', {
                class: 'btn ghost grow', onclick: async () => {
                    if (!await confirmDialog({ title: t('Вийти на всіх пристроях?'), text: t('Усім телефонам і комп\'ютерам доведеться увійти знову.'), ok: t('Вийти всюди') })) return;
                    await api('api/logout-all', {}).catch(() => {});
                    stopAll();
                    boot();
                }
            }, t('Вийти на всіх пристроях'))));

    // Logged-in devices and the login history
    const devList = h('div', { class: 'login-list' });
    const histList = h('div', { class: 'login-list' });
    const devicesCard = card('chip', t('Пристрої, де виконано вхід'), devList,
        h('p', { class: 'tip', style: { marginTop: '14px' } }, icon('lock', 'sm'), t('Не впізнаєте пристрій? Натисніть «Вийти» біля нього і змініть пароль.')));
    const historyCard = card('clock', t('Історія входів'), histList);
    let loginsSeq = null;
    async function loadLogins() {
        loginsSeq = status ? status.logins : null;
        try {
            const r = await api('api/logins');
            devList.replaceChildren(...r.sessions.map(e => loginRow(e, {
                current: e.current,
                action: e.current ? null : h('button', {
                    class: 'btn ghost', onclick: async () => {
                        if (!await confirmDialog({ title: t('Вийти на цьому пристрої?'), text: t('На пристрої {d} доведеться увійти знову.', { d: e.dev || t('Невідомий пристрій') }), ok: t('Вийти') })) return;
                        try { await api('api/logins/end', { id: e.id }); toast(t('Пристрій вийшов з камери')); } catch (ex) { showError(ex); }
                        loadLogins();
                    }
                }, icon('logout', 'sm'), t('Вийти')),
            })));
            histList.replaceChildren(...(r.history.length ? r.history.map(e => loginRow(e)) :
                [h('p', { class: 'muted small', text: t('Входів ще не було.') })]));
        } catch (e) { showError(e); }
    }
    const accountSection = h('div', { class: 'stack' }, accountCard, devicesCard, historyCard);

    // --- device
    const nameInput = h('input', { type: 'text', maxLength: 40, 'aria-label': t('Назва камери') });
    let nameTimer;
    const saveName = () => {
        clearTimeout(nameTimer);
        const v = nameInput.value.trim();
        if (v && S && v !== S.name) save({ name: v }).then(() => shellApi.poll());
    };
    // Saves a moment after typing stops, and when leaving the field
    nameInput.addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(saveName, 1000); });
    nameInput.addEventListener('change', saveName);
    refreshers.push(() => { if (document.activeElement !== nameInput) nameInput.value = S.name; });
    const sdInfo = h('div', { class: 'txt' });
    const fwInfo = h('div', { class: 'txt' });
    const sysInfo = h('p', { class: 'faint small' });
    const clockInfo = h('span');
    const fwFile = h('input', { type: 'file', accept: '.bin', class: 'hidden', onchange: () => fwFile.files[0] && uploadFirmware(fwFile.files[0]) });
    const deviceCard = card('chip', t('Пристрій'),
        h('div', { class: 'set-row col' }, h('div', { class: 'txt' }, h('b', { text: t('Назва камери') }), h('span', { text: t('Наприклад, «Подвір\'я» або «Вхідні двері»') })), nameInput),
        themeRow(),
        h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', { text: t('Мова') }), h('span', { text: t('Мова цієї сторінки на цьому пристрої') })), langSwitch()),
        select(t('Часовий пояс'), null, [
            ['EET-2EEST,M3.5.0/3,M10.5.0/4', t('Київ')],
            ['CET-1CEST,M3.5.0,M10.5.0/3', t('Варшава, Берлін')],
            ['GMT0BST,M3.5.0/1,M10.5.0', t('Лондон')],
            ['EST5EDT,M3.2.0,M11.1.0', t('Нью-Йорк')],
            ['UTC0', 'UTC']], () => S.tz, v => ({ tz: v })),
        row(t('Час на камері'), null, clockInfo),
        h('div', { class: 'set-row' }, sdInfo, h('button', {
            class: 'btn danger', onclick: async () => {
                if (!await confirmDialog({ title: t('Видалити всі записи?'), text: t('Усі відео з карти пам\'яті буде видалено назавжди.'), ok: t('Видалити все'), danger: true })) return;
                try {
                    const r = await api('api/rec/clear', {});
                    let n = r.deleted;
                    if (r.queued) {
                        // The camera deletes in the background: wait until it's done
                        toast(t('Записи видаляються…'));
                        for (let i = 0; i < 600; i++) {
                            await sleep(1000);
                            const st = await api('api/status');
                            n = st.sd.cleared;
                            if (!st.sd.clearing) break;
                        }
                    }
                    toast(t('Видалено {n} {u}', { n, u: pl(n, 'rec') }));
                    recEvents.dispatchEvent(new CustomEvent('changed'));
                    shellApi.poll();
                } catch (e) { showError(e); }
            }
        }, icon('trash', 'sm'), t('Очистити'))),
        h('div', { class: 'set-row' }, fwInfo, fwFile, h('button', { class: 'btn', onclick: () => fwFile.click() }, icon('upload', 'sm'), t('Оновити'))),
        h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', { text: t('Перезавантажити камеру') }), h('span', { text: t('Займає близько 15 секунд') })),
            h('button', {
                class: 'btn', onclick: async () => {
                    if (!await confirmDialog({ title: t('Перезавантажити камеру?'), ok: t('Перезавантажити') })) return;
                    try { await api('api/reboot', {}); waitForRestart(t('Камера перезавантажується…')); } catch (e) { showError(e); }
                }
            }, icon('power', 'sm'), t('Перезавантажити'))),
        h('p', { class: 'tip', style: { marginTop: '10px' } }, icon('alert', 'sm'), t('Забули пароль? Натисніть кнопку RST на камері тричі поспіль — вона на 15 хвилин увімкне власну мережу Wi-Fi, де можна задати новий пароль. Записи збережуться, а обличчя, входи й посилання для віддаленого доступу буде скинуто.')),
        sysInfo);

    function themeRow() {
        const btns = THEMES.map(([id, label, bg, accent]) => h('button', {
            type: 'button', class: 'swatch', title: label, 'aria-label': label,
            onclick: () => { applyTheme(id); info.theme = id; save({ theme: id }); },
        }, h('span', { class: 'swatch-dot', style: { background: `linear-gradient(135deg, ${bg} 0 50%, ${accent} 50% 100%)` } }), h('span', { text: label })));
        refreshers.push(() => btns.forEach((b, i) => {
            const on = (S.theme || 'purple') === THEMES[i][0];
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
        }));
        return h('div', { class: 'set-row col' },
            h('div', { class: 'txt' }, h('b', { text: t('Оформлення') }), h('span', { text: t('Кольори сторінки на всіх телефонах і комп\'ютерах') })),
            h('div', { class: 'swatches', role: 'group', 'aria-label': t('Оформлення') }, btns));
    }

    async function uploadFirmware(file) {
        try {
            if (!await ensureConfirmed()) { fwFile.value = ''; return; }
        } catch (e) { fwFile.value = ''; return showError(e); }
        const bar = h('div');
        const label = h('p', { class: 'muted', text: t('Завантаження…') });
        const d = h('div', { class: 'dialog' }, h('h2', { text: t('Оновлення прошивки') }), label, h('div', { class: 'progress', style: { marginTop: '14px' } }, bar),
            h('p', { class: 'faint', style: { marginTop: '12px' }, text: t('Не вимикайте камеру й не закривайте сторінку.') }));
        const close = overlay(d);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'api/update');
        xhr.setRequestHeader('X-Requested-With', 'cam');
        xhr.upload.onprogress = e => { if (e.lengthComputable) bar.style.width = (e.loaded / e.total) * 100 + '%'; };
        xhr.onload = () => {
            fwFile.value = '';
            if (xhr.status === 200) {
                close();
                waitForRestart(t('Прошивку оновлено. Камера перезавантажується…'));
            } else {
                label.textContent = t('Не вдалося оновити: файл не підходить або пошкоджений.');
                d.append(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, t('Закрити'))));
            }
        };
        xhr.onerror = () => {
            fwFile.value = '';
            label.textContent = t('З\'єднання перервалося.');
            d.append(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, t('Закрити'))));
        };
        const fd = new FormData();
        fd.append('firmware', file, file.name);
        xhr.send(fd);
    }

    const sections = [
        ['security', 'shield', t('Охорона'), secCard],
        info.faces ? ['faces', 'face', t('Обличчя'), facesCard] : null,
        ['image', 'image', t('Зображення'), imgCard],
        ['wifi', 'wifi', 'Wi-Fi', wifiCard],
        ['remote', 'globe', t('Віддалений доступ'), remoteCard],
        ['account', 'user', t('Обліковий запис'), accountSection],
        ['device', 'chip', t('Пристрій'), deviceCard],
    ].filter(Boolean);
    let shown = localStorageGet('settingsSection');
    if (!sections.some(s => s[0] === shown)) shown = 'security';
    const navBtns = sections.map(([id, ic, label]) => h('button', { type: 'button', class: 'set-tab', onclick: () => show(id) }, icon(ic, 'sm'), label));
    nav.append(...navBtns);
    function show(id) {
        shown = id;
        localStorageSet('settingsSection', id);
        sections.forEach(([sid], i) => {
            const on = sid === id;
            navBtns[i].classList.toggle('on', on);
            if (on) navBtns[i].setAttribute('aria-current', 'true'); else navBtns[i].removeAttribute('aria-current');
        });
        panel.replaceChildren(sections.find(s => s[0] === id)[3]);
        replay(panel, 'panel-in');
        if (id === 'faces' && S) loadPeople();
        if (id === 'account' && S) loadLogins();
        // The live preview only runs while the picture settings are open
        if (preview) {
            if (id === 'image' && !el.classList.contains('hidden')) preview.start(); else preview.stop();
        }
    }
    show(shown);

    function updateStatus(st) {
        if (!S) return;
        wifiInfo.replaceChildren(
            h('div', { class: 'stat' }, h('div', { class: 'grow' }, h('div', { class: 'faint', text: t('Мережа') }), h('div', { class: 'value', text: st.wifi.connected ? st.wifi.ssid : t('Не підключено') })),
                st.wifi.connected ? h('span', { class: 'row small muted' }, signalBars(st.wifi.rssi), signalText(st.wifi.rssi)) : null),
            st.wifi.connected ? h('div', null, h('div', { class: 'faint', text: t('Адреса камери вдома') }),
                h('div', { class: 'value mono', text: `http://${st.wifi.ip}/` }),
                h('div', { class: 'faint small', text: t('або {x}', { x: `http://${st.wifi.host}/` }) })) : null,
            S.apPassword ? h('div', null, h('div', { class: 'faint', text: t('Власна мережа камери') }),
                h('div', { class: 'value', text: S.apSsid }),
                h('div', { class: 'small muted' }, t('Пароль: '), h('span', { class: 'mono', text: S.apPassword })),
                h('p', { class: 'tip', style: { marginTop: '8px' } }, icon('wifi', 'sm'), t('Камера вмикає цю мережу, коли не може підключитися до домашньої. Запишіть пароль: він знадобиться, щоб змінити мережу Wi-Fi без домашнього інтернету.'))) : null);
        remoteState.className = 'pill ' + (st.remote.state === 'online' ? 'ok' : st.remote.state.startsWith('error') || st.remote.state === 'unreachable' ? 'bad' : 'warn');
        remoteState.replaceChildren(h('span', { class: 'dot' }), remoteStateText(st.remote.state));
        linkText.textContent = st.remote.url;
        linkBox.querySelector('a').href = /^https?:\/\//.test(st.remote.url) ? st.remote.url : '#';
        newUser.placeholder = info.user || '';
        if (!newUser.value && info.user) newUser.value = info.user;
        sdInfo.replaceChildren(h('b', { text: t('Карта пам\'яті') }),
            h('span', { text: st.sd.ok ? t('Зайнято {a} з {b}', { a: fmtGB(st.sd.used), b: fmtGB(st.sd.total) }) : t('Не вставлено') }));
        fwInfo.replaceChildren(h('b', { text: t('Прошивка') }), h('span', { text: t('Версія {x}. Оберіть файл firmware.bin, щоб оновити.', { x: st.fw }) }));
        clockInfo.textContent = st.clock ? new Date(st.time * 1000).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) : t('Не встановлено');
        clockInfo.className = 'muted small';
        sysInfo.textContent = t('Працює {u} · Вільна пам\'ять {h} КБ / {p} КБ · {w}×{hh}, {f} кадр/с', { u: fmtDur(st.uptime), h: Math.round(st.heap / 1024), p: Math.round(st.psram / 1024), w: st.width, hh: st.height, f: st.fps.toFixed(1) });
        if (preview) preview.setRotate(S.camera.rotate || 0);
        if (shown === 'account' && st.logins !== loginsSeq && !el.classList.contains('hidden')) loadLogins();
    }

    async function enter() {
        // The home page's "Усі" opens a section
        const want = localStorageGet('settingsSection');
        if (want !== shown && sections.some(x => x[0] === want)) show(want);
        try {
            S = await api('api/settings');
            refresh();
            loginsSeq = null;
            if (status) updateStatus(status);
            if (shown === 'faces') loadPeople();
            if (shown === 'account' && !status) loadLogins();
        } catch (e) { showError(e); }
        if (!preview) {
            preview = liveView({ fps: 5 });
            previewBox.append(preview.el);
            preview.el.style.aspectRatio = 'auto';
            preview.el.style.position = 'absolute';
            preview.el.style.inset = '0';
        }
        if (shown === 'image') preview.start();
    }

    return {
        el,
        enter,
        leave() { if (preview) preview.stop(); },
        update: updateStatus,
    };
}

async function waitForRestart(msg) {
    stopAll();
    const app = document.getElementById('app');
    app.replaceChildren(h('div', { class: 'auth-page' }, h('div', { class: 'card auth-card center stack' },
        h('div', { class: 'spinner', style: { margin: '0 auto' } }), h('h2', { text: msg }), h('p', { class: 'muted', text: t('Сторінка оновиться сама.') }))));
    await sleep(5000);
    for (let i = 0; i < 60; i++) {
        try {
            await api('api/state', undefined, { noAuthRedirect: true });
            location.reload();
            return;
        } catch (e) {
            await sleep(2000);
        }
    }
    location.reload();
}

boot();
