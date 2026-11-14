/**
 * 水位提醒状态机的离线测试（纯函数，不碰 cordis / 会话 / 时钟）。
 *
 * 这个状态机的全部价值在**不重复、不遗漏**：同一档只喊一次，跨档再喊一次，
 * 跌回 60 以下重置（否则一次压缩之后就再也不提醒——那比没有更糟，因为它让写的人
 * 以为这里有人看着）。所以每条判据都配一个「会红」的反面样本。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INITIAL_GAUGE_STATE,
  STEP_HARD,
  STEP_MILD,
  WARN_HARD,
  WARN_HIGH,
  WARN_LOW,
  advanceGauge,
  buildWaterLevelNotice,
} from '../lib/water-level.js'
import { serializeTraceEntry } from '../lib/trace.js'

/** 把一串水位依次喂给状态机，返回每步的结论（便于断言整条轨迹）。 */
function run(levels, initial = INITIAL_GAUGE_STATE) {
  let state = initial
  const decisions = []
  for (const level of levels) {
    const decision = advanceGauge(level, state)
    state = decision.state
    decisions.push(decision)
  }
  return { decisions, state }
}

/** 只取出声的步骤，形如 `['trace@60', 'notice@66']`。 */
function sounds(decisions) {
  return decisions
    .filter((d) => d.kind !== 'none')
    .map((d) => `${d.kind}@${d.bucket}`)
}

describe('常量：水位与档距', () => {
  test('60 / 65 / 75 与 2 / 1 是设计值（改了这里必须重读状态机注释）', () => {
    assert.equal(WARN_LOW, 60)
    assert.equal(WARN_HIGH, 65)
    assert.equal(WARN_HARD, 75)
    assert.equal(STEP_MILD, 2)
    assert.equal(STEP_HARD, 1)
  })

  test('初始状态两个桶都是 0（0 = 未提醒），且不可变', () => {
    assert.deepEqual(INITIAL_GAUGE_STATE, { lastTraceBucket: 0, lastNoticeBucket: 0 })
    assert.ok(Object.isFrozen(INITIAL_GAUGE_STATE))
  })
})

describe('状态机：只留痕 / 提醒 / 沉默', () => {
  test('60 以下不出声，且状态保持初始', () => {
    const { decisions, state } = run([0, 12.5, 59.9])
    assert.deepEqual(decisions.map((d) => d.kind), ['none', 'none', 'none'])
    assert.deepEqual(state, INITIAL_GAUGE_STATE)
  })

  test('60 起步：60 / 62 / 64 各写一条 trace（不打扰），同一档重复不写', () => {
    const { decisions } = run([60, 60, 62, 62.9, 64])
    assert.deepEqual(sounds(decisions), ['trace@60', 'trace@62', 'trace@64'])
  })

  test('65 起：第一次提醒在 66（档距 2 向下取整，65 落在 64 档——这是设计里的算术）', () => {
    // 单独钉住这条：很多人会以为「65 就提醒」，但 floor(65/2)*2 = 64 < WARN_HIGH。
    const at65 = run([65]).decisions[0]
    assert.equal(at65.kind, 'trace')
    assert.equal(at65.bucket, 64)
    assert.equal(at65.stepSize, STEP_MILD)

    const at66 = run([66]).decisions[0]
    assert.equal(at66.kind, 'notice')
    assert.equal(at66.bucket, 66)
  })

  test('同一档重复不提醒（66 → 66.9 → 67 仍然只喊一次）', () => {
    const { decisions } = run([66, 66, 66.9, 67])
    assert.deepEqual(sounds(decisions), ['notice@66'])
  })

  test('跨档再提醒一次（66 → 68 → 70）', () => {
    const { decisions } = run([66, 67, 68, 69, 70])
    assert.deepEqual(sounds(decisions), ['notice@66', 'notice@68', 'notice@70'])
  })

  test('提醒之后不再补 trace（两个桶一起推到同档）', () => {
    // 60 写 trace，66 提醒；66 之后到 74 之间不该出现任何 trace（都被提醒覆盖）。
    const { decisions } = run([60, 66, 67, 68, 72, 74])
    const kinds = decisions.filter((d) => d.kind !== 'none').map((d) => d.kind)
    assert.deepEqual(kinds, ['trace', 'notice', 'notice', 'notice', 'notice'])
    assert.ok(!kinds.slice(1).includes('trace'), '提醒档里出现 trace 说明两个桶被共用了')
  })

  test('75 以上档距变 1：75.2 / 75.9 / 76.4 给出 75 / 75 / 76', () => {
    const { decisions } = run([75.2, 75.9, 76.4])
    assert.deepEqual(sounds(decisions), ['notice@75', 'notice@76'])
    assert.equal(decisions[0].stepSize, STEP_HARD)
    assert.equal(decisions[2].stepSize, STEP_HARD)
    assert.equal(decisions[1].kind, 'none', '75.9 仍在 75 档（档距 1 时同一整数百分点只喊一次）')
    // 74.9 仍在温和档（< 75），档距 2 ⇒ 74
    const below = run([74.9]).decisions[0]
    assert.equal(below.stepSize, STEP_MILD)
    assert.equal(below.bucket, 74)
  })

  test('跌回 60 以下 ⇒ 重置：再上来必须重新提醒（尸体样本：不重置就永远静音）', () => {
    const history = run([66, 55, 66])
    assert.deepEqual(sounds(history.decisions), ['notice@66', 'notice@66'])
    assert.deepEqual(history.decisions[1].state, INITIAL_GAUGE_STATE)

    // 反面对照：如果实现忘了重置，第三步会退回 'none'（因为 66 不大于上次提醒的 66）。
    // 这里再走一条更长的路：提醒→压缩后跌到 30→重新爬升。
    const long = run([66, 70, 30, 58, 60, 66])
    assert.deepEqual(sounds(long.decisions), ['notice@66', 'notice@70', 'trace@60', 'notice@66'])
  })

  test('非有限水位 ⇒ 沉默且**不推进状态**（既不当 0 重置、也不凭空喊红线）', () => {
    const before = { lastTraceBucket: 64, lastNoticeBucket: 66 }
    for (const bad of [NaN, Infinity, -Infinity]) {
      const decision = advanceGauge(bad, before)
      assert.equal(decision.kind, 'none')
      assert.deepEqual(decision.state, before, '坏读数不得改写状态机')
    }
  })

  test('超窗（>100）照常提醒，不截断（水位就是超了）', () => {
    const decision = advanceGauge(130, INITIAL_GAUGE_STATE)
    assert.equal(decision.kind, 'notice')
    assert.equal(decision.bucket, 130)
    assert.equal(decision.stepSize, STEP_HARD)
  })

  test('状态不可变：推进不修改传入的 state', () => {
    const state = Object.freeze({ lastTraceBucket: 0, lastNoticeBucket: 0 })
    advanceGauge(66, state)
    assert.deepEqual(state, { lastTraceBucket: 0, lastNoticeBucket: 0 })
  })
})

describe('告知文案：说清「你可以做什么」', () => {
  test('温和档（68%）：给水位、三条出路，且不催人立刻决定', () => {
    const text = buildWaterLevelNotice(68)
    assert.match(text, /68%/)
    for (const sentinel of ['<!-- self-compact -->', '<!-- handoff-compact -->', '<compacted-summary>']) {
      assert.ok(text.includes(sentinel), '要能直接照抄：' + sentinel)
    }
    assert.ok(text.includes('继续'), '第二条出路：继续')
    assert.ok(text.includes('换一个会话'), '第三条出路：换会话')
    assert.ok(text.includes('不要求你现在决定'), '温和档不得催')
    assert.ok(!text.includes('红线'), '温和档不得喊红线')
  })

  test('红线档（77%）：措辞换掉，直接、不铺垫（「吵」在这里不是缺点）', () => {
    const text = buildWaterLevelNotice(77)
    assert.match(text, /77%/)
    assert.ok(text.includes('红线'), '红线档必须明说自己在红线')
    assert.ok(text.includes('<!-- self-compact -->') && text.includes('<!-- handoff-compact -->'))
    assert.ok(!text.includes('不要求你现在决定'), '红线档不得沿用温和档的「不用现在决定」')
    assert.ok(text.includes('立刻'), '红线档必须给「立刻做」的动作')
  })

  test('两档文案必须不同（按水位切档，而不是恒同一句）', () => {
    assert.notEqual(buildWaterLevelNotice(74), buildWaterLevelNotice(75))
  })

  test('档边界：74.9 温和、75 红线', () => {
    assert.ok(!buildWaterLevelNotice(74.9).includes('红线'))
    assert.ok(buildWaterLevelNotice(75).includes('红线'))
  })

  test('水位取整显示（67.6 → 68%）', () => {
    assert.match(buildWaterLevelNotice(67.6), /68%/)
  })
})

describe('侧车证据：water-level 行带水位 / 档位 / 档距', () => {
  test('三个字段按 totalMs 之后落位，缺省时不出现', () => {
    const line = serializeTraceEntry({
      atMs: 1,
      phase: 'water-level',
      build: '0.3.0@1',
      trigger: 'water-level',
      waterLevel: 68.4,
      bucket: 68,
      stepSize: 2,
    })
    assert.equal(
      line,
      '{"atMs":1,"phase":"water-level","build":"0.3.0@1","trigger":"water-level",'
      + '"waterLevel":68.4,"bucket":68,"stepSize":2}',
    )
    const bare = serializeTraceEntry({ atMs: 1, phase: 'boot', build: 'b' })
    for (const field of ['waterLevel', 'bucket', 'stepSize']) {
      assert.ok(!bare.includes(field), field + ' 不该出现在无水位信息的行里')
    }
  })
})

