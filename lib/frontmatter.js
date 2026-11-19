/**
 * 最小 YAML-frontmatter 解析（无依赖）。
 * 只为 SKILL.md 服务：标量、引号串（含跨行）、折叠块（>/|-）、流数组（含跨行）、块序列。
 * 解析不了的字段尽力保留原文；整体失败返回 undefined（调用方跳过该技能）。
 */

const KEY_RE = /^([A-Za-z][\w.-]*):\s*(.*)$/;
const ITEM_RE = /^\s*-\s+(.*)$/;

export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return undefined;
  const lines = raw.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return undefined;
  let data;
  try { data = parseYamlSubset(lines.slice(1, end)); } catch { return undefined; }
  const body = lines.slice(end + 1).join('\n').trim();
  return { data, body };
}

function parseYamlSubset(lines) {
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    const m = KEY_RE.exec(line);
    if (!m) { i++; continue; } // 认不出的行跳过（不致命）
    const key = m[1];
    let rest = m[2];
    // 块序列：key: 换行 - item
    if (rest === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const im = ITEM_RE.exec(lines[j]);
        if (im) { items.push(unquote(im[1].trim())); j++; }
        else if (lines[j].trim() === '' && j + 1 < lines.length && ITEM_RE.test(lines[j + 1] ?? '')) { j++; }
        else break;
      }
      if (items.length) { data[key] = items; i = j; continue; }
      data[key] = ''; i++; continue;
    }
    // 引号串（可能跨行）
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = rest[0];
      const buf = [rest];
      while (!quoteClosed(buf.join('\n'), q) && i + 1 < lines.length) { i++; buf.push(lines[i]); }
      data[key] = unquote(buf.join('\n').trim());
      i++; continue;
    }
    // 流数组（可能跨行）
    if (rest.startsWith('[')) {
      const buf = [rest];
      while (!bracketsBalanced(buf.join(' ')) && i + 1 < lines.length) { i++; buf.push(lines[i]); }
      data[key] = parseFlowArray(buf.join(' '));
      i++; continue;
    }
    // 折叠/字面块
    if (/^(>|\|)(-|\d+)?\s*$/.test(rest)) {
      const buf = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s+\S/.test(lines[j]))) { buf.push(lines[j]); j++; }
      data[key] = buf.map(l => l.trim()).filter(Boolean).join(' ');
      i = j; continue;
    }
    // 裸标量
    data[key] = scalar(rest.trim());
    i++;
  }
  return data;
}

function quoteClosed(text, q) {
  const body = text.slice(1); // 去掉开引号
  if (q === '"') {
    for (let k = 0; k < body.length; k++) {
      if (body[k] === '\\') { k++; continue; }
      if (body[k] === '"') return true;
    }
    return false;
  }
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "'") { if (body[k + 1] === "'") { k++; continue; } return true; }
  }
  return false;
}

function bracketsBalanced(text) {
  let depth = 0, inStr = null;
  for (const ch of text) {
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return true; }
  }
  return depth === 0;
}

function parseFlowArray(text) {
  const inner = text.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
  const items = [];
  let buf = '', inStr = null;
  for (const ch of inner) {
    if (inStr) { buf += ch; if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
    if (ch === ',') { items.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) items.push(buf.trim());
  return items.filter(s => s !== '').map(s => unquote(s));
}

function unquote(text) {
  if (text.length >= 2 && text[0] === '"' && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (text.length >= 2 && text[0] === "'" && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return scalar(text);
}

function scalar(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return parseFloat(text);
  return text;
}

/** dsh-skill 同款技能名校验（kebab-case）。 */
export function isSkillName(name) {
  return typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}

/** dsh-skill-filesystem 同款 invocation 语义。 */
export function parseInvocationPolicy(data) {
  const disableModel = data['disable-model-invocation'] === true || data['disable-model-invocation'] === 'true';
  const userInvocable = data['user-invocable'];
  return {
    modelInvocable: !disableModel,
    userInvocable: userInvocable !== false && userInvocable !== 'false',
  };
}
