# 工具说明（MCP）

端点：`https://mcp.xiexiubifa.cn/mcp`（streamable HTTP；OAuth 2.1，范围 `write`、`drafts:read`、`account:read`）。**服务尚未上线**，这个地址现在连不上（见仓库首页）。每个结果都有给人看的文字（`content`）和同样内容的结构化字段（`structuredContent`，其中 `status` 必有；写作任务的结果还有 `account`：连接的账号，手机号前三位和后四位）。

| 工具 | 作用 | 主要参数 | 使用额度 | 范围 |
| --- | --- | --- | --- | --- |
| `write_material` | 写一篇材料 | `request`（必填）、`material`、`title`、`words`、`level`、`audience`、`purpose`、`speaker`、`doc_type`、`mode`（`standard`/`quick`）、`deep_thinking`、`request_id` | 是 | write |
| `get_writing_result` | 查看进度和结果（只读取） | `job_id`、`wait_seconds`（0–25，默认 20） | 否 | write |
| `continue_writing` | 停下的任务接着做 | `job_id`，可补充 `title`、`words`、`level`、`audience`、`purpose`、`speaker`、`material` | 接下来的步骤照常使用 | write |
| `cancel_writing` | 取消任务 | `job_id`、`delete_saved_input` | 否 | write |
| `revise_draft` | 在成稿上改出新的一稿 | `record_id`、`instruction`、`version`、`deep_thinking`、`request_id` | 是 | write |
| `polish_text` | 智能润色（两个版本） | `text`、`requirements`、`emphasis`、`strength`、`deep_thinking`、`request_id` | 是 | write |
| `get_account_status` | 会员等级、剩余额度、到期时间、会员中心位置 | — | 否 | account:read |
| `list_drafts` | 成稿记录 | `limit` | 否 | drafts:read |
| `get_draft` | 读取一篇成稿 | `record_id`、`version` | 否 | drafts:read |
| `get_word_file` | 网站版式 Word（以文件资源返回） | `record_id`、`version` | 否 | drafts:read |
| `list_document_types` | 文种目录 / 某文种的结构和文风 | `doc_type` | 否 | — |
| `get_service_info` | 提供方、数据、保存期限、费用、断开和删除 | — | 否 | — |

## 写作任务的 status

| status | 意思 | 接下来 |
| --- | --- | --- |
| `done` | 网站写好了。`draft`（或润色的 `variants`）是网站返回的原文，`source` 是来源行 | 原样交付 |
| `running` | 还在写 | `get_writing_result`；带 `stalled: true` 时处理中断了，用 `continue_writing` |
| `needs_membership` | 网站要开通会员、体验结束或额度用完。`site_message` 是网站原话，`links` 有会员中心 | 用户在网站开通后 `continue_writing` |
| `needs_more_info` | 网站要先补充设定，`missing` 列出缺的项 | `continue_writing` 带上补充的字段 |
| `needs_login` | 网站不再确认这个账号的登录 | 重新连接后 `continue_writing` |
| `temporarily_failed` | 暂时没完成（已自动重试两次） | 稍后 `continue_writing` |
| `account_disabled` | 账号被网站停用 | 联系网站 |
| `failed` | 其他原因没写成，`site_message` 说明原因 | — |
| `cancelled` / `deleted` | 已取消 / 已删除保存的内容 | — |
| `cleared` | 带 `request_id` 的任务已经结束，过了保留期限（`cleared_reason: expired`）或已按要求删除（`deleted`）；`records` 是它的成稿记录 | 用 `get_draft` 读取成稿 |
| `connection_closed` | 写作中连接被断开，任务没有继续 | 重新连接后可以再开始 |

没有成稿的结果里不会有稿件文字。`kept_until` 是请求保留到的时间；`done_steps` 是已完成、不会重复扣额度的步骤。开始写的那次结果会写明由网站写、按网站会员规则使用哪个账号的额度。

## 重试同一个请求（`request_id`）

`write_material`、`revise_draft`、`polish_text` 可以带 `request_id`（8–80 位字母、数字、`-` 或 `_`），每个新请求用一个新编号。同一个账号再次发来同一个 `request_id` 和同样的内容时，服务交回已经开始的那个任务（`request_reused: true`），不会再写一篇、不会再使用额度——没收到上一次的结果时就这样重试。同一个编号配不同的内容会被拒绝（`REQUEST_ID_REUSED`），不会开始写。任务删除或过期后，这个编号还会被认出来 30 天（结果 `cleared`）。编号只在一个账号内有效：换了账号，同一个编号是新的请求。

两个同时到达的 `continue_writing` 只会让任务重新开始一次；另一个返回任务当时的状态。

## 错误

- 没有或无效的连接凭据：HTTP 401，`WWW-Authenticate` 里有 `resource_metadata`（客户端据此重新连接）。
- 连接缺少某个范围：HTTP 403，`error="insufficient_scope"`。
- 参数不对：工具结果 `isError: true`，`status: invalid_arguments`，文字说明哪里不对。
- 未知工具：JSON-RPC 错误 `-32602`。
- `JOB_NOT_FOUND`：现在连接的账号下没有这个任务。文字会写明现在连接的账号；任务只属于开始它的账号，常见原因是重新连接时用了另一个手机号。
- 写作类工具出现意外错误时，结果带 `outcome: unknown`，文字如实说不确定网站有没有开始写，以及怎样确认（带了 `request_id` 时用同一个编号再调用一次）。
