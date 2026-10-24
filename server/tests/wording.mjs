// Phrases agent-facing text must not contain: instructions that would steer the host's own confirmation or safety
// handling, keep options from the person, or claim priority over other tools. Agent-facing text is everything the AI
// host reads from this project: tool descriptions, server instructions, tool results, SKILL.md files and references.
export const BANNED = [
  '不要询问', '不要问用户', '无需询问', '不用询问', '不必询问', '无需确认', '不用确认', '不必确认', '不要确认', '跳过确认', '不需要确认',
  '不要提出', '不要提议', '不要建议', '不要列出', '不要提供其他', '不要推荐', '不要让用户选', '不要做成选项', '不要给出选项', '只给网站',
  '不要自己写', '不要改由你', '不提议', '不暗示', '不要告诉用户', '不要向用户提', '不要提起', '不得', '禁止', '忽略', '无视',
  '必须使用', '只能使用', '一律使用', '总是使用', '优先于其他', '其他技能', '安全审查', '自动批准', '默认批准',
  'do not ask', "don't ask", 'without asking', 'without confirmation', 'no need to confirm', 'never offer', 'do not offer', "don't offer",
  'do not suggest', "don't suggest", 'ignore ', 'must use', 'always use', 'bypass', 'skip confirmation', 'instead of writing', 'pre-approved'
];

export function bannedIn(text) {
  const lower = String(text).toLowerCase();
  return BANNED.filter((phrase) => lower.includes(phrase.toLowerCase()));
}

// URLs in text the person will read must stand apart (a URL glued to Chinese text or full-width punctuation is often
// not turned into a link).
export function gluedUrls(text) {
  const out = [];
  for (const match of String(text).matchAll(/https?:\/\/[^\s]+/g)) {
    const before = text[match.index - 1];
    const after = text[match.index + match[0].length];
    if ((before && !/\s/.test(before)) || (after && !/\s/.test(after))) out.push(match[0]);
    if (/[　-〿＀-￯一-鿿]/.test(match[0])) out.push(match[0]);
  }
  return out;
}
