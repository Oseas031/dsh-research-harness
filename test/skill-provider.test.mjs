import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, parseInvocationPolicy, isSkillName } from '../lib/frontmatter.js';
import { createHarnessSkillProvider, registerHarnessSkills, SKILL_PROVIDER_NAME, BUNDLED_RANK } from '../lib/skill-provider.js';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(PKG, 'skills');
const EXPECTED = ['expectation-alignment',
  'humanizer-paper', 'latex-paper-en', 'latex-thesis-zh', 'literature-search-arxiv', 'nature-polishing', 'qu-ai-wei', 'sci-figure', 'scientific-problem-selection', 'validate-data'];
const FIXTURE = "---\nname: t1\ndescription: \"带 \\\"内嵌引号\\\" 与: 冒号\"\ntags: [a, \"b c\", 'd']\nblock:\n  - x\n  - y\nfold: >-\n  第一行\n  第二行\n---\n\n正文";

test('frontmatter: 9 个真实 SKILL.md 全部解析出 name+description', () => {
  for (const name of EXPECTED) {
    const raw = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const parsed = parseFrontmatter(raw);
    assert.ok(parsed, name + ': frontmatter 解析失败');
    assert.equal(parsed.data.name, name, name + ': name 不匹配');
    assert.ok(typeof parsed.data.description === 'string' && parsed.data.description.length > 10, name + ': description 缺失或过短');
    assert.ok(parsed.body.length > 100, name + ': 正文过短');
    assert.ok(!/^---/.test(parsed.body), name + ': 正文里残留 frontmatter 围栏');
  }
});

test('frontmatter: 引号串/流数组/块序列各语法路径', () => {
  const p = parseFrontmatter(FIXTURE);
  assert.equal(p.data.name, 't1');
  assert.equal(p.data.description, '带 "内嵌引号" 与: 冒号');
  assert.deepEqual(p.data.tags, ['a', 'b c', 'd']);
  assert.deepEqual(p.data.block, ['x', 'y']);
  assert.equal(p.data.fold, '第一行 第二行');
  assert.equal(p.body, '正文');
  assert.equal(parseFrontmatter('无围栏'), undefined);
  assert.equal(parseFrontmatter('---\nname: x\n'), undefined);
});

test('isSkillName/parseInvocationPolicy 语义', () => {
  assert.ok(isSkillName('sci-figure'));
  assert.ok(!isSkillName('Sci Figure'));
  assert.ok(!isSkillName(''));
  assert.deepEqual(parseInvocationPolicy({}), { modelInvocable: true, userInvocable: true });
  assert.deepEqual(parseInvocationPolicy({ 'disable-model-invocation': true }), { modelInvocable: false, userInvocable: true });
  assert.deepEqual(parseInvocationPolicy({ 'user-invocable': false }), { modelInvocable: true, userInvocable: false });
});

test('provider: list() 返回 10 技能且候选字段齐备', async () => {
  const logs = [];
  const provider = createHarnessSkillProvider({ skillsDir: SKILLS, log: (e) => logs.push(e) });
  assert.equal(provider.name, SKILL_PROVIDER_NAME);
  const candidates = await provider.list({});
  assert.equal(candidates.length, 10, '应有 10 个技能，实际 ' + candidates.length + '；skip 日志: ' + JSON.stringify(logs));
  const names = candidates.map(c => c.name).sort();
  assert.deepEqual(names, [...EXPECTED].sort());
  for (const c of candidates) {
    assert.equal(c.provider, SKILL_PROVIDER_NAME);
    assert.equal(c.rank, BUNDLED_RANK);
    assert.equal(c.source, 'bundled');
    assert.equal(typeof c.path, 'string');
    assert.ok(c.invocation && typeof c.invocation.modelInvocable === 'boolean');
    assert.deepEqual(c.resourceBase, { kind: 'directory', path: dirname(c.path) });
    assert.ok(c.locator && typeof c.locator.file === 'string');
  }
});

test('provider: get() 装回完整定义', async () => {
  const provider = createHarnessSkillProvider({ skillsDir: SKILLS });
  const [c] = (await provider.list({})).filter(c => c.name === 'sci-figure');
  assert.ok(c);
  const def = await provider.get(c, {});
  assert.equal(def.name, 'sci-figure');
  assert.equal(def.provider, SKILL_PROVIDER_NAME);
  assert.ok(def.content.length > 100);
  assert.ok(/render\.py/.test(def.content));
  const def2 = await provider.get({ path: c.path }, {});
  assert.equal(def2.name, 'sci-figure');
  assert.equal(await provider.get({}, {}), undefined);
});

test('provider: 品牌残留红线——技能目录无 .clawsgo-rev/__pycache__', () => {
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      if (e.isDirectory()) {
        assert.ok(e.name !== '__pycache__', '残留目录: ' + fp);
        walk(fp);
      } else {
        assert.ok(e.name !== '.clawsgo-rev', '残留文件: ' + fp);
      }
    }
  };
  walk(SKILLS);
});

test('registerHarnessSkills: ctx.skills 缺席时 state=absent 不炸', () => {
  const r = registerHarnessSkills({}, { skillsDir: SKILLS });
  assert.equal(r.state, 'absent');
  assert.equal(r.count, 0);
  const r2 = registerHarnessSkills(null, {});
  assert.equal(r2.state, 'absent');
});

test('registerHarnessSkills: 有注册表时挂上并计数', () => {
  const registered = [];
  const fakeCtx = {
    skills: {
      registerProvider(create) {
        const p = create({ signal: new AbortController().signal, invalidate() {} });
        registered.push(p);
        return () => { const i = registered.indexOf(p); if (i >= 0) registered.splice(i, 1); };
      },
    },
  };
  const r = registerHarnessSkills(fakeCtx, { skillsDir: SKILLS });
  assert.equal(r.state, 'ok');
  assert.equal(r.count, 10);
  assert.equal(registered.length, 1);
  assert.equal(typeof r.dispose, 'function');
});
