// Small file stores: the VAPID key pair (global) and push subscriptions (per user).
// Single Node process + synchronous fs calls, so no locking is needed; writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateVapidKeys } from './webpush.mjs';

export const MAX_SUBSCRIPTIONS_PER_USER = 5;
export const PLUGIN_DIRECTORY_NAME = '_di-bgmessage-live';

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Loads the server's VAPID key pair, creating it on first use. The private key never leaves this file. */
export function loadOrCreateVapid(directory) {
  const file = path.join(directory, 'vapid.json');
  const existing = readJson(file, null);
  if (existing?.publicKey && existing?.privateKey) return existing;
  const created = { ...generateVapidKeys(), createdAt: new Date().toISOString() };
  writeJsonAtomic(file, created);
  return created;
}

/** Push subscriptions of one user, stored under that user's own data directory. */
export function createSubscriptionStore(userRoot) {
  const file = path.join(userRoot, PLUGIN_DIRECTORY_NAME, 'push.json');
  const load = () => {
    const data = readJson(file, { subscriptions: [] });
    return Array.isArray(data.subscriptions) ? data.subscriptions : [];
  };
  const save = (subscriptions) => writeJsonAtomic(file, { subscriptions });
  return {
    list: load,
    add(subscription, { userAgent = '', language = 'en' } = {}) {
      const others = load().filter(item => item.endpoint !== subscription.endpoint);
      others.push({ ...subscription, language, createdAt: new Date().toISOString(), device: describeDevice(userAgent) });
      const kept = others.slice(-MAX_SUBSCRIPTIONS_PER_USER);
      save(kept);
      return kept.length;
    },
    remove(endpoints) {
      const drop = new Set(Array.isArray(endpoints) ? endpoints : [endpoints]);
      const current = load();
      const kept = current.filter(item => !drop.has(item.endpoint));
      if (kept.length !== current.length) save(kept);
      return current.length - kept.length;
    },
  };
}

/** Coarse device label for the user's own status list; the raw user agent is not stored. */
export function describeDevice(userAgent) {
  const ua = String(userAgent);
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  return 'Other';
}
