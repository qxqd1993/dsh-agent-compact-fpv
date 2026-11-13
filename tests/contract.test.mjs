/**
 * checkpoint 契约维度离线单测（self / handoff 双契约）
 *
 * 为什么必须做契约维度的尸体测试：契约选择错了，压缩**照样会成功**——只是把
 * 「我此刻是谁、近来如何」压成了任务交接清单，或反过来。这类错误不会报错，
 * 只会让接续的那个 agent 从错误的前提出发。⇒ 每一条都必须喂「看起来合法但
 * 必须被拒」的样本，证明契约维度真的在拦，而不是恒绿。
 *
 * 与既有 `checkpoint-block.test.mjs` 的分工：那边守**五层护栏各自的形状**；
 * 这边只守**契约二选一**与**按契约校验**，同一份护栏逻辑不重复测。
 *
 * ⚠ 与任务书的两处口径差异（有意为之，已在交付报告里说明）：
 *   1) 任务书早先要求「哨兵在围栏内 → absent」，但 upstream 护栏二与既有测试
 *      （`checkpoint-block.test.mjs`「围栏代码块内视为引用」）明确要求 `invalid`，
 *      且任务书同时禁止改动围栏排除的既有行为。这里按「不改既有行为」优先，
 *      固化 `invalid`——它同样是拒绝，只是会响一声。
 *   2) 只有围栏内哨兵时**不带 `contract` 字段**：连「这是哪种自述」都判不出来，
 *      标一个契约就是瞎猜（与多契约歧义同一口径）。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKPOINT_CONTRACTS,
  CHECKPOINT_SECTIONS,
  CHECKPOINT_SENTINEL,
  CHECKPOINT_SENTINELS,
  buildRejectionNotice,
  formatCheckpointBlock,
  parseCheckpointBlock,
} from '../lib/checkpoint-block.js'

const MIN = 200

const SELF_SENTINEL = '<!-- self-compact -->'
const HANDOFF_SENTINEL = '<!-- handoff-compact -->'
const SELF_SECTIONS = ['## 此刻', '## 近來', '## 回響', '## 沉澱']
const HANDOFF_SECTIONS = [
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
]

/**
 * 按指定总长度造一份四格中文正文（section 按序、无首尾空白，长度等于 `length`）。
 * 长度用填充行补齐，因此 199/201 这类边界是**精确**的。
 */
const selfBody = (length = 260) => {
  const base = SELF_SECTIONS.join('\n')
  return base + '\n' + 'x'.repeat(Math.max(1, length - base.length - 1))
}

/** 按指定总长度造一份八格英文正文（同上，长度精确）。 */
const handoffBody = (length = 460) => {
  const base = HANDOFF_SECTIONS.join('\n')
  return base + '\n' + 'x'.repeat(Math.max(1, length - base.length - 1))
}

/** 块 = 哨兵 + 外壳 + 正文 */
const block = (sentinel, body) => sentinel + '\n' + formatCheckpointBlock(body)

describe('契约表 · 兼容导出', () => {
  test('CHECKPOINT_SENTINELS 含两条契约哨兵', () => {
    assert.deepEqual([...CHECKPOINT_SENTINELS], [SELF_SENTINEL, HANDOFF_SENTINEL])
  })

  test('既有导出 CHECKPOINT_SENTINEL / CHECKPOINT_SECTIONS 仍指向 handoff 契约', () => {
    assert.equal(CHECKPOINT_SENTINEL, HANDOFF_SENTINEL, '外部 API 的默认契约必须仍是 handoff')
    assert.deepEqual([...CHECKPOINT_SECTIONS], HANDOFF_SECTIONS)
    const handoff = CHECKPOINT_CONTRACTS.find(c => c.id === 'handoff')
    assert.equal(handoff.minChars, 400)
  })
})

describe('护栏二（不变）· 围栏内的哨兵不构成意图', () => {
  test('尸体样本：整块贴进围栏讲给别人听 → invalid，且理由指向围栏', () => {
    // 任务书写的是 absent；上游既有行为是 invalid（见文件头说明）。此处固化上游行为。
    const text = '这是规范形态：\n\n```markdown\n' + block(SELF_SENTINEL, selfBody()) + '\n```\n\n看懂了吗？'
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /围栏/)
    assert.equal('contract' in parsed, false, '只有围栏内哨兵 ⇒ 判不出契约，不得瞎标')
  })
})

describe('护栏三（不变）· 外壳缺失或未闭合', () => {
  test('尸体样本：只有哨兵、没有 <compacted-summary> 闭合 → invalid', () => {
    const text = SELF_SENTINEL + '\n<compacted-summary>\n' + selfBody() + '\n## 沉澱\n没闭合'
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /缺少配对/)
    assert.equal(parsed.contract, 'self')
  })
})

describe('契约维度 · section 必须按「本契约」校验', () => {
  test('尸体样本：self 缺一格 → invalid 并点名缺 ## 沉澱', () => {
    const partial = SELF_SECTIONS.slice(0, 3).join('\n')
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, partial + '\n' + 'x'.repeat(220)), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.equal(parsed.contract, 'self')
    assert.match(parsed.reason, /## 沉澱/)
  })

  test('尸体样本：self 四格乱序 → invalid（只查「在不在」会放过它）', () => {
    const shuffled = [...SELF_SECTIONS].reverse().join('\n')
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, shuffled + '\n' + 'x'.repeat(220)), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /缺少 section/)
  })

  test('尸体样本：self 哨兵 + 完整八格英文正文 → invalid（缺四格中文）', () => {
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, handoffBody()), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.equal(parsed.contract, 'self')
    assert.match(parsed.reason, /## 此刻/)
    assert.match(parsed.reason, /## 沉澱/)
  })

  test('尸体样本：handoff 哨兵 + 完整四格中文正文（补足 400 字符）→ invalid（缺八格英文）', () => {
    const parsed = parseCheckpointBlock(block(HANDOFF_SENTINEL, selfBody(480)), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.equal(parsed.contract, 'handoff')
    assert.match(parsed.reason, /## Primary Request and Intent/)
    assert.match(parsed.reason, /## Critical Context/)
  })
})

describe('地板 · 契约地板与全局下限取较大者', () => {
  test('self 正文 199 字符 → invalid（碎片拒收）', () => {
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, selfBody(199)), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.equal(parsed.chars, 199)
    assert.match(parsed.reason, /碎片拒收/)
  })

  test('self 正文 201 字符 → valid', () => {
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, selfBody(201)), MIN)
    assert.equal(parsed.kind, 'valid')
  })

  test('handoff 正文 399 字符 → invalid（契约地板 400 生效）', () => {
    const parsed = parseCheckpointBlock(block(HANDOFF_SENTINEL, handoffBody(399)), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.equal(parsed.chars, 399)
    assert.match(parsed.reason, /下限 400/)
  })

  test('handoff 正文 401 字符 → valid', () => {
    const parsed = parseCheckpointBlock(block(HANDOFF_SENTINEL, handoffBody(401)), MIN)
    assert.equal(parsed.kind, 'valid')
  })

  test('全局下限只能抬高地板：self 250 字符 + minChars=500 → invalid', () => {
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, selfBody(250)), 500)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /下限 500/)
  })

  test('全局下限不能压低契约地板：handoff 450 字符 + minChars=100 → valid', () => {
    const parsed = parseCheckpointBlock(block(HANDOFF_SENTINEL, handoffBody(450)), 100)
    assert.equal(parsed.kind, 'valid')
  })
})

describe('歧义 · 两条契约哨兵同时出现', () => {
  test('尸体样本：self 与 handoff 各一块 → invalid，理由是歧义', () => {
    const text = block(SELF_SENTINEL, selfBody()) + '\n\n' + block(HANDOFF_SENTINEL, handoffBody())
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /同时出现多条契约哨兵/)
    assert.match(parsed.reason, /无法判定/)
    assert.equal(parsed.contract, undefined, '判不出契约时不得瞎标')
  })
})

describe('正路径 · 两种契约各走各的', () => {
  test('正常的 self 块 → valid 且 contract === self', () => {
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, selfBody()), MIN)
    assert.equal(parsed.kind, 'valid')
    assert.equal(parsed.contract, 'self')
    assert.ok(parsed.body.startsWith('## 此刻'))
  })

  test('正常的 handoff 块 → valid 且 contract === handoff', () => {
    const parsed = parseCheckpointBlock(block(HANDOFF_SENTINEL, handoffBody()), MIN)
    assert.equal(parsed.kind, 'valid')
    assert.equal(parsed.contract, 'handoff')
    assert.ok(parsed.body.startsWith('## Primary Request and Intent'))
  })
})

describe('近似诊断 · 中文标题也适用', () => {
  test('尸体样本：`## 1. 此刻`（带编号前缀）→ invalid 并给出近似提示', () => {
    const numbered = selfBody().replace(SELF_SECTIONS[0], '## 1. 此刻')
    const parsed = parseCheckpointBlock(block(SELF_SENTINEL, numbered), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /近似命中/)
    assert.match(parsed.reason, /1\. 此刻/)
  })
})

describe('围栏剔除先于契约判定（讨论契约本身是常态）', () => {
  test('尸体样本：围栏内贴 self 模板 + 正文真写 handoff 块 → valid 且 contract === handoff', () => {
    // 真实用法：先贴一段 self 范本讲清楚，再真写一个 handoff 块压缩。
    // 若按「全部哨兵」判契约，两条哨兵同时出现 ⇒ 被误判成歧义拒收。
    const text = '先贴一下 self 契约长什么样：\n\n```markdown\n'
      + block(SELF_SENTINEL, selfBody())
      + '\n```\n\n那我现在压一下：\n\n'
      + block(HANDOFF_SENTINEL, handoffBody())
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'valid')
    assert.equal(parsed.contract, 'handoff', '围栏内的 self 是引用，不得参与契约判定')
    assert.ok(parsed.body.startsWith('## Primary Request and Intent'))
  })

  test('尸体样本：两条哨兵都只在围栏内 → invalid（围栏理由），且不带 contract', () => {
    const text = '两套契约分别是：\n\n```markdown\n'
      + block(SELF_SENTINEL, selfBody())
      + '\n```\n\n```markdown\n'
      + block(HANDOFF_SENTINEL, handoffBody())
      + '\n```\n\n就这样。'
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /围栏/)
    assert.equal('contract' in parsed, false, '连哪种契约都判不出时，不得标 contract')
  })

  test('围栏内的 self 模板不得影响正文 handoff 的「恰好一次」计数', () => {
    const text = '```\n' + block(SELF_SENTINEL, selfBody()) + '\n```\n\n'
      + block(HANDOFF_SENTINEL, handoffBody()) + '\n\n'
      + block(HANDOFF_SENTINEL, handoffBody())
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.equal(parsed.contract, 'handoff')
    assert.match(parsed.reason, /哨兵出现 2 次/)
  })
})

describe('失败通知 · 按契约分派（不再一律叫人写八格英文）', () => {
  /** self 失败：正文 199 字符（地板 200）⇒ invalid + contract self */
  const selfFailure = () => parseCheckpointBlock(block(SELF_SENTINEL, selfBody(199)), MIN)
  /** handoff 失败：正文 399 字符（地板 400）⇒ invalid + contract handoff */
  const handoffFailure = () => parseCheckpointBlock(block(HANDOFF_SENTINEL, handoffBody(399)), MIN)
  /** 歧义失败：两条哨兵都在围栏外 ⇒ invalid，无 contract */
  const ambiguousFailure = () => parseCheckpointBlock(
    block(SELF_SENTINEL, selfBody()) + '\n\n' + block(HANDOFF_SENTINEL, handoffBody()),
    MIN,
  )

  test('self 失败 → 提示 self 哨兵与四格中文，不提 handoff', () => {
    const parsed = selfFailure()
    assert.equal(parsed.contract, 'self')
    const notice = buildRejectionNotice(parsed, MIN)
    assert.ok(notice.includes('<!-- self-compact -->'), '要能直接照抄 self 哨兵')
    for (const section of ['此刻', '近來', '回響', '沉澱']) {
      assert.ok(notice.includes(section), '缺 ' + section + ' 的写法提示')
    }
    assert.ok(!notice.includes('handoff-compact'), 'self 失败不得叫人去写 handoff')
  })

  test('handoff 失败 → 提示 handoff 哨兵与八格英文，不提 self', () => {
    const parsed = handoffFailure()
    assert.equal(parsed.contract, 'handoff')
    const notice = buildRejectionNotice(parsed, MIN)
    assert.ok(notice.includes('<!-- handoff-compact -->'), '要能直接照抄 handoff 哨兵')
    assert.ok(notice.includes('Primary Request'), '八格英文清单要出现')
    assert.ok(!notice.includes('self-compact'), 'handoff 失败不得叫人去写 self')
  })

  test('多契约歧义 → 两条哨兵都列出，让人自己选', () => {
    const parsed = ambiguousFailure()
    assert.equal(parsed.kind, 'invalid')
    assert.equal('contract' in parsed, false)
    const notice = buildRejectionNotice(parsed, MIN)
    assert.ok(notice.includes('<!-- self-compact -->'), '两条哨兵都要给出来')
    assert.ok(notice.includes('<!-- handoff-compact -->'))
    assert.match(notice, /二选一/)
  })

  test('地板显示实际值：handoff + minChars=200 → 写 400（不是配置的 200）', () => {
    const notice = buildRejectionNotice(handoffFailure(), MIN)
    assert.match(notice, /≥ 400 字符/, '契约地板 400 必须压过配置下限 200')
    assert.ok(!notice.includes('≥ 200 字符'), '不得把配置值当地板报出去')
  })

  test('地板显示实际值：minChars=500 → self 与 handoff 都写 500', () => {
    const selfNotice = buildRejectionNotice(selfFailure(), 500)
    assert.match(selfNotice, /≥ 500 字符/)
    assert.ok(!selfNotice.includes('≥ 200 字符'))
    const handoffNotice = buildRejectionNotice(handoffFailure(), 500)
    assert.match(handoffNotice, /≥ 500 字符/)
    assert.ok(!handoffNotice.includes('≥ 400 字符'), 'minChars=500 时地板是 500，不是契约的 400')
  })
})
