/** 缺口③ 成本槽（v0.3）：token 词表对齐 OTel GenAI registry（gen_ai.usage.*）。
 * 官方无 cost 属性——cost_usd 为我们自留派生字段（currency 恒 USD）。
 * 出处：open-telemetry/semantic-conventions-genai docs/gen-ai/gen-ai-token-metrics.md。
 */
const TOKEN_KEYS = new Set([
  'input_tokens', 'output_tokens',
  'cache_read.input_tokens', 'cache_write.input_tokens',
  'reasoning.output_tokens',
  'cost_usd', 'currency',
]);

/** 校验 tokens 槽。返回 null 放行 / {code, reason}。 */
export function validateCost(tokens) {
  if (tokens === undefined || tokens === null) return null;
  if (typeof tokens !== 'object' || Array.isArray(tokens)) {
    return { code: 'COST_BAD_TOKENS', reason: 'COST_BAD_TOKENS: tokens 必须是对象（OTel gen_ai.usage 词表键）。' };
  }
  for (const k of Object.keys(tokens)) {
    if (!TOKEN_KEYS.has(k)) {
      return { code: 'COST_BAD_KEY', reason: 'COST_BAD_KEY: tokens 只收 OTel gen_ai.usage 词表键（' + [...TOKEN_KEYS].join(', ') + '），收到: ' + k };
    }
  }
  for (const k of Object.keys(tokens)) {
    if (k === 'currency') continue;
    const v = tokens[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { code: 'COST_BAD_VALUE', reason: 'COST_BAD_VALUE: ' + k + ' 必须是非负数。' };
    }
  }
  if (tokens.currency !== undefined && tokens.currency !== 'USD') {
    return { code: 'COST_BAD_CURRENCY', reason: 'COST_BAD_CURRENCY: 当前只收 USD（派生字段）。' };
  }
  return null;
}
