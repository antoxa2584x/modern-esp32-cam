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
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    if (req.url === '/api/login') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end('{"error":"wrong"}');
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

    const relay = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: data, RELAY_TOKEN: TOKEN }, stdio: 'ignore' });
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
                'X-Forwarded-For': '1.2.3.4', 'CF-Connecting-IP': '1.2.3.4', Authorization: 'Basic eA==', 'X-Custom': 'y',
            },
        });
        check('site cookies are not forwarded to the camera', lastRequestHeaders.cookie === 'sid=abc123', lastRequestHeaders.cookie);
        check('proxy/auth/custom headers are not forwarded',
            !lastRequestHeaders['x-forwarded-for'] && !lastRequestHeaders['cf-connecting-ip'] && !lastRequestHeaders.authorization && !lastRequestHeaders['x-custom']);

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
            const res = await request('POST', `/cam/${ID}/api/login`, { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: '{}' });
            statuses.push(res.status);
        }
        check('login attempts limited to 10 per 15 min per address', statuses.slice(0, 10).every(s => s === 403) && statuses.slice(10).every(s => s === 429), statuses.join(','));
        const other = await request('POST', `/cam/${ID}/api/login`, { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '8.8.8.8' }, body: '{}' });
        check('other addresses are not affected', other.status === 403, String(other.status));
        reg.ws.close();

        // 8. Connection flood from one address is cut off
        const results = [];
        for (let i = 0; i < 25; i++) results.push(await connectCamera({ 'X-Cam-Id': 'flood' + i + 'aaaa', 'X-Cam-Key': KEY, 'CF-Connecting-IP': '7.7.7.7' }));
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
