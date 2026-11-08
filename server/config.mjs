// Administrator settings. The file lives in SillyTavern's data directory
// (data/_di-bgmessage-live/config.json), not in the plugin folder, so plugin updates never overwrite it.
import path from 'node:path';
import { PLUGIN_DIRECTORY_NAME, readJson, writeJsonAtomic } from './store.mjs';

export const PROJECT_URL = 'https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive';

export const DEFAULT_CONFIG = Object.freeze({
  // Contact for push services (RFC 8292 "sub"): "mailto:you@example.com" or an https:// URL of your site.
  vapidSubject: '',
  // Title shown on notifications. Keep it neutral: it appears on the lock screen.
  notificationTitle: 'SillyTavern',
  // A background job is cancelled after this many minutes.
  jobTimeoutMinutes: 20,
  // Finished replies that were never put back into a chat are deleted after this many days.
  resultRetentionDays: 7,
  // Take over SillyTavern's generate route in-process (no reverse proxy needed).
  inProcessTakeover: true,
});

const intIn = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

/** Reads the config file (creating it with defaults on first start) and returns sanitised values. */
export function loadConfig(dataRoot) {
  const file = path.join(dataRoot, PLUGIN_DIRECTORY_NAME, 'config.json');
  let raw = readJson(file, null);
  if (raw === null) {
    writeJsonAtomic(file, DEFAULT_CONFIG, { pretty: true });
    raw = { ...DEFAULT_CONFIG };
  }
  const warnings = [];
  const subject = typeof raw.vapidSubject === 'string' ? raw.vapidSubject.trim() : '';
  const subjectValid = /^mailto:[^\s@]+@[^\s@]+$/.test(subject) || /^https:\/\/[^\s]+$/.test(subject);
  if (subject && !subjectValid) warnings.push('vapidSubject must start with "mailto:" or "https://"; using the project URL instead');
  if (!subject) warnings.push(`vapidSubject is empty; using ${PROJECT_URL}. Set your own contact in ${file}`);

  const title = typeof raw.notificationTitle === 'string' && raw.notificationTitle.trim() && raw.notificationTitle.length <= 60
    ? raw.notificationTitle.trim() : DEFAULT_CONFIG.notificationTitle;

  return {
    file,
    warnings,
    config: Object.freeze({
      vapidSubject: subjectValid ? subject : PROJECT_URL,
      notificationTitle: title,
      jobTimeoutMs: intIn(raw.jobTimeoutMinutes, 1, 120, DEFAULT_CONFIG.jobTimeoutMinutes) * 60_000,
      resultRetentionMs: intIn(raw.resultRetentionDays, 1, 90, DEFAULT_CONFIG.resultRetentionDays) * 24 * 3600_000,
      inProcessTakeover: typeof raw.inProcessTakeover === 'boolean' ? raw.inProcessTakeover : DEFAULT_CONFIG.inProcessTakeover,
    }),
  };
}
