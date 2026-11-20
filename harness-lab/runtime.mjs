import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAB_DIR = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const BOOT_MODULE = join('@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
const ENTRY_TOKEN = "'__RESEARCH_HARNESS_ENTRY__'";
const LEDGER_TOKEN = "'__HARNESS_LAB_LEDGER_DIR__'";

function asPath(value) {
  const text = String(value).trim();
  return text.startsWith('file:') ? fileURLToPath(text) : resolve(text);
}

function nodeModulesCandidates(env) {
  const candidates = [];
  const addWindowsInstall = (base) => {
    if (base) candidates.push(join(base, 'DeepSeek Harness', 'resources', 'app', 'dsh', 'node_modules'));
  };
  if (env.DSH_INSTALL_DIR) {
    candidates.push(join(asPath(env.DSH_INSTALL_DIR), 'resources', 'app', 'dsh', 'node_modules'));
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app', 'dsh', 'node_modules'));
  }
  addWindowsInstall(env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'));
  addWindowsInstall(env.ProgramFiles);
  addWindowsInstall(env['ProgramFiles(x86)']);
  if (process.platform === 'win32') {
    addWindowsInstall(join(homedir(), 'AppData', 'Local', 'Programs'));
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      candidates.push(join(base, 'DeepSeek Harness.app', 'Contents', 'Resources', 'app', 'dsh', 'node_modules'));
    }
  } else {
    candidates.push('/opt/DeepSeek Harness/resources/app/dsh/node_modules');
    candidates.push('/usr/lib/deepseek-harness/resources/app/dsh/node_modules');
  }
  return [...new Set(candidates)];
}

export function resolveDshRuntime(env = process.env) {
  const bootSetting = env.DSH_BOOT_PATH || env.DSH_BOOT_URL;
  const baseSetting = env.DSH_BARE_MODULE_BASE_URL || env.DSH_BARE_MODULE_BASE_PATH;
  let bootPath;
  let nodeModulesDir;

  if (bootSetting) {
    bootPath = asPath(bootSetting);
    nodeModulesDir = baseSetting ? asPath(baseSetting) : resolve(dirname(bootPath), '..', '..', '..');
  } else if (baseSetting) {
    nodeModulesDir = asPath(baseSetting);
    bootPath = join(nodeModulesDir, BOOT_MODULE);
  } else {
    for (const candidate of nodeModulesCandidates(env)) {
      const candidateBoot = join(candidate, BOOT_MODULE);
      if (existsSync(candidateBoot)) {
        bootPath = candidateBoot;
        nodeModulesDir = candidate;
        break;
      }
    }
  }

  if (!bootPath) {
    throw new Error('未探测到 DSH boot；请设置 DSH_BOOT_PATH（boot index.js）或 DSH_BARE_MODULE_BASE_URL（DSH node_modules）。');
  }
  if (!existsSync(bootPath)) {
    throw new Error('DSH boot 不存在: ' + bootPath + '；请检查 DSH_BOOT_PATH / DSH_BARE_MODULE_BASE_URL。');
  }
  return {
    bootPath,
    bareModuleBaseUrl: pathToFileURL(resolve(nodeModulesDir) + sep).href,
  };
}

export async function createHarnessLab(env = process.env) {
  const runtime = resolveDshRuntime(env);
  const bootModule = await import(pathToFileURL(runtime.bootPath).href);
  if (typeof bootModule.boot !== 'function') {
    throw new Error('DSH boot 模块未导出 boot(): ' + runtime.bootPath);
  }

  const ledgerDir = env.HARNESS_LAB_LEDGER_DIR
    ? asPath(env.HARNESS_LAB_LEDGER_DIR)
    : join(LAB_DIR, '.research');
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-research-harness-lab-'));
  const profilePath = join(profileDir, 'cordis.yml');
  try {
    const template = readFileSync(new URL('./profile/cordis.yml', import.meta.url), 'utf8');
    const rendered = template
      .replaceAll(ENTRY_TOKEN, JSON.stringify(join(REPO_ROOT, 'lib', 'index.js')))
      .replaceAll(LEDGER_TOKEN, JSON.stringify(ledgerDir));
    if (rendered.includes('__RESEARCH_HARNESS_ENTRY__') || rendered.includes('__HARNESS_LAB_LEDGER_DIR__')) {
      throw new Error('profile/cordis.yml 占位符替换不完整');
    }
    writeFileSync(profilePath, rendered, 'utf8');
  } catch (error) {
    rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }

  return {
    boot: bootModule.boot,
    bareModuleBaseUrl: runtime.bareModuleBaseUrl,
    profilePath,
    ledgerDir,
    cleanup() {
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}
