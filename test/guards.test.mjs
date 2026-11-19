import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardBinaryRead, guardPathEscape, guardAgentParams, check } from '../lib/guards.js';

test('guards: 文本小文件放行', () => {
  assert.equal(guardBinaryRead({ path: 'a.py', size: 1000 }), null);
});
test('guards: 二进制扩展名拒绝', () => {
  assert.equal(guardBinaryRead({ path: 'model.safetensors' }).code, 'READ_BINARY');
});
test('guards: 超大文件拒绝', () => {
  assert.equal(guardBinaryRead({ path: 'big.log', size: 30 * 1024 * 1024 }).code, 'READ_TOO_LARGE');
});
test('guards: 工作区内写入放行', () => {
  assert.equal(guardPathEscape({ root: 'E:/ws', target: 'E:/ws/sub/a.txt' }), null);
});
test('guards: 工作区外写入拒绝', () => {
  assert.equal(guardPathEscape({ root: 'E:/ws', target: 'C:/Windows/System32/a.dll' }).code, 'WRITE_OUTSIDE_WORKSPACE');
});
test('guards: 前缀相似但越界拒绝', () => {
  assert.equal(guardPathEscape({ root: 'E:/ws', target: 'E:/ws-evil/a.txt' }).code, 'WRITE_OUTSIDE_WORKSPACE');
});
test('guards: 读取越界给 READ 码', () => {
  assert.equal(guardPathEscape({ root: 'E:/ws', target: 'C:/x.txt', mode: 'read' }).code, 'READ_OUTSIDE_WORKSPACE');
});
test('guards: 合法子代理参数放行', () => {
  assert.equal(guardAgentParams({ description: '检索文献', prompt: '找 3 篇相关论文' }), null);
});
test('guards: 子代理缺描述拒绝', () => {
  assert.equal(guardAgentParams({ prompt: 'x' }).code, 'AGENT_NO_DESCRIPTION');
});
test('guards: 子代理超长 prompt 拒绝', () => {
  assert.equal(guardAgentParams({ description: 'd', prompt: 'x'.repeat(20001) }).code, 'AGENT_PROMPT_TOO_LONG');
});
test('guards: 子代理持有 Bash 拒绝', () => {
  assert.equal(guardAgentParams({ description: 'd', prompt: 'p', tools: ['Bash'] }).code, 'AGENT_FORBIDDEN_TOOLS');
});
test('check: read 路由到二进制守卫', () => {
  assert.equal(check('Read', { file_path: 'x.pt' }).code, 'READ_BINARY');
});
test('check: write 路由到路径守卫', () => {
  assert.equal(check('write', { file_path: 'C:/evil.txt' }, { workspaceRoot: 'E:/ws' }).code, 'WRITE_OUTSIDE_WORKSPACE');
});
test('check: subagent 路由到参数守卫（大小写无关）', () => {
  assert.equal(check('Subagent', { prompt: 'x' }).code, 'AGENT_NO_DESCRIPTION');
});
test('check: 未知工具放行', () => {
  assert.equal(check('todo_write', { anything: 1 }), null);
});

import { validateProvenance } from '../lib/evidence-gate.js';
test('裸 tool:<名> 引用合法（v0.3 修 TOOL_REF_RE 回归）', () => {
  assert.equal(validateProvenance('tool:run_code'), null);
  assert.equal(validateProvenance('tool:web_search 关键词'), null);
  assert.ok(validateProvenance('tool:')?.code === 'EVIDENCE_BAD_PROVENANCE' || validateProvenance('tool:') !== null);
  assert.ok(validateProvenance('tool:bad/key')?.code === 'EVIDENCE_BAD_PROVENANCE');
  assert.ok(validateProvenance('nope at all')?.code === 'EVIDENCE_BAD_PROVENANCE');
});