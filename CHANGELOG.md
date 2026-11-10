# Changelog / 更新日志

## 1.1.0 — 2026-11-10

- "Copy diagnostics" in the panel: a per-device log of this extension's recent events (which browser call failed, error names, job registration and recovery outcomes, test-push results per device) plus versions and browser capabilities, ready to paste into a bug report. No chat content, names, chat ids or addresses; push endpoints are reduced to their host.
  面板新增“复制诊断信息”：记录本扩展在这台设备上最近的事件（哪一步浏览器调用失败、错误名称、生成登记和找回结果、各设备的测试推送结果），附上版本号和浏览器能力，可以直接贴进问题反馈。不含聊天内容、名字、聊天编号或地址，推送地址只保留域名。
- Unknown errors now point to "Copy diagnostics". README: Android notification requirements.
  未知错误会提示使用“复制诊断信息”；说明文档补充了安卓通知的前提条件。

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
