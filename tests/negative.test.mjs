/**
 * negative.ts 判据离线单测
 *
 * 这里钉住的是「没有证据的否定判断」的边界：否定词表、自认字样放行、只认明确路径，
 * 以及**不按逗号切句**（事故原句的路径与否定正是用逗号连着的）。
 * 最后一组是跨模块对照：只列举过（glob/Get-ChildItem）的会话里，同一句否定仍然命中；
 * 若哪天有人把列举算成「读过」，那条会直接变红。
 *
 * 运行：node tests/negative.test.mjs（先 npx tsc -p tsconfig.json）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReadIndex } from '../lib/read-index.js'
import { findUnbackedNegatives } from '../lib/negative.js'

/** 造一个按 seq 取事件的视图（事件数组下标即 seq） */
const view = events => ({ seq: events.length, eventAt: seq => events[seq] })

/** 造第一行 session 事件 */
const session = cwd => ({ type: 'session', data: { cwd } })

/** 造一条 read 调用 */
const read = file_path => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'read', name: 'read', arguments: JSON.stringify({ file_path }) },
})

/** 已读过某些路径的索引 */
const readIndex = (cwd, paths = []) => buildReadIndex(view([session(cwd), ...paths.map(read)]))

/** 什么都没读过的索引 */
const emptyIndex = readIndex('E:\\proj')

describe('事故原句 · 未读 → 命中', () => {
  test('繁体原句：路径 + 否定、未读 → 命中，path 是句子里那一个', () => {
    const text = '`notes\\todo.md` 最後一次是 11-11，沒有當天尾巴；我沒動過它，也沒往裏加東西。'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].path, 'notes\\todo.md')
    assert.match(claims[0].sentence, /沒動過/)
    assert.match(claims[0].sentence, /沒往裏加東西/)
    assert.match(claims[0].sentence, /11-11/, '回报的是原始句子，不是剪裁后的摘要')
  })

  test('简体同一句也能命中（比对前做简繁归一）', () => {
    const text = '`notes\\todo.md` 最后一次是 11-11，没有当天尾巴；我没动过它，也没往里加东西。'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].path, 'notes\\todo.md')
  })

  test('路径与否定靠逗号连着：按逗号切就会漏（切句只按 。！？\\n）', () => {
    const text = '`notes\\todo.md` 最后一次是 11-11，没有当天尾巴'
    assert.equal(
      findUnbackedNegatives(text, emptyIndex).length,
      1,
      '这句只有一个句末标点在最后；逗号不是切句点',
    )
  })
})

describe('已读 · 有依据的否定放行', () => {
  test('read 过这个路径的内容 → 不命中', () => {
    const index = readIndex('E:\\proj', ['notes\\todo.md'])
    assert.deepEqual(findUnbackedNegatives('`notes/todo.md` 没有变。', index), [])
  })
})

describe('自认字样 · 整句放行', () => {
  test('句子自己承认没查／没打开／只看了 mtime → 不命中（简繁都认）', () => {
    const sentences = [
      '我沒查 `notes/todo.md` 有沒有動過。',
      '我没查 `notes/todo.md` 有没有动过。',
      '`notes/todo.md` 未驗證，不能說它沒變。',
      '`notes/todo.md` 未验证，不能说它没变。',
      '我沒有讀 `notes/todo.md`，所以「它沒變」這句話不成立。',
      '我没有读 `notes/todo.md`，所以「它没变」这句话不成立。',
      '`notes/todo.md` 僅憑 mtime 看是沒變的。',
      '`notes/todo.md` 仅凭 mtime 看是没变的。',
      '我沒有打開 `notes/todo.md`，只看到它沒動。',
      '我没有打开 `notes/todo.md`，只看到它没动。',
      'I did not read `notes/todo.md`; it is unchanged.',
      '`notes/todo.md` is unverified; it may be unchanged.',
    ]
    for (const text of sentences) {
      assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [], text)
    }
  })
})

describe('只认明确路径 · URL / 通配符 / 目录 / ~ 一律不命中', () => {
  test('这些都不是「具体文件路径」', () => {
    const sentences = [
      '`https://github.com/org/repo/blob/main/notes.md` 没有变。',
      'https://github.com/org/repo/blob/main/notes.md 没有变。',
      '`github.com/org/repo/blob/main/notes.md` 没有变。',
      'github.com/org/repo/blob/main/notes.md 没有变。',
      '`src/*.ts` 没动过。',
      '`notes/todo` 没变。',
      '`notes` 没有新东西。',
      '`~/notes/todo.md` 没变。',
    ]
    for (const text of sentences) {
      assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [], text)
    }
  })
})

describe('同一句多路径 · 只回报没读的那个', () => {
  test('一句里两个路径、只有一个未读 → 只回报那一个', () => {
    const index = readIndex('E:\\proj', ['notes/a.md'])
    const text = '`notes/a.md` 没变，但 `notes/b.md` 没动过。'
    const claims = findUnbackedNegatives(text, index)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].path, 'notes/b.md')
  })

  test('同一路径在多个句子重复出现 → 只回报一次', () => {
    const text = '`notes/b.md` 没变。\n`notes/b.md` 仍然没有新增。'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.equal(claims.length, 1)
    assert.deepEqual(claims.map(claim => claim.path), ['notes/b.md'])
  })
})

describe('否定词固定表 · 逐字钉住', () => {
  test('表内每个词（简繁各一形）都能让一条未读路径的否定命中；加词必须同时改这里', () => {
    const sentences = [
      '`a.md` 沒變。',
      '`a.md` 没变。',
      '`a.md` 沒有。',
      '`a.md` 没有。',
      '`a.md` 沒動。',
      '`a.md` 没动。',
      '`a.md` 沒掛。',
      '`a.md` 没挂。',
      '`a.md` 不存在。',
      '`a.md` 未改。',
      '`a.md` 未變。',
      '`a.md` 未变。',
      '`a.md` 都沒。',
      '`a.md` 都没。',
      '`a.md` unchanged.',
      '`a.md` no change.',
      '`a.md` missing.',
      '`a.md` absent.',
    ]
    for (const text of sentences) {
      const claims = findUnbackedNegatives(text, emptyIndex)
      assert.equal(claims.length, 1, text)
      assert.equal(claims[0].path, 'a.md', text)
    }
  })
})

describe('自认字样固定表 · 逐字钉住', () => {
  test('每一个自认字样（简繁写法都走归一后的比对）都能放行同句的否定', () => {
    const sentences = [
      '我沒查 `a.md` 沒變。',
      '我没查 `a.md` 没变。',
      '`a.md` 未驗證沒變。',
      '`a.md` 未验证没变。',
      '沒有讀 `a.md`，所以說它沒變。',
      '没有读 `a.md`，所以说它没变。',
      '僅憑 mtime 說 `a.md` 沒變。',
      '仅凭 mtime 说 `a.md` 没变。',
      '沒有打開 `a.md`，但說它沒變。',
      '没有打开 `a.md`，但说它没变。',
      'did not read, `a.md` unchanged.',
      '`a.md` unverified unchanged.',
    ]
    for (const text of sentences) {
      assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [], text)
    }
  })
})

describe('简繁归一 · 只用于比对', () => {
  test('我没有查 / 我沒查 两种写法都放行', () => {
    for (const text of [
      '`notes/compact-verify.md` 我没有查，不知道有没有变。',
      '`notes/compact-verify.md` 我沒查，不知道有沒有變。',
    ]) {
      assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [], text)
    }
  })

  test('未经验证 / 未經驗證 两种写法都放行', () => {
    for (const text of [
      '`notes/todo.md` 未经验证，不能说它没变。',
      '`notes/todo.md` 未經驗證，不能說它沒變。',
    ]) {
      assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [], text)
    }
  })

  test('归一不得改写原文：claim.sentence 仍是输入里的繁体字', () => {
    const text = '`notes/todo.md` 沒有變'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].sentence, text)
    assert.ok(claims[0].sentence.includes('沒'))
    assert.ok(!claims[0].sentence.includes('没'))

    // 未命中时也不得动输入（字符串本身不可变，这里留一条意图明确的回归）
    const admitted = '`notes/todo.md` 我沒有查。'
    assert.deepEqual(findUnbackedNegatives(admitted, emptyIndex), [])
    assert.equal(admitted, '`notes/todo.md` 我沒有查。')
  })
})

describe('回归样本 · 2026-11-15 实际说过的话', () => {
  test('sparks 那句（用日志里的真实档名）→ 命中', () => {
    const text = '`sparks_from_ruksinnda.md` 自 11-14 14:51 起沒動過，所以你沒往裏加東西。'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].path, 'sparks_from_ruksinnda.md')
  })

  test('边界：裸字 sparks（无扩展名、无分隔符、无反引号）不是明确路径 → 不命中', () => {
    // 纯函数拿不到文件系统，无法知道 `sparks` 是一个文件；若把任意裸词都当路径，
    // 「build 沒過」「test 沒有跑」这类似是而非的句子会全部变成误报。
    const text = 'sparks 自 11-14 14:51 起沒動過，所以你沒往裏加東西。'
    assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [])
  })

  test('notes\\todo.md 没有当天尾巴 → 命中', () => {
    const text = '`notes\\todo.md` 沒有當天尾巴'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].path, 'notes\\todo.md')
  })

  test('「找不到 harness」那句：没有词表里的否定词，也没有明确路径 → 不命中', () => {
    const text = '這三個檔案找不到 harness，於是 process.exit(0)'
    assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [])
  })
})

describe('有否定但没有明确路径 · 不命中', () => {
  test('不做无路径指控', () => {
    const sentences = [
      '目录里没有新东西。',
      'notes 目录没有变。',
      '这个功能还不存在。',
      '`notes` 这个目录没有变。',
    ]
    for (const text of sentences) {
      assert.deepEqual(findUnbackedNegatives(text, emptyIndex), [], text)
    }
  })
})

describe('路径抽取 · 反引号与裸 token', () => {
  test('反引号片段与「含分隔符 + 扩展名」的裸 token 都算', () => {
    const text = '`src/a.ts` 没变；notes\\b.md 也没动。'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.deepEqual(
      claims.map(claim => claim.path).sort(),
      ['notes\\b.md', 'src/a.ts'].sort(),
    )
  })

  test('任务列出的扩展名都认得（.jsonl / .zst / .ps1 等）', () => {
    const text = '`data/a.jsonl` 没变，`cache/b.zst` 没动，`scripts/c.ps1` 未改。'
    const claims = findUnbackedNegatives(text, emptyIndex)
    assert.deepEqual(
      claims.map(claim => claim.path).sort(),
      ['cache/b.zst', 'data/a.jsonl', 'scripts/c.ps1'].sort(),
    )
  })

  test('file:// 是路径的 URL 写法：读过就不命中，没读过就命中', () => {
    const readUrl = readIndex('E:\\proj', ['file:///E:/proj/notes/todo.md'])
    assert.deepEqual(findUnbackedNegatives('`file:///E:/proj/notes/todo.md` 没有变。', readUrl), [])
    const claims = findUnbackedNegatives('`file:///E:/proj/notes/todo.md` 没有变。', emptyIndex)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].path, 'file:///E:/proj/notes/todo.md')
  })
})

describe('退化输入 · 不抛', () => {
  test('空字符串 / null / 纯英文 / 超长段落都回空数组', () => {
    assert.deepEqual(findUnbackedNegatives('', emptyIndex), [])
    assert.deepEqual(findUnbackedNegatives(null, emptyIndex), [])
    assert.deepEqual(
      findUnbackedNegatives('The quick brown fox jumps over the lazy dog. Nothing to report.', emptyIndex),
      [],
    )
    const long = '这是一段没有路径的长文，'.repeat(5000) + '。'
    assert.deepEqual(findUnbackedNegatives(long, emptyIndex), [])
  })
})

describe('跨模块对照 · 列举不是内容', () => {
  test('只 glob / Get-ChildItem 过的会话，否定句仍然命中（把列举算成读过就会红）', () => {
    const index = buildReadIndex(view([
      session('E:\\proj'),
      { type: 'tool/call', data: { name: 'glob', arguments: JSON.stringify({ pattern: 'notes/todo.md' }) } },
      { type: 'tool/call', data: { name: 'Get-ChildItem', arguments: JSON.stringify({ path: 'notes\\todo.md' }) } },
    ]))
    const claims = findUnbackedNegatives('`notes/todo.md` 没有变。', index)
    assert.equal(claims.length, 1, '列举看的是文件名与 mtime；内容没被读过，否定就没有依据')
    assert.equal(claims[0].path, 'notes/todo.md')
  })
})
