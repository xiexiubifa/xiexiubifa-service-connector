'use strict';
// The MCP tools. Names and parameters are stable; descriptions say what each tool does, what it sends and whether it
// uses the person's membership quota on the site, so a host (and the person) can tell paid actions from reads.
// Annotations are set to what the tools really do.
const { ServiceError } = require('./util.cjs');
const present = require('./present.cjs');
const { serviceInfo, membershipView } = require('./disclosure.cjs');

const JOB_ID = { type: 'string', pattern: '^wj_[A-Za-z0-9_-]{20,40}$', description: '写作任务编号（write_material 等返回的 job_id）' };
const RECORD_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', description: '成稿记录编号（record_id）' };
const VERSION = { type: 'integer', minimum: 1, maximum: 1000, description: '第几稿（默认最新一稿）' };
const DEEP = { type: 'boolean', description: '网站的「深度思考」：换用更强的模型，按网站规则会用掉更多额度。用户要求时再打开。' };
const REQUEST_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$', description: '这次请求自己的编号（可选，8–80 位字母、数字、- 或 _，每个新请求用一个新编号）。没收到结果要重试时带同一个编号：已经开始的任务会原样返回，不会重复写、不会重复使用额度。' };
const SETTINGS = {
  title: { type: 'string', maxLength: 200, description: '标题' },
  words: { type: 'string', pattern: '^(recommend|[0-9]{2,5})$', description: '总字数，例如 1500；recommend 表示由网站推荐' },
  level: { type: 'string', maxLength: 40, description: '行政层级：通用、省级、市级、区县级、乡镇级，或其他' },
  audience: { type: 'string', maxLength: 200, description: '受众' },
  purpose: { type: 'string', maxLength: 200, description: '目的' },
  speaker: { type: 'string', maxLength: 200, description: '落款单位或讲话人' }
};
const STATUS_OUTPUT = { type: 'object', properties: { status: { type: 'string' }, job_id: { type: 'string' } }, required: ['status'] };
const ANY_OUTPUT = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };

const paid = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'write_material', title: '邪修笔法 · 写材料', scope: 'write', annotations: { title: '邪修笔法 · 写材料', ...paid },
    description: '用用户自己的邪修笔法（xiexiubifa.cn）账号写一篇中文材料：公文（通知、通报、请示、报告、函、纪要等）、讲话稿、致辞、主持词、工作总结、述职报告、汇报材料、工作方案、实施方案、调研报告、信息简报、心得体会、宣传稿等。网站按自己的流程写（理解需求 → 基础设定 → 六模块提示词 → 文章），成稿存进用户网站账号的成稿记录；和在网站上写一样使用用户的会员额度。写完返回网站的原文；写作一般要几分钟，没写完时返回任务编号，用 get_writing_result 取结果。带上 request_id 时，重试同一个请求不会再写一篇。'
      + ' / Writes a Chinese document (official notices, reports, speeches, summaries, plans…) with the user\'s own xiexiubifa.cn account; uses the user\'s membership quota on that site.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['request'], properties: {
      request: { type: 'string', minLength: 1, maxLength: 20000, description: '用户的写作需求，尽量保留用户的原话（文种、主题、要求）。' },
      material: { type: 'string', maxLength: 120000, description: '用户提供的素材原文（例如用户文件里的文字）。' },
      ...SETTINGS,
      doc_type: { type: 'string', maxLength: 40, description: '文种编号（可选，见 list_document_types）' },
      mode: { type: 'string', enum: ['standard', 'quick'], description: 'standard（默认）：网站的六模块流程；quick：网站的「传统方式一键生成文章」' },
      deep_thinking: DEEP,
      request_id: REQUEST_ID
    } },
    outputSchema: STATUS_OUTPUT
  },
  {
    name: 'get_writing_result', title: '邪修笔法 · 查看写作进度', scope: 'write', annotations: { title: '查看写作进度', ...read },
    description: '查看写作任务的进度和结果。任务还在写时，最多等 wait_seconds 秒（默认 20）再返回。只读取，不会重复扣额度。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: {
      job_id: JOB_ID, wait_seconds: { type: 'integer', minimum: 0, maximum: 25, description: '最多等待的秒数（0–25，默认 20）' }
    } },
    outputSchema: STATUS_OUTPUT
  },
  {
    name: 'continue_writing', title: '邪修笔法 · 接着写', scope: 'write', annotations: { title: '接着写停下的任务', ...paid, idempotentHint: true },
    description: '让停下的写作任务接着做：用户在网站开通或续费会员之后、补充了网站要的信息之后、重新连接账号之后，或暂时失败之后。先向网站核对，再从停下的那一步继续；已完成的步骤不会重复发送、不会重复扣额度。接下来的步骤照常使用会员额度。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: {
      job_id: JOB_ID, ...SETTINGS, material: { type: 'string', maxLength: 120000, description: '补充的素材' }
    } },
    outputSchema: STATUS_OUTPUT
  },
  {
    name: 'cancel_writing', title: '邪修笔法 · 取消任务', scope: 'write', annotations: { title: '取消写作任务', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: '取消写作任务。delete_saved_input 为 true 时，同时删除写作服务里保存的这次需求、素材和进度（网站成稿记录里已经生成的成稿不受影响）。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: {
      job_id: JOB_ID, delete_saved_input: { type: 'boolean', description: '同时删除保存的需求、素材和进度' }
    } },
    outputSchema: ANY_OUTPUT
  },
  {
    name: 'revise_draft', title: '邪修笔法 · 改稿', scope: 'write', annotations: { title: '邪修笔法 · 改稿', ...paid },
    description: '按用户的修改意见，让网站在一篇已生成的成稿上改出新的一稿（原稿保留）。使用会员额度。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['record_id', 'instruction'], properties: {
      record_id: RECORD_ID, instruction: { type: 'string', minLength: 1, maxLength: 20000, description: '修改意见，尽量用用户的原话' }, version: VERSION, deep_thinking: DEEP, request_id: REQUEST_ID
    } },
    outputSchema: STATUS_OUTPUT
  },
  {
    name: 'polish_text', title: '邪修笔法 · 智能润色', scope: 'write', annotations: { title: '邪修笔法 · 智能润色', ...paid },
    description: '用网站的「智能润色」润色一段文字，返回“规范表达”“重构全文”两个版本（存进成稿记录）。使用会员额度。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 120000, description: '要润色的原文' },
      requirements: { type: 'string', maxLength: 4000, description: '润色要求' },
      emphasis: { type: 'string', enum: ['golden', 'classical', 'parallel', 'metaphor', 'data', 'plain', 'theory', 'imagery'], description: '表达增强（选一项）：golden 金句、classical 古诗文、parallel 排比、metaphor 比喻、data 数据、plain 朴实、theory 理论性、imagery 画面感' },
      strength: { type: 'integer', minimum: 1, maximum: 10, description: '表达增强的强度 1–10（默认 5）' },
      deep_thinking: DEEP,
      request_id: REQUEST_ID
    } },
    outputSchema: STATUS_OUTPUT
  },
  {
    name: 'get_account_status', title: '邪修笔法 · 账号与额度', scope: 'account:read', annotations: { title: '账号与额度', ...read },
    description: '查看连接的邪修笔法账号：手机号（部分隐藏）、会员等级、剩余额度（百分比）、到期时间，以及会员中心在哪里。不使用额度。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: ANY_OUTPUT
  },
  {
    name: 'list_drafts', title: '邪修笔法 · 成稿记录', scope: 'drafts:read', annotations: { title: '成稿记录', ...read },
    description: '列出账号在网站上的成稿记录（和网站「找回已生成的文稿」是同一份）：编号、标题、稿次、时间。不使用额度。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多列出几篇（默认 20）' } } },
    outputSchema: ANY_OUTPUT
  },
  {
    name: 'get_draft', title: '邪修笔法 · 读取成稿', scope: 'drafts:read', annotations: { title: '读取成稿', ...read },
    description: '读取一篇成稿的原文（默认最新一稿）。不使用额度。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['record_id'], properties: { record_id: RECORD_ID, version: VERSION } },
    outputSchema: ANY_OUTPUT
  },
  {
    name: 'get_word_file', title: '邪修笔法 · 下载 Word', scope: 'drafts:read', annotations: { title: '下载 Word', ...read },
    description: '取得一篇成稿的网站版式 Word 文件（.docx），以文件资源返回。不使用额度。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['record_id'], properties: { record_id: RECORD_ID, version: VERSION } },
    outputSchema: ANY_OUTPUT
  },
  {
    name: 'list_document_types', title: '邪修笔法 · 文种目录', scope: null, annotations: { title: '文种目录', ...read },
    description: '列出网站支持的文种（材料类型）和编号，供 write_material 的 doc_type 使用；给出 doc_type 时列出该文种的结构方案和文风。不使用额度。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { doc_type: { type: 'string', maxLength: 40, description: '文种编号（可选）' } } },
    outputSchema: ANY_OUTPUT
  },
  {
    name: 'get_service_info', title: '邪修笔法 · 服务说明', scope: null, annotations: { title: '服务说明', ...read },
    description: '说明这个写作服务：提供方、会发送和保存哪些内容、保存多久、费用、怎样断开连接或删除数据。不使用额度。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: ANY_OUTPUT
  }
];

// A small JSON Schema check for the shapes above. Returns a message, or '' when the value fits.
function check(schema, value, path = '参数') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}应该是对象。`;
    for (const key of schema.required || []) if (value[key] === undefined) return `缺少 ${key}。`;
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) { if (schema.additionalProperties === false) return `不支持的参数 ${key}。`; continue; }
      const problem = check(sub, v, key);
      if (problem) return problem;
    }
    return '';
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} 应该是文字。`;
    if (schema.minLength && value.trim().length < schema.minLength) return `${path} 不能为空。`;
    if (schema.maxLength && value.length > schema.maxLength) return `${path} 太长（最多 ${schema.maxLength} 字）。`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} 格式不正确。`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} 只能是：${schema.enum.join('、')}。`;
    return '';
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${path} 应该是整数。`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}。`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}。`;
    return '';
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? '' : `${path} 应该是 true 或 false。`;
  return '';
}

function createTools({ config, site, jobs }) {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const settingsOf = (a) => Object.fromEntries(['title', 'words', 'level', 'audience', 'purpose', 'speaker', 'material'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  const jobOut = (caller, extra = {}) => (view) => present.jobResult(view, { site, phoneLabel: caller.grant.phoneLabel, ...extra });
  // write_material, revise_draft and polish_text start paid work; request_id makes a retry find the same job.
  const startJob = async (caller, kind, params, a) => jobOut(caller, { started: true })(await jobs.start(caller, kind, params, { requestId: a.request_id }));

  const handlers = {
    async write_material(a, caller) {
      const params = { request: a.request, ...settingsOf(a), ...(a.doc_type ? { subKey: a.doc_type } : {}), mode: a.mode === 'quick' ? 'quick' : 'six', deepThinking: a.deep_thinking === true };
      return startJob(caller, 'write', params, a);
    },
    async get_writing_result(a, caller) {
      return jobOut(caller)(await jobs.get(caller, a.job_id, { waitMs: (a.wait_seconds ?? 20) * 1000 }));
    },
    async continue_writing(a, caller) {
      return jobOut(caller)(await jobs.resume(caller, a.job_id, settingsOf(a)));
    },
    async cancel_writing(a, caller) {
      return jobOut(caller)(await jobs.cancel(caller, a.job_id, { forget: a.delete_saved_input === true }));
    },
    async revise_draft(a, caller) {
      return startJob(caller, 'revise', { recordId: a.record_id, baseVersion: a.version, instruction: a.instruction, deepThinking: a.deep_thinking === true }, a);
    },
    async polish_text(a, caller) {
      const prefs = a.emphasis ? [{ key: a.emphasis, strength: a.strength ?? 5 }] : [];
      return startJob(caller, 'polish', { text: a.text, requirements: a.requirements || '', prefs, deepThinking: a.deep_thinking === true }, a);
    },
    async get_account_status(a, caller) {
      const { grant } = caller;
      const membership = await site.membership(grant.uid);
      const info = site.info;
      const m = membershipView(membership);
      const lines = [`账号：${grant.phoneLabel}（通过「${grant.clientName}」连接）`];
      if (m) {
        lines.push(`会员：${present.memberLine(m) || m.tierName}`);
        if (m.expiresAt) lines.push(`会员到期：${present.when(m.expiresAt)}`);
        if (m.trialExpiresAt && m.tier === 'trial') lines.push(`免费体验到：${present.when(m.trialExpiresAt)}`);
      } else {
        lines.push(`会员信息暂时读不到：${membership?.message || '请稍后再试。'}`);
      }
      lines.push(`会员中心（开通、续费、查看额度）：${info.membershipWhere}，链接 ${info.membershipUrl} `);
      return present.textResult(lines.join('\n'), { status: 'ok', account: grant.phoneLabel, connected_via: grant.clientName, membership: m,
        ...(m ? {} : { membership_error: membership?.message || '' }), links: [{ label: '会员中心', url: info.membershipUrl }] });
    },
    async list_drafts(a, caller) {
      const items = (await site.drafts(caller.grant.uid)).slice(0, a.limit || 20);
      const text = items.length ? items.map((d) => `- ${d.recordId}《${d.title || '（无标题）'}》 共 ${d.versions} 稿 · ${present.when(d.createdAt)}`).join('\n') : '网站上还没有成稿记录。';
      return present.textResult(text, { status: 'ok', drafts: items.map((d) => ({ record_id: d.recordId, title: d.title, versions: d.versions, created_at: new Date(d.createdAt).toISOString() })) });
    },
    async get_draft(a, caller) {
      const d = await site.draft(caller.grant.uid, a.record_id, a.version);
      const block = present.draftBlock({ ...d, method: '成稿记录' }, site.info);
      return present.textResult(`《${d.title || '（无标题）'}》\n${block.text}`, { status: 'ok', draft: { title: d.title, text: d.text, record_id: d.recordId, version: d.version, versions: d.versions, source: block.source } });
    },
    async get_word_file(a, caller) {
      const file = await site.wordFile(caller.grant.uid, a.record_id, a.version);
      const bytes = Buffer.from(file.base64, 'base64').length;
      return {
        content: [
          { type: 'text', text: `网站版式的 Word：${file.name}（约 ${Math.max(1, Math.round(bytes / 1024))} KB，成稿记录 ${file.recordId} 第 ${file.version} 稿）。也可以在${site.info.draftsWhere}下载。` },
          { type: 'resource', resource: { uri: `xiexiubifa://drafts/${encodeURIComponent(file.recordId)}/${file.version}/${encodeURIComponent(file.name)}`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', blob: file.base64 } }
        ],
        structuredContent: { status: 'ok', file_name: file.name, size_bytes: bytes, record_id: file.recordId, version: file.version },
        isError: false
      };
    },
    async list_document_types(a, caller) {
      const out = await site.documentTypes(caller.grant.uid, a.doc_type || '');
      return present.textResult(out.text, { status: 'ok', ...out.structured });
    },
    async get_service_info() {
      const out = serviceInfo({ config, site });
      return present.textResult(out.text, out.structured);
    }
  };

  function list() {
    return TOOLS.map(({ scope, ...tool }) => tool);
  }

  // Runs a tool for an authenticated caller. Scope problems throw INSUFFICIENT_SCOPE (an HTTP 403 for the client);
  // everything else becomes a tool result.
  async function call(name, args, caller) {
    const tool = byName.get(name);
    if (!tool) throw new ServiceError('UNKNOWN_TOOL', '没有这个工具：' + String(name).slice(0, 60));
    if (tool.scope && !caller.scope.includes(tool.scope)) throw new ServiceError('INSUFFICIENT_SCOPE', '这个连接没有包含所需的权限：' + tool.scope, { scope: tool.scope });
    const problem = check(tool.inputSchema, args ?? {});
    if (problem) return present.textResult(problem, { status: 'invalid_arguments', message: problem }, true);
    try {
      return await handlers[name](args ?? {}, caller);
    } catch (error) {
      if (!(error instanceof ServiceError)) console.error('[tool]', name, error?.name || 'Error', String(error?.code || '').slice(0, 40));
      // Tools that can start or continue paid work have an open outcome after an unexpected failure.
      return present.errorResult(error instanceof ServiceError ? error : null,
        { paid: tool.annotations.readOnlyHint === false && name !== 'cancel_writing', requestId: args?.request_id || '', jobId: name === 'continue_writing' ? args?.job_id || '' : '' });
    }
  }

  return { list, call, TOOLS };
}

module.exports = { createTools, TOOLS, check };
