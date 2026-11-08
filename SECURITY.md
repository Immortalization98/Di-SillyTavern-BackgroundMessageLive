# Security policy / 安全策略

This project is a SillyTavern **server plugin**, so it runs with full privileges inside your SillyTavern server.
本项目是 SillyTavern 的**服务器插件**，在你的酒馆服务器里拥有完整权限。

## Reporting a vulnerability / 报告漏洞

Please **do not** open a public issue for security problems.
Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.

请**不要**为安全问题公开提 issue。请使用 GitHub 的私密报告功能：在本仓库点击 **Security → Report a vulnerability**。

Please include the SillyTavern version, the plugin version and steps to reproduce.
请附上酒馆版本、插件版本和复现步骤。

## Scope / 范围

In scope: anything that lets one SillyTavern user read or affect another user's jobs, results or push subscriptions; bypassing SillyTavern's login or CSRF protection through this plugin; making the server send requests to arbitrary hosts; leaking chat content through notifications or logs.

范围内：让一个酒馆用户读取或影响另一个用户的任务、结果或推送订阅；借助本插件绕过酒馆的登录或 CSRF 防护；让服务器向任意地址发送请求；通过通知或日志泄露聊天内容。
