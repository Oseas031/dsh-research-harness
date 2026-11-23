import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

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
const FORBIDDEN_CHILD_TOOLS = new Set([
  'bash', 'pwsh', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'terminal_open', 'terminal_send',
]);
const OFFLINE_SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal_send']);
const SHELL_NETWORK_PATTERNS = [
  { label: 'PowerShell/.NET 网络客户端', re: /\b(Invoke-RestMethod|Invoke-WebRequest|Start-BitsTransfer|Net\.WebClient|WebClient|HttpClient)\b/i },
  { label: 'PowerShell 网络别名 (irm/iwr)', re: /(?:^|[\s;|&(])(irm|iwr)(?:\s|$)/i },
  { label: 'CLI HTTP 客户端 (curl/wget)', re: /(?:^|[\s;|&(])(curl(?:\.exe)?|wget(?:\.exe)?)(?:\s|$)/i },
  { label: '脚本网络客户端', re: /\b(urllib\.request|urlopen|requests\.(?:get|post|put|patch|delete|head|request|Session)|httpx\.(?:get|post|put|patch|delete|head|request|Client|AsyncClient)|aiohttp\.ClientSession|http\.client\.(?:HTTPConnection|HTTPSConnection)|socket\.create_connection)\b/i },
  { label: 'fetch(http(s)://...)', re: /\bfetch\s*\(\s*['"`]https?:\/\//i },
  { label: 'DNS 探测', re: /\b(Resolve-DnsName|nslookup)\b/i },
];
const HTTP_URL_RE = /\bhttps?:\/\/[^\s'"`<>)]+/gi;
const LOOPBACK_URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?:[:/?#]|$)/i;

const deny = (code, reason) => ({ code, reason });

function resolveReal(targetPath) {
  const abs = resolve(targetPath);
  const pending = [];
  let cur = abs;
  while (true) {
    try {
      const real = realpathSync(cur);
      let out = real;
      for (let i = pending.length - 1; i >= 0; i--) out = join(out, pending[i]);
      return out;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      pending.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

/** 二进制/超大文件读取守卫。返回 null（放行）或 {code, reason}。 */
export function guardBinaryRead({ path: p, size } = {}) {
  if (typeof p === 'string' && p.trim().length > 0) {
    const cleaned = p.trim();
    const dot = extname(cleaned).toLowerCase();
    if (BINARY_EXTENSIONS.has(dot)) {
      return deny('READ_BINARY', 'READ_BINARY: ' + cleaned + ' 是二进制/模型文件，交给专用脚本处理，不要直接 Read。');
    }
  }
  if (typeof size === 'number' && size > BINARY_READ_MAX_BYTES) {
    return deny('READ_TOO_LARGE', 'READ_TOO_LARGE: ' + String(p).trim() + ' 超过 20MB 读取上限，分段或用脚本抽样。');
  }
  return null;
}

/** 路径越界守卫（解析真实路径以防工作区内 symlink/junction 逃逸；相对路径按 root 解析）。 */
export function guardPathEscape({ root, target, mode = 'write' } = {}) {
  if (typeof target !== 'string' || target.length === 0) return null;
  const logicalBase = resolve(root || '.');
  const logicalTarget = resolve(logicalBase, target);
  const realBase = resolveReal(logicalBase);
  const realTarget = resolveReal(logicalTarget);
  const rel = relative(realBase, realTarget);
  const inside = (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) || rel === '';
  if (!inside) {
    const code = mode === 'read' ? 'READ_OUTSIDE_WORKSPACE' : 'WRITE_OUTSIDE_WORKSPACE';
    return deny(code, code + ': ' + target + ' 不在工作区 ' + logicalBase + ' 内。越界前先问用户。');
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

/** 离线 Shell 联网守卫：阻断 pwsh/bash/terminal_send 中的公网 HTTP/DNS 客户端调用（放行回环与纯本地数据分析）。 */
export function guardShellNetwork({ command, tool = 'shell' } = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  let matched = null;
  for (const rule of SHELL_NETWORK_PATTERNS) {
    if (rule.re.test(command)) {
      matched = rule.label;
      break;
    }
  }
  if (!matched) return null;
  const urls = command.match(HTTP_URL_RE) || [];
  if (urls.length > 0 && urls.every(u => LOOPBACK_URL_RE.test(u))) {
    return null;
  }
  return deny(
    'SHELL_NETWORK_BLOCKED',
    `SHELL_NETWORK_BLOCKED: 当前处于离线隔离模式（enforceOfflineShell=true），禁止在 ${tool} 中发起外部网络请求（命中 ${matched}）。请仅基于工作区本地数据进行统计分析与核验。`,
  );
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
    const patchText = a.input ?? a.patchText ?? a.patch;
    if (!ctx.workspaceRoot || typeof patchText !== 'string') return null;
    for (const p of extractPatchPaths(patchText)) {
      const d = guardPathEscape({ root: ctx.workspaceRoot, target: p, mode: 'write' });
      if (d) return d;
    }
    return null;
  }

  if (name === 'str_replace_editor') {
    const editorPath = a.path ?? a.file_path ?? a.filePath;
    const cmd = String(a.command || '').toLowerCase();
    if (cmd === 'view') {
      let size = typeof a.size === 'number' ? a.size : undefined;
      if (size === undefined && typeof editorPath === 'string' && editorPath.trim().length > 0) {
        try {
          const probe = resolve(ctx.workspaceRoot || '.', editorPath);
          const st = statSync(probe);
          if (st.isFile()) size = st.size;
        } catch { /* 不存在或不可访问时不在此截断，交给工具自身报 ENOENT */ }
      }
      const binDeny = guardBinaryRead({ path: editorPath, size });
      if (binDeny) return binDeny;
      if (ctx.workspaceRoot && ctx.enforceReadInsideWorkspace === true) {
        return guardPathEscape({ root: ctx.workspaceRoot, target: editorPath, mode: 'read' });
      }
      return null;
    }
    if (!ctx.workspaceRoot) return null;
    return guardPathEscape({ root: ctx.workspaceRoot, target: editorPath, mode: 'write' });
  }

  if (name === 'subagent' || name === 'agent') {
    const agentDeny = guardAgentParams({ description: a.description, prompt: a.prompt, tools: a.tools });
    if (agentDeny) return agentDeny;
    if (ctx.workspaceRoot && typeof a.cwd === 'string' && a.cwd.trim().length > 0) {
      return guardPathEscape({ root: ctx.workspaceRoot, target: a.cwd, mode: 'write' });
    }
    return null;
  }

  if (ctx.enforceOfflineShell === true && OFFLINE_SHELL_TOOLS.has(name)) {
    const cmd = a.command ?? a.cmd ?? a.input ?? a.script ?? a.text;
    return guardShellNetwork({ command: cmd, tool: name });
  }
  return null;
}

export const GUARD_LIMITS = {
  BINARY_READ_MAX_BYTES,
  PROMPT_MAX_CHARS,
  FORBIDDEN_CHILD_TOOLS: [...FORBIDDEN_CHILD_TOOLS],
  OFFLINE_SHELL_TOOLS: [...OFFLINE_SHELL_TOOLS],
};
