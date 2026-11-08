# Changelog / 更新日志

## 1.0.0 — 2026-11-09

First public release. / 首个公开版本。

- Background generation for OpenAI-compatible Chat Completion sources in single-character chats: send, regenerate, swipe, continue keep running on the server when the browser disconnects.
  后台生成：单角色聊天、OpenAI 兼容的 Chat Completion 来源，发送 / 重新生成 / 换页 / 继续写在浏览器断开后继续在服务器上生成。
- Recovery prompt (put into chat / copy / delete / later) with non-destructive insertion.
  找回提示（放回聊天 / 复制 / 删除 / 稍后），放回时不覆盖已有内容。
- Content-free Web Push notifications (RFC 8291 / RFC 8292, Node standard library only), per-device language.
  不含内容的 Web Push 通知（RFC 8291 / 8292，只用 Node 标准库），按设备语言发送。
- In-process takeover of the generate route — no reverse proxy needed; optional reverse-proxy mode kept as a fallback.
  在酒馆进程内接管生成接口，无需反向代理；保留反向代理模式作为备用。
- English and Simplified Chinese UI. Admin config in `data/_di-bgmessage-live/config.json`.
  中英文界面；管理员配置位于 `data/_di-bgmessage-live/config.json`。
- Tested with SillyTavern 1.19.0 on Node 20 / 22 / 24.
  已在 SillyTavern 1.19.0、Node 20 / 22 / 24 上测试。
