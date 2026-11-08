import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, TEST_COOLDOWN_MS } from '../server/index.mjs';
import { buildNotification } from '../server/messages.mjs';
import { b64u } from '../server/webpush.mjs';

function fakeRouter() {
  const routes = new Map();
  const add = (method) => (route, fn) => routes.set(`${method} ${route}`, fn);
  return { routes, get: add('GET'), post: add('POST') };
}

async function call(router, method, route, { user, body, params = {}, query = {} } = {}) {
  const fn = router.routes.get(`${method} ${route}`);
  assert.ok(fn, `route ${method} ${route}`);
  const response = {
    statusCode: 200, body: undefined, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
  };
  await fn({ user, body, params, query, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X)' }, response);
  return response;
}

function subscription(host = 'web.push.apple.com') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: `https://${host}/${crypto.randomBytes(8).toString('hex')}`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
}

async function setup(t, { version = '1.19.0', fetchImpl, loopback, inProcess = false, routerModuleUrl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgml-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDirectory = path.join(root, 'app');
  fs.mkdirSync(appDirectory);
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'sillytavern', version }));
  const dataRoot = path.join(root, 'data');
  const user = (handle) => ({ profile: { handle }, directories: { root: path.join(dataRoot, handle) } });
  let clock = 1_000_000;
  const sent = [];
  const router = fakeRouter();
  await init(router, {
    appDirectory, dataRoot,
    fetchImpl: fetchImpl || (async (url, init2) => { sent.push({ url, init: init2 }); return { status: 201 }; }),
    loopback,
    now: () => clock,
    inProcess,
    routerModuleUrl,
  });
  return { router, dataRoot, user, sent, advance: (ms) => { clock += ms; } };
}

test('starts on an untested SillyTavern version with a warning', async (t) => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { router, user } = await setup(t, { version: '1.20.0' });
    assert.equal((await call(router, 'GET', '/push/public-key', { user: user('alice') })).statusCode, 200);
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some(line => /1\.20\.0 has not been tested/.test(line)));
});

test('creates a private VAPID key and serves only the public half', async (t) => {
  const { router, dataRoot } = await setup(t);
  const file = path.join(dataRoot, '_di-bgmessage-live', 'vapid.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const response = await call(router, 'GET', '/push/public-key');
  assert.deepEqual(response.body, { ok: true, publicKey: stored.publicKey });
  assert.ok(!JSON.stringify(response.body).includes(stored.privateKey));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('user routes require a logged-in user', async (t) => {
  const { router } = await setup(t);
  for (const [method, route] of [['GET', '/push/status'], ['POST', '/push/subscribe'], ['POST', '/push/unsubscribe'], ['POST', '/push/test']]) {
    const response = await call(router, method, route, {});
    assert.equal(response.statusCode, 401, route);
    assert.deepEqual(response.body, { ok: false, error: { code: 'NOT_LOGGED_IN' } });
  }
});

test('subscriptions are validated, stored per user and isolated', async (t) => {
  const { router, user, dataRoot } = await setup(t);
  const bad = await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: subscription('evil.test') } });
  assert.equal(bad.statusCode, 400);
  const sub = subscription();
  const ok = await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: sub } });
  assert.deepEqual(ok.body, { ok: true, count: 1 });
  const again = await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: sub } });
  assert.equal(again.body.count, 1, 'same endpoint is not duplicated');
  const alice = await call(router, 'GET', '/push/status', { user: user('alice') });
  assert.equal(alice.body.count, 1);
  assert.equal(alice.body.devices[0].device, 'iOS');
  assert.equal(alice.body.devices[0].service, 'web.push.apple.com');
  assert.ok(!JSON.stringify(alice.body).includes(sub.endpoint), 'status never exposes the endpoint token');
  const bob = await call(router, 'GET', '/push/status', { user: user('bob') });
  assert.equal(bob.body.count, 0);
  assert.ok(fs.existsSync(path.join(dataRoot, 'alice', '_di-bgmessage-live', 'push.json')));
});

test('at most five subscriptions are kept per user', async (t) => {
  const { router, user } = await setup(t);
  let count = 0;
  for (let i = 0; i < 7; i++) count = (await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: subscription() } })).body.count;
  assert.equal(count, 5);
});

test('test push sends the fixed content-free message, is rate limited and prunes gone subscriptions', async (t) => {
  const statuses = [201, 410];
  const sent = [];
  const { router, user, advance } = await setup(t, {
    fetchImpl: async (url, init2) => { sent.push({ url, init: init2 }); return { status: statuses.shift() ?? 201 }; },
  });
  const none = await call(router, 'POST', '/push/test', { user: user('alice') });
  assert.equal(none.statusCode, 409);
  advance(TEST_COOLDOWN_MS);
  await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: subscription() } });
  await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: subscription() } });
  const first = await call(router, 'POST', '/push/test', { user: user('alice') });
  assert.equal(first.body.ok, true);
  assert.equal(first.body.results.length, 2);
  assert.equal(first.body.removed, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].init.headers.Topic, 'bgml-test');
  const limited = await call(router, 'POST', '/push/test', { user: user('alice') });
  assert.equal(limited.statusCode, 429);
  advance(TEST_COOLDOWN_MS);
  const status = await call(router, 'GET', '/push/status', { user: user('alice') });
  assert.equal(status.body.count, 1);
  for (const language of ['en', 'zh']) {
    const sentBody = JSON.stringify(buildNotification('test', language));
    assert.ok(!/mes|text|reasoning/.test(sentBody), 'test notification carries no chat fields');
  }
});

test('network failures are reported without details and keep the subscription', async (t) => {
  const { router, user } = await setup(t, { fetchImpl: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1'); } });
  await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { subscription: subscription() } });
  const response = await call(router, 'POST', '/push/test', { user: user('alice') });
  assert.equal(response.body.results[0].error, 'NETWORK_ERROR');
  assert.ok(!JSON.stringify(response.body).includes('10.0.0.1'));
  assert.equal((await call(router, 'GET', '/push/status', { user: user('alice') })).body.count, 1);
});

test('end to end: a registered generation finishes after the user left, is listed only for that user, notifies without content and can be dismissed', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { createDecipheriv } = crypto;
  let upstream;
  const loopback = async () => {
    upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'text/event-stream' };
    upstream.complete = false;
    return upstream;
  };
  const sent = [];
  const { router, user } = await setup(t, { loopback, fetchImpl: async (url, init2) => { sent.push({ url, init: init2 }); return { status: 201 }; } });
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  await call(router, 'POST', '/push/subscribe', { user: user('alice'), body: { language: 'zh-cn', subscription: { endpoint: 'https://web.push.apple.com/device', keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } } });

  const registration = { type: 'normal', chatId: '小镇 - 2026-11-09', characterAvatar: 'town.png', characterName: '店主', messageCount: 4 };
  const bad = await call(router, 'POST', '/jobs/register', { user: user('alice'), body: { ...registration, type: 'quiet' } });
  assert.equal(bad.statusCode, 400);
  const registered = await call(router, 'POST', '/jobs/register', { user: user('alice'), body: registration });
  const id = registered.body.id;
  assert.match(id, /^[a-f0-9]{32}$/);

  const response = new EventEmitter();
  Object.assign(response, {
    headersSent: false, writableFinished: false, chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    flushHeaders() {}, write(chunk) { this.chunks.push(String(chunk)); }, end() {},
  });
  router.routes.get('POST /generate')({ body: { type: 'normal', chat_completion_source: 'custom' }, user: user('alice'), socket: { localPort: 8000 }, headers: {} }, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.headers['X-Bgml-Job'], id);
  const active = await call(router, 'GET', '/jobs/active', { user: user('alice') });
  assert.equal(active.body.jobs.length, 1);
  response.emit('close'); // the phone went to background
  upstream.write('data: {"choices":[{"delta":{"content":"欢迎回来。"}}]}\n\n');
  upstream.write('data: [DONE]\n\n');
  upstream.complete = true;
  upstream.end();
  await new Promise(resolve => setTimeout(resolve, 30));

  const listed = await call(router, 'GET', '/jobs/results', { user: user('alice') });
  assert.equal(listed.body.results.length, 1);
  assert.equal(listed.body.results[0].id, id);
  assert.equal(listed.body.results[0].status, 'done');
  assert.ok(!('text' in listed.body.results[0]));
  const full = await call(router, 'GET', '/jobs/results/:id', { user: user('alice'), params: { id } });
  assert.equal(full.body.result.text, '欢迎回来。');
  assert.equal(full.body.result.messageCount, 4);
  const other = await call(router, 'GET', '/jobs/results/:id', { user: user('bob'), params: { id } });
  assert.equal(other.statusCode, 404, 'another user cannot read it');
  assert.equal((await call(router, 'GET', '/jobs/results', { user: user('bob') })).body.results.length, 0);

  assert.equal(sent.length, 1, 'one completion notification');
  const body = sent[0].init.body;
  const asPublic = body.subarray(21, 86);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const salt = body.subarray(0, 16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = body.subarray(86);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipher.subarray(-16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]).toString().replace(/\x02$/, '');
  const payload = JSON.parse(plain);
  assert.deepEqual(payload, buildNotification('done', 'zh'));
  assert.equal(payload.body, '有一条回复已生成，回到酒馆就能看到。', 'a device subscribed in Chinese gets the Chinese text');
  assert.ok(!plain.includes('欢迎回来') && !plain.includes('店主') && !plain.includes('小镇'), 'notification carries no chat content');

  const dismissed = await call(router, 'POST', '/jobs/results/:id/dismiss', { user: user('alice'), params: { id } });
  assert.equal(dismissed.body.removed, true);
  assert.equal((await call(router, 'GET', '/jobs/results', { user: user('alice') })).body.results.length, 0);
  const badId = await call(router, 'POST', '/jobs/results/:id/dismiss', { user: user('alice'), params: { id: '../vapid' } });
  assert.equal(badId.statusCode, 400);
});

test('in-process mode takes over the generate route without a proxy, reports its mode and restores on exit', async (t) => {
  const { pathToFileURL } = await import('node:url');
  const { exit } = await import('../server/index.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bgml-st-router-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'chat-completions.mjs');
  fs.writeFileSync(file, `export const calls = [];
export const router = { stack: [{ route: { path: '/generate', methods: { post: true }, stack: [{ handle(request, response) { calls.push(request.body.type); } }] } }] };`);
  const url = pathToFileURL(file).href;
  const st = await import(url);
  const loopbacks = [];
  const { PassThrough } = await import('node:stream');
  const loopback = async (request, body, options) => {
    loopbacks.push(options.extraHeaders);
    const upstream = new PassThrough();
    upstream.statusCode = 200; upstream.headers = {}; upstream.complete = false;
    return upstream;
  };
  const { router, user } = await setup(t, { inProcess: true, routerModuleUrl: url, loopback });
  t.after(() => exit());
  assert.deepEqual((await call(router, 'GET', '/status', { user: user('alice') })).body, { ok: true, mode: 'in-process', takeoverError: null });

  const wrapped = st.router.stack[0].route.stack[0].handle;
  assert.equal(wrapped.bgmlWrapped, true);
  const { EventEmitter } = await import('node:events');
  const response = () => Object.assign(new EventEmitter(), { writeHead() {}, flushHeaders() {}, write() {}, end() {}, headersSent: false });
  wrapped({ headers: {}, body: { type: 'normal', chat_completion_source: 'custom' }, user: user('alice'), socket: {} }, response(), () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(st.calls, ['normal'], 'unregistered request handled by SillyTavern itself');
  assert.equal(loopbacks.length, 0);

  await call(router, 'POST', '/jobs/register', { user: user('alice'), body: { type: 'normal', chatId: 'c', characterAvatar: 'a.png', characterName: 'A', messageCount: 2 } });
  wrapped({ headers: {}, body: { type: 'normal', chat_completion_source: 'custom' }, user: user('alice'), socket: { localPort: 8000 } }, response(), () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(st.calls, ['normal'], 'registered request does not go straight to SillyTavern');
  assert.equal(loopbacks.length, 1);
  assert.equal(Object.keys(loopbacks[0])[0], 'x-bgml-bypass');
  assert.equal(loopbacks[0]['x-bgml-bypass'].length, 48);

  await exit();
  assert.notEqual(st.router.stack[0].route.stack[0].handle, wrapped, 'original handler restored');
});

test('without a reachable SillyTavern router the plugin falls back to proxy-only mode', async (t) => {
  const { exit } = await import('../server/index.mjs');
  const { router, user } = await setup(t, { inProcess: true });
  t.after(() => exit());
  const status = await call(router, 'GET', '/status', { user: user('alice') });
  assert.deepEqual(status.body, { ok: true, mode: 'proxy-only', takeoverError: 'UNAVAILABLE' });
});
