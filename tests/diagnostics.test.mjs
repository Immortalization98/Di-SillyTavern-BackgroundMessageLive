import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, collectEnvironment, configureRedaction, createDiagnosticsLog, describeError, engineOf, hostOf, scrub } from '../extension/diagnostics.js';

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

test('scrub removes addresses but keeps push-service hosts and version numbers', () => {
  configureRedaction(['https://tavern.example.org:8443', 'tavern.example.org:8443', 'tavern.example.org']);
  try {
    assert.equal(scrub('failed https://fcm.googleapis.com/fcm/send/dAbC123:APA91bHxyz?x=1 and http://192.168.1.5:8000/chat'), 'failed <fcm.googleapis.com> and <url>');
    assert.equal(scrub("Failed to register a ServiceWorker for scope ('https://tavern.example.org:8443/scripts/x/') with script ('https://tavern.example.org:8443/scripts/x/sw.js')"),
      "Failed to register a ServiceWorker for scope ('<server>/scripts/x/') with script ('<server>/scripts/x/sw.js')");
    assert.equal(scrub('host tavern.example.org is down'), 'host <server> is down');
  } finally {
    configureRedaction([]);
  }
  assert.equal(scrub('https://user:pw@private.example.net/a'), '<url>');
  assert.equal(scrub('see //cdn.example.net/x.js'), 'see <url>');
  assert.equal(scrub('reach 10.0.0.7:8000 or [::1]:8000 or localhost:8000 or my.box.lan:8080'), 'reach <ip> or <ip> or <host> or <host>');
  assert.equal(scrub('mail me@example.com'), 'mail <email>');
  assert.equal(scrub('Chrome/120.0.6099.230 Mobile'), 'Chrome/120.0.6099.230 Mobile');
  assert.equal(scrub(`key ${'a'.repeat(64)} end`), 'key <token> end');
  assert.equal(scrub('ab '.repeat(200)).length, 160);
  assert.equal(scrub(undefined), '');
});

test('hostOf keeps only known push services, describeError keeps name and message', () => {
  assert.equal(hostOf('https://web.push.apple.com/QGuQ-token'), 'web.push.apple.com');
  assert.equal(hostOf('https://updates.push.services.mozilla.com/wpush/v2/x'), 'updates.push.services.mozilla.com');
  assert.equal(hostOf('https://push.selfhosted.example/up/abc'), 'other');
  assert.equal(hostOf('not a url'), '');
  const error = new DOMException('Error retrieving push subscription.', 'AbortError');
  assert.deepEqual(describeError(error), { name: 'AbortError', message: 'Error retrieving push subscription.' });
  assert.deepEqual(describeError('plain'), { name: '', message: 'plain' });
  const hostile = { get name() { throw new Error('x'); }, message: 'm' };
  assert.deepEqual(describeError(hostile), { name: '', message: 'm' });
});

test('log keeps the newest entries, merges repeats and survives broken storage', () => {
  const storage = fakeStorage();
  let clock = Date.UTC(2026, 10, 10, 8, 0, 0);
  const log = createDiagnosticsLog({ storage, storageKey: 'k', now: () => clock, limit: 3 });
  log.record('push.enable', { step: 'subscribe', error: new DOMException('Error retrieving push subscription.', 'AbortError') });
  clock += 1000;
  log.record('push.enable', { step: 'subscribe', error: new DOMException('Error retrieving push subscription.', 'AbortError') });
  let entries = log.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);
  assert.equal(entries[0].at, '2026-11-10T08:00:01.000Z');
  assert.equal(entries[0].name, 'AbortError');

  for (let i = 0; i < 5; i += 1) log.record('job.register', { detail: { type: 'normal', n: i } });
  entries = log.entries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.detail.n), [2, 3, 4]);

  log.clear();
  assert.deepEqual(log.entries(), []);

  storage.setItem('k', '{not json');
  assert.deepEqual(log.entries(), []);

  storage.setItem('k', JSON.stringify([null, 3, { event: 'ok' }, { no: 'event' }]));
  assert.deepEqual(log.entries(), [{ event: 'ok' }]);
  assert.ok(log.record('after.dirty'));

  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  const memoryLog = createDiagnosticsLog({ storage: throwing, storageKey: 'k' });
  memoryLog.record('x');
  assert.equal(memoryLog.entries().length, 1);

  // Readable but full storage (Safari private mode): falls back to memory instead of losing events.
  const full = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} };
  const fullLog = createDiagnosticsLog({ storage: full, storageKey: 'k' });
  fullLog.record('a');
  fullLog.record('b');
  assert.deepEqual(fullLog.entries().map(e => e.event), ['a', 'b']);
});

test('details are scrubbed and capped', () => {
  const storage = fakeStorage();
  const log = createDiagnosticsLog({ storage, storageKey: 'k' });
  const entry = log.record('push.enable', { detail: { service: 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk', empty: '', ok: true } });
  assert.deepEqual(entry.detail, { service: '<updates.push.services.mozilla.com>', ok: true });
  assert.ok(!storage.map.get('k').includes('wpush'));
});

test('engineOf recognises common mobile browsers', () => {
  assert.equal(engineOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'WebKit');
  assert.equal(engineOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'), 'WebKit');
  assert.equal(engineOf('Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0'), 'Gecko');
  assert.equal(engineOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), 'Blink');
  assert.equal(engineOf('Mozilla/5.0 (Linux; Android 13; M2102J2SC; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.4'), 'Blink (Android WebView)');
  assert.equal(engineOf(''), 'unknown');
});

test('collectEnvironment reads capabilities without throwing on odd browsers', () => {
  const env = collectEnvironment({
    navigator: { userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0', language: 'zh-CN', serviceWorker: {} },
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    PushManager: function PushManager() {},
    Notification: { permission: 'granted' },
  });
  assert.deepEqual(env, {
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    engine: 'Gecko', language: 'zh-CN', secureContext: true, standalone: false,
    serviceWorker: true, pushManager: true, notification: true, permission: 'granted',
  });
  const bare = collectEnvironment({ navigator: {}, matchMedia() { throw new Error('nope'); } });
  assert.equal(bare.pushManager, false);
  assert.equal(bare.permission, 'unsupported');
});

test('report lists versions, capabilities and events but no addresses', () => {
  const report = buildReport({
    header: '后台生成与通知 · 诊断信息',
    versions: { extension: '1.1.0', tavern: '1.19.0' },
    server: { mode: 'in-process', devices: 1 },
    environment: { userAgent: 'UA', engine: 'Gecko', language: 'zh-CN', secureContext: true, standalone: false, serviceWorker: true, pushManager: true, notification: true, permission: 'granted' },
    device: { subscription: false },
    entries: [{ at: '2026-11-10T08:00:00.000Z', event: 'push.enable', step: 'subscribe', name: 'AbortError', message: 'Error retrieving push subscription.', count: 3 }],
  });
  assert.match(report, /^后台生成与通知 · 诊断信息\n```/);
  assert.match(report, /extension: 1\.1\.0 · SillyTavern: 1\.19\.0/);
  assert.match(report, /server plugin: in-process/);
  assert.match(report, /PushManager: yes/);
  assert.match(report, /this device subscribed: no/);
  assert.match(report, /push\.enable \| step=subscribe \| AbortError: Error retrieving push subscription\. \| ×3/);
  assert.match(report, /```$/);
  assert.match(buildReport({}), /\(none\)/);
});
