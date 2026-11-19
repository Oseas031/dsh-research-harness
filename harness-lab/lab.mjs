import { existsSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { boot } from "file:///C:/Users/ASUS/AppData/Local/Programs/DeepSeek%20Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";

const ROOT_YML = 'E:/dsh-research-harness/harness-lab/profile/cordis.yml';
const LEDGER_DIR = 'E:/dsh-research-harness/harness-lab/.research';
const argv = process.argv.slice(2);
const scenarioPath = argv.find(a => !a.startsWith('--'));
const keep = argv.includes('--keep');
if (!scenarioPath) { console.error('usage: node lab.mjs <scenario.mjs> [--keep]'); process.exit(2); }
if (!keep && existsSync(LEDGER_DIR)) rmSync(LEDGER_DIR, { recursive: true, force: true });

const mod = await import(pathToFileURL(scenarioPath).href);
const ctx = await boot('harness-lab', ROOT_YML, [], undefined, "file:///C:/Users/ASUS/AppData/Local/Programs/DeepSeek%20Harness/resources/app/dsh/node_modules/");
try {
  const defs = ctx.tools.definitions(undefined);
  const results = [];
  const step = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
  await (mod.default ?? mod.run)({ ctx, defs, step, ledgerDir: LEDGER_DIR });
  const fails = results.filter(r => !r.pass);
  console.log('===== ' + scenarioPath + ': ' + (results.length - fails.length) + '/' + results.length + ' =====');
  if (fails.length) { console.log('FAILED: ' + fails.map(f => f.name).join(' ; ')); process.exitCode = 1; }
} finally {
  try { await ctx.fiber.dispose(); } catch {}
}
