/**
 * `src/vendor.ts` 的离线单测 + 「运行期不 import 宿主包」的机制守卫。
 *
 * 背景（本仓 2026-11 的移植障碍）：`@deepseek-ai/dsh-compaction` 与
 * `@deepseek-ai/dsh-llm` 封在 DSH 的 `app.asar` 里，外部插件运行期解析不到
 * （registry 上的版本又太旧）。所以这两个包里的**运行期原语**被抄进 `vendor.ts`。
 *
 * 本文件守两件事：
 *  ① **抄得对不对**：`errorChain` / `toolPairingBalanced*` / `createUserMessage` /
 *     `compactCheckpointSource` 的行为必须与宿主一致（用宿主实现里可观察的样本钉住：
 *     多级 cause、AggregateError、循环 cause、工具配对平衡的切点语义、消息身份与冻结）。
 *  ② **运行期真的不依赖宿主**：`lib/*.js` 里不得再出现指向这两个包的
 *     `import/export ... from`（注释里写出处是**要求**，不算违规）。
 *
 * 诚实边界：这是**副本**的测试，不是宿主实现的测试。判据来自读 asar 里的原实现
 * （见 `vendor.ts` 顶部逐项出处）；宿主升级后本文件不会红——那是 `vendor.ts` 里
 * 写明的「升级时必须回来核对」这条人力义务。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  createUserMessage,
  errorChain,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '../lib/vendor.js'

// ── 模型无关的工具配对折叠：用假会话（只要 surface + eventAt）───────────────

/** 造一个足够被 `toolPairingBalanced*` 读取的假会话。 */
function fakeSession(nodes, events, generation = 1) {
  return {
    surface: { nodes: [...nodes], replaceGeneration: generation },
    eventAt: (seq) => events.get(seq),
  }
}

/** 一条助手消息（content 里的 tool-call 数决定「进行中调用数」的增量）。 */
function assistant(seq, toolCalls = 0) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: Array.from({ length: toolCalls }, () => ({ type: 'tool-call' })) } },
  }
}

/** 一条工具结果（增量恒 -1）。 */
const toolResult = (seq) => ({ seq, type: 'tool/result', data: {} })

/** 一条与工具无关的普通消息（增量 0）。 */
const plain = (seq) => ({ seq, type: 'user/message', data: {} })

describe('toolPairingBalancedBefore / After（宿主 dsh-compaction 原逻辑）', () => {
  // 表层：1 普通 → 2 助手（2 个 tool-call）→ 3 结果 → 4 结果
  const events = new Map([
    [1, plain(1)],
    [2, assistant(2, 2)],
    [3, toolResult(3)],
    [4, toolResult(4)],
  ])
  const session = fakeSession([1, 2, 3, 4], events)

  test('切口语义：节点「之前」取它自己那道切口，「之后」取下一道', () => {
    assert.equal(toolPairingBalancedBefore(session, 1), true, '空表层的首道切口恒平衡')
    assert.equal(toolPairingBalancedAfter(session, 1), true, '普通消息前后都不改变进行中的调用数')
    assert.equal(toolPairingBalancedBefore(session, 2), true)
    assert.equal(toolPairingBalancedAfter(session, 2), false, '助手消息之后有 2 个未回应的工具调用')
    assert.equal(toolPairingBalancedBefore(session, 3), false)
    assert.equal(toolPairingBalancedAfter(session, 3), false, '只回来一个结果，仍差一个')
    assert.equal(toolPairingBalancedBefore(session, 4), false)
    assert.equal(toolPairingBalancedAfter(session, 4), true, '两个结果都齐了')
  })

  test('不在当前表层的 seq ⇒ 抛（不静默返回 false）', () => {
    assert.throws(() => toolPairingBalancedBefore(session, 99), /not found/)
  })

  test('工具结果多于调用（表层损坏）⇒ 抛，而不是把余额压成负数', () => {
    const corrupt = fakeSession([1], new Map([[1, toolResult(1)]]))
    assert.throws(() => toolPairingBalancedAfter(corrupt, 1), /has no matching tool-call/)
  })

  test('缓存按需扩展：同一会话追加节点后仍给出正确切点', () => {
    const growing = fakeSession([1, 2], new Map([
      [1, plain(1)],
      [2, assistant(2, 1)],
    ]))
    assert.equal(toolPairingBalancedAfter(growing, 2), false)
    // 追加「工具结果」节点（seq 3）——缓存应只折叠新尾部，不重建
    growing.surface.nodes.push(3)
    growing.eventAt = ((inner) => (seq) => {
      if (seq === 3) return toolResult(3)
      return inner(seq)
    })(growing.eventAt)
    assert.equal(toolPairingBalancedAfter(growing, 3), true)
    assert.equal(toolPairingBalancedBefore(growing, 3), false)
  })

  test('表层代次（replaceGeneration）一变 ⇒ 整表重建（替换后旧缓存不得复用）', () => {
    const before = fakeSession([1, 2], new Map([
      [1, plain(1)],
      [2, assistant(2, 1)],
    ]))
    assert.equal(toolPairingBalancedAfter(before, 2), false)
    // 压缩把节点 1..2 换成节点 9（一条普通消息）
    const replaced = fakeSession([9], new Map([[9, plain(9)]]), 2)
    assert.equal(toolPairingBalancedAfter(replaced, 9), true, '代次变了必须重建，不得沿用旧余额')
  })
})

describe('errorChain（宿主 dsh-llm 原逻辑）', () => {
  test('单层错误：message 为空时退回 name', () => {
    assert.equal(errorChain(new Error('boom')), 'boom')
    const empty = new Error('')
    empty.name = 'WeirdError'
    assert.equal(errorChain(empty), 'WeirdError')
  })

  test('多级 cause：以「: 」串起来', () => {
    const inner = new Error('inner')
    const middle = new Error('middle', { cause: inner })
    const outer = new Error('outer', { cause: middle })
    assert.equal(errorChain(outer), 'outer: middle: inner')
  })

  test('包装器重复自己的 cause ⇒ 不重复渲染', () => {
    const wrapper = new Error('boom', { cause: new Error('boom') })
    assert.equal(errorChain(wrapper), 'boom')
  })

  test('AggregateError 成员用 [a; b] 展开', () => {
    const aggregate = new AggregateError([new Error('x'), new Error('y')], 'agg')
    assert.equal(errorChain(aggregate), 'agg [x; y]')
  })

  test('循环 cause ⇒ 标 <circular cause>，不无限递归', () => {
    const a = new Error('a')
    const b = new Error('b')
    a.cause = b
    b.cause = a
    assert.equal(errorChain(a), 'a: b: <circular cause>')
  })

  test('非 Error：字符串直出；带 message 值的对象取 message；其余 String()', () => {
    assert.equal(errorChain('plain'), 'plain')
    assert.equal(errorChain({ message: 'from-descriptor' }), 'from-descriptor')
    assert.equal(errorChain(42), '42')
    assert.equal(errorChain(undefined), 'undefined')
  })

  test('敌意 getter ⇒ <unrenderable value>，不逃出异常（本函数喂 UI 与日志）', () => {
    const hostile = new Error('fine')
    Object.defineProperty(hostile, 'cause', {
      get() { throw new Error('nope') },
    })
    assert.equal(errorChain(hostile), '<unrenderable value>')
  })
})

describe('createUserMessage（宿主 dsh-llm 原逻辑的等价物）', () => {
  test('形状：role=user + 非空 id + 原样 content/source', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'dsh-agent-compact' },
    })
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0, 'id 不得为空——宿主 assertMessageEventShape 会拒收无身份消息')
    assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
    assert.deepEqual(message.source, { kind: 'dsh-agent-compact' })
  })

  test('每次一条新身份（同一个入参两次调用不得复用 id）', () => {
    const input = { content: [{ type: 'text', text: 'x' }], source: { kind: 'dsh-agent-compact' } }
    assert.notEqual(createUserMessage(input).id, createUserMessage(input).id)
  })

  test('深冻结：消息与其子结构都不可改（宿主读侧按冻结语义处理）', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'x' }],
      source: { kind: 'dsh-agent-compact' },
    })
    assert.ok(Object.isFrozen(message), '消息本体必须冻结')
    assert.ok(Object.isFrozen(message.content), '内容数组必须冻结')
    assert.ok(Object.isFrozen(message.content[0]), '内容块必须冻结')
    assert.ok(Object.isFrozen(message.source), '来源必须冻结')
    assert.throws(() => { message.content[0].text = 'changed' }, TypeError)
  })

  test('detach：调用方之后改入参，不得影响已建的消息（structuredClone 的语义）', () => {
    const block = { type: 'text', text: 'original' }
    const message = createUserMessage({ content: [block], source: { kind: 'dsh-agent-compact' } })
    block.text = 'mutated'
    assert.equal(message.content[0].text, 'original')
  })
})

describe('checkpoint 来源（宿主 dsh-compaction 的纯结构）', () => {
  test('CompactionId 是恒等函数（品牌只在类型层）', () => {
    assert.equal(CompactionId('abc'), 'abc')
  })

  test('来源形状：kind + compactionId（可选 sourceCommandId），且冻结', () => {
    const plainSource = compactCheckpointSource(CompactionId('c-1'))
    assert.deepEqual(plainSource, { kind: 'compact-checkpoint', compactionId: 'c-1' })
    assert.ok(!('sourceCommandId' in plainSource), '没有发起命令时不得凭空长出该字段')
    assert.ok(Object.isFrozen(plainSource), '来源必须冻结（与宿主 Object.freeze 一致）')

    const manual = compactCheckpointSource(CompactionId('c-2'), 'cmd-9')
    assert.deepEqual(manual, { kind: 'compact-checkpoint', compactionId: 'c-2', sourceCommandId: 'cmd-9' })
  })

  test('谓词只看 kind（宿主读侧同款判据）', () => {
    assert.equal(isCompactCheckpointSource(compactCheckpointSource(CompactionId('c'))), true)
    assert.equal(isCompactCheckpointSource({ kind: 'user' }), false)
  })
})

describe('ManualCompactionError（同形状）', () => {
  test('name / code / message / cause 全部保留', () => {
    const cause = new Error('origin')
    const error = new ManualCompactionError('busy', 'already compacting', { cause })
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'ManualCompactionError')
    assert.equal(error.code, 'busy')
    assert.equal(error.message, 'already compacting')
    assert.equal(error.cause, cause, 'cause 必须原样保留（宿主手动路径靠它做诊断）')
  })
})

// ── 机制守卫：运行期不 import 宿主包 ─────────────────────────────────────────

/**
 * 抽出一个模块里**真实的模块说明符**（只认 `import/export ... from '...'`，
 * 不认注释里写出处——注释是要求，不是违规）。
 * @param source - 模块源码。
 * @returns 说明符列表。
 */
function specifiersOf(source) {
  const out = []
  const pattern = /(?:^|\n)[ \t]*(?:import|export)\b[^\n]*?\bfrom[ \t]+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) out.push(match[1])
  // `import 'x'`（纯副作用导入）也要算
  for (const match of source.matchAll(/(?:^|\n)[ \t]*import[ \t]+['"]([^'"]+)['"]/g)) out.push(match[1])
  return out
}

describe('运行期依赖：lib/*.js 不得 import 宿主那两个包', () => {
  const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
  const files = readdirSync(libDir).filter((name) => name.endsWith('.js'))

  test('产物齐全（守卫本身不得因为目录为空而空转）', () => {
    assert.ok(files.includes('index.js'), 'lib/index.js 必须存在（先 npm run build）')
    assert.ok(files.includes('vendor.js'), 'lib/vendor.js 必须存在')
  })

  test('没有任何指向 dsh-compaction / dsh-llm 的模块说明符（schemastery 除外）', () => {
    const offenders = []
    for (const name of files) {
      for (const specifier of specifiersOf(readFileSync(join(libDir, name), 'utf8'))) {
        if (specifier === '@deepseek-ai/dsh-compaction' || specifier.startsWith('@deepseek-ai/dsh-compaction/')
          || specifier === '@deepseek-ai/dsh-llm' || specifier.startsWith('@deepseek-ai/dsh-llm/')) {
          offenders.push(`${name} → ${specifier}`)
        }
      }
    }
    assert.deepEqual(offenders, [],
      '运行期 import 宿主这两个包会让插件在 DSH 里加载失败（它们封在 app.asar）；'
      + '运行期原语应走 lib/vendor.js')
  })

  test('反向对照：schemastery 仍被引用（证明上面那条不是靠「什么都没扫到」变绿的）', () => {
    const all = files.map((name) => specifiersOf(readFileSync(join(libDir, name), 'utf8'))).flat()
    assert.ok(all.includes('@deepseek-ai/schemastery'), '配置 schema 仍走宿主提供的 schemastery')
  })
})
