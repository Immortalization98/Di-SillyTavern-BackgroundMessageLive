# 后台生成与通知（Background Message Live）

[![test](https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive/actions/workflows/test.yml/badge.svg)](https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | **简体中文**

发出消息、锁上手机，回复照样会写完。

- **后台继续生成**：浏览器连接断开时（手机锁屏、切到别的 App、关掉页面），服务器会把这条回复继续生成完，而不是直接丢掉。
- **回来找回**：回到那个聊天时，会先问你怎么处理：放回聊天、复制、删除或稍后再说。
  - 原位置是半截回复，就替换它；
  - 原位置已经有另一条真实回复，绝不覆盖，而是作为新的一页（swipe）加进去。
- **不含内容的推送通知**：你不在时回复生成完，会收到“有一条回复已生成”这样的通知。通知**不包含任何聊天内容和角色名**，锁屏上不会露出隐私。
- **不需要反向代理，也不改写 `fetch`**：服务器插件在酒馆进程内部接管生成接口；浏览器端的扩展只监听酒馆事件，不会干扰其他观察或拦截请求的扩展。

> 已在 **SillyTavern 1.19.0**、Node 20 / 22 / 24 上测试。其他版本启动时会给出警告；如果生成接口的结构不同，插件会自动停用，不影响正常聊天。

## 目录

- [和同类项目的区别](#和同类项目的区别)
- [要求与限制](#要求与限制)
- [安装](#安装)
- [开启通知（iPhone 等）](#开启通知)
- [配置](#配置)
- [工作原理](#工作原理)
- [隐私与安全](#隐私与安全)
- [常见问题](#常见问题)
- [反向代理模式（备用）](#反向代理模式备用)
- [更新与卸载](#更新与卸载)
- [开发](#开发)
- [致谢](#致谢)

## 和同类项目的区别

下面这些项目解决的是同一类问题的不同部分，你也许更适合用它们：

| 项目 | 后台生成 | 页面关掉后的推送通知 | 接管请求的方式 |
| --- | --- | --- | --- |
| [SillyTavern-BackgroundGen](https://github.com/SAOCSB/SillyTavern-BackgroundGen) + [Server](https://github.com/SAOCSB/SillyTavern-BackgroundGen-Server) | ✅（Chat 和 Text Completion、群聊、无缝续传） | — | 在浏览器里改写 `window.fetch` |
| [SillyTavern-ResumableGen](https://github.com/Sakura-Byte/SillyTavern-ResumableGen) | ✅（无缝续传） | — | 在浏览器里改写 `window.fetch` |
| [SillyTavern-PushNotifications](https://github.com/SillyTavern/SillyTavern-PushNotifications)（官方） | — | 只在页面开着时有效 | — |
| **本项目** | ✅（OpenAI 兼容的 Chat Completion、单角色聊天） | ✅ Web Push，页面关掉也能收到，不含内容 | 在服务器进程内接管；浏览器只监听事件 |

如果你需要锁屏安全的通知，或者装了对 `fetch` 改写比较敏感的扩展，选本项目；如果你需要 Text Completion、群聊或生成中途无缝续传，选 BackgroundGen。

## 要求与限制

- **版本**：SillyTavern **1.19.x**（已在 1.19.0 上测试），需要开启服务器插件；Node **20 及以上**。
- **适用来源**：后台生成适用于 **Chat Completion** 中的 OpenAI 兼容来源，即 `custom`、`openai`、`openrouter`、`deepseek`。其他来源、Text Completion 和**群聊**的行为和原来完全一样（没有后台生成）。
- **适用的生成类型**：发送、重新生成、换页（swipe）、继续写。以下请求一概不接管：代替你说话（impersonate）、其他扩展发起的静默请求、预览、token 计数。
- **推送的前提**：推送通知需要 **HTTPS**。iPhone/iPad（iOS/iPadOS 16.4 及以上）必须先把酒馆**添加到主屏幕**，并从那个图标打开。
- **酒馆重启**：如果酒馆在生成过程中重启，这条回复会丢失（和现在一样）。已经生成完的回复保存在磁盘上，重启后仍可找回。
- **页面被冻结**：如果手机让连接一直保持着，但把页面冻结了，回复会被视为已送达，通常页面恢复后会自动接着显示完。只有冻结期间页面又被系统彻底关掉，这条回复才可能丢失。

## 安装

这个仓库**同时是**服务器插件和前端扩展，两边都要装。

### 1. 服务器插件

```bash
cd SillyTavern/plugins
git clone https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive.git
```

在 `config.yaml` 里开启服务器插件，然后重启酒馆：

```yaml
enableServerPlugins: true
```

服务器日志里应该出现：

```
[di-bgmessage-live] background generation (in-process) and push notifications ready; config: …/data/_di-bgmessage-live/config.json
```

如果显示的是 `proxy-only`，请看[常见问题](#常见问题)。

**Docker 部署**：`plugins` 目录需要挂载成卷，例如在 `docker-compose.yml` 里写 `./plugins:/home/node/app/plugins`。把仓库克隆到宿主机的这个目录，在挂载的 `config.yaml` 里设置 `enableServerPlugins: true`，然后重启容器。

**白名单**：插件会通过本机回环地址（`127.0.0.1`）调用酒馆自己的接口。如果你开启了 `whitelistMode` 并自定义了 `whitelist`，请保留 `127.0.0.1`（和 `::1`）。

### 2. 前端扩展

在酒馆里打开**扩展 → 安装扩展**，粘贴

```
https://github.com/Immortalization98/Di-SillyTavern-BackgroundMessageLive
```

选择“为所有用户安装”（或只为自己安装），然后刷新页面。扩展列表里会出现**后台生成与通知**面板，并显示“后台生成：已就绪（无需反向代理）”。

到这里后台生成就可以用了。通知是可选的，见下一节。

## 开启通知

在每台需要收通知的设备上操作：

1. **iPhone/iPad**：用 Safari 打开酒馆，点**分享 → 添加到主屏幕**，以后都从这个图标打开。安卓和电脑浏览器可以跳过这一步。
2. 打开**扩展 → 后台生成与通知**，点**开启通知**，在系统弹窗里选“允许”。
3. 点**发送测试通知**，然后锁屏或切到别的 App，几秒内应该会收到测试通知。

每台设备收到的通知语言，取决于开启通知时界面用的语言（英文或简体中文）。

## 配置

插件第一次启动时会创建 `data/_di-bgmessage-live/config.json`。它放在酒馆的数据目录里，所以更新插件不会覆盖它。修改后重启酒馆即可生效。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `vapidSubject` | `""` | 推送服务出问题时可以联系你的方式：`"mailto:you@example.com"` 或你网站的 `https://` 地址。留空时会改用本项目地址，并在日志里提醒。**请填写你自己的。** |
| `notificationTitle` | `"SillyTavern"` | 通知标题。建议保持中性，它会显示在锁屏上。 |
| `jobTimeoutMinutes` | `20` | 后台生成超过这么多分钟就取消（1–120）。 |
| `resultRetentionDays` | `7` | 生成完但一直没有放回的回复，过了这么多天自动删除（1–90）。 |
| `inProcessTakeover` | `true` | 在酒馆进程内接管生成接口。只有你想改用[反向代理模式](#反向代理模式备用)时才设为 `false`。 |

## 工作原理

```
浏览器（酒馆页面）                           酒馆服务器进程
───────────────────────                     ─────────────────────────────────────────
扩展：一次真实的发送 / 重新生成 / 换页 / 继续写，
  在 CHAT_COMPLETION_SETTINGS_READY 时
  → POST /api/plugins/di-bgmessage-live/jobs/register
酒馆：POST /api/backends/chat-completions/generate（请求不变）
                                             登录 / CSRF 中间件（不变）
                                             被包装的接口处理函数：
                                               没登记 → 交给原处理函数（和原来一样）
                                               已登记 → 后台任务：
                                                 回环调用原处理函数，
                                                 把流式结果转给浏览器；
                                                 浏览器断开 → 继续生成，保存结果，
                                                 发送不含内容的推送
扩展：回来后先询问，确认后才把保存的回复放进聊天
```

- **不读密钥、不写聊天文件**：插件不读取任何 API 密钥，也不写聊天文件。生成由酒馆自己的接口完成；你确认之后，由浏览器按酒馆正常的保存流程保存回复。
- **启动时自检**：插件启动时会检查能否接管生成接口。如果酒馆代码的结构不一样（例如升级之后），插件什么都不改，并报告 `proxy-only`。

## 隐私与安全

- **存储的数据**，全部在酒馆的数据目录里：
  - `data/_di-bgmessage-live/vapid.json`：服务器的推送密钥对（文件权限 0600，私钥不会离开服务器）；
  - `data/_di-bgmessage-live/config.json`：你的配置；
  - `data/<用户>/_di-bgmessage-live/push.json`：该用户的推送订阅（最多 5 台设备）；
  - `data/<用户>/_di-bgmessage-live/results/`：后台生成完的回复。放回聊天、删除或超过保留期后会被删除。
- **诊断记录**（只在浏览器里）：扩展会在浏览器的 `localStorage` 里保留本扩展最近 50 条记录（版本号、哪一步浏览器调用失败、错误名称），方便你用“复制诊断信息”附到问题反馈里。记录不包含聊天内容、角色名、聊天编号、账号名或服务器地址，推送地址只保留域名。在诊断窗口里点“清空记录”即可删除。
- **用户之间互相隔离**：所有接口都要求已登录的酒馆用户，并经过酒馆的 CSRF 校验；每个用户只能看到自己的任务、结果和设备。
- **通知不含内容**：只有一句固定的话，加上你配置的标题。
- **推送地址受限**：只允许苹果、谷歌、Mozilla 和微软的推送服务，服务器不会被诱导去访问其他地址。
- **服务器插件拥有完整的服务器权限**：请在安装前阅读代码。除 Node 标准库外，本插件没有任何运行时依赖。
- **自动更新**：酒馆默认在启动时用 git 自动更新插件（`enableServerPluginsAutoUpdate`）。如果你想先审阅每次更新，请关闭这一项。
- **报告漏洞**：请私下报告，见 [SECURITY.md](SECURITY.md)。

## 常见问题

| 看到的情况 | 处理方法 |
| --- | --- |
| 日志或面板显示 `proxy-only` | 酒馆生成接口的结构和插件预期的不一样，通常是版本不同。此时后台生成已停用，正常聊天不受影响。请附上你的酒馆版本提 issue，或改用[反向代理模式](#反向代理模式备用)。 |
| 面板提示“服务器上还没有安装或启用后台生成插件” | 漏了第 1 步，或者 `enableServerPlugins` 还是 `false`。重启后检查服务器日志。 |
| 面板提示“需要从主屏幕图标打开” | iPhone/iPad 上只有主屏幕网页应用才能收推送。 |
| 已经开启通知，却什么都没收到 | 检查系统设置里主屏幕应用或浏览器的通知权限，并确认酒馆是通过 HTTPS 访问的。面板上会显示服务器登记了几台设备。 |
| 回复没有被找回 | 后台生成只适用于单角色聊天中、OpenAI 兼容的 Chat Completion 来源，而且面板里“手机切走后继续生成回复”要处于开启状态。 |
| 安卓上开启通知失败（例如显示 `Error retrieving push subscription`） | 安卓上的 Chrome 和 Firefox 都通过谷歌的推送服务发送网页通知，手机需要有谷歌服务框架，并且能连上谷歌。基于系统 WebView 的浏览器完全不支持网页通知。没有通知时，后台生成照样可以用。 |

**反馈问题**：打开面板，点**复制诊断信息**，看一遍后贴到 issue 或 Discord 留言里。里面只有版本号、浏览器信息和它支持哪些功能，以及本扩展在这台设备上最近的报错，不含聊天内容。

## 反向代理模式（备用）

只有进程内接管不可用（显示 `proxy-only`）时才需要。做法是把 `POST /api/backends/chat-completions/generate` 改写给插件，其他请求保持不变。

Caddy（写在代理酒馆的那个站点块里）：

```caddy
@bgml_generate {
    method POST
    path /api/backends/chat-completions/generate
}
rewrite @bgml_generate /api/plugins/di-bgmessage-live/generate
```

nginx：

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

等插件显示 `in-process` 之后，可以把这条规则删掉；两者同时存在也是安全的。

## 更新与卸载

- **更新**：在 `plugins/Di-SillyTavern-BackgroundMessageLive` 里执行 `git pull`（或交给酒馆自动更新），在扩展面板里更新扩展，然后重启酒馆。
- **卸载**：在扩展面板里删除扩展，删除 `plugins/Di-SillyTavern-BackgroundMessageLive`，重启酒馆。如果需要，再删除 `data/_di-bgmessage-live` 和 `data/*/_di-bgmessage-live`。

## 开发

```bash
node --test
```

`dev-tools/` 里有两个辅助工具，用来在本机酒馆上测试后台生成：
- `mock-llm.mjs`：一个慢速流式输出的模拟 OpenAI 兼容模型；
- `caddy-proxy.mjs`：一个可以随时切断连接的小代理。

## 致谢

本项目由 Immortalization98 与 [Claude](https://www.anthropic.com/claude)（Anthropic）共同设计和编写，实现与测试借助 Claude Code 完成。
感谢 SillyTavern-BackgroundGen、SillyTavern-ResumableGen 和 SillyTavern-PushNotifications 的作者，是他们先在这个方向上做了探索。

## 许可证

[MIT](LICENSE) © 2026 Immortalization98
