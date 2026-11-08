// Background Message Live — SillyTavern front-end extension.
// It never wraps window.fetch and never changes a generation request. It only:
//  1. tells the server plugin "the next request is a main chat generation" (registration),
//  2. cancels the background job when the user presses Stop,
//  3. offers replies that finished in the background, and inserts them after confirmation,
//  4. manages the push-notification subscription of this device.
import { planInsertion } from './insertion.js';
import { createTranslator } from './i18n.js';

const SETTINGS_KEY = 'di-bgmessage-live';
const EXTENSION_PATH = new URL('.', import.meta.url).pathname;
const SW_URL = `${EXTENSION_PATH}sw.js`;
const SW_SCOPE = EXTENSION_PATH;
const API = '/api/plugins/di-bgmessage-live';
const MAIN_TYPES = ['normal', 'regenerate', 'swipe', 'continue'];
const DETACHABLE_SOURCES = ['custom', 'openai', 'openrouter', 'deepseek'];
const POLL_MS = 5000;
const STOP_GRACE_MS = 5000;
const RESULT_COPY = 10;
const RESULT_DELETE = 11;

let i18n = createTranslator('en');
const t = (key, values) => i18n.t(key, values);

const ERROR_KEYS = {
  NOT_LOGGED_IN: 'errNotLoggedIn',
  INVALID_SUBSCRIPTION: 'errInvalidSubscription',
  NO_SUBSCRIPTION: 'errNoSubscription',
  RATE_LIMITED: 'errRateLimited',
  SERVER_ERROR: 'errServer',
  NETWORK_ERROR: 'errNetwork',
  PLUGIN_MISSING: 'errPluginMissing',
  NOT_FOUND: 'errNotFound',
  IOS_NOT_STANDALONE: 'errIOSStandalone',
  UNSUPPORTED: 'errUnsupported',
  PERMISSION_DENIED: 'errPermissionDenied',
  PERMISSION_DISMISSED: 'errPermissionDismissed',
  SW_NOT_INSTALLED: 'errServiceWorker',
  SW_TIMEOUT: 'errServiceWorker',
  SW_REDUNDANT: 'errServiceWorker',
};

const REASON_KEYS = {
  TIMEOUT: 'reasonTimeout',
  UPSTREAM_ERROR: 'reasonUpstream',
  INTERRUPTED: 'reasonInterrupted',
  EMPTY: 'reasonEmpty',
  TOO_LARGE: 'reasonTooLarge',
  RELAY_ERROR: 'reasonRelay',
};

const messageFor = (error) => (ERROR_KEYS[error?.message] ? t(ERROR_KEYS[error.message]) : t('errUnknown', { code: error?.message || '?' }));

const context = () => SillyTavern.getContext();

function settings() {
  const all = context().extensionSettings;
  all[SETTINGS_KEY] ??= { backgroundEnabled: true };
  return all[SETTINGS_KEY];
}

async function api(method, route, body) {
  let response;
  try {
    response = await fetch(`${API}${route}`, {
      method,
      headers: context().getRequestHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }
  if (response.status === 404 && !route.startsWith('/jobs/results/')) throw new Error('PLUGIN_MISSING');
  const data = await response.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.error?.code || 'SERVER_ERROR');
  return data;
}

// ---------------------------------------------------------------------------------------
// 1–2. Registration and cancellation
// ---------------------------------------------------------------------------------------

let mainGenerationType = null;
let currentJobId = null;
// stopGeneration() emits GENERATION_ENDED (via hideStopButton) *before* GENERATION_STOPPED,
// so the job id must survive the "ended" event briefly for Stop to cancel it.
let endedJob = { id: null, at: 0 };

function currentCharacter() {
  const ctx = context();
  if (ctx.groupId) return null;
  const character = ctx.characters?.[ctx.characterId];
  return character ? { avatar: character.avatar || '', name: ctx.name2 || character.name || '' } : null;
}

function onGenerationStarted(type, options, dryRun) {
  currentJobId = null;
  mainGenerationType = (!dryRun && MAIN_TYPES.includes(type) && !options?.quiet_prompt) ? type : null;
}

async function onChatCompletionSettingsReady(data) {
  if (!settings().backgroundEnabled || !mainGenerationType || data?.type !== mainGenerationType) return;
  if (!DETACHABLE_SOURCES.includes(data?.chat_completion_source)) return;
  const ctx = context();
  const character = currentCharacter();
  const chatId = ctx.getCurrentChatId();
  if (!character || !chatId) return;
  const last = ctx.chat[ctx.chat.length - 1];
  const registration = {
    type: mainGenerationType,
    chatId,
    characterAvatar: character.avatar,
    characterName: character.name,
    messageCount: ctx.chat.length,
  };
  if (mainGenerationType === 'continue') registration.baseLength = typeof last?.mes === 'string' ? last.mes.length : 0;
  try {
    // Never hold up the generation for long: without registration it simply runs as before.
    const result = await Promise.race([api('POST', '/jobs/register', registration), new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 3000))]);
    currentJobId = result.id;
  } catch {
    currentJobId = null;
  }
}

function onGenerationStopped() {
  const recentlyEnded = Date.now() - endedJob.at < STOP_GRACE_MS ? endedJob.id : null;
  const id = currentJobId || recentlyEnded;
  currentJobId = null;
  endedJob = { id: null, at: 0 };
  mainGenerationType = null;
  if (id) api('POST', `/jobs/${id}/cancel`).catch(() => {});
}

function onGenerationEnded() {
  if (currentJobId) endedJob = { id: currentJobId, at: Date.now() };
  mainGenerationType = null;
  currentJobId = null;
  // A broken stream ends the generation in the page while the server keeps going.
  setTimeout(() => checkForResults(), 1500);
}

// ---------------------------------------------------------------------------------------
// 3. Recovery of replies finished in the background
// ---------------------------------------------------------------------------------------

const deferred = new Set();
const announcedRunning = new Set();
let checking = false;
let promptOpen = false;
let pollTimer = null;
let otherChatsHintShown = false;

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling() { if (!pollTimer) pollTimer = setInterval(() => checkForResults(), POLL_MS); }

async function checkForResults() {
  if (checking || promptOpen || mainGenerationType || document.visibilityState === 'hidden') return;
  const ctx = context();
  const character = currentCharacter();
  const chatId = ctx.getCurrentChatId();
  checking = true;
  try {
    const { results } = await api('GET', '/jobs/results');
    const here = character && chatId ? results.filter(item => item.chatId === chatId && item.characterAvatar === character.avatar) : [];
    const elsewhere = results.length - here.length;
    if (elsewhere > 0 && !otherChatsHintShown) {
      otherChatsHintShown = true;
      toastr.info(t('toastOtherChats', { count: elsewhere }), t('toastTitle'));
    }
    const next = here.find(item => !deferred.has(item.id));
    if (next) {
      stopPolling();
      await offerResult(next.id);
      return;
    }
    const { jobs } = await api('GET', '/jobs/active');
    const running = character && chatId ? jobs.filter(job => job.chatId === chatId && job.characterAvatar === character.avatar) : [];
    if (running.length) {
      if (!announcedRunning.has(running[0].id)) {
        announcedRunning.add(running[0].id);
        toastr.info(t('toastStillRunning'), t('toastTitle'));
      }
      startPolling();
    } else {
      stopPolling();
    }
  } catch {
    // The plugin may be missing or the network down; recovery is best-effort.
  } finally {
    checking = false;
  }
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(i18n.language === 'zh' ? 'zh-CN' : undefined, { hour12: false });
}

function paragraph(text, className) {
  const p = document.createElement('p');
  if (className) p.className = className;
  p.textContent = text;
  return p;
}

async function offerResult(id) {
  const ctx = context();
  let result;
  try {
    result = (await api('GET', `/jobs/results/${id}`)).result;
  } catch {
    return;
  }
  promptOpen = true;
  try {
    const content = document.createElement('div');
    content.className = 'bgml-recovery';
    content.append(Object.assign(document.createElement('h3'), { textContent: t('recoveryTitle') }));

    if (result.status !== 'done') {
      const reason = t(REASON_KEYS[result.code] || 'reasonUnknown');
      content.append(paragraph(t('recoveryFailed', { reason, time: formatTime(result.finishedAt) })));
      await ctx.callGenericPopup(content, ctx.POPUP_TYPE.TEXT, '', { okButton: t('buttonGotIt') });
      await api('POST', `/jobs/results/${id}/dismiss`).catch(() => {});
      return;
    }

    content.append(paragraph(t('recoveryDone', { time: formatTime(result.finishedAt), length: result.text.length })));
    content.append(paragraph(result.text.length > 400 ? `${result.text.slice(0, 400)}…` : result.text, 'bgml-preview'));

    const choice = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.TEXT, '', {
      okButton: t('buttonInsert'),
      cancelButton: t('buttonLater'),
      customButtons: [
        { text: t('buttonCopy'), result: RESULT_COPY },
        { text: t('buttonDelete'), result: RESULT_DELETE, classes: ['redWarningBG'] },
      ],
      wide: true,
    });

    if (choice === ctx.POPUP_RESULT.AFFIRMATIVE) {
      await insertResult(result);
    } else if (choice === RESULT_COPY) {
      deferred.add(id);
      const copied = await copyText(result.text);
      if (copied) toastr.success(t('copied'), t('toastTitle'));
      else toastr.warning(t('copyFailed'), t('toastTitle'));
    } else if (choice === RESULT_DELETE) {
      const sure = await ctx.callGenericPopup(t('confirmDelete'), ctx.POPUP_TYPE.CONFIRM, '', { okButton: t('buttonDelete'), cancelButton: t('buttonCancel') });
      if (sure === ctx.POPUP_RESULT.AFFIRMATIVE) await api('POST', `/jobs/results/${id}/dismiss`).catch(() => {});
      else deferred.add(id);
    } else {
      deferred.add(id);
    }
  } finally {
    promptOpen = false;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function swipeInfo(result, sendDate) {
  return { send_date: sendDate, gen_started: result.startedAt, gen_finished: result.finishedAt, extra: { reasoning: result.reasoning || '', bgml_job: result.id } };
}

function setCurrentText(message, text, result) {
  message.mes = text;
  if (Array.isArray(message.swipes)) message.swipes[message.swipe_id ?? 0] = text;
  message.extra = { ...(message.extra || {}), bgml_job: result.id };
  if (result.reasoning) message.extra.reasoning = result.reasoning;
  message.gen_finished = result.finishedAt;
}

function addSwipe(message, result, sendDate) {
  if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
    message.swipes = [message.mes];
    message.swipe_info = [{ send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished, extra: structuredClone(message.extra || {}) }];
    message.swipe_id = 0;
  }
  message.swipe_info = Array.isArray(message.swipe_info) ? message.swipe_info : [];
  while (message.swipe_info.length < message.swipes.length) message.swipe_info.push({});
  message.swipes.push(result.text);
  message.swipe_info.push(swipeInfo(result, sendDate));
  message.swipe_id = message.swipes.length - 1;
  message.mes = result.text;
  message.gen_started = result.startedAt;
  message.gen_finished = result.finishedAt;
  message.extra = { ...(message.extra || {}), bgml_job: result.id, reasoning: result.reasoning || '' };
}

async function insertResult(result) {
  const ctx = context();
  const character = currentCharacter();
  if (ctx.getCurrentChatId() !== result.chatId || character?.avatar !== result.characterAvatar) {
    toastr.warning(t('wrongChat'), t('toastTitle'));
    deferred.add(result.id);
    return;
  }
  const plan = planInsertion(ctx.chat, result);
  if (plan.kind === 'mismatch') {
    const copied = await copyText(result.text);
    await ctx.callGenericPopup(t('mismatch', { copied: copied ? t('mismatchCopied') : '' }), ctx.POPUP_TYPE.TEXT, '', { okButton: t('buttonGotIt') });
    deferred.add(result.id);
    return;
  }

  const { getMessageTimeStamp } = await import('/scripts/RossAscends-mods.js');
  const sendDate = getMessageTimeStamp();
  const events = ctx.eventTypes;

  if (plan.kind === 'append') {
    const message = {
      name: result.characterName || ctx.name2,
      is_user: false,
      is_system: false,
      send_date: sendDate,
      mes: result.text,
      gen_started: result.startedAt,
      gen_finished: result.finishedAt,
      extra: { api: 'openai', bgml_job: result.id, ...(result.reasoning ? { reasoning: result.reasoning } : {}) },
      swipes: [result.text],
      swipe_id: 0,
      swipe_info: [swipeInfo(result, sendDate)],
    };
    ctx.chat.push(message);
    const index = ctx.chat.length - 1;
    ctx.addOneMessage(message);
    await ctx.eventSource.emit(events.MESSAGE_RECEIVED, index, 'normal');
    await ctx.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, index, 'normal');
    await ctx.saveChat();
  } else {
    const message = ctx.chat[plan.index];
    if (plan.kind === 'continue') setCurrentText(message, message.mes.slice(0, result.baseLength) + result.text, result);
    else if (plan.kind === 'replaceCurrent') setCurrentText(message, result.text, result);
    else addSwipe(message, result, sendDate);
    await ctx.saveChat();
    await ctx.reloadCurrentChat();
    await ctx.eventSource.emit(events.MESSAGE_RECEIVED, plan.index, plan.kind === 'continue' ? 'continue' : 'swipe');
    await ctx.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, plan.index, plan.kind === 'continue' ? 'continue' : 'swipe');
  }
  await api('POST', `/jobs/results/${result.id}/dismiss`).catch(() => {});
  toastr.success(plan.kind === 'addSwipe' ? t('insertedSwipe') : t('inserted'), t('toastTitle'));
}

// ---------------------------------------------------------------------------------------
// 4. Push notifications (device setup)
// ---------------------------------------------------------------------------------------

function environment() {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  return { isIOS, standalone, supported, permission: 'Notification' in window ? Notification.permission : 'unsupported' };
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function sameKey(buffer, publicKey) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function ownRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  // getRegistration returns the closest matching scope; make sure it is ours, not a root one.
  return registration && new URL(registration.scope).pathname === SW_SCOPE ? registration : null;
}

function waitUntilActive(registration, timeoutMs = 15000) {
  if (registration.active) return Promise.resolve(registration.active);
  const worker = registration.installing || registration.waiting;
  if (!worker) return Promise.reject(new Error('SW_NOT_INSTALLED'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SW_TIMEOUT')), timeoutMs);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') { clearTimeout(timer); resolve(worker); }
      if (worker.state === 'redundant') { clearTimeout(timer); reject(new Error('SW_REDUNDANT')); }
    });
  });
}

async function enableNotifications() {
  const env = environment();
  if (!env.supported) throw new Error(env.isIOS && !env.standalone ? 'IOS_NOT_STANDALONE' : 'UNSUPPORTED');
  // iOS only shows the permission prompt when called directly from the tap, so ask first.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_DISMISSED');
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  await waitUntilActive(registration);
  const { publicKey } = await api('GET', '/push/public-key');
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  await api('POST', '/push/subscribe', { subscription: subscription.toJSON(), language: i18n.language });
}

async function disableNotifications() {
  const registration = await ownRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api('POST', '/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe();
  }
  await registration?.unregister();
}

function render(root, { background, device, server, note, busy }) {
  const lines = [];
  if (background) lines.push(t('statusBackground', { value: background }));
  lines.push(t('statusDevice', { value: device }));
  if (server) lines.push(t('statusServer', { value: server }));
  root.querySelector('[data-bgml-status]').textContent = lines.join('\n');
  root.querySelector('[data-bgml-note]').textContent = note || '';
  root.querySelectorAll('button').forEach(button => { button.disabled = Boolean(busy); });
}

async function describe() {
  const env = environment();
  let device;
  if (!env.supported) device = env.isIOS && !env.standalone ? t('deviceNeedsHomeScreen') : t('deviceUnsupported');
  else if (env.permission === 'denied') device = t('deviceDenied');
  else {
    const registration = await ownRegistration().catch(() => null);
    const subscription = await registration?.pushManager.getSubscription().catch(() => null);
    device = subscription && env.permission === 'granted' ? t('deviceOn') : t('deviceOff');
  }
  let server = '';
  try {
    const status = await api('GET', '/push/status');
    server = t('serverCount', { count: status.count, devices: status.devices.map(d => d.device).join(', ') || '-' });
  } catch (error) {
    server = messageFor(error);
  }
  let background;
  try {
    const { mode } = await api('GET', '/status');
    background = mode === 'in-process' ? t('backgroundReady') : t('backgroundProxyOnly');
  } catch (error) {
    background = messageFor(error);
  }
  return { background, device, server };
}

async function refresh(root, note) {
  render(root, { ...(await describe()), note });
}

function buildPanel() {
  const root = document.createElement('div');
  root.className = 'bgml-settings';
  root.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b data-bgml-text="title"></b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label bgml-toggle">
          <input type="checkbox" data-bgml-background>
          <span data-bgml-text="toggle"></span>
        </label>
        <p class="bgml-intro" data-bgml-text="introBackground"></p>
        <p class="bgml-intro" data-bgml-text="introPush"></p>
        <p class="bgml-hint" data-bgml-text="hintIOS"></p>
        <pre class="bgml-status" data-bgml-status></pre>
        <div class="bgml-actions">
          <button type="button" class="menu_button" data-bgml-action="enable" data-bgml-text="enable"></button>
          <button type="button" class="menu_button" data-bgml-action="test" data-bgml-text="test"></button>
          <button type="button" class="menu_button" data-bgml-action="disable" data-bgml-text="disable"></button>
        </div>
        <p class="bgml-note" data-bgml-note role="status" aria-live="polite"></p>
      </div>
    </div>`;
  root.querySelectorAll('[data-bgml-text]').forEach(node => { node.textContent = t(node.dataset.bgmlText); });
  root.querySelector('[data-bgml-status]').textContent = t('checking');

  const toggle = root.querySelector('[data-bgml-background]');
  toggle.checked = settings().backgroundEnabled !== false;
  toggle.addEventListener('change', () => {
    settings().backgroundEnabled = toggle.checked;
    context().saveSettingsDebounced();
  });

  const actions = {
    enable: async () => { await enableNotifications(); return t('enabled'); },
    test: async () => {
      const result = await api('POST', '/push/test');
      const ok = result.results.filter(item => item.ok).length;
      const extra = result.removed ? t('testRemoved', { count: result.removed }) : '';
      return ok ? t('testSent', { ok, total: result.results.length, extra }) : t('testNone', { extra });
    },
    disable: async () => { await disableNotifications(); return t('disabled'); },
  };

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-bgml-action]');
    if (!button) return;
    const action = actions[button.dataset.bgmlAction];
    render(root, { background: '', device: t('working'), server: '', busy: true });
    let note;
    try { note = await action(); } catch (error) { note = messageFor(error); }
    await refresh(root, note);
  });
  return root;
}

// ---------------------------------------------------------------------------------------

jQuery(async () => {
  try {
    const { getCurrentLocale } = await import('/scripts/i18n.js');
    i18n = createTranslator(getCurrentLocale());
  } catch {
    i18n = createTranslator(navigator.language);
  }

  const ctx = context();
  const events = ctx.eventTypes;
  ctx.eventSource.on(events.GENERATION_STARTED, onGenerationStarted);
  ctx.eventSource.on(events.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
  ctx.eventSource.on(events.GENERATION_STOPPED, onGenerationStopped);
  ctx.eventSource.on(events.GENERATION_ENDED, onGenerationEnded);
  ctx.eventSource.on(events.CHAT_CHANGED, () => { deferred.clear(); setTimeout(() => checkForResults(), 800); });
  ctx.eventSource.on(events.APP_READY, () => setTimeout(() => checkForResults(), 1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => checkForResults(), 800); });

  const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (container) {
    const panel = buildPanel();
    container.append(panel);
    await refresh(panel);
  }
});
