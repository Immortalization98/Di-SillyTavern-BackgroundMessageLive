// Web Push sender built on node:crypto only (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID).
import crypto from 'node:crypto';

const CURVE = 'prime256v1';
const RECORD_SIZE = 4096;

export const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
export const fromB64u = (text) => Buffer.from(String(text), 'base64url');

/**
 * Push services we are willing to contact. A subscription endpoint is supplied by the browser,
 * but it reaches the server through a user request, so anything else is refused (no SSRF).
 */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isAllowedEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  return PUSH_HOSTS.some(pattern => pattern.test(url.hostname));
}

/** Validates a PushSubscription JSON and returns a normalised copy, or null. */
export function normaliseSubscription(input) {
  if (!input || typeof input !== 'object') return null;
  const { endpoint, keys } = input;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !isAllowedEndpoint(endpoint)) return null;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  const p256dh = fromB64u(keys.p256dh);
  const auth = fromB64u(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) return null;
  return { endpoint, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
}

export function generateVapidKeys() {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(fromB64u(privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

/** Builds the RFC 8292 `Authorization: vapid` header value for one push service origin. */
export function vapidAuthorization(endpoint, vapid, { subject, now = Date.now(), lifetimeSeconds = 12 * 3600 } = {}) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + lifetimeSeconds,
    sub: subject,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(vapid),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * RFC 8291 message encryption. `salt` and `senderPrivateKey` are injectable only for test vectors;
 * production calls always use fresh random values.
 */
export function encryptPayload(plaintext, subscriptionKeys, { salt = crypto.randomBytes(16), senderPrivateKey } = {}) {
  const uaPublic = fromB64u(subscriptionKeys.p256dh);
  const authSecret = fromB64u(subscriptionKeys.auth);
  const sender = crypto.createECDH(CURVE);
  if (senderPrivateKey) sender.setPrivateKey(senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
  if (data.length + 16 > RECORD_SIZE) throw new Error('Push payload too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * Sends one notification. Returns { ok, status, gone } — `gone` means the subscription is dead
 * (404/410) and should be removed. Never throws for HTTP errors; network errors propagate.
 */
export async function sendPush(subscription, payload, { vapid, subject, ttl = 24 * 3600, urgency = 'high', topic, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!isAllowedEndpoint(subscription.endpoint)) throw new Error('Push endpoint not allowed');
  const body = encryptPayload(JSON.stringify(payload), subscription.keys);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization(subscription.endpoint, vapid, { subject }),
  };
  if (topic) headers.Topic = topic;
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  return { ok: response.status >= 200 && response.status < 300, status: response.status, gone: response.status === 404 || response.status === 410 };
}
