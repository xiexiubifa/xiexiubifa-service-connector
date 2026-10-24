# 写作服务后端（server/）

Node.js 18+，没有运行时依赖。开发依赖只有官方 MCP TypeScript SDK（用于连接测试）。

```bash
npm install
npm test                       # 全部测试；Node 22+ 且有 Chrome/Chromium 时含浏览器测试（XXB_TEST_BROWSER 指定浏览器）
node bin/dev-server.cjs        # 本地演示服务：http://127.0.0.1:8787/mcp ，演示站 /demo-site/
node bin/dev-server.cjs --data .local/dev-store.json --step-delay 1000   # 重启后保留数据；放慢演示写作
node bin/dev-server.cjs --device-interval 1 --device-limit 200          # 测试用：授权码轮询间隔 1 秒，每分钟可发 200 个授权码
```

服务还没有部署到网上；这里的一切都在本机运行（见仓库首页的上线状态）。

| 文件 | 作用 |
| --- | --- |
| `src/service.cjs` | 组装与 HTTP 路由；`siteAction()` 给网站页面用 |
| `src/oauth.cjs`、`src/grants.cjs` | OAuth 2.1 授权服务器、连接与凭据 |
| `src/mcp.cjs`、`src/tools.cjs`、`src/present.cjs` | MCP 协议、工具定义与处理、结果文字 |
| `src/jobs.cjs` | 写作任务：租约、续写、取消、清理 |
| `src/disclosure.cjs` | 授权页面和 `get_service_info` 的说明内容 |
| `src/config.cjs`、`src/limits.cjs` | 设置与限流 |
| `src/store-memory.cjs`、`src/store-file.cjs` | 存储接口的内存实现和本地文件实现 |
| `src/node-http.cjs` | node:http 适配 |
| `web/consent-ui.js`、`web/consent-ui.css` | 授权页面和“已连接的 AI 助手”列表（网站页面引入） |
| `demo/` | 演示适配器（本地假数据）和演示站页面 |
| `tests/` | 测试：OAuth、MCP 协议、写作任务、恢复（重叠的继续请求、同一请求重试、换账号后的提示）、说明与措辞、官方 SDK 连接、浏览器 |

在本地用其他 MCP 客户端试：把 `http://127.0.0.1:8787/mcp` 加为远程 MCP 服务。授权页面在演示站：用任意 11 位手机号“登录”（不发短信），在演示站「会员中心」里可以模拟开通会员或体验结束。演示站和演示稿件都明确标注，不是 xiexiubifa.cn。

架构见 [../docs/architecture.md](../docs/architecture.md)，站点适配器接口见 [../docs/adapter.md](../docs/adapter.md)。
