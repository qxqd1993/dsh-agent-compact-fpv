/**
 * 剪枝闸回归测试（2026-11-15 会话文档损坏事故守卫）
 *
 * 事故：一条已经走过的可能性里，标记路径的监听器在 `turn/end` **之后**才跑到，压缩前的
 * 工具结果剪枝照样执行，15 个剪枝替身落在回合外。宿主 v4 读取器对 `tool/result` 分两支：
 * `surfaceOp === 'append'` 要求 openStep；**非 append（替换体）只要求 `openTurn !== null`**，
 * 否则整份日志被拒收——
 *
 *   SessionFormatError: tool/result is outside an open turn
 *
 * 拒绝发生在**下一次加载**（退出再进来那一刻），此时谁都救不回来：那份会话文档打不开了。
 *
 * 本测试守的是**闸的位置**：闸必须在写之前，而且必须真的挡住调用，不只是记一笔账。
 *   - 正样本：回合关着 ⇒ pruner 一次都不许被调
 *   - 尸体对照：若实现退回「不看回合状态直接剪」，第一条必红（pruner 被调了）
 *
 * 诚实边界：这里不跑真实宿主读取器，也不验「写下去日志真的坏了」——那一点由事故本身
 * 提供；被验的是本引擎在回合关着时会不会仍然去写。判据 `openTurn` 用的是引擎里同一份
 * 入口状态扫描（`region.ts` 的 `inspectCompactionEntryState`），没有第二份实现。
 *
 * 运行：先构建（tsc），再 node --test tests/prune-gate.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { pruneBeforeCompaction } from '../lib/prune.js'

/** 每个用例一个独立侧车，避免互相看到对方的行。 */
function freshTracePath() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prune-gate-'))
  return { path: join(dir, 'compaction-trace.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 假会话：只要 `seq` 与 `eventAt`。
 *
 * 刻意不用真实 harness Session——闸的判据是纯读，用数组喂它才验得出「看不看这件事」；
 * 真实 Session 的 append 会替我们把坏写拦掉，反而掩盖问题。
 * @param {Array<{type: string, data?: unknown}>} events - 按 seq 排列的事件
 */
function fakeSession(events) {
  return {
    seq: events.length,
    eventAt: (seq) => events[seq],
  }
}

/** 记账型 pruner：记下被调过几次、返回指定的剪枝结果。 */
function spyPruner(result) {
  const calls = []
  return {
    calls,
    prune: (session) => {
      calls.push(session)
      return result ?? { pruned: [{ seq: 999 }], charsRemoved: 2048 }
    },
  }
}

/** 读侧车；文件不存在就是「一行都没写」——这正是「无事可做不留声音」的判据。 */
function traceLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

test('回合关着 ⇒ 一条替身都不许写（pruner 一次都不许被调）', () => {
  const { path, cleanup } = freshTracePath()
  try {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: {} },
      { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
    ])
    const pruner = spyPruner()
    const outcome = pruneBeforeCompaction(session, 'marker', pruner.prune, path)

    assert.equal(outcome, 'turn-closed', '回合关闭时必须整体跳过')
    assert.equal(pruner.calls.length, 0,
      '尸体守卫：pruner 被调用了 ⇒ 替身会落在回合外 ⇒ 下次加载整份日志被拒收')

    const lines = traceLines(path)
    assert.equal(lines.length, 1, `应只留一行 prune-skipped，实得 ${JSON.stringify(lines)}`)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.phase, 'prune-skipped')
    assert.equal(entry.trigger, 'marker')
    assert.match(entry.note, /open turn/, 'note 必须写明宿主那条判据，否则下次只看到「跳过」不知道为什么')
  } finally {
    cleanup()
  }
})

test('回合开着 ⇒ 照常剪，并记账', () => {
  const { path, cleanup } = freshTracePath()
  try {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 7 } },
      { type: 'user/message', data: {} },
      { type: 'tool/result', data: {} },
    ])
    const pruner = spyPruner({ pruned: [{ seq: 1 }, { seq: 2 }], charsRemoved: 4096 })
    const outcome = pruneBeforeCompaction(session, 'marker', pruner.prune, path)

    assert.equal(outcome, 'pruned')
    assert.equal(pruner.calls.length, 1, '回合开着时闸不得误拦')

    const entry = JSON.parse(traceLines(path)[0])
    assert.equal(entry.phase, 'pruned')
    assert.match(entry.note, /2 条/)
    assert.match(entry.note, /4096/)
  } finally {
    cleanup()
  }
})

test('回合开着但没有可剪 ⇒ nothing，且不写噪声行', () => {
  const { path, cleanup } = freshTracePath()
  try {
    const session = fakeSession([{ type: 'turn/start', data: { turn: 1 } }])
    const pruner = spyPruner({ pruned: [], charsRemoved: 0 })
    const outcome = pruneBeforeCompaction(session, 'tool', pruner.prune, path)

    assert.equal(outcome, 'nothing')
    assert.equal(pruner.calls.length, 1, '没有可剪的东西也得先问过：那是服务的事，不是闸的事')
    assert.equal(traceLines(path).length, 0, '无事可做不该留一行噪声')
  } finally {
    cleanup()
  }
})

test('服务没挂 ⇒ no-service，写明原因（不静默）', () => {
  const { path, cleanup } = freshTracePath()
  try {
    const session = fakeSession([{ type: 'turn/start', data: { turn: 1 } }])
    const outcome = pruneBeforeCompaction(session, 'tool', undefined, path)

    assert.equal(outcome, 'no-service')
    const entry = JSON.parse(traceLines(path)[0])
    assert.equal(entry.phase, 'prune-skipped')
    assert.match(entry.note, /toolResultPruner/)
  } finally {
    cleanup()
  }
})

test('剪枝自己抛 ⇒ failed 记账，但不把异常扔回主事务', () => {
  const { path, cleanup } = freshTracePath()
  try {
    const session = fakeSession([{ type: 'turn/start', data: { turn: 1 } }])
    const outcome = pruneBeforeCompaction(session, 'marker', () => {
      throw new Error('pruner exploded')
    }, path)

    assert.equal(outcome, 'failed')
    const entry = JSON.parse(traceLines(path)[0])
    assert.equal(entry.phase, 'prune-failed')
    assert.match(String(entry.error), /pruner exploded/)
  } finally {
    cleanup()
  }
})
