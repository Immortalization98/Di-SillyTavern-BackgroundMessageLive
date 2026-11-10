# Background Message Live for SillyTavern

[![test](https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive/actions/workflows/test.yml/badge.svg)](https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

Send a message, lock your phone, and the reply still gets written.

- **Keeps generating in the background.** If the browser disconnects (phone locked, app switched, tab closed), the server finishes the reply instead of throwing it away.
- **Recovers the reply.** When you come back to that chat you are asked before anything is put into it: *Put into chat / Copy / Delete / Later*. A half-finished reply is replaced; a different real reply is never overwritten (the result becomes a new swipe instead).
- **Content-free push notifications.** When a reply finishes while you are away, you get a notification such as "A reply is ready". It never contains any chat text or character name, so nothing private shows on a lock screen.
- **No reverse proxy needed, no `fetch` patching.** The server plugin takes over SillyTavern's generate route inside the server process. The browser-side extension only listens to SillyTavern events, so it does not interfere with other extensions that observe or intercept requests.

> Tested with **SillyTavern 1.19.0** on Node 20 / 22 / 24. Other versions start with a warning and stay inactive if the generate route looks different.

## Contents

- [How it compares](#how-it-compares)
- [Requirements and limits](#requirements-and-limits)
- [Install](#install)
- [Turn on notifications (iPhone and others)](#turn-on-notifications)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Reverse-proxy mode (fallback)](#reverse-proxy-mode-fallback)
- [Update and uninstall](#update-and-uninstall)
- [Development](#development)
- [Acknowledgements](#acknowledgements)

## How it compares

Other projects solve parts of the same problem, and you may prefer them:

| Project | Background generation | Push notifications when the page is closed | How requests are taken over |
| --- | --- | --- | --- |
| [SillyTavern-BackgroundGen](https://github.com/SAOCSB/SillyTavern-BackgroundGen) + [Server](https://github.com/SAOCSB/SillyTavern-BackgroundGen-Server) | ✅ (Chat & Text Completion, group chats, seamless resume) | — | wraps `window.fetch` in the browser |
| [SillyTavern-ResumableGen](https://github.com/Sakura-Byte/SillyTavern-ResumableGen) | ✅ (seamless resume) | — | wraps `window.fetch` in the browser |
| [SillyTavern-PushNotifications](https://github.com/SillyTavern/SillyTavern-PushNotifications) (official) | — | only while the page is open | — |
| **This project** | ✅ (OpenAI-compatible Chat Completion, single-character chats) | ✅ Web Push, works with the page closed, no content | server-side, in-process; the browser only listens to events |

Choose this one if you want lock-screen-safe notifications, or if you run extensions that are sensitive to `fetch` wrapping. Choose BackgroundGen if you need Text Completion, group chats or seamless mid-stream resume.

## Requirements and limits

- SillyTavern **1.19.x** (tested on 1.19.0) with server plugins enabled. Node **20 or newer**.
- Background generation works for **Chat Completion** with OpenAI-compatible sources: `custom`, `openai`, `openrouter`, `deepseek`. Other sources, Text Completion and **group chats** behave exactly as before (no background generation).
- Covered generation types: send, regenerate, swipe, continue. Impersonate, quiet/background prompts of other extensions, previews and token counting are never touched.
- Push notifications need **HTTPS** (a secure context). On iPhone/iPad (iOS/iPadOS 16.4+) SillyTavern must be **added to the Home Screen** and opened from that icon.
- If SillyTavern restarts while a reply is being generated, that reply is lost (same as today). Finished replies are kept on disk and survive restarts.
- If a phone keeps the connection open but freezes the page, the reply counts as delivered; it normally continues to appear when the page wakes up. Only if the system kills the frozen page can that reply be lost.

## Install

The repository is **both** a server plugin and a UI extension. Install it in both places.

### 1. Server plugin

```bash
cd SillyTavern/plugins
git clone https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive.git
```

In `config.yaml`, enable server plugins and restart SillyTavern:

```yaml
enableServerPlugins: true
```

The server log should show:

```
[di-bgmessage-live] background generation (in-process) and push notifications ready; config: …/data/_di-bgmessage-live/config.json
```

If it says `proxy-only` instead, see [Troubleshooting](#troubleshooting).

**Docker:** the `plugins` folder must be a volume (for example `./plugins:/home/node/app/plugins` in `docker-compose.yml`). Clone into the host folder, set `enableServerPlugins: true` in your mounted `config.yaml`, and restart the container.

**Whitelist:** the plugin calls SillyTavern's own endpoint over loopback (`127.0.0.1`). If you use `whitelistMode` with a custom `whitelist`, keep `127.0.0.1` (and `::1`) in it.

### 2. UI extension

In SillyTavern open **Extensions → Install extension**, paste

```
https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive
```

and choose "Install for all users" (or just for yourself). Reload the page. The panel **Background Message Live** appears in the extensions list and shows `Background generation: ready (no reverse proxy needed)`.

That's all for background generation. Notifications are optional, see below.

## Turn on notifications

On each device that should receive notifications:

1. **iPhone/iPad:** open SillyTavern in Safari, tap **Share → Add to Home Screen**, and from now on open it from that icon. (Android/desktop browsers can skip this.)
2. Open **Extensions → Background Message Live**, tap **Turn on notifications** and allow notifications in the system prompt.
3. Tap **Send a test notification**, then lock the phone or switch apps. A test notification should arrive within a few seconds.

Each device receives notifications in the language the UI had when notifications were turned on (English or Simplified Chinese).

## Configuration

On first start the plugin creates `data/_di-bgmessage-live/config.json` (inside SillyTavern's data folder, so plugin updates never overwrite it). Edit it and restart SillyTavern.

| Key | Default | Meaning |
| --- | --- | --- |
| `vapidSubject` | `""` | Contact that push services may use if something goes wrong: `"mailto:you@example.com"` or an `https://` URL of your site. When empty, the project URL is used and a warning is logged. **Please set your own.** |
| `notificationTitle` | `"SillyTavern"` | Title of notifications. Keep it neutral — it is visible on the lock screen. |
| `jobTimeoutMinutes` | `20` | A background reply is cancelled after this many minutes (1–120). |
| `resultRetentionDays` | `7` | Finished replies that were never put back are deleted after this many days (1–90). |
| `inProcessTakeover` | `true` | Take over the generate route inside SillyTavern. Set to `false` only if you prefer [reverse-proxy mode](#reverse-proxy-mode-fallback). |

## How it works

```
Browser (SillyTavern page)                 SillyTavern server process
───────────────────────────                ───────────────────────────────────────────────
extension: on CHAT_COMPLETION_SETTINGS_READY
  of a real send/regenerate/swipe/continue
  → POST /api/plugins/di-bgmessage-live/jobs/register
SillyTavern: POST /api/backends/chat-completions/generate   (unchanged request)
                                           login / CSRF middlewares (unchanged)
                                           wrapped route handler:
                                             not registered → original handler (as before)
                                             registered → background job:
                                               loopback call to the original handler,
                                               stream copied to the browser,
                                               browser gone → keeps running, result saved,
                                               content-free Web Push sent
extension: on return, asks before putting the saved reply into the chat
```

- The plugin never reads API keys and never writes chat files. SillyTavern's own endpoint does the generation, and the browser saves the reply through SillyTavern's normal save path after you confirm.
- The route takeover is checked at start-up. If SillyTavern's code looks different (for example after an upgrade), nothing is changed and the plugin reports `proxy-only`.

## Privacy and security

- **Stored data**, all inside SillyTavern's data folder:
  - `data/_di-bgmessage-live/vapid.json`: the server's push key pair (file mode 0600; the private key never leaves the server);
  - `data/_di-bgmessage-live/config.json`: your settings;
  - `data/<user>/_di-bgmessage-live/push.json`: that user's push subscriptions (up to 5 devices);
  - `data/<user>/_di-bgmessage-live/results/`: replies finished in the background, deleted when put back, dismissed, or after the retention period.
- **Diagnostics log** (browser only): the extension keeps the last 50 events of this extension (versions, which browser call failed, error names) in the browser's `localStorage`, so you can attach them to a bug report with "Copy diagnostics". It never contains chat text, character names, chat ids, account names or the server address; push endpoints are reduced to their host name. "Clear log" in the diagnostics window deletes it.
- **Users are isolated.** Every API needs a logged-in SillyTavern user, passes SillyTavern's CSRF check, and only sees that user's jobs, results and devices.
- **Notifications carry no content**: only a fixed sentence and your configured title.
- **Push endpoints are restricted** to the Apple, Google, Mozilla and Microsoft push services, so the server cannot be tricked into sending requests elsewhere.
- **Server plugins run with full server privileges.** Read the code before installing; it has no runtime dependencies besides Node's standard library.
- SillyTavern updates plugins with git on start-up by default (`enableServerPluginsAutoUpdate`). Disable that if you prefer to review every update.
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Log or panel says `proxy-only` | SillyTavern's generate route looks different from what the plugin expects (usually another version). Background generation is off; chatting is unaffected. Open an issue with your SillyTavern version, or use [reverse-proxy mode](#reverse-proxy-mode-fallback). |
| Panel says "The server plugin is not installed or not enabled" | Step 1 is missing or `enableServerPlugins` is `false`. Check the server log after restart. |
| "must be opened from the Home Screen icon" | On iPhone/iPad push only works in a Home Screen web app. |
| Notifications turned on but nothing arrives | Check the system notification settings for the Home Screen app / browser, and that SillyTavern is served over HTTPS. The panel shows how many devices the server knows. |
| Replies are not recovered | Background generation applies only to OpenAI-compatible Chat Completion sources in single-character chats, with the panel toggle "Keep generating when I leave the page" on. |
| Android: turning on notifications fails (for example `Error retrieving push subscription`) | On Android, Chrome and Firefox deliver web push through Google's push service, so the phone needs Google Play services and access to Google. Browsers built on Android System WebView do not support web push at all. Background generation still works without notifications. |

**Reporting a problem:** open the panel, tap **Copy diagnostics**, check the text and paste it into your issue or Discord message. It lists versions, your browser and what it supports, and recent errors of this extension on this device — no chat content.

## Reverse-proxy mode (fallback)

Only needed if the in-process takeover is unavailable (`proxy-only`). Rewrite `POST /api/backends/chat-completions/generate` to the plugin, keep everything else unchanged.

Caddy (inside the site block that proxies SillyTavern):

```caddy
@bgml_generate {
    method POST
    path /api/backends/chat-completions/generate
}
rewrite @bgml_generate /api/plugins/di-bgmessage-live/generate
```

nginx:

```nginx
location = /api/backends/chat-completions/generate {
    if ($request_method = POST) {
        rewrite ^ /api/plugins/di-bgmessage-live/generate break;
    }
    proxy_pass http://127.0.0.1:8000;
    proxy_buffering off;
    proxy_set_header Host $host;
}
```

Remove the rule again once the plugin reports `in-process`; both can coexist safely.

## Update and uninstall

- **Update:** `git pull` inside `plugins/Di-SillyTavern-BackgroundMessageLive` (or let SillyTavern auto-update it), update the extension from the Extensions panel, restart SillyTavern.
- **Uninstall:** delete the extension in the Extensions panel, delete `plugins/Di-SillyTavern-BackgroundMessageLive`, restart. Optionally delete `data/_di-bgmessage-live` and `data/*/_di-bgmessage-live`.

## Development

```bash
node --test
```

`dev-tools/` contains a mock OpenAI-compatible model that streams slowly (`mock-llm.mjs`) and a small proxy that can cut connections on demand (`caddy-proxy.mjs`), used to test background generation against a local SillyTavern.

## Acknowledgements

Designed and written by Immortalization98 together with [Claude](https://www.anthropic.com/claude) (Anthropic), using Claude Code for implementation and testing.
Thanks to the authors of SillyTavern-BackgroundGen, SillyTavern-ResumableGen and SillyTavern-PushNotifications for exploring this space first.

## License

[MIT](LICENSE) © 2026 Immortalization98
