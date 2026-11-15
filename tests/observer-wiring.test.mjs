/**
 * 兩個新觀測的**接線**測試（2026-11-15）
 *
 * 純判據由 `read-index.test.mjs` / `negative.test.mjs` / `reconcile.test.mjs` 覆蓋；
 * 這裡只證明它們**真的接在 `session/event` 上、且在錯的地方不出聲**：
 *  ① `tool/call` 會餵進讀取索引（增量，不重建）；
 *  ② 助手消息裡對「本會話沒讀過內容」的路徑下否定判斷 → 落一筆 `unbacked-negative`；
 *  ③ 讀過的、或自己已經認了「我沒查」的 → 不落；
 *  ④ 塊裡點名「存在但沒讀過」的路徑 → `ref-unread` + 投遞提醒（target=next-step, wakeup=false）；
 *  ⑤ 塊裡點名「不存在」的路徑 → 不提醒（那是 suspected，不是確證）。
 *
 * 用樁 ctx 直接 `new AgentCompactEngine(...)`，不碰 cordis、不碰真實會話。
 * `DSH_HOME` 先指到臨時目錄：引擎一 import 就落 boot 軌跡，合成讀數不得寫進真實側車。
 *
 * 運行：先 `npx tsc -p tsconfig.json`，再 `node tests/observer-wiring.test.mjs`
 * （**不要** `npm test`：受限沙盒下 `node --test` 會 spawn EPERM）
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compactionTracePath, readTraceEntries } from '../lib/trace.js'
import { formatCheckpointBlock } from '../lib/checkpoint-block.js'

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'compact-observer-wiring-'))
const WORK = mkdtempSync(join(tmpdir(), 'compact-observer-work-'))
process.env.DSH_HOME = TEMP_HOME
const { default: AgentCompactEngine } = await import('../lib/index.js')

after(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
})

/** 六格俱全的合法正文（新契約；缺一格就不合法，這份測試不想順帶驗格式）。 */
const SECTIONS = ['## 此刻', '## 近來', '## 回響', '## 這一輪我吃了什麼虧', '## 我沒查的', '## 沉澱']
// 尾巴那串必须够长：引擎有 200 字符的硬地板（`minCheckpointChars` 只能往上抬，不能往下压），
// 而 2026-11-15 之前这里只有 20 个字符 ⇒ 正文 122 字符、被判 invalid，
// 「读过的路径不提醒」那个用例其实是靠「块无效」通过的，从没走到对账。
const bodyWith = (extra) =>
  SECTIONS.map((head, index) => head + '\n占位' + String(index + 1) + (index === 0 ? '\n' + extra : '')).join('\n')
  + '\n' + 'x'.repeat(200)

/** 桩上下文：收下监听器，不实现 cordis 的任何语义。 */
function harness() {
  const listeners = []
  const sends = []
  const events = []
  const session = {
    id: 'session-observer',
    seq: 0,
    eventAt: (seq) => events[seq],
    surface: { nodes: [] },
  }
  const agent = {
    id: 'agent-observer',
    session,
    send(message, target, wakeup) {
      sends.push({ text: message?.content?.[0]?.text ?? '', target, wakeup })
    },
  }
  const ctx = {
    provide: () => () => {},
    on: (name, handler) => { if (name === 'session/event') listeners.push(handler) },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }), contextPressure: () => ({ contextWindow: 1000 }), estimateMessage: () => 1 },
    sessions: { flush: async () => {} },
    agents: { get: () => agent },
  }
  new AgentCompactEngine(ctx, { minCheckpointChars: 100 })
  // 侧车是**同一个文件**（每个会话的轨迹都往那一处写），所以每个用例只认自己这一段——
  // 否则前一个用例的行会被算进后一个，红得毫无道理。基线在建 harness 时就取。
  const base = readTraceEntries(compactionTracePath(TEMP_HOME)).length
  /** 推入并广播一条事件（模拟 session.append 后的监听）。 */
  const emit = (type, data) => {
    const event = { type, seq: events.length, data }
    events.push(event)
    session.seq = events.length
    for (const listener of listeners) listener(session, event)
  }
  const lines = () => readTraceEntries(compactionTracePath(TEMP_HOME)).slice(base)
  const phases = () => lines().map((entry) => entry.phase)
  return { emit, lines, phases, sends, session }
}

const tmpFile = (name) => {
  const path = join(WORK, name)
  writeFileSync(path, '# read me\n')
  return path
}

test('读过的路径：否定句不落账；没读过的：落一笔', () => {
  const h = harness()
  const readPath = tmpFile('read-me.md')
  const neverPath = tmpFile('never-opened.md')

  h.emit('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: readPath }) })
  h.emit('assistant/message', {
    message: { content: [{ type: 'text', text: '`' + readPath + '` 没有变，`' + neverPath + '` 也没有新内容。' }] },
  })

  const hits = h.lines().filter((entry) => entry.phase === 'unbacked-negative')
  assert.equal(hits.length, 1, `应只报未读的那一个，实得 ${JSON.stringify(hits.map(e => e.note))}`)
  assert.match(String(hits[0].note), /never-opened\.md/, 'note 必须指出是哪个路径')
})

test('自己已经认了「我沒查」→ 不落账', () => {
  const h = harness()
  const neverPath = tmpFile('acknowledged.md')
  h.emit('assistant/message', {
    message: { content: [{ type: 'text', text: '`' + neverPath + '` 我没有查，不知道有没有变。' }] },
  })
  assert.equal(h.lines().filter(e => e.phase === 'unbacked-negative').length, 0)
})

test('块里点名「存在但没读过」→ ref-unread + 投递；「不存在」→ 不投递', () => {
  const h = harness()
  const existsUnread = tmpFile('cited-but-never-read.md')
  const missing = join(WORK, 'hypothetical.md')
  const body = bodyWith('引用了 `' + existsUnread + '` 与 `' + missing + '`。')
  h.emit('assistant/message', {
    message: {
      content: [
        { type: 'tool-call', id: 'c1', name: 'noop', arguments: '{}' },
        { type: 'text', text: '<!-- self-compact -->\n' + formatCheckpointBlock(body) },
      ],
    },
  })

  const refs = h.lines().filter((entry) => entry.phase === 'ref-unread')
  assert.equal(refs.length, 1, `应只确证存在且未读的那一条，实得 ${JSON.stringify(refs.map(e => e.note))}`)
  assert.match(String(refs[0].note), /cited-but-never-read\.md/)
  assert.doesNotMatch(String(refs[0].note), /hypothetical\.md/, '不存在的路径只能是 suspected，不得进确证')

  assert.equal(h.sends.length, 1, '确证之后必须当场提醒（早发现早修正）')
  assert.equal(h.sends[0].target, 'next-step', '提醒走 next-step')
  assert.equal(h.sends[0].wakeup, false, '提醒不得新开回合')
  assert.match(h.sends[0].text, /清单，不是判决/)
})

test('块里引用的路径如果本会话读过 → 不提醒', () => {
  const h = harness()
  const path = tmpFile('cited-and-read.md')
  h.emit('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: path }) })
  h.emit('assistant/message', {
    message: { content: [{ type: 'text', text: '<!-- self-compact -->\n' + formatCheckpointBlock(bodyWith('引用了 `' + path + '`。')) }] },
  })
  assert.equal(h.lines().filter(e => e.phase === 'ref-unread').length, 0)
  assert.equal(h.sends.length, 0)
  // 「没提醒」有两种：对过账、都干净，或者对账根本没跑。留一笔 ref-clean 才能分开——
  // 否则侧车里的沉默和没跑过是同一个样子（2026-11-15 实测那块裸相对路径的块正是如此）。
  const clean = h.lines().filter(e => e.phase === 'ref-clean')
  assert.equal(clean.length, 1, '对过账但零确证时必须留 ref-clean')
  // 「读过就放行」这条判据排在所有分档之前，所以读过的路径连候选都不算 ⇒ 候选 0 条。
  assert.match(String(clean[0].note), /没有确证未读/)
  assert.match(String(clean[0].note), /候选 0 条/)
  assert.match(String(clean[0].note), /确证 0/)
})

test('不合法的块不做对账（不会成为断口材料，对它是给废纸做校对）', () => {
  const h = harness()
  const path = tmpFile('cited-in-invalid.md')
  const shortBody = '## 此刻\n' + 'x'.repeat(30) // 缺五格 + 太短 ⇒ invalid
  h.emit('assistant/message', {
    message: { content: [{ type: 'text', text: '<!-- self-compact -->\n' + formatCheckpointBlock(shortBody + '\n`' + path + '`') }] },
  })
  assert.equal(h.lines().filter(e => e.phase === 'ref-unread').length, 0)
  assert.equal(h.sends.length, 0)
  // 反向：不合法的块**连 ref-clean 都不该有**——这正好把「对过账、干净」和「没对账」分开。
  assert.equal(h.lines().filter(e => e.phase === 'ref-clean').length, 0)
})
