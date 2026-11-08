# Dev tools / 开发工具

Local-only helpers for testing background generation against a SillyTavern instance on your machine.
只在本机使用的辅助工具，用来在本机的酒馆上测试后台生成。

- `mock-llm.mjs` — a mock OpenAI-compatible model. `node dev-tools/mock-llm.mjs 8020`.
  It streams 20 short parts, one every 0.4 s, and logs whether each request **completed** or the **client aborted**.
  模拟 OpenAI 兼容模型：每 0.4 秒输出一段，共 20 段，并在日志里记录每个请求是“完整结束”还是“客户端中途断开”。
  Point SillyTavern's Chat Completion source "Custom (OpenAI-compatible)" at `http://127.0.0.1:8020/v1`.
  在酒馆里把 Chat Completion 来源设为“自定义（OpenAI 兼容）”，地址填 `http://127.0.0.1:8020/v1`。

- `caddy-proxy.mjs` — a tiny proxy in front of SillyTavern. `node dev-tools/caddy-proxy.mjs 8011 8000 [--no-rewrite]`.
  Opening `http://127.0.0.1:8011/__drop-generate` cuts the running generate connection, which simulates a phone that went to the background.
  Without `--no-rewrite` it also rewrites the generate request to the plugin (the reverse-proxy mode).
  放在酒馆前面的小代理：访问 `http://127.0.0.1:8011/__drop-generate` 会切断正在进行的生成连接，用来模拟手机切到后台；
  不加 `--no-rewrite` 时，它还会把生成请求改写给插件（即反向代理模式）。

Typical checks / 常用检查：
1. Send a message, reload the page after ~3 s → the mock completes all 20 parts, and reopening the chat offers to put the reply back.
   发送消息，约 3 秒后刷新页面 → 模拟模型完整输出 20 段，重新打开聊天时会提示放回。
2. Press Stop while generating → the mock logs "CLIENT ABORTED" and nothing is kept.
   生成中点“停止” → 模拟模型记录“客户端中途断开”，什么都不会保留。
3. Through the proxy, call `/__drop-generate` while generating → the page shows "still being generated", and the recovery prompt appears when it finishes.
   通过代理访问，在生成中调用 `/__drop-generate` → 页面提示“仍在后台生成”，完成后弹出放回提示。
