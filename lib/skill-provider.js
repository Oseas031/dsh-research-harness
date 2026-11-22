/**
 * 自定位技能 provider：把包内 skills/ 目录挂进 ctx.skills 注册表。
 * 为什么不走 dsh-skill-filesystem 的 customSkillDirs：那个 config 只收绝对路径
 * （resolve(root) 相对宿主 cwd），写进 dsh.patch.yml 就是写死安装机路径——不可移植。
 * 这里用 import.meta.url 自定位包根，安装到任何机器/任何 profile 都成立。
 * rank=600 与 @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK 对齐（该常量不可 import：
 * junction 安装形态解析不到 store 依赖，本插件保持零运行时依赖）。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, parseInvocationPolicy, isSkillName } from './frontmatter.js';

export const SKILL_PROVIDER_NAME = 'research-harness-skills';
export const BUNDLED_RANK = 600;

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function scanSkills(skillsDir, log) {
  const found = [];
  let entries = [];
  try { entries = readdirSync(skillsDir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === '__pycache__' || e.name.startsWith('.')) continue;
    const dir = join(skillsDir, e.name);
    const file = join(dir, 'SKILL.md');
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    let parsed;
    try { parsed = parseFrontmatter(readFileSync(file, 'utf8')); } catch { parsed = undefined; }
    if (!parsed || !parsed.data) { log?.({ kind: 'skill-skip', file, why: 'frontmatter 解析失败' }); continue; }
    const name = parsed.data.name;
    const description = parsed.data.description;
    if (typeof name !== 'string' || typeof description !== 'string' || !description) { log?.({ kind: 'skill-skip', file, why: '缺 name/description' }); continue; }
    if (!isSkillName(name)) { log?.({ kind: 'skill-skip', file, why: '技能名非 kebab-case: ' + name }); continue; }
    const metadata = { ...parsed.data };
    delete metadata.name; delete metadata.description; delete metadata['disable-model-invocation']; delete metadata['user-invocable'];
    found.push({ name, description, whenToUse: typeof parsed.data.whenToUse === 'string' ? parsed.data.whenToUse : undefined, invocation: parseInvocationPolicy(parsed.data), metadata: Object.keys(metadata).length ? metadata : undefined, body: parsed.body, file, dir });
  }
  return found;
}

export function createHarnessSkillProvider({ skillsDir, log }) {
  return {
    name: SKILL_PROVIDER_NAME,
    async list() {
      return scanSkills(skillsDir, log).map(s => ({
        name: s.name,
        description: s.description,
        ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
        invocation: s.invocation,
        source: 'bundled',
        provider: SKILL_PROVIDER_NAME,
        rank: BUNDLED_RANK,
        path: s.file,
        resourceBase: { kind: 'directory', path: s.dir },
        locator: { file: s.file },
        ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
      }));
    },
    async get(candidate) {
      const file = typeof candidate?.locator?.file === 'string' ? candidate.locator.file : (typeof candidate?.path === 'string' ? candidate.path : null);
      if (!file) return undefined;
      let realFile;
      try {
        const realRoot = realpathSync(resolve(skillsDir));
        realFile = realpathSync(resolve(realRoot, file));
        const rel = relative(realRoot, realFile);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
      } catch {
        return undefined;
      }
      let parsed;
      try { parsed = parseFrontmatter(readFileSync(realFile, 'utf8')); } catch { return undefined; }
      if (!parsed || !parsed.data) return undefined;
      return {
        name: parsed.data.name,
        description: parsed.data.description,
        ...(typeof parsed.data.whenToUse === 'string' ? { whenToUse: parsed.data.whenToUse } : {}),
        invocation: parseInvocationPolicy(parsed.data),
        source: 'bundled',
        provider: SKILL_PROVIDER_NAME,
        path: realFile,
        resourceBase: { kind: 'directory', path: dirname(realFile) },
        content: parsed.body,
      };
    },
  };
}

/** 挂进 ctx.skills；返回 { state, count, dispose? }。ctx.skills 缺席时 state='absent'（不炸）。 */
export function registerHarnessSkills(ctx, { skillsDir, log }) {
  const dir = skillsDir ?? join(PKG_ROOT, 'skills');
  try {
    // ctx.get() 可选获取——不需要 inject 声明，服务缺席时返回 undefined（同 dsh-skill-filesystem optionalFileSystem 惯例）
    const skills = typeof ctx?.get === 'function' ? ctx.get('skills') : ctx?.skills;
    if (!skills || typeof skills.registerProvider !== 'function') {
      return { state: 'absent', count: 0, dir };
    }
    const provider = createHarnessSkillProvider({ skillsDir: dir, log });
    const count = scanSkills(dir, log).length;
    const dispose = skills.registerProvider(() => provider);
    return { state: 'ok', count, dir, dispose };
  } catch (e) {
    return { state: 'error', count: 0, dir, error: String(e?.message ?? e) };
  }
}
