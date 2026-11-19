/** 缺口④ Results-to-Code 复现槽（v0.3）：SLSA v1.0 provenance predicate 字段子集。
 * 出处：slsa.dev/spec/v1.0/provenance（字段名直接采纳，不用 level 体系）。
 * 用法：findings.record 带 repro 时校验；harness-lab 新场景构造反向复现任务。
 */
const REPRO_KEYS = new Set([
  'build_type', 'external_parameters', 'internal_parameters',
  'resolved_dependencies', 'subject_digest', 'invocation_id',
  'started_on', 'finished_on',
]);

/** 校验 repro 槽。返回 null 放行 / {code, reason}。 */
export function validateRepro(repro) {
  if (repro === undefined || repro === null) return null;
  if (typeof repro !== 'object' || Array.isArray(repro)) {
    return { code: 'REPRO_BAD_OBJECT', reason: 'REPRO_BAD_OBJECT: repro 必须是对象（SLSA predicate 字段子集）。' };
  }
  for (const k of Object.keys(repro)) {
    if (!REPRO_KEYS.has(k)) {
      return { code: 'REPRO_BAD_KEY', reason: 'REPRO_BAD_KEY: repro 只收 SLSA 字段（' + [...REPRO_KEYS].join(', ') + '），收到: ' + k };
    }
  }
  if (typeof repro.subject_digest === 'string' && !/^[0-9a-f]{8,64}$/i.test(repro.subject_digest)) {
    return { code: 'REPRO_BAD_DIGEST', reason: 'REPRO_BAD_DIGEST: subject_digest 必须是十六进制摘要（sha256 前 8-64 位）。' };
  }
  return null;
}
