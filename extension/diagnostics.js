// Local diagnostics: a small per-device event log plus an environment summary that a user can
// copy into a bug report. No SillyTavern imports here so it can be unit-tested.
//
// Privacy rules (enforced here, not by callers):
//  - never store chat text, character names, chat ids, user names or the tavern's address;
//  - addresses are removed: only the host of a known push service survives, everything else
//    (URLs, host:port, IP addresses, e-mail addresses, the page's own host) becomes a placeholder;
//  - every stored string is truncated, and the report scrubs everything once more.

export const DIAG_LIMIT = 50;
const MAX_TEXT = 160;
const MAX_DETAIL_KEYS = 8;

// Push services whose host name is useful in a report and says nothing about the user.
const PUSH_HOST = /(^|\.)(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/i;

let redactions = [];

/** Strings that must never appear in a report (the page's host, hostname and origin). */
export function configureRedaction(values) {
  redactions = [...new Set((values || []).map(String).filter(value => value.length >= 3))]
    .sort((a, b) => b.length - a.length);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Host of a push endpoint if it belongs to a known push service, otherwise 'other' (or ''). */
export function hostOf(url) {
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { return ''; }
  return PUSH_HOST.test(host) ? host : 'other';
}

/** Removes addresses and tokens and caps the length. */
export function scrub(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  let text = String(value);
  for (const secret of redactions) text = text.replace(new RegExp(escapeRegExp(secret), 'gi'), '<server>');
  text = text
    // scheme://[user@]host[:port]/… → push-service host or <url>
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?(\[[^\]\s]*\]|[^\s/?#:]+)[^\s'")\]]*/gi,
      (match, host) => (PUSH_HOST.test(host) ? `<${host}>` : '<url>'))
    // protocol-relative //host/…
    .replace(/(^|[\s('"])\/\/[^\s/]+[^\s'")\]]*/g, '$1<url>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\[[0-9a-f:.]*:[0-9a-f:.]*\](:\d+)?/gi, '<ip>')
    // IPv4, but not version numbers such as "Chrome/120.0.6099.230".
    .replace(/(^|[^\w/.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '$1<ip>')
    // bare host:port such as tavern.example.com:8000 or localhost:8000 (not "rv:131.0" in Firefox UAs)
    .replace(/(^|[^\w/.])(?:localhost|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+):\d{2,5}\b/gi, '$1<host>')
    // Long opaque tokens (keys, endpoint ids) are never useful in a report.
    .replace(/[A-Za-z0-9_-]{40,}/g, '<token>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(detail).slice(0, MAX_DETAIL_KEYS)) {
    if (value === undefined || value === null || value === '') continue;
    out[scrub(key, 24)] = typeof value === 'number' || typeof value === 'boolean' ? value : scrub(value);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Turns an Error (or anything thrown) into { name, message } without stack traces. */
export function describeError(error) {
  if (error === undefined || error === null) return { name: '', message: '' };
  if (typeof error !== 'object') return { name: '', message: scrub(error) };
  let name = '';
  let message = '';
  try { name = scrub(error.name || ''); } catch { /* hostile getter */ }
  try { message = scrub(error.message || ''); } catch { /* hostile getter */ }
  return { name, message };
}

function memoryStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_, next) => { value = next; }, removeItem: () => { value = null; } };
}

const isEntry = (item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && typeof item.event === 'string';

/**
 * Event log kept in localStorage (per device, per browser). Consecutive identical entries are
 * merged with a counter so that a retry loop cannot push everything else out. It never throws:
 * a broken log must not break the extension.
 */
export function createDiagnosticsLog({ storage, storageKey, now = () => Date.now(), limit = DIAG_LIMIT } = {}) {
  let store = storage;
  try { store?.getItem(storageKey); } catch { store = null; }
  store ??= memoryStorage();
  const original = store;

  const load = () => {
    try {
      const parsed = JSON.parse(store.getItem(storageKey) || '[]');
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      return [];
    }
  };
  const save = (entries) => {
    const value = JSON.stringify(entries);
    try {
      store.setItem(storageKey, value);
    } catch {
      // Storage full or blocked (e.g. private browsing): keep the log in memory for this page.
      store = memoryStorage();
      store.setItem(storageKey, value);
    }
  };

  return {
    record(event, { step, error, detail } = {}) {
      try {
        const entry = { at: new Date(now()).toISOString(), event: scrub(event, 40) };
        if (step) entry.step = scrub(step, 40);
        if (error !== undefined) {
          const { name, message } = describeError(error);
          if (name) entry.name = name;
          if (message) entry.message = message;
        }
        const cleaned = cleanDetail(detail);
        if (cleaned) entry.detail = cleaned;

        const entries = load();
        const last = entries[entries.length - 1];
        const key = (item) => JSON.stringify([item.event, item.step, item.name, item.message, item.detail]);
        if (last && key(last) === key(entry)) {
          last.count = (Number(last.count) || 1) + 1;
          last.at = entry.at;
        } else {
          entries.push(entry);
        }
        save(entries.slice(-limit));
        return entry;
      } catch {
        return null;
      }
    },
    entries: load,
    clear() {
      // After a fallback to memory, the old copy may still sit in the real storage.
      for (const target of new Set([store, original])) {
        try { target.removeItem(storageKey); } catch { /* ignore */ }
      }
    },
  };
}

/** Browser engine guess from the user agent; WebView is flagged because it has no Push API. */
export function engineOf(userAgent) {
  const ua = String(userAgent || '');
  // Every iOS/iPadOS browser is WebKit, whatever it calls itself.
  if (/iPhone|iPad|iPod/.test(ua)) return 'WebKit';
  if (/Firefox\//.test(ua)) return 'Gecko';
  if (/Chrome\/|Chromium\//.test(ua)) {
    const webview = /; wv\)/.test(ua) || /Version\/[\d.]+ Chrome\/[\d.]+ Mobile/.test(ua);
    return webview ? 'Blink (Android WebView)' : 'Blink';
  }
  if (/AppleWebKit/.test(ua)) return 'WebKit';
  return 'unknown';
}

/**
 * Snapshot of what the browser can do. `scope` is an object with the browser globals
 * (window-like); tests pass a plain object.
 */
export function collectEnvironment(scope) {
  const nav = scope.navigator || {};
  const has = (name) => {
    try { return name in scope; } catch { return false; }
  };
  let standalone = false;
  try { standalone = Boolean(scope.matchMedia?.('(display-mode: standalone)')?.matches) || nav.standalone === true; } catch { /* ignore */ }
  let permission = 'unsupported';
  try { if (has('Notification')) permission = String(scope.Notification.permission); } catch { /* ignore */ }
  return {
    userAgent: scrub(nav.userAgent, 320),
    engine: engineOf(nav.userAgent),
    language: scrub(nav.language, 20),
    secureContext: Boolean(scope.isSecureContext),
    standalone,
    serviceWorker: Boolean(nav.serviceWorker),
    pushManager: has('PushManager'),
    notification: has('Notification'),
    permission: scrub(permission, 20),
  };
}

const yesNo = (value) => (value ? 'yes' : 'no');

/**
 * Plain-text report. Field names stay in English so maintainers can read reports from anyone;
 * only the header follows the UI language. Every value is scrubbed again here.
 */
export function buildReport({ header, versions = {}, server = {}, environment, device = {}, entries = [] }) {
  const s = (value, max) => scrub(value, max) || '?';
  const lines = [];
  lines.push(scrub(header) || 'Background Message Live diagnostics');
  lines.push('```');
  lines.push(`time: ${new Date().toISOString()}`);
  lines.push(`extension: ${s(versions.extension, 20)} · SillyTavern: ${s(versions.tavern, 20)}`);
  lines.push(`server plugin: ${s(server.mode || server.error, 40)}`);
  if (server.devices !== undefined) lines.push(`server devices: ${s(server.devices, 10)}`);
  if (environment) {
    lines.push(`browser: ${s(environment.userAgent, 320)}`);
    lines.push(`engine: ${s(environment.engine, 40)} · language: ${s(environment.language, 20)}`);
    lines.push(`https: ${yesNo(environment.secureContext)} · home screen app: ${yesNo(environment.standalone)}`);
    lines.push(`serviceWorker: ${yesNo(environment.serviceWorker)} · PushManager: ${yesNo(environment.pushManager)} · Notification: ${yesNo(environment.notification)} · permission: ${s(environment.permission, 20)}`);
  }
  if (device.subscription !== undefined) lines.push(`this device subscribed: ${device.subscription ? `yes (${s(device.pushHost, 60)})` : 'no'}`);
  const list = (Array.isArray(entries) ? entries : []).filter(isEntry);
  lines.push(`events (${list.length}, oldest first):`);
  if (list.length === 0) lines.push('  (none)');
  for (const entry of list) {
    const at = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(entry.at)) ? entry.at : '?';
    const parts = [at, scrub(entry.event, 40)];
    if (entry.step) parts.push(`step=${scrub(entry.step, 40)}`);
    if (entry.name || entry.message) parts.push(`${entry.name ? `${scrub(entry.name)}: ` : ''}${scrub(entry.message)}`.trim());
    if (entry.detail && typeof entry.detail === 'object') {
      parts.push(Object.entries(entry.detail).slice(0, MAX_DETAIL_KEYS).map(([k, v]) => `${scrub(k, 24)}=${scrub(v)}`).join(' '));
    }
    if (Number(entry.count) > 1) parts.push(`×${Number(entry.count)}`);
    lines.push(`  ${parts.join(' | ')}`);
  }
  lines.push('```');
  return lines.join('\n');
}
