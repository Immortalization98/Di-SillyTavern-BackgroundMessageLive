import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, PROJECT_URL } from '../server/config.mjs';
import { buildNotification, notificationLanguage } from '../server/messages.mjs';
import { createTranslator, languageOf, STRINGS } from '../extension/i18n.js';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgml-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('first start writes a readable default config and warns about the empty contact', (t) => {
  const root = tempRoot(t);
  const { config, warnings, file } = loadConfig(root);
  const written = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(written), DEFAULT_CONFIG);
  assert.ok(written.includes('\n  "vapidSubject"'), 'pretty printed for humans');
  assert.equal(config.vapidSubject, PROJECT_URL);
  assert.equal(config.jobTimeoutMs, 20 * 60_000);
  assert.equal(config.resultRetentionMs, 7 * 24 * 3600_000);
  assert.equal(config.inProcessTakeover, true);
  assert.ok(warnings.some(line => /vapidSubject is empty/.test(line)));
});

test('custom values are used; invalid ones fall back to safe defaults', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, '_di-bgmessage-live', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ vapidSubject: 'mailto:owner@example.com', notificationTitle: 'My Tavern', jobTimeoutMinutes: 5, resultRetentionDays: 30, inProcessTakeover: false }));
  let { config, warnings } = loadConfig(root);
  assert.deepEqual(config, { vapidSubject: 'mailto:owner@example.com', notificationTitle: 'My Tavern', jobTimeoutMs: 300_000, resultRetentionMs: 30 * 24 * 3600_000, inProcessTakeover: false });
  assert.equal(warnings.length, 0);

  fs.writeFileSync(file, JSON.stringify({ vapidSubject: 'http://insecure.example', notificationTitle: '', jobTimeoutMinutes: 0, resultRetentionDays: 1000, inProcessTakeover: 'yes' }));
  ({ config, warnings } = loadConfig(root));
  assert.equal(config.vapidSubject, PROJECT_URL);
  assert.equal(config.notificationTitle, 'SillyTavern');
  assert.equal(config.jobTimeoutMs, 20 * 60_000);
  assert.equal(config.resultRetentionMs, 7 * 24 * 3600_000);
  assert.equal(config.inProcessTakeover, true);
  assert.ok(warnings.some(line => /must start with/.test(line)));
});

test('notification language follows the locale and texts never carry chat content', () => {
  assert.equal(notificationLanguage('zh-cn'), 'zh');
  assert.equal(notificationLanguage('zh-TW'), 'zh');
  assert.equal(notificationLanguage('en-US'), 'en');
  assert.equal(notificationLanguage(undefined), 'en');
  for (const language of ['en', 'zh']) {
    for (const kind of ['test', 'done', 'failed']) {
      const notification = buildNotification(kind, language, { title: 'Tavern' });
      assert.deepEqual(Object.keys(notification).sort(), ['body', 'tag', 'title', 'url']);
      assert.equal(notification.title, 'Tavern');
      assert.equal(notification.url, '/');
    }
  }
  assert.equal(buildNotification('done', 'en').body, 'A reply is ready. Open SillyTavern to see it.');
  assert.throws(() => buildNotification('content', 'en'), /unknown notification kind/);
});

test('both UI languages have exactly the same keys and placeholders', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
  for (const key of Object.keys(STRINGS.en)) {
    assert.equal(placeholders(STRINGS.zh[key]), placeholders(STRINGS.en[key]), key);
  }
});

test('translator picks the language, fills placeholders and falls back to English', () => {
  assert.equal(languageOf('zh-cn'), 'zh');
  assert.equal(languageOf('ja-jp'), 'en');
  const zh = createTranslator('zh-cn');
  assert.equal(zh.language, 'zh');
  assert.equal(zh.t('serverCount', { count: 2, devices: 'iOS, Windows' }), '2 台（iOS, Windows）');
  const en = createTranslator('en');
  assert.equal(en.t('testSent', { ok: 1, total: 2, extra: '' }), 'Test notification sent (1/2 devices).');
  assert.equal(en.t('no-such-key'), 'no-such-key');
});
