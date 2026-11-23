/** 结构化预期对齐卡（Alignment Card）：6 层预期校验、Markdown 持久化与 ledger 同步。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ALIGNMENT_LAYERS = [
  'goal',
  'constraints',
  'deliverables',
  'success_criteria',
  'assumptions',
  'non_goals',
];

export const PROBE_VERDICTS = ['adopt', 'reject', 'reframe'];
const VERDICT_SET = new Set(PROBE_VERDICTS);
const START_MARKER = '<!-- ALIGNMENT_JSON';
const END_MARKER = '-->';

function normalizeSlug(raw) {
  const s = String(raw ?? 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'default';
}

function hasContent(val) {
  if (typeof val === 'string') return val.trim().length > 0;
  if (Array.isArray(val)) return val.some(item => hasContent(item));
  if (val && typeof val === 'object') return Object.keys(val).length > 0;
  return false;
}

function formatLayerBody(val) {
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map(v => '- ' + String(v).trim()).join('\n');
  return JSON.stringify(val, null, 2);
}

/** 校验并归一化 6 层预期对齐卡；缺失任意层或探测裁决非法时抛错。 */
export function validateAlignmentCard(card) {
  if (!card || typeof card !== 'object') {
    throw new Error('ALIGNMENT_BAD_CARD: alignment card 必须是对象');
  }
  const topic = String(card.topic ?? '').trim();
  if (!topic) {
    throw new Error('ALIGNMENT_NO_TOPIC: 缺少 topic 主题描述');
  }
  const srcLayers = card.layers && typeof card.layers === 'object' ? card.layers : card;
  const missing = [];
  const layers = {};
  for (const layer of ALIGNMENT_LAYERS) {
    const val = srcLayers[layer];
    if (!hasContent(val)) {
      missing.push(layer);
    } else {
      layers[layer] = Array.isArray(val)
        ? val.map(item => String(item).trim()).filter(Boolean)
        : (typeof val === 'string' ? val.trim() : val);
    }
  }
  if (missing.length > 0) {
    throw new Error('ALIGNMENT_INCOMPLETE: 缺少必填预期层: ' + missing.join(', '));
  }

  const probes = [];
  if (card.probes !== undefined) {
    if (!Array.isArray(card.probes)) {
      throw new Error('ALIGNMENT_BAD_PROBES: probes 必须是数组');
    }
    for (let i = 0; i < card.probes.length; i++) {
      const p = card.probes[i];
      if (!p || typeof p !== 'object') {
        throw new Error('ALIGNMENT_BAD_PROBE: probes[' + i + '] 必须是对象');
      }
      const question = String(p.question ?? '').trim();
      if (!question) {
        throw new Error('ALIGNMENT_BAD_PROBE: probes[' + i + '] 缺少 question');
      }
      const verdict = String(p.verdict ?? '').trim();
      if (!VERDICT_SET.has(verdict)) {
        throw new Error('ALIGNMENT_BAD_PROBE: probes[' + i + '] verdict 必须是 adopt|reject|reframe，收到: ' + verdict);
      }
      probes.push({
        id: String(p.id ?? 'P' + (i + 1)),
        layer: p.layer ? String(p.layer) : null,
        question,
        verdict,
        ...(p.note ? { note: String(p.note).trim() } : {}),
      });
    }
  }

  const openUnknowns = [];
  const rawUnknowns = card.open_unknowns ?? card.unknowns ?? [];
  if (!Array.isArray(rawUnknowns)) {
    throw new Error('ALIGNMENT_BAD_UNKNOWNS: open_unknowns 必须是数组');
  }
  for (let i = 0; i < rawUnknowns.length; i++) {
    const u = rawUnknowns[i];
    const what = typeof u === 'string' ? u.trim() : String(u?.what ?? '').trim();
    if (!what) {
      throw new Error('ALIGNMENT_BAD_UNKNOWN: open_unknowns[' + i + '] 缺少 what');
    }
    openUnknowns.push({
      what,
      classification: typeof u === 'object' && u?.classification ? String(u.classification) : 'non-blocker',
      ...(typeof u === 'object' && u?.why ? { why: String(u.why).trim() } : {}),
    });
  }

  return {
    slug: normalizeSlug(card.slug || topic),
    topic,
    updatedAt: card.updatedAt ? String(card.updatedAt) : new Date().toISOString(),
    layers,
    probes,
    open_unknowns: openUnknowns,
  };
}

function escapeYamlScalar(s) {
  return '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 将对齐卡序列化为 Markdown 并持久化到 <wsRoot>/.research/alignment/<slug>.md。 */
export function writeAlignmentCard(wsRoot, card) {
  if (!wsRoot) throw new Error('ALIGNMENT_NO_ROOT: 缺少工作区根目录 wsRoot');
  const normalized = validateAlignmentCard(card);
  const dir = join(wsRoot, '.research', 'alignment');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, normalized.slug + '.md');
  const reframeCount = normalized.probes.filter(p => p.verdict === 'reframe').length;

  const lines = [
    '---',
    'topic: ' + escapeYamlScalar(normalized.topic),
    'slug: ' + escapeYamlScalar(normalized.slug),
    'updatedAt: ' + escapeYamlScalar(normalized.updatedAt),
    'probesCount: ' + normalized.probes.length,
    'reframeCount: ' + reframeCount,
    '---',
    '',
    '# Alignment Card: ' + normalized.topic,
    '',
  ];

  for (let i = 0; i < ALIGNMENT_LAYERS.length; i++) {
    const layer = ALIGNMENT_LAYERS[i];
    lines.push('## ' + (i + 1) + '. ' + layer);
    lines.push('');
    lines.push(formatLayerBody(normalized.layers[layer]));
    lines.push('');
  }

  lines.push('## Probes');
  lines.push('');
  if (normalized.probes.length === 0) {
    lines.push('_(无显式探测记录)_');
  } else {
    lines.push('| ID | Layer | Question | Verdict | Note |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const p of normalized.probes) {
      lines.push(
        '| ' + mdCell(p.id)
        + ' | ' + mdCell(p.layer ?? '-')
        + ' | ' + mdCell(p.question)
        + ' | ' + mdCell(p.verdict)
        + ' | ' + mdCell(p.note ?? '')
        + ' |'
      );
    }
  }
  lines.push('');

  lines.push('## Open Unknowns');
  lines.push('');
  if (normalized.open_unknowns.length === 0) {
    lines.push('_(无)_');
  } else {
    for (const u of normalized.open_unknowns) {
      lines.push('- [' + u.classification + '] ' + u.what + (u.why ? ' — ' + u.why : ''));
    }
  }
  lines.push('');

  const safeJson = JSON.stringify(normalized, null, 2).replace(/-->/g, '--\\u003e');
  lines.push(START_MARKER);
  lines.push(safeJson);
  lines.push(END_MARKER);
  lines.push('');

  writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { path: filePath, slug: normalized.slug, card: normalized };
}

/** 从对齐卡 Markdown 文件无损读取并校验结构化内容。 */
export function readAlignmentCard(filePath) {
  if (!filePath || !existsSync(filePath)) {
    throw new Error('ALIGNMENT_NOT_FOUND: 对齐卡文件不存在: ' + filePath);
  }
  const raw = readFileSync(filePath, 'utf8');
  const startIdx = raw.indexOf(START_MARKER);
  if (startIdx === -1) {
    throw new Error('ALIGNMENT_PARSE_ERROR: 文件缺少结构化注释块 ' + START_MARKER);
  }
  const bodyStart = startIdx + START_MARKER.length;
  const endIdx = raw.indexOf(END_MARKER, bodyStart);
  if (endIdx === -1) {
    throw new Error('ALIGNMENT_PARSE_ERROR: 结构化注释块未闭合');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(bodyStart, endIdx).trim());
  } catch (e) {
    throw new Error('ALIGNMENT_PARSE_ERROR: 结构化 JSON 解析失败: ' + e.message);
  }
  return validateAlignmentCard(parsed);
}

/** 将对齐卡中的 open_unknowns 与 reframe 探测同步到 Ledger。 */
export function syncAlignmentToLedger(card, ledger) {
  if (!ledger || typeof ledger.append !== 'function') {
    throw new Error('ALIGNMENT_BAD_LEDGER: ledger 需要 append 方法');
  }
  const normalized = validateAlignmentCard(card);
  const entries = [];
  let unknownsAdded = 0;
  let reframesRecorded = 0;
  const provenance = 'tool:alignment_record';

  for (const u of normalized.open_unknowns) {
    const rec = typeof ledger.addUnknown === 'function'
      ? ledger.addUnknown({
          what: u.what,
          classification: u.classification ?? 'non-blocker',
          why: u.why ?? ('对齐卡未知项 [' + normalized.slug + ']'),
          provenance,
        })
      : ledger.append({
          kind: 'unknown',
          what: u.what,
          classification: u.classification ?? 'non-blocker',
          status: 'open',
          why: u.why ?? ('对齐卡未知项 [' + normalized.slug + ']'),
          provenance,
        });
    unknownsAdded += 1;
    entries.push(rec);
  }

  for (const p of normalized.probes) {
    if (p.verdict !== 'reframe') continue;
    const rec = ledger.append({
      kind: 'alignment-reframe',
      slug: normalized.slug,
      probeId: p.id,
      layer: p.layer,
      question: p.question,
      ...(p.note ? { note: p.note } : {}),
      provenance,
    });
    reframesRecorded += 1;
    entries.push(rec);
  }

  return { slug: normalized.slug, unknownsAdded, reframesRecorded, entries };
}
