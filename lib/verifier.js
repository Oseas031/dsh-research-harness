import { spawnSync } from 'node:child_process';
import { gateEntry } from './evidence-gate.js';

/**
 * 可插拔校验器。
 * kind='evidence'（默认）：对台账里 observed/inferred 条目复跑证据门（provenance 必须在场且合法）。
 * kind='command'：跑一条命令（如 lean --version 的探活 / 自定义校验脚本），退出码 0=通过——Lean 接口。
 */
export function createVerifier(cfg = {}) {
  const kind = cfg.kind ?? 'evidence';
  const enabled = cfg.enabled !== false;
  if (kind === 'command') {
    const command = cfg.command ?? '';
    return {
      kind, enabled,
      verify(_ledger) {
        if (!command) return { pass: true, checks: ['verifier command 未配置，跳过'] };
        const r = spawnSync(command, { shell: true, timeout: 60000, encoding: 'utf8' });
        const pass = r.status === 0;
        return { pass, checks: ['command: ' + command], failed: pass ? [] : ['exit=' + r.status + ' ' + String(r.stderr ?? '').slice(0, 200)] };
      },
    };
  }
  const cfgMaxAgeMs = typeof cfg.maxAgeHours === 'number' && cfg.maxAgeHours > 0 ? cfg.maxAgeHours * 3600 * 1000 : null;
  return {
    kind: 'evidence', enabled, maxAgeHours: cfgMaxAgeMs ? cfg.maxAgeHours : null,
    verify(ledger) {
      const failed = [];
      const warnings = [];
      let checked = 0, stale = 0;
      for (const e of ledger.entries()) {
        if (e.kind === 'finding' && (e.confidence === 'observed' || e.confidence === 'inferred')) {
          checked += 1;
          const d = gateEntry({ claim: e.claim, confidence: e.confidence, provenance: e.provenance });
          if (d) failed.push(e.id + ' ' + d.code);
          // v0.3 时效降档：条目年龄超过 maxAgeHours → 警告并降 confidence（findings.aggregate 按 todo 档计）
          if (cfgMaxAgeMs && e.ts) {
            const age = Date.now() - Date.parse(e.ts);
            if (Number.isFinite(age) && age > cfgMaxAgeMs) {
              stale += 1;
              warnings.push(e.id + ' stale(' + Math.round(age / 3600000) + 'h) → confidence 降 unknown');
            }
          }
        }
      }
      return { pass: failed.length === 0, checks: ['evidence re-gate over ' + checked + ' observed/inferred entries' + (stale ? ', ' + stale + ' stale' : '')], failed, warnings };
    },
  };
}
