// Registrations (announced by the extension right before a main generation) and finished results.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLUGIN_DIRECTORY_NAME, readJson, writeJsonAtomic } from './store.mjs';

/** Generation types that may continue in the background. quiet / impersonate never do. */
export const MAIN_TYPES = Object.freeze(['normal', 'regenerate', 'swipe', 'continue']);
export const REGISTRATION_TTL_MS = 60_000;
export const MAX_REGISTRATIONS_PER_USER = 20;
export const RESULT_TTL_MS = 7 * 24 * 3600 * 1000;

const JOB_ID = /^[a-f0-9]{32}$/;
export const isJobId = (id) => typeof id === 'string' && JOB_ID.test(id);
export const newJobId = () => crypto.randomBytes(16).toString('hex');

const shortString = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null);

/** Validates what the extension announces; returns a clean copy or null. */
export function validateRegistration(input) {
  if (!input || typeof input !== 'object' || !MAIN_TYPES.includes(input.type)) return null;
  const chatId = shortString(input.chatId, 512);
  const messageCount = count(input.messageCount);
  if (!chatId || messageCount === null) return null;
  const registration = {
    type: input.type,
    chatId,
    characterAvatar: shortString(input.characterAvatar, 512) || '',
    characterName: shortString(input.characterName, 200) || '',
    messageCount,
  };
  if (input.type === 'continue') {
    const baseLength = count(input.baseLength);
    if (baseLength === null) return null;
    registration.baseLength = baseLength;
  }
  return registration;
}

/** In-memory, per user. A registration is consumed by the next generate request of the same type. */
export function createRegistry({ now = () => Date.now() } = {}) {
  const byUser = new Map();
  const fresh = (handle) => {
    const list = (byUser.get(handle) || []).filter(item => now() - item.createdAt < REGISTRATION_TTL_MS);
    byUser.set(handle, list);
    return list;
  };
  return {
    register(handle, registration) {
      const list = fresh(handle);
      const item = { ...registration, id: newJobId(), createdAt: now() };
      list.push(item);
      while (list.length > MAX_REGISTRATIONS_PER_USER) list.shift();
      return item;
    },
    /** Takes the most recent registration of this type, or null. */
    consume(handle, type) {
      if (!MAIN_TYPES.includes(type)) return null;
      const list = fresh(handle);
      for (let index = list.length - 1; index >= 0; index--) {
        if (list[index].type === type) return list.splice(index, 1)[0];
      }
      return null;
    },
    size(handle) { return fresh(handle).length; },
  };
}

/** Finished background results of one user, one private file each. */
export function createResultStore(userRoot, { ttlMs = RESULT_TTL_MS } = {}) {
  const directory = path.join(userRoot, PLUGIN_DIRECTORY_NAME, 'results');
  const file = (id) => path.join(directory, `${id}.json`);
  const ids = () => {
    try { return fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(isJobId); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const metadata = ({ text, reasoning, ...rest }) => ({ ...rest, length: typeof text === 'string' ? text.length : 0 });
  return {
    save(result) {
      if (!isJobId(result.id)) throw new Error('invalid job id');
      writeJsonAtomic(file(result.id), result);
    },
    get(id) { return isJobId(id) ? readJson(file(id), null) : null; },
    list() {
      return ids().map(id => readJson(file(id), null)).filter(Boolean).map(metadata)
        .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    },
    remove(id) {
      if (!isJobId(id)) return false;
      try { fs.unlinkSync(file(id)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
    prune(nowMs = Date.now()) {
      let removed = 0;
      for (const id of ids()) {
        const result = readJson(file(id), null);
        const finished = Date.parse(result?.finishedAt || '');
        if (!result || !Number.isFinite(finished) || nowMs - finished > ttlMs) { this.remove(id); removed++; }
      }
      return removed;
    },
  };
}
