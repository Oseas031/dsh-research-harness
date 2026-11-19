#!/usr/bin/env node
/**
 * research-harness CLI（v0.4.1，issue #4）：让任意会话/裸 shell 操作同一台账。
 * 与插件工具共用 lib（单一实现，收据同规）。route 每次调用落 route-check（检查点机读化）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ledger } from '../lib/ledger.js';
import { route } from '../lib/route.js';
import { verifyLedger } from '../lib/receipts.js';
import { ingestReport, markVerified } from '../lib/ingest.js';

const USAGE = `用法: research-harness <command> [flags]
命令:
  init                                    建台账目录
  record --claim C --provenance P [--confidence observed] [--task TASK-0000] [--tags a,b] [--verified-by agent-reported]
  add-unknown --what W --why Y [--classification non-blocker|blocker|parameterizable]
  resolve --id U3 --resolution R
  gate-skip --gate G --reason R --risk R --compensation C [--covers U1,U2]
  route [--scale solo|delegate|cluster] [--acceptance acceptance.json]
  verify                                  收据核对（drifted 时 exit 1）
  status                                  台账统计 + 未决 blocker
  ingest --file report.md --source SRC [--task TASK-0000]
  mark-verified --id E5 [--note ...]
通用: --ledger DIR（缺省 ./.research 或 $RESEARCH_LEDGER）`;

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 1); }
const flags = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  const v = args[i + 1];
  if (v !== undefined && !v.startsWith('--')) { flags[a.slice(2)] = v; i++; } else { flags[a.slice(2)] = true; }
}
const need = (k) => { if (typeof flags[k] !== 'string' || !flags[k].trim()) { console.error('缺参数 --' + k + '\n' + USAGE); process.exit(1); } return flags[k]; };
const out = (o) => console.log(JSON.stringify(o, null, 2));

const dir = flags.ledger ? resolve(flags.ledger) : (process.env.RESEARCH_LEDGER ? resolve(process.env.RESEARCH_LEDGER) : resolve('.research'));
const led = new Ledger(dir, { receipts: true });

try {
  switch (cmd) {
    case 'init':
      led.ensure(); out({ ok: true, ledger: led.file }); break;
    case 'record': {
      need('claim'); need('provenance');
      const rec = led.record({
        claim: need('claim'),
        confidence: flags.confidence ?? 'observed',
        provenance: need('provenance'),
        ...(flags.task ? { task: flags.task } : {}),
        ...(flags.tags ? { tags: String(flags.tags).split(',').map(s => s.trim()).filter(Boolean) } : {}),
        ...(flags['verified-by'] ? { verifiedBy: flags['verified-by'] } : {}),
      });
      out({ ok: true, id: rec.id, seq: rec.seq }); break;
    }
    case 'add-unknown': {
      const rec = led.addUnknown({ what: need('what'), why: flags.why ?? null, classification: flags.classification ?? 'non-blocker' });
      out({ ok: true, id: rec.id }); break;
    }
    case 'resolve': {
      const rec = led.resolve(need('id'), need('resolution'));
      out({ ok: true, id: rec.id, ref: rec.ref }); break;
    }
    case 'gate-skip': {
      const rec = led.gateSkipped({
        gate: need('gate'), reason: need('reason'), risk: need('risk'), compensation: need('compensation'),
        ...(flags.covers ? { covers: String(flags.covers).split(',').map(s => s.trim()).filter(Boolean) } : {}),
      });
      out({ ok: true, id: rec.id, covers: rec.covers }); break;
    }
    case 'route': {
      let acceptance;
      if (typeof flags.acceptance === 'string') acceptance = JSON.parse(readFileSync(resolve(flags.acceptance), 'utf8'));
      const r = route(led, { clusterScale: flags.scale ?? 'delegate', ...(acceptance ? { acceptance } : {}) });
      led.append({ kind: 'route-check', action: r.action, why: r.why }); // 检查点落账（issue #6 配套）
      out({ ok: true, ledger: led.file, ...r }); break;
    }
    case 'verify': {
      const v = verifyLedger(led.file);
      out(v); if (!v.ok) process.exit(1); break;
    }
    case 'status': {
      const stats = led.stats();
      out({ ledger: led.file, stats, blockers: led.blockers(), routeChecks: stats.byKind['route-check'] ?? 0 }); break;
    }
    case 'ingest': {
      const r = ingestReport(led, resolve(need('file')), { source: flags.source ?? 'unnamed', ...(flags.task ? { task: flags.task } : {}) });
      out({ ok: r.errors.length === 0, ...r }); break;
    }
    case 'mark-verified': {
      const rec = markVerified(led, need('id'), flags.note);
      out({ ok: true, id: rec.id, ref: rec.ref, status: 'lead-verified' }); break;
    }
    default:
      console.error('未知命令: ' + cmd + '\n' + USAGE); process.exit(1);
  }
} catch (e) {
  console.error(String(e.message ?? e)); process.exit(1);
}
