'use strict';
// What the person is told before connecting (the site's consent page) and on request (get_service_info): who provides
// the service, which data is sent and kept where and for how long, what it costs, what a connection cannot do, and the
// choices they keep. The site adapter supplies its own facts (names, places on the site, plan prices from the site's
// own membership catalog, the person's current membership); this module only arranges them.
const DAY = 24 * 3600 * 1000;
const days = (ms) => Math.round(ms / DAY);

function sections({ config, site }) {
  const info = site.info;
  return [
    { id: 'data', title: '会发送哪些内容', items: [
      '你在对话里提出的写作要求，以及你交给 AI 助手、让它转交的素材文字（例如文件里的内容）；',
      '改稿、润色时的稿件和修改要求。',
      `这些内容由 AI 助手发送到${info.name}（${info.domain}）的写作服务，只用于按你的要求生成和修改稿件。`
    ] },
    { id: 'storage', title: '保存在哪里、保存多久', items: [
      `成稿和在网站上写的一样，保存在你账号的成稿记录里（${info.draftsWhere}）。`,
      `写作任务（需求、素材和进度）保存在写作服务里，用来完成和继续这次写作：完成后 ${days(config.retention.done)} 天删除；等你开通会员或补充信息的任务保留 ${days(config.retention.blocked)} 天。可以随时让 AI 助手取消任务并删除这些内容。`,
      `AI 助手给请求带了编号时，任务删除或到期后，写作服务还会把这个编号对应的任务编号和成稿记录编号保留 ${days(config.retention.cleared)} 天（不含需求、素材和稿件），用来避免同一个请求被重复写、重复使用额度。`,
      '连接凭据只保存摘要（哈希）；页面和对话里只显示手机号的前三位和后四位。'
    ] },
    { id: 'fees', title: '费用', items: [
      '连接本身免费，不另外收费。',
      '写作、改稿、润色和在网站上写一样，按网站会员规则使用你账号的额度。',
      ...(info.feeNotes || []),
      '开通或续费只在网站会员中心由你本人完成，AI 助手不能替你付款。'
    ] },
    { id: 'cannot', title: '连接后不能做的事', items: ['付款或开通会员；', '修改手机号或账号设置；', '查看其他账号的内容。'] },
    { id: 'choices', title: '你的选择', items: [
      '可以不允许。不允许不影响你直接在网站上使用。',
      `允许后可以随时在${info.connectionsWhere}断开，断开后立即失效。`,
      `不想用${info.name}写的时候，直接告诉 AI 助手用别的方式就行。`
    ] },
    { id: 'host', title: 'AI 助手那一侧', items: ['AI 助手会收到返回的稿件和状态，并按它自己的规则处理对话内容。'] }
  ];
}

function membershipView(membership) {
  if (!membership || !membership.ok) return null;
  const m = membership.status;
  return { tier: m.tier, tierName: m.tierName, quotaPercent: m.quotaPercent ?? null, exhausted: !!m.exhausted, unlimited: !!m.unlimited,
    expiresAt: m.expiresAt || null, trialExpiresAt: m.trialExpiresAt || null };
}

function consentDisclosure({ config, site, membership, plans }) {
  return {
    provider: `${site.info.name}（${site.info.domain}）`,
    sections: sections({ config, site }),
    plans: Array.isArray(plans) ? plans : null,
    membership: membershipView(membership),
    termsUrl: config.termsUrl || ''
  };
}

// get_service_info: the same facts as plain text, plus where things are on the site.
function serviceInfo({ config, site }) {
  const info = site.info;
  const lines = [`${config.serviceName}（提供方：${info.name}，${info.domain}）`, ''];
  for (const section of sections({ config, site })) {
    lines.push(section.title + '：');
    for (const item of section.items) lines.push('- ' + item);
    lines.push('');
  }
  lines.push('网站的位置：');
  lines.push(`- 会员中心（开通、续费、查看额度）：${info.membershipWhere}，链接 ${info.membershipUrl} `);
  lines.push(`- 成稿记录：${info.draftsWhere}`);
  lines.push(`- 断开连接：${info.connectionsWhere}`);
  if (config.termsUrl) lines.push(`- 完整说明：${config.termsUrl} `);
  return {
    text: lines.join('\n').trim(),
    structured: { status: 'info', provider: info.name, domain: info.domain, sections: sections({ config, site }),
      links: { site: info.siteUrl, membership: info.membershipUrl, ...(config.termsUrl ? { terms: config.termsUrl } : {}) } }
  };
}

module.exports = { consentDisclosure, serviceInfo, membershipView };
