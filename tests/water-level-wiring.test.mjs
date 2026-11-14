/**
 * 水位提醒的**接线**测试：`agent/pre-step` → 算水位 → 状态机 → 投递 / 侧车。
 *
 * 纯状态机与文案由 `water-level.test.mjs` 覆盖；这里只证明它**真的接上了**：
 *  ① 监听器注册在 `agent/pre-step` 上，且永远 `next()` 放行（提醒不是拦截）；
 *  ② 分子/分母取的是 `tokenMeter.measure().totalTokens` 与 `contextPressure().contextWindow`；
 *  ③ 提醒投给 `next-step`、`wakeup=false`（不新开回合），同档不重复；
 *  ④ 分母未知 / 投递失败都只记账，不拦 step、不静默。
 *
 * 用桩 ctx 直接 `new AgentCompactEngine(...)`——不需要 cordis，也不碰真实会话。
 * `DSH_HOME` 先指到临时目录：引擎模块一被 import 就落 boot 轨迹，合成读数不得写进
 * 使用者真实的 `compaction-trace.jsonl`。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compactionTracePath, readTraceEntries } from '../lib/trace.js'

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'compact-gauge-wiring-'))
process.env.DSH_HOME = TEMP_HOME
const { default: AgentCompactEngine } = await import('../lib/index.js')

// 本文件自己建的临时家目录，跑完就删（别把合成读数留在磁盘上）。
after(() => { rmSync(TEMP_HOME, { recursive: true, force: true }) })

// ── 接线：agent/pre-step → 状态机 → 投递（桩上下文，不碰真实会话）──────────────

/**
 * 用桩 ctx 直接构造引擎（不需要 cordis），并取出它注册的 `agent/pre-step` 监听器。
 *
 * 测的是**接线**：分子/分母从哪来、水位怎么算、提醒投给谁、失败会不会拦住 step。
 * 状态机的纯逻辑由上面那组测试覆盖，这里不重复。
 * @param {{capacity?: number|null, sendFails?: boolean, sessionId?: string}} [options]
 * @returns 引擎、收集器与驱动入口。
 */
function gaugeHarness(options = {}) {
  const sends = []
  const listeners = new Map()
  let level = 0
  let capacity = options.capacity === undefined ? 1000 : options.capacity
  const sendFails = options.sendFails === true

  const session = {
    id: options.sessionId ?? 'session-gauge',
    seq: 0,
    eventAt: () => undefined,
    surface: { nodes: [] },
  }
  const agent = {
    id: 'agent-gauge',
    session,
    send(message, target, wakeup) {
      if (sendFails) throw new Error('send-failed')
      sends.push({ text: message?.content?.[0]?.text, target, wakeup })
    },
  }

  const ctx = {
    provide: () => () => {},
    get: () => undefined,
    on: (event, listener) => { listeners.set(event, listener) },
    logger: { warn: () => {} },
    agents: { get: () => agent },
    sessions: { flush: async () => {} },
    tokenMeter: {
      contextPressure: () => (capacity === null ? {} : { contextWindow: capacity }),
      measure: () => ({ nodes: [], totalTokens: (level / 100) * capacity }),
      estimateMessage: () => 1,
    },
  }

  const engine = new AgentCompactEngine(ctx, {})
  const listener = listeners.get('agent/pre-step')
  assert.equal(typeof listener, 'function', '构造函数必须注册 agent/pre-step 监听器')

  return {
    engine,
    sends,
    session,
    setLevel(value) { level = value },
    setCapacity(value) { capacity = value },
    /**
     * 走一次 pre-step，返回监听器给它的决定。
     * @returns {Promise<object>} `next()` 的决定（用来证明它确实放行了）。
     */
    async step() {
      const decision = { kind: 'enter', messages: [] }
      return await listener(
        { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: {} },
        () => Promise.resolve(decision),
      )
    },
  }
}

/** 读侧车并按 phase + 会话 tag 过滤（各测试共用一个临时家目录，必须按会话分开）。 */
function traceLines(phase, sessionTag) {
  return readTraceEntries(compactionTracePath(TEMP_HOME))
    .filter((entry) => entry.phase === phase && entry.session === sessionTag)
}

describe('接线：agent/pre-step → 状态机 → 投递（桩上下文）', () => {
  test('68% 注入一条 next-step 告知；同一档下一步不重复', async () => {
    const h = gaugeHarness()
    h.setLevel(68)
    const decision = await h.step()
    assert.equal(h.sends.length, 1)
    assert.equal(h.sends[0].target, 'next-step')
    assert.equal(h.sends[0].wakeup, false, '提醒不得唤醒一个新回合')
    assert.match(h.sends[0].text, /68%/)
    assert.match(h.sends[0].text, /checkpoint/)
    assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'pre-step 必须照常放行（提醒不是拦截）')

    h.setLevel(68.5)
    await h.step()
    assert.equal(h.sends.length, 1, '同一档不得重复喊')
  })

  test('跌回 60 以下重置后再上来，必须重新提醒', async () => {
    const h = gaugeHarness()
    h.setLevel(66)
    await h.step()
    h.setLevel(50)
    await h.step()
    h.setLevel(66)
    await h.step()
    assert.equal(h.sends.length, 2, '不重置就会永远静音——那比没有提醒更糟')
  })

  test('分母未知：不出声，但侧车留一笔「压力计瞎了」（不静默）', async () => {
    const h = gaugeHarness({ capacity: null, sessionId: 'session-blind' })
    h.setLevel(99)
    await h.step()
    await h.step()
    assert.equal(h.sends.length, 0, '算不出百分比就不许猜')
    assert.equal(traceLines('water-level-skipped', 'blind').length, 1, '同一会话只记首次，不刷屏')
  })

  test('投递失败：不拦 step，只落 water-level-failed', async () => {
    const h = gaugeHarness({ sendFails: true, sessionId: 'session-failx' })
    h.setLevel(66)
    const decision = await h.step() // 不得抛
    assert.equal(decision.kind, 'enter')
    const failed = traceLines('water-level-failed', 'failx')
    assert.equal(failed.length, 1)
    assert.match(String(failed[0].error), /send-failed/)
  })

  test('60-64 只写 trace，不打扰（可见通道零消息）', async () => {
    const h = gaugeHarness({ sessionId: 'session-quiet' })
    h.setLevel(62)
    await h.step()
    assert.equal(h.sends.length, 0)
    const lines = traceLines('water-level', 'quiet')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].waterLevel, 62)
    assert.equal(lines[0].bucket, 62)
    assert.equal(lines[0].stepSize, 2)
    assert.match(String(lines[0].note), /620\/1000 tok/, '侧车要能回答「当时算的是多少」')
  })

  test('enabled:false ⇒ 水位监听也不注册（说了做不到的出路，不如不说）', () => {
    const listeners = new Map()
    const ctx = {
      provide: () => () => {},
      get: () => undefined,
      on: (event, listener) => { listeners.set(event, listener) },
      logger: { warn: () => {} },
      agents: { get: () => undefined },
      sessions: { flush: async () => {} },
      tokenMeter: {},
    }
    new AgentCompactEngine(ctx, { enabled: false })
    assert.equal(listeners.has('agent/pre-step'), false)
    assert.equal(listeners.has('session/event'), false, '标记路径本就受 enabled 管，两者一起关')
  })
})
