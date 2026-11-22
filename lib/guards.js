import { statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

/** 工具契约守卫（纯函数，无副作用；接线在 lib/index.js 的 ctx.tools.guard()）。 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.safetensors', '.onnx', '.pt', '.pth', '.ckpt',
  '.parquet', '.feather', '.npy', '.npz', '.h5', '.dta',
  '.db', '.sqlite', '.sqlite3', '.wasm', '.asar',
  '.docx', '.pptx', '.xlsx',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac',
  '.ttf', '.otf', '.woff', '.woff2',
]);
const BINARY_READ_MAX_BYTES = 20 * 1024 * 1024;
const PROMPT_MAX_CHARS = 20000;
const FORBIDDEN_CHILD_TOOLS = new Set(['bash', 'pwsh', 'write', 'edit']);

const deny = (code, reason) => ({ code, reason });

/** 二进制/超大文件读取守卫。返回 null（放行）或 {code, reason}。 */
export function guardBinaryRead({ path: p, size } = {}) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const dot = p.toLowerCase().slice(p.lastIndexOf('.'));
  if (BINARY_EXTENSIONS.has(dot)) {
    return deny('READ_BINARY', 'READ_BINARY: ' + p + ' 是二进制/模型文件，交给专用脚本处理，不要直接 Read。');
  }
  if (typeof size === 'number' && size > BINARY_READ_MAX_BYTES) {
    return deny('READ_TOO_LARGE', 'READ_TOO_LARGE: ' + p + ' 超过 20MB 读取上限，分段或用脚本抽样。');
  }
  return null;
}

/** 路径越界守卫（前缀相似陷阱：E:/ws vs E:/ws-evil；相对路径按 root 解析）。 */
export function guardPathEscape({ root, target, mode = 'write' } = {}) {
  if (typeof target !== 'string' || target.length === 0) return null;
  const base = resolve(root || '.');
  const abs = resolve(base, target);
  const rel = relative(base, abs);
  const inside = (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) || rel === '';
  if (!inside) {
    const code = mode === 'read' ? 'READ_OUTSIDE_WORKSPACE' : 'WRITE_OUTSIDE_WORKSPACE';
    return deny(code, code + ': ' + target + ' 不在工作区 ' + base + ' 内。越界前先问用户。');
  }
  return null;
}

/** 从 DSH apply_patch 文本中提取所有目标文件与重命名目标路径。 */
export function extractPatchPaths(patchText) {
  if (typeof patchText !== 'string' || !patchText) return [];
  const paths = [];
  const seen = new Set();
  for (const rawLine of patchText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^\*\*\*\s+(?:(?:Add|Update|Delete)\s+File|Move\s+to):\s*(.+)$/i.exec(line);
    if (!match) continue;
    const filePath = match[1].trim();
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }
  }
  return paths;
}

/** 子代理派单参数守卫：缺描述/缺 prompt/超长/子代理直接持有可变更工具。 */
export function guardAgentParams({ description, prompt, tools } = {}) {
  if (!description || String(description).trim().length === 0) {
    return deny('AGENT_NO_DESCRIPTION', 'AGENT_NO_DESCRIPTION: 派单必须有一句人类可读的 description（做什么、验收什么）。');
  }
  if (!prompt || String(prompt).trim().length === 0) {
    return deny('AGENT_NO_PROMPT', 'AGENT_NO_PROMPT: 派单必须带完整 prompt。');
  }
  if (String(prompt).length > PROMPT_MAX_CHARS) {
    return deny('AGENT_PROMPT_TOO_LONG', 'AGENT_PROMPT_TOO_LONG: prompt 超过 ' + PROMPT_MAX_CHARS + ' 字符，拆任务或落盘后给路径。');
  }
  if (Array.isArray(tools)) {
    const hit = tools.map(String).map(s => s.toLowerCase()).find(t => FORBIDDEN_CHILD_TOOLS.has(t));
    if (hit) {
      return deny('AGENT_FORBIDDEN_TOOLS', 'AGENT_FORBIDDEN_TOOLS: 子代理不得直接持有 ' + hit + '；可变更操作由主智能体把关。');
    }
  }
  return null;
}

/** 统一入口：check(工具名, 参数, ctx) → null 放行 / {code, reason} 拒绝。 */
export function check(tool, args = {}, ctx = {}) {
  const name = String(tool || '').toLowerCase();
  const a = args || {};
  const targetPath = a.filePath ?? a.file_path ?? a.path;

  if (name === 'read') {
    let size = typeof a.size === 'number' ? a.size : undefined;
    if (size === undefined && typeof targetPath === 'string' && targetPath.trim().length > 0) {
      try {
        const probe = resolve(ctx.workspaceRoot || '.', targetPath);
        const st = statSync(probe);
        if (st.isFile()) size = st.size;
      } catch { /* 不存在或不可访问时不在此截断，交给工具自身报 ENOENT */ }
    }
    const binDeny = guardBinaryRead({ path: targetPath, size });
    if (binDeny) return binDeny;
    if (ctx.workspaceRoot && ctx.enforceReadInsideWorkspace === true) {
      return guardPathEscape({ root: ctx.workspaceRoot, target: targetPath, mode: 'read' });
    }
    return null;
  }

  if (name === 'write' || name === 'edit') {
    if (!ctx.workspaceRoot) return null;
    return guardPathEscape({ root: ctx.workspaceRoot, target: targetPath, mode: 'write' });
  }

  if (name === 'apply_patch') {
    if (!ctx.workspaceRoot || typeof a.patchText !== 'string') return null;
    for (const p of extractPatchPaths(a.patchText)) {
      const d = guardPathEscape({ root: ctx.workspaceRoot, target: p, mode: 'write' });
      if (d) return d;
    }
    return null;
  }

  if (name === 'subagent' || name === 'agent') {
    return guardAgentParams({ description: a.description, prompt: a.prompt, tools: a.tools });
  }
  return null;
}

export const GUARD_LIMITS = { BINARY_READ_MAX_BYTES, PROMPT_MAX_CHARS, FORBIDDEN_CHILD_TOOLS: [...FORBIDDEN_CHILD_TOOLS] };
