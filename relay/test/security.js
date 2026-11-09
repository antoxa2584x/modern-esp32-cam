'use strict';
// Security checks for the relay: starts a real relay plus a fake camera that
// misbehaves on purpose, then probes what a browser and an attacker would see.
//   node relay/test/security.js

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 3941, CAM_PORT = 3942;
const TOKEN = 'test-registration-code-123';
const ID = 'secur1ty00';
const KEY = 'fake-camera-key-0123456789abcdef';
const UI_KEY = 'test-ui-signing-key';
const CF = '173.245.48.1'; // a Cloudflare address, as nginx would pass it in X-Real-IP
const sleep = ms => new Promise(r => setTimeout(r, ms));
const crypto = require('crypto');
const sign = (type, body) => crypto.createHmac('sha256', UI_KEY).update(type + '\n').update(body).digest('hex');

let failed = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) failed++;
}

function request(method, p, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function connectCamera(headers) {
    return new Promise(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/cam-relay/ws`, { headers });
        let first = null;
        ws.on('message', (m, bin) => { if (!bin && !first) { first = JSON.parse(m); resolve({ ws, msg: first }); } });
        ws.on('unexpected-response', (req, res) => resolve({ ws, status: res.statusCode }));
        ws.on('error', () => {});
        ws.on('close', () => { if (!first) resolve({ ws, msg: null }); });
    });
}

// A camera that tries to set dangerous headers, and records what it receives
let lastRequestHeaders = null;
const cam = http.createServer((req, res) => {
    lastRequestHeaders = req.headers;
    if (req.url === '/api/evil') {
        res.writeHead(302, {
            'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'site_admin=stolen; Domain=example.com; Path=/', 'sid=x; Domain=.example.com; Path=/'],
            'Strict-Transport-Security': 'max-age=1; includeSubDomains',
            'Access-Control-Allow-Origin': '*',
            'Service-Worker-Allowed': '/',
            'Clear-Site-Data': '"*"',
            'Location': 'https://evil.example/phish',
            'Content-Type': 'text/html',
        });
        return res.end('evil');
    }
    if (req.url.startsWith('/api/login')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end('{"error":"wrong"}');
    }
    // Page files: one signed as the build would, one a fake camera made up
    if (req.url === '/app.js') {
        const body = 'console.log("genuine")';
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'X-UI-Sig': sign('application/javascript', body) });
        return res.end(body);
    }
    if (req.url === '/evil.js' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html' : 'application/javascript', 'X-UI-Sig': 'ab'.repeat(32) });
        return res.end('<script>steal()</script>');
    }
    if (req.url === '/api/page') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<script>steal()</script>');
    }
    if (req.url === '/stream') {
        // Like port 81: video only with a valid session
        if (req.headers.cookie !== 'sid=viewer') {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            return res.end('login required');
        }
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
        const t = setInterval(() => res.write('--frame\r\n'), 200);
        return res.on('close', () => clearInterval(t));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
}).listen(CAM_PORT);

// Tunnel client, like src/remote.cpp
function serveTunnel(ws) {
    const streams = new Map();
    const frame = (t, id, p) => ws.send(p ? Buffer.concat([Buffer.from([t, id >> 8, id & 255]), p]) : Buffer.from([t, id >> 8, id & 255]));
    ws.on('message', (d, bin) => {
        if (!bin) return;
        const t = d[0], id = (d[1] << 8) | d[2];
        if (t === 1) {
            const s = net.connect(CAM_PORT, '127.0.0.1');
            streams.set(id, s);
            s.on('data', c => frame(2, id, c));
            s.on('close', () => { if (streams.delete(id)) frame(3, id); });
            s.on('error', () => {});
        } else if (t === 2) streams.get(id)?.write(d.subarray(3));
        else if (t === 3) { streams.get(id)?.destroy(); streams.delete(id); }
    });
}

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));

    // 1. Refuses to run as an open relay
    const open = spawnSync(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: data, RELAY_TOKEN: '' }, timeout: 5000 });
    check('refuses to start without RELAY_TOKEN', open.status === 1, `exit ${open.status}`);

    const relay = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: data, RELAY_TOKEN: TOKEN, UI_SIGN_KEY: UI_KEY, UI_SIGN_ENFORCE: '1' }, stdio: 'ignore' });
    await sleep(800);
    try {
        // 2. Registration needs the code
        let r = await connectCamera({ 'X-Cam-Id': ID, 'X-Cam-Key': KEY });
        check('camera without code is rejected', r.msg && r.msg.code === 'token', JSON.stringify(r.msg));
        r = await connectCamera({ 'X-Cam-Id': ID, 'X-Cam-Key': KEY, 'X-Cam-Token': 'wrong' });
        check('camera with wrong code is rejected', r.msg && r.msg.code === 'token', JSON.stringify(r.msg));
        const good = await connectCamera({ 'X-Cam-Id': ID, 'X-Cam-Key': KEY, 'X-Cam-Token': TOKEN });
        check('camera with the code is accepted', good.msg && good.msg.t === 'ok', JSON.stringify(good.msg));
        serveTunnel(good.ws);

        // 3. Someone else can't take over the id
        r = await connectCamera({ 'X-Cam-Id': ID, 'X-Cam-Key': 'another-key-0123456789abcdef', 'X-Cam-Token': TOKEN });
        check('other key cannot take an existing id', r.msg && r.msg.code === 'taken', JSON.stringify(r.msg));

        // 4. Malicious response headers are cleaned
        const evil = await request('GET', `/cam/${ID}/api/evil`, { headers: { 'X-Forwarded-Proto': 'https' } });
        const cookies = evil.headers['set-cookie'] || [];
        check('only sid cookies pass (site cookie dropped)', cookies.length > 0 && cookies.every(c => c.startsWith('sid=')), JSON.stringify(cookies));
        check('cookie locked to the camera path', cookies.every(c => c.includes(`Path=/cam/${ID}/`) && !/domain=/i.test(c)), JSON.stringify(cookies));
        check('cookie is HttpOnly, Secure, SameSite=Strict', cookies.every(c => /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Strict/.test(c)));
        check('camera cannot set HSTS', !evil.headers['strict-transport-security']);
        check('camera cannot set CORS / service-worker / clear-site-data',
            !evil.headers['access-control-allow-origin'] && !evil.headers['service-worker-allowed'] && !evil.headers['clear-site-data']);
        check('redirect to another site is neutralised', evil.headers.location === `/cam/${ID}/`, evil.headers.location);
        check('security headers added (CSP, no framing, no referrer)',
            /frame-ancestors 'none'/.test(evil.headers['content-security-policy'] || '') && evil.headers['x-frame-options'] === 'DENY' && evil.headers['referrer-policy'] === 'no-referrer');

        // 5. Only the camera's own cookie and safe headers reach the camera
        await request('GET', `/cam/${ID}/x`, {
            headers: {
                Cookie: '_ga=GA1.1; site_admin=secret; sid=abc123; other=1',
                'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': CF, 'CF-Connecting-IP': '1.2.3.4', Authorization: 'Basic eA==', 'X-Custom': 'y',
                'X-Client-Ip': '6.6.6.6', 'X-Client-Place': 'Fake', 'CF-IPCountry': 'UA', 'CF-IPCity': 'Kyiv',
            },
        });
        check('site cookies are not forwarded to the camera', lastRequestHeaders.cookie === 'sid=abc123', lastRequestHeaders.cookie);
        check('proxy/auth/custom headers are not forwarded',
            !lastRequestHeaders['x-forwarded-for'] && !lastRequestHeaders['cf-connecting-ip'] && !lastRequestHeaders.authorization && !lastRequestHeaders['x-custom']);
        check('visitor address and place come from the relay, not the browser',
            lastRequestHeaders['x-client-ip'] === '1.2.3.4' && lastRequestHeaders['x-client-place'] === encodeURIComponent('Kyiv, UA'),
            `${lastRequestHeaders['x-client-ip']} ${lastRequestHeaders['x-client-place']}`);

        // 5b. Only Cloudflare may name the visitor
        await request('GET', `/cam/${ID}/x`, { headers: { 'X-Real-IP': '5.5.5.5', 'CF-Connecting-IP': '1.2.3.4' } });
        check('a visitor address claimed by a non-Cloudflare client is ignored', lastRequestHeaders['x-client-ip'] === '5.5.5.5', lastRequestHeaders['x-client-ip']);

        // 5c. Fake page files are refused, signed ones pass
        const genuine = await request('GET', `/cam/${ID}/app.js`);
        check('signed page file is served', genuine.status === 200 && genuine.body.includes('genuine'), String(genuine.status));
        const fake = await request('GET', `/cam/${ID}/evil.js`);
        const fakeIndex = await request('GET', `/cam/${ID}/`);
        check('unsigned page files are refused', fake.status === 502 && !fake.body.includes('steal') && fakeIndex.status === 502 && !fakeIndex.body.includes('steal'), `${fake.status} ${fakeIndex.status}`);
        const apiPage = await request('GET', `/cam/${ID}/api/page`);
        check('API answers are sandboxed (no scripts on this origin)', /(^|;\s*)sandbox(;|$)/.test(apiPage.headers['content-security-policy'] || ''), apiPage.headers['content-security-policy']);
        check('signed page files are not sandboxed', !/sandbox/.test(genuine.headers['content-security-policy'] || ''));

        // 5d. Paths the camera would decode differently are refused
        for (const bad of ['/api/%6cogin', '/api//login', '/api/./login', '/api/x/../login', '/api\\login']) {
            const r2 = await request('POST', `/cam/${ID}${bad}`, { headers: { 'Content-Type': 'application/json' }, body: '{}' });
            check(`encoded path ${bad} is refused`, r2.status === 404, String(r2.status));
        }

        // 5e. A stranger can't push the owner's live view out
        const watch = () => new Promise(resolve => {
            const r2 = http.get({ host: '127.0.0.1', port: PORT, path: `/cam/${ID}/stream`, headers: { Cookie: 'sid=viewer' } }, res => resolve({ req: r2, res }));
        });
        const v1 = await watch(), v2 = await watch();
        const v1Data = () => new Promise(resolve => { v1.res.once('data', () => resolve(true)); setTimeout(() => resolve(false), 1000); });
        await sleep(11000); // the relay only replaces viewers that have watched a while
        const strangers = [];
        for (let i = 0; i < 3; i++) strangers.push(await request('GET', `/cam/${ID}/stream`));
        check('streams without a login are refused', strangers.every(x => x.status === 401), strangers.map(x => x.status).join(','));
        check('and the owner keeps watching', await v1Data() && !v1.res.destroyed);
        v1.req.destroy();
        v2.req.destroy();
        await sleep(300);

        // 6. Offline and unknown cameras look the same (no id probing)
        const unknown = await request('GET', '/cam/zzzzzzzzzz/');
        good.ws.close();
        await sleep(300);
        const offline = await request('GET', `/cam/${ID}/`);
        check('unknown and offline ids answer identically', unknown.status === offline.status && unknown.body === offline.body, `${unknown.status} vs ${offline.status}`);
        const reg = await connectCamera({ 'X-Cam-Id': ID, 'X-Cam-Key': KEY, 'X-Cam-Token': TOKEN });
        serveTunnel(reg.ws);

        // 7. Password guessing is rate limited per address
        let statuses = [];
        for (let i = 0; i < 12; i++) {
            const res = await request('POST', `/cam/${ID}/api/login${i % 2 ? '/x' : ''}`, { headers: { 'Content-Type': 'application/json', 'X-Real-IP': CF, 'CF-Connecting-IP': '9.9.9.9' }, body: '{}' });
            statuses.push(res.status);
        }
        check('login attempts (also /api/login/...) limited to 10 per 15 min per address', statuses.slice(0, 10).every(s => s === 403) && statuses.slice(10).every(s => s === 429), statuses.join(','));
        const other = await request('POST', `/cam/${ID}/api/login`, { headers: { 'Content-Type': 'application/json', 'X-Real-IP': CF, 'CF-Connecting-IP': '8.8.8.8' }, body: '{}' });
        const spoof = await request('POST', `/cam/${ID}/api/login`, { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '6.6.6.6' }, body: '{}' });
        check('a made-up CF-Connecting-IP does not buy new tries', spoof.status === 403 || spoof.status === 429, String(spoof.status));
        check('other addresses are not affected', other.status === 403, String(other.status));
        reg.ws.close();

        // 8. Connection flood from one address is cut off
        const results = [];
        for (let i = 0; i < 25; i++) results.push(await connectCamera({ 'X-Cam-Id': 'flood' + i + 'aaaa', 'X-Cam-Key': KEY, 'X-Real-IP': CF, 'CF-Connecting-IP': '7.7.7.7' }));
        check('camera connection flood gets 429', results.slice(20).every(x => x.status === 429), results.map(x => x.status || x.msg?.code).join(','));
        results.forEach(x => x.ws.terminate());
    } finally {
        relay.kill();
        cam.close();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
})();
