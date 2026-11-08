import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  b64u, fromB64u, encryptPayload, generateVapidKeys, isAllowedEndpoint,
  normaliseSubscription, sendPush, vapidAuthorization,
} from '../server/webpush.mjs';

// RFC 8291 Appendix A example values.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Independent receiver-side implementation (user agent role) used to check our sender. */
function decrypt(body, uaPrivate, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 0x02, 'last record delimiter');
  return padded.subarray(0, end).toString();
}

test('RFC 8291 Appendix A: receiver decrypts the published example body', () => {
  assert.equal(decrypt(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.authSecret)), RFC.plaintext);
});

test('RFC 8291 Appendix A: sender produces the published body byte for byte', () => {
  const body = encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.authSecret }, {
    salt: fromB64u(RFC.salt), senderPrivateKey: fromB64u(RFC.asPrivate),
  });
  assert.equal(b64u(body), RFC.body);
});

test('random keys round-trip and differ every call', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };
  const payload = JSON.stringify({ title: 'SillyTavern', body: '有一条回复已生成' });
  const a = encryptPayload(payload, keys);
  const b = encryptPayload(payload, keys);
  assert.notEqual(b64u(a), b64u(b));
  assert.equal(decrypt(a, ua.getPrivateKey(), auth), payload);
});

test('payload larger than one record is refused', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  assert.throws(() => encryptPayload('x'.repeat(5000), { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) }), /too large/);
});

test('VAPID header is a valid ES256 JWT for the endpoint origin', () => {
  const vapid = generateVapidKeys();
  const value = vapidAuthorization('https://web.push.apple.com/QWERTY', vapid, { subject: 'mailto:admin@example.com', now: 1_800_000_000_000 });
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(value);
  assert.ok(match);
  const [, h, c, s, k] = match;
  assert.equal(k, vapid.publicKey);
  assert.deepEqual(JSON.parse(fromB64u(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(fromB64u(c));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:admin@example.com');
  assert.equal(claims.exp, 1_800_000_000 + 12 * 3600);
  const pub = fromB64u(vapid.publicKey);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s)));
});

test('only real push services are accepted as endpoints', () => {
  for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.ok(isAllowedEndpoint(ok), ok);
  }
  for (const bad of ['http://web.push.apple.com/x', 'https://127.0.0.1/x', 'https://web.push.apple.com.evil.test/x', 'https://evil.test/web.push.apple.com', 'https://web.push.apple.com:8443/x', 'https://user@web.push.apple.com/x', 'not a url', 'https://localhost/x']) {
    assert.ok(!isAllowedEndpoint(bad), bad);
  }
});

test('subscription validation rejects malformed keys', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const good = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
  assert.deepEqual(normaliseSubscription(good), good);
  assert.equal(normaliseSubscription({ ...good, endpoint: 'https://evil.test/x' }), null);
  assert.equal(normaliseSubscription({ ...good, keys: { ...good.keys, auth: b64u(crypto.randomBytes(8)) } }), null);
  assert.equal(normaliseSubscription({ ...good, keys: { ...good.keys, p256dh: b64u(crypto.randomBytes(65)) } }), null);
  assert.equal(normaliseSubscription(null), null);
});

test('sendPush posts an encrypted body with the required headers and reports gone subscriptions', async () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: calls.length === 1 ? 201 : 410 }; };
  const vapid = generateVapidKeys();
  const first = await sendPush(subscription, { title: 't', body: 'b' }, { vapid, subject: 'mailto:admin@example.com', fetchImpl });
  assert.deepEqual(first, { ok: true, status: 201, gone: false });
  const { headers, body, method, redirect } = calls[0].init;
  assert.equal(method, 'POST');
  assert.equal(redirect, 'error');
  assert.equal(headers['Content-Encoding'], 'aes128gcm');
  assert.equal(headers.TTL, '86400');
  assert.match(headers.Authorization, /^vapid t=/);
  assert.deepEqual(JSON.parse(decrypt(body, ua.getPrivateKey(), auth)), { title: 't', body: 'b' });
  const second = await sendPush(subscription, { title: 't' }, { vapid, subject: 'mailto:admin@example.com', fetchImpl });
  assert.deepEqual(second, { ok: false, status: 410, gone: true });
  await assert.rejects(sendPush({ ...subscription, endpoint: 'https://evil.test/x' }, {}, { vapid, subject: 's', fetchImpl }), /not allowed/);
});
