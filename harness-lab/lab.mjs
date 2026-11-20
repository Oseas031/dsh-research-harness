import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarnessLab } from './runtime.mjs';

const argv = process.argv.slice(2);
const scenarioPath = argv.find(a => !a.startsWith('--'));
const keep = argv.includes('--keep');
if (!scenarioPath) { console.error('usage: node lab.mjs <scenario.mjs> [--keep]'); process.exit(2); }

const lab = await createHarnessLab();
let ctx;
try {
  if (!keep && existsSync(lab.ledgerDir)) rmSync(lab.ledgerDir, { recursive: true, force: true });
  const mod = await import(pathToFileURL(resolve(scenarioPath)).href);
  ctx = await lab.boot('harness-lab', lab.profilePath, [], undefined, lab.bareModuleBaseUrl);
  const defs = ctx.tools.definitions(undefined);
  const results = [];
  const step = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
  await (mod.default ?? mod.run)({ ctx, defs, step, ledgerDir: lab.ledgerDir });
  const fails = results.filter(r => !r.pass);
  console.log('===== ' + scenarioPath + ': ' + (results.length - fails.length) + '/' + results.length + ' =====');
  if (fails.length) { console.log('FAILED: ' + fails.map(f => f.name).join(' ; ')); process.exitCode = 1; }
} finally {
  try { await ctx?.fiber.dispose(); } catch {}
  lab.cleanup();
}
