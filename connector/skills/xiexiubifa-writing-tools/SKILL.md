---
name: xiexiubifa-writing-tools
display_name: 邪修笔法写材料
display_name_en: Xiexiubifa Writing
description: 邪修笔法写材料连接器的使用说明。用户连接了自己的邪修笔法（xiexiubifa.cn）账号来写材料：写公文（通知、请示、报告、函、纪要等）、讲话稿、致辞、工作总结、述职报告、工作方案、调研报告、信息简报、心得体会、宣传稿等中文材料，以及改稿、润色、取 Word 时使用 write_material、get_writing_result、continue_writing 等工具；“帮我写一份……”“直接帮我写”这类日常的写作请求也用它们，用户明确表示这次不用邪修笔法时按用户的选择。说明每种结果的意思、连接和开通会员后怎样接着写、费用和数据。
description_zh: 用你自己的邪修笔法账号写公文、讲话稿、总结、方案等中文材料，改稿、润色、取 Word；按网站会员规则使用额度。
description_en: Use your own xiexiubifa.cn account to write, revise and polish Chinese documents; uses your membership quota on the site.
examples_zh:
  - "用邪修笔法帮我写一份街道冬季安全生产工作方案，1500字左右"
  - "把这份年终工作总结交给邪修笔法润色一下"
  - "我的邪修笔法会员还剩多少额度？"
examples_en:
  - "Use Xiexiubifa to draft a winter work-safety plan for our subdistrict"
  - "Polish this year-end work summary with Xiexiubifa"
  - "How much of my Xiexiubifa quota is left?"
version: 3.0.1
author: 邪修笔法
---

# 邪修笔法写材料（连接器）

这个连接器把用户自己的邪修笔法（xiexiubifa.cn）账号接到 WorkBuddy。写作需求发给邪修笔法的写作服务，网站按自己的流程写（理解需求 → 基础设定 → 六模块提示词 → 文章），返回网站写的原文，同时存进用户网站账号的成稿记录。会员和额度按网站规则，由网站服务器核对。

## 什么时候用

- 用户连接这个连接器，就是为了用邪修笔法写材料。日常的写作请求——“帮我写一份……”“直接帮我写”“你直接写吧”——是让你动手写这份材料，照常调用 `write_material`。
- 用户明确表示这次不用邪修笔法（不用这个网站或服务），按用户的选择来；那样写出来的稿子不是邪修笔法网站写的，交付时如实说明。

## 费用和服务，先说清楚

第一次替用户调用写作工具之前（以及用户看起来不清楚的时候），用一两句话告诉用户：这篇交给邪修笔法网站写，和在网站上写一样，按网站会员规则使用他账号的额度；连接本身免费，付款只能由用户本人在网站会员中心完成。`write_material` 开始写时，结果文字里也会写明用的是哪个账号（手机号前三位和后四位）。

## 连接账号（第一次，以及断开或过期之后）

- 连接在 WorkBuddy 的「连接器」里完成：找到「邪修笔法写材料」，点「连接」。WorkBuddy 会用平时用的浏览器打开邪修笔法网站的授权页面。
- 网站上已经登录的话，直接看到授权页面；没登录就先用手机号登录网站，登录后会回到这一步。
- 授权页面会说明：谁在请求、连接的是哪个账号（手机号前三位和后四位，就是浏览器里现在登录的账号）、连接后能做什么、会发送哪些内容、保存在哪里和多久、费用，以及连接后不能做的事（付款、改手机号或账号设置）。浏览器里登录的是别的账号时，在页面上点「换一个账号」。用户看完再决定点「允许连接」或「不允许」。
- 点了允许，浏览器会回到 WorkBuddy。之后在后台使用，不需要再登录。
- 看不到邪修笔法的工具时（还没连接，或者连接被断开、过期了），把上面的步骤告诉用户；重新连接时要用**同一个手机号**的账号，之前的任务才能接着做。
- 连好后：还没有发出去的需求，用原来的内容调用 `write_material`，用户不用再说一遍；已经拿到 `job_id` 的任务，用 `get_writing_result` 或 `continue_writing` 接着取（再调用 `write_material` 会开始新的一篇，再用一次额度）。
- 用户随时可以在网站「会员中心 → 已连接的 AI 助手」断开，或在 WorkBuddy 的连接器里断开。

## 写一篇

调用 `write_material`：

- `request`：用户的写作需求，尽量保留原话（可以整理成一段）；不添加用户没给的事实、数据、单位名称。
- `material`：用户提供的素材原文（例如用户文件里的文字）。
- `request_id`：这次请求自己的编号（8–80 位字母、数字、- 或 _，例如 `rq-20261024-a7k2`），每个新请求换一个。没收到结果、要重试同一个请求时，带同一个 `request_id`：已经开始的任务会原样返回（`request_reused: true`），不会重复写、不会重复使用额度。
- 用户说明了的才填：`title`、`words`（如 1500）、`level`（通用、省级、市级、区县级、乡镇级）、`audience`、`purpose`、`speaker`、`doc_type`（见 `list_document_types`）、`mode: quick`（网站的「传统方式一键生成文章」）、`deep_thinking`（网站的「深度思考」，会用掉更多额度）。

`revise_draft`、`polish_text` 也可以带 `request_id`，规则相同。

写一篇一般要几分钟。结果的 `status` 是 `running` 时，告诉用户邪修笔法正在写，用 `get_writing_result`（带上 `job_id`）查看，直到不是 `running`。

| status | 意思 | 接下来 |
| --- | --- | --- |
| `done` | 网站写好了 | 交付稿件（见下一节）。`request_reused: true` 表示这是之前已经交给网站的同一个请求，没有重复写 |
| `running` | 还在写 | `get_writing_result`；`stalled: true` 表示处理中断了，用 `continue_writing` 让它接着做 |
| `needs_membership` | 网站提示要开通会员、体验结束或额度用完 | 把结果里的说明转告用户：网站的原话、账号的会员状态和会员中心链接。会员中心在用户平时用的浏览器里打开；打开后先确认网站上登录的是同一个账号（结果里写着手机号前三位和后四位），开通、付款由用户本人在网站上完成。用户说好了，调用 `continue_writing`：从停下的那一步接着写，已完成的步骤不会重复扣额度。网站还没显示会员生效时，结果会如实说明 |
| `needs_more_info` | 网站要先补充设定（例如标题） | 问用户 `missing` 里的项，用 `continue_writing` 带上补充的字段 |
| `needs_login` | 网站不再确认这个账号的登录 | 请用户在连接器里用同一个手机号重新连接，然后 `continue_writing` |
| `temporarily_failed` | 网站暂时没完成 | 转告原因；稍后 `continue_writing` 再试 |
| `cleared` | 任务已经结束、过了保留期限或已删除 | 转告结果里的说明；成稿在网站的成稿记录里（`records`，可以用 `get_draft` 读取） |
| `account_disabled` | 网站停用了这个账号 | 转告结果里的说明，需要联系网站处理；开通会员解决不了 |
| `failed` | 其他原因没写成 | 转告结果里的说明 |
| `error` | 工具没有完成，例如 `JOB_NOT_FOUND`（现在连接的账号下没有这个任务：可能是用另一个手机号的账号开始的）或 `outcome: unknown`（不确定网站有没有开始写） | 转告结果里的说明；`outcome: unknown` 时，用同一个 `request_id` 再调用一次就能知道结果 |

结果里没有 `draft` 时就是还没有稿件，说明文字会讲清原因和网站的下一步。结果里的链接给成可点开的形式。

## 交付稿件

- 把稿件原样交给用户（结果文字里两条分隔线之间的部分，也就是 `draft.text`），附上来源那一行（成稿记录编号和第几稿）。要提醒的事，例如稿中有几处“待补充”需要填真实信息，另起一段说，正文保持原样。
- 用户提修改意见：`revise_draft`（`record_id` + 用户的意见），网站生成新的一稿，原稿保留。要润色：`polish_text`，返回“规范表达”“重构全文”两个版本。
- 如果你按用户的要求自己动手改了内容，就说明这是改过的版本，不再标为网站原稿。
- 要 Word：`get_word_file`（可以带 `version` 指定第几稿）返回网站版式的 .docx 文件；也可以在网站「找回已生成的文稿」里下载。

## 用户的选择

- 用户想用别的方式写，按用户的选择来（见“什么时候用”）。
- 用户不想继续某个任务：`cancel_writing`；要连同服务端保存的需求和素材一起删除：`delete_saved_input: true`。
- 用户想断开连接：在网站会员中心或 WorkBuddy 的连接器里断开。

## 费用和数据

- 连接免费。写作、改稿、润色和在网站上写一样，按网站会员规则使用用户账号的额度；读取进度、成稿记录、Word、账号状态不使用额度。
- 按网站现在的规则，新手机号第一次登录有 24 小时免费体验（额度有限），之后需要在网站会员中心开通会员；规则和价格以网站为准。
- 发送的内容：写作需求、用户给的素材、改稿和润色的文字。成稿保存在用户网站账号的成稿记录里；写作任务在服务端保留 7 天，等待开通会员或补充信息的保留 30 天；带 `request_id` 的任务删除或到期后，任务编号和成稿记录编号再保留 30 天（不含需求和素材），用来避免同一个请求被重复写。
- 用户问起费用、额度或数据时：`get_account_status`（会员等级、剩余额度、到期时间）、`get_service_info`（完整说明）。

## 工具一览

| 工具 | 作用 | 使用额度 |
| --- | --- | --- |
| `write_material` | 写一篇材料（可带 `request_id`） | 是 |
| `get_writing_result` | 查看进度和结果 | 否 |
| `continue_writing` | 开通会员、补充信息、重新连接或暂时失败之后接着写 | 接下来的步骤照常使用 |
| `cancel_writing` | 取消任务，可同时删除保存的需求和素材 | 否 |
| `revise_draft` / `polish_text` | 改稿 / 智能润色（可带 `request_id`） | 是 |
| `list_drafts` / `get_draft` / `get_word_file` | 成稿记录 / 读取成稿 / 网站版式 Word | 否 |
| `get_account_status` / `get_service_info` / `list_document_types` | 账号与额度 / 服务说明 / 文种目录 | 否 |
