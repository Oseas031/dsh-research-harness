import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * 收据层（v0.4，RSIHub 吸纳 #1）：机制写入的每条 ledger 记录，
 * 同步把该行内容的 SHA-256 追加进 <ledgerRoot>/ledger-receipts.jsonl。
 * verifyLedger 重算哈希逐条核对——手改台账行立即可检（drifted）。
 * 与 append-only 结构正交：旧台账无收据不报错，标 unverified。
 */

export function receiptsPath(ledgerFile) {
  return join(dirname(ledgerFile), 'ledger-receipts.jsonl');
}

/** 一行记录的收据哈希（sha256 hex）。行内容不含行尾换行——append 与 verify 两侧同规。 */
export function receiptOf(line) {
  return createHash('sha256').update(String(line).replace(/\n$/, ''), 'utf8').digest('hex');
}

/** 机制追加一条收据。line 必须是刚写入 ledger 的那一行原文（带换行）。 */
export function appendReceipt(ledgerFile, line) {
  const text = String(line);
  if (!text.endsWith('\n')) throw new Error('RECEIPT_BAD_LINE: 收据行必须以换行结尾（原文一行）');
  appendFileSync(receiptsPath(ledgerFile), receiptOf(text) + '\n', 'utf8');
}

function readLines(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim().length > 0);
}

/**
 * 核对台账：每行重算哈希与收据文件按位比对。
 * 返回 { ok, checked, drifted, unverified, receipts }：
 *  - drifted：行存在收据但哈希不匹配（行被手改）
 *  - unverified：行没有对应收据（旧台账/收据缺失），不算错
 *  - ok = drifted.length === 0
 * 收据比台账行多（台账被截断/删行）也计入 drifted（末尾多出的收据数）。
 */
export function verifyLedger(ledgerFile) {
  const lines = readLines(ledgerFile);
  const receipts = readLines(receiptsPath(ledgerFile));
  const drifted = [];
  let unverified = 0;
  const n = Math.min(lines.length, receipts.length);
  for (let i = 0; i < n; i++) {
    if (receiptOf(lines[i]) !== receipts[i]) drifted.push({ line: i + 1, expected: receipts[i].slice(0, 12), actual: receiptOf(lines[i]).slice(0, 12) });
  }
  if (lines.length < receipts.length) {
    for (let i = lines.length; i < receipts.length; i++) drifted.push({ line: i + 1, expected: receipts[i].slice(0, 12), actual: null });
  }
  if (lines.length > receipts.length) unverified = lines.length - receipts.length;
  return {
    ok: drifted.length === 0,
    checked: n,
    drifted,
    unverified,
    receipts: receipts.length,
    ...(drifted.length ? { hint: 'drifted=行被手改或删行；见 .research/ledger-receipts.jsonl 机制收据' } : {}),
  };
}
