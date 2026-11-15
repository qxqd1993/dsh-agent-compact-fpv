/**
 * 压缩前后水位读数回归测试（2026-11-15）
 *
 * 缺口：`shadowedTokenCount` 只答「吞掉多少」，答不了「剩下多少」。于是「这次压缩降了
 * 几个点」只能事后推——记录者据此把**一次读数**推成了结构性的「地板」，推错了。
 * 修法：`committed` 行同时写压缩前 / 后的读数，差值就是真的。
 *
 * 本测试守三件事：
 *   ① 两次读数落在正确的字段上（before/after 不许写反——写反会让「压缩让水位上升」这种荒唐读数显得合理）
 *   ② 分母未知（还没有 request/context）时**只给 token 量，不给百分比**（编一个百分比就是假读数）
 *   ③ 计量器抛错 ⇒ 返回空读数 + error，**不抛**（读数失败不许吃掉一次成功的压缩）
 *
 * 诚实边界：用桩计量器，不验真实 meter 的数值。被验的是「读哪个数、写哪个字段、
 * 读不出来时怎么收场」，不是 token 计量的准确性。
 *
 * 运行：先构建（tsc），再 node --test tests/levels.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readLevels } from '../lib/water-level.js'

/** 桩：totalTokens 与 contextWindow 由用例给；contextWindow 缺省表示「分母未知」。 */
function stubMeter(totalTokens, contextWindow) {
  return {
    measure: () => ({ totalTokens }),
    contextPressure: () => (contextWindow === undefined ? {} : { contextWindow }),
  }
}

test('压缩前：读数落在 before 字段，一位小数', () => {
  const reading = readLevels(stubMeter(748_000, 1_048_576), {}, false)
  assert.equal(reading.error, undefined)
  assert.equal(reading.levels.tokensBefore, 748_000)
  assert.equal(reading.levels.waterLevelBefore, 71.3, '(748000/1048576)*100 = 71.3')
  assert.equal(reading.levels.tokensAfter, undefined, '前读数不许写到 after 字段（写反会造出「压缩让水位上升」）')
  assert.equal(reading.levels.waterLevelAfter, undefined)
})

test('压缩后：读数落在 after 字段，且与 before 不同名', () => {
  const reading = readLevels(stubMeter(200_295, 1_048_576), {}, true)
  assert.equal(reading.levels.tokensAfter, 200_295)
  assert.equal(reading.levels.waterLevelAfter, 19.1)
  assert.equal(reading.levels.tokensBefore, undefined, '后读数不许写到 before 字段')
})

test('分母未知 ⇒ 只给 token 量，不编百分比', () => {
  const reading = readLevels(stubMeter(123_456, undefined), {}, false)
  assert.equal(reading.error, undefined, '没有分母不是错误，只是算不出比例')
  assert.equal(reading.levels.tokensBefore, 123_456)
  assert.equal(reading.levels.waterLevelBefore, undefined, '分母未知时给百分比就是捏造')
})

test('分母为 0 / 负数 / 非安全整数 ⇒ 同样不给百分比', () => {
  for (const broken of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    const reading = readLevels(stubMeter(1000, broken), {}, false)
    assert.equal(reading.levels.waterLevelBefore, undefined, `contextWindow=${String(broken)} 不该算出百分比`)
    assert.equal(reading.levels.tokensBefore, 1000)
  }
})

test('计量器抛错 ⇒ 空读数 + error，绝不抛回调用方', () => {
  const throwing = {
    measure: () => { throw new Error('meter exploded') },
    contextPressure: () => ({ contextWindow: 1000 }),
  }
  const reading = readLevels(throwing, {}, false)
  assert.equal(reading.error, 'meter exploded')
  assert.deepEqual(reading.levels, {}, '失败时不给半截读数：半截会被读成「压完就空了」')
})

test('百分比取一位小数（不是整数，也不是长尾）', () => {
  const reading = readLevels(stubMeter(1, 3), {}, false)
  assert.equal(reading.levels.waterLevelBefore, 33.3)
})
