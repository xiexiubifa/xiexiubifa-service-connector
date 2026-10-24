# 邪修笔法写作服务 · WorkBuddy 连接器与 AI 助手技能

> **尚未上线（Not deployed yet）。** 邪修笔法写作服务还没有部署：`https://mcp.xiexiubifa.cn/mcp` 只是计划使用的地址，现在连不上。在服务上线之前，这个仓库里的 WorkBuddy 连接器和 AI 助手技能都连不上任何服务，也不能写作、不会使用任何额度。现在能做的是用本仓库的本地演示环境把连接和写作流程完整走一遍（见“开发与测试”，演示数据都是假的）。服务上线后，[`release.json`](release.json) 里的 `service_status` 会从 `not_deployed` 改成 `deployed`，这段说明也会改掉。

用你自己的邪修笔法（[xiexiubifa.cn](https://xiexiubifa.cn/)）账号，在 AI 助手里写公文、讲话稿、总结、方案等中文材料，也能按意见改稿、智能润色、取得网站版式的 Word。稿件由网站按自己的流程生成（理解需求 → 基础设定 → 六模块提示词 → 文章），存进你网站账号的成稿记录；会员和额度按网站规则，由网站服务器核对。

## 里面有什么

| 路径 | 内容 |
| --- | --- |
| [`connector/`](connector/) | WorkBuddy 自定义连接器（MCP + Skill）：`connector-meta.json`、`mcp.json`、`icon.svg`、`skills/xiexiubifa-writing-tools/SKILL.md` |
| [`agent-skill/xiexiubifa-writing/`](agent-skill/xiexiubifa-writing/) | 给 AI 助手用的小技能（Agent Skills 格式）：`SKILL.md` + 只用 Python 标准库的脚本；WorkBuddy 也可以装 |
| [`server/`](server/) | 写作服务后端：MCP（streamable HTTP）、OAuth 2.1 账号连接（授权码 + PKCE、动态注册、设备授权）、可续写的写作任务；附本地演示适配器和演示站 |
| [`docs/`](docs/) | [架构](docs/architecture.md)、[工具说明](docs/tools.md)、[数据与费用说明](docs/data-and-fees.md)、[站点适配器接口](docs/adapter.md) |
| [`tools/check_release.py`](tools/check_release.py) | 发布检查（连接器规范、版本、服务地址、上线状态、凭据扫描）和打包 |

## 一句话安装通用 Skill

仓库发布到 `xiexiubifa/xiexiubifa-service-connector` 后，可把下面这一句交给支持 Skills CLI 的 AI 代理：

```bash
npx skills add xiexiubifa/xiexiubifa-service-connector --skill xiexiubifa-writing
```

这条命令安装客户端；写作服务的上线状态仍以 `release.json` 为准。WorkBuddy 的安装和调用还需在实际客户端验证，手动方式见下一节。

## 费用和数据（先看这里）

- **连接免费**，写作服务不另外收费。**写作、改稿、润色**和在网站上写一样，按网站会员规则使用你账号的额度；读取进度、成稿、Word 和账号状态不使用额度。付款只能由你本人在网站会员中心完成，AI 助手不能替你付款。
- 发送的内容：写作要求、你交给助手的素材、改稿和润色的文字，只用于生成和修改你的稿件。成稿存在你网站账号的成稿记录里。
- 第一次连接时，网站的授权页面会在你允许之前写明这些内容（提供方、发送和保存什么、保存多久、费用和当时的价格、你现在的会员状态、你的选择）。完整说明：[数据与费用说明](docs/data-and-fees.md)。

## 在 WorkBuddy 里使用（手动安装）

这个连接器**还没有上架 WorkBuddy 的连接器市场**，在市场里搜不到；下面是从 GitHub 手动安装的办法。再说一次：**服务上线之前，两种办法都连不上服务**，装好以后第一次写作会提示连不上。

**办法一：装 AI 助手技能（`xiexiubifa-writing`）**

1. 下载这个仓库发布页里的 `xiexiubifa-writing-skill-<版本>.zip`，或者直接用仓库里的 `agent-skill/xiexiubifa-writing/` 文件夹。
2. 在 WorkBuddy 新建一个对话，把 zip 拖进对话框，说“把这个技能安装到我的技能里”。WorkBuddy 让你手动装时：解压，把里面的 `xiexiubifa-writing` 文件夹整个放进 WorkBuddy 的用户技能目录（可以问 WorkBuddy“你的用户技能目录在哪里？”），然后新开一个对话。
3. 核实：问“你现在有哪些技能？”，要能看到 `xiexiubifa-writing`；再说“运行 xiexiubifa-writing 的 doctor”，结果里 `skill_version` 是这个版本，`service_status` 是服务的上线状态。
4. 电脑上需要 Python 3.8 或更高版本（只用 Python 自带的功能）。第一次写的时候，技能给出一个链接和 8 位授权码：在平时用的浏览器里打开链接，核对授权码，看完说明后点「允许连接」，然后回到对话说“好了”。

**办法二：手动添加 MCP 服务（自定义连接器）**——未经测试

[WorkBuddy 官方说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)给出的入口是「专家·技能·连接器」→「连接器」→ 右上角「自定义连接器」。该页面同时链接了 [MCP 配置说明](https://www.codebuddy.cn/docs/ide/User-guide/MCP)。在配置中的 `mcpServers` 里**加上**（不要覆盖已有的）下面这一项，内容和 [`connector/mcp.json`](connector/mcp.json) 相同；远程配置格式也见[官方开发文档](https://open.workbuddy.cn/docs/connector)：

```json
"xiexiubifa-writing": { "type": "streamableHttp", "url": "https://mcp.xiexiubifa.cn/mcp", "timeout": 30000 }
```

不需要也不要填写 Token：服务用 OAuth，第一次调用时 WorkBuddy 应该在浏览器里打开邪修笔法网站的授权页面。想让 WorkBuddy 也读到连接器的使用说明，可以按办法一的方式把 `connector/skills/xiexiubifa-writing-tools/` 装成技能。这条路还没有和真实的 WorkBuddy 一起验证过：自定义 MCP 是否会走 OAuth、回调能否回到 WorkBuddy，都要等服务上线后实际确认。

## 用户怎样连接

**WorkBuddy 连接器**（上架以后）：在「连接器」里找到「邪修笔法写材料」，点「连接」。WorkBuddy 用你平时用的浏览器打开邪修笔法网站的授权页面：已经登录就直接看到说明；没登录就先用手机号登录网站，登录后会回到这一步。看完点「允许连接」，浏览器回到 WorkBuddy，之后在后台使用。

**AI 助手技能（脚本）**：见上面的办法一。其他能运行脚本的 AI 助手也一样：把 `agent-skill/xiexiubifa-writing/` 装进助手的技能目录。

**支持 MCP 的 AI 助手**：添加远程 MCP 服务 `https://mcp.xiexiubifa.cn/mcp`（streamable HTTP），助手自己的 OAuth 流程会在浏览器里打开同一个授权页面。

**连接的是哪个账号**：授权页面会显示要连接的账号（手机号前三位和后四位）——就是这个浏览器里现在登录的账号。浏览器里登录的是别的账号时，在页面上点「换一个账号」（或先在网站上退出），用要连接的手机号登录后会回到这一步。

连接可以随时在网站「会员中心 → 已连接的 AI 助手」断开，断开后立即失效。

技能说明的默认用法是：安装或连接服务后，普通的“帮我写一份……”“直接帮我写”交给邪修笔法；明确说这次不用时尊重用户选择。实际触发由 AI 代理决定，普通 Skill 不能从技术上禁止代理自行写作。

## 会员、额度和恢复

- **开通会员或额度用完**：结果会带上网站的原话、账号（手机号前三位和后四位）和会员中心链接。在平时用的浏览器里打开会员中心，先确认登录的是同一个账号，再开通；然后让助手接着写（`continue_writing` / 脚本的 `continue`），从停下的那一步继续，已完成的步骤不会重复扣额度。请求保留 30 天。
- **没收到回复**（网络中断、超时）：请求带着自己的编号保存在电脑上（脚本），或者由 AI 助手带着 `request_id` 重试（MCP）。再问一次时，服务交回已经开始的同一个任务，不会再写一篇、不会重复使用额度；结果不确定时，提示会如实说“不确定网站有没有开始写”。
- **MCP 重试的边界**：`request_id` 在工具参数里是可选项。MCP 宿主如果不发送它，或重试时换了编号，仍可能创建第二个任务。Python 客户端会自动保存并复用编号；真实 WorkBuddy 的行为仍待联调。
- **连接过期或被断开**：助手会提示重新连接；用**同一个手机号**连接后，同一个任务可以接着做。用别的账号连接时，提示会说清现在连接的是哪个账号、原来的任务为什么找不到，不会在新账号下悄悄重写一遍。

## 开发与测试

需要 Node.js 18+ 和 Python 3.8+。

```bash
cd server && npm install && npm test          # 服务端测试（含官方 MCP SDK 客户端的连接测试；Node 22+ 且有 Chrome 时含浏览器测试）
node bin/dev-server.cjs                        # 本地演示：MCP 端点 http://127.0.0.1:8787/mcp，演示站 /demo-site/
cd .. && python3 -m unittest discover -s agent-skill/tests   # 技能脚本测试（离线测试 + 会启动本地演示服务的测试）
python3 tools/check_release.py                 # 发布检查，并在 dist/ 生成连接器和技能的 zip
```

用本地演示服务试技能：`XIEXIUBIFA_SERVICE=http://127.0.0.1:8787/mcp python3 agent-skill/xiexiubifa-writing/scripts/xiexiubifa.py write --request "帮我写一份通知"`。

本地演示用的是**演示适配器**：账号、会员、额度和稿件都是本地假数据（稿件明确标着“演示稿”），不连接 xiexiubifa.cn。真实服务通过站点适配器运行网站自己的写作和会员代码；站点适配器和网站源码不在这个仓库里（接口见 [docs/adapter.md](docs/adapter.md)）。

## English summary

**Not deployed yet.** The writing service has not been deployed; `https://mcp.xiexiubifa.cn/mcp` is only the planned address and does not answer. Until it does, the WorkBuddy connector and the agent skill in this repository cannot connect to anything (nothing is written and no quota is used). `release.json` (`service_status`) records the status.

A writing service for **xiexiubifa.cn** (邪修笔法): a WorkBuddy custom MCP connector, a small Agent Skill for AI agents, and the backend they talk to. The connector is not listed in WorkBuddy's connector marketplace; install the agent skill into WorkBuddy by hand, or add the MCP server as a custom connector (untested). People connect their existing site account in their everyday browser (OAuth 2.1 with PKCE and dynamic client registration for MCP clients; RFC 8628 device authorization for the script-based skill), read a first-use disclosure of data and fees, and allow or refuse; the consent page shows which account is being connected and lets the person switch. The site's own membership, quota and writing code decide every request; drafts are the site's own and are saved to the person's site history. A request stopped for membership or quota is kept and continues from the refused step. The Python client keeps and reuses a request id. MCP hosts must send and reuse the optional request_id to obtain the same recovery behaviour; a host that omits it can still create a second job after a lost reply. The backend here runs locally with a clearly labelled demo adapter; the adapter that runs the site's code is deployment-specific and not part of this repository.
