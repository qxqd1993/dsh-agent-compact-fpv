/**
 * 对账分档判据离线单测（2026-11-15 checkpoint 引用未读文件事故）
 *
 * 事故形状：一块 checkpoint 引用了三个文件路径，而那个会话一个都没打开过。
 * 原型的对账清单跑出 17 条可疑，其中 12 条是误报（路径缩写、URL 片段、通配符、
 * 没展开的 `~/`）——七成误报的清单会被整份忽略。所以本模块的判据不是「尽量多抓」，
 * 而是「只把确证交出去」：本文件逐档钉住 confirmed / suspected / noise 的边界。
 *
 * 诚实边界：这里用假索引与假 exists，不碰真实文件系统，也不验「真实会话的索引是否完整」；
 * 被验的是分档函数在给定证据下会不会把误报放进 confirmed。
 *
 * 运行：先 `npx tsc -p tsconfig.json`，再 `node tests/reconcile.test.mjs`
 * （不要用 `npm test`：本沙盒禁止 Node 子进程管道，`node --test` 会以 spawn EPERM 失败）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { reconcileReferences, confirmedOnly } from '../lib/reconcile.js'

/** 事故原句里那一类路径：绝对路径、写法明确。 */
const EVENT_PATH = '/work/acme-app/src/checkpoint-block.ts'

/**
 * 假依赖：索引与存在性都由数组喂，测试不碰磁盘。
 * @param {{read?: string[], existing?: string[]}} [options] - `read` 是已读集合，
 *   `existing` 是 exists 为真的集合；两者都按原文路径精确匹配。
 */
function fakeDeps({ read = [], existing = [] } = {}) {
  const readSet = new Set(read)
  const existingSet = new Set(existing)
  const readCalls = []
  return {
    readCalls,
    index: {
      hasReadContent(pathish) {
        readCalls.push(pathish)
        return readSet.has(pathish)
      },
    },
    exists(path) {
      return existingSet.has(path)
    },
  }
}

/** 按原文路径找一条结论；找不到就红。 */
function find(refs, path) {
  return refs.find((ref) => ref.path === path)
}

test('写法明确 + 索引未读 + 文件存在 ⇒ confirmed（事故原句那一类）', () => {
  const block = '## Files and Code\n\n- `' + EVENT_PATH + '` —— 我改了这个文件'
  const refs = reconcileReferences(block, fakeDeps({ existing: [EVENT_PATH] }))

  assert.equal(refs.length, 1, '只该有一条结论：' + JSON.stringify(refs))
  assert.equal(refs[0].tier, 'confirmed')
  assert.equal(refs[0].path, EVENT_PATH)
  assert.match(refs[0].reason, /存在/, 'reason 要能让人看出「凭什么确证」')
})

test('同一路径但索引里读过了 ⇒ 整条放行，什么也不回', () => {
  const block = '## Files and Code\n\n- `' + EVENT_PATH + '`'
  const deps = fakeDeps({ read: [EVENT_PATH], existing: [EVENT_PATH] })
  const refs = reconcileReferences(block, deps)

  assert.deepEqual(refs, [], '读过的路径不是嫌疑；有结论就说明去重/放行没做')
  assert.deepEqual(deps.readCalls, [EVENT_PATH], '应拿块里的原文路径去问索引，不能自己编')
})

test('写法明确 + 未读 + 文件不存在 ⇒ suspected，reason 说出「不存在」', () => {
  const missing = '/work/acme-app/src/missing.ts'
  const refs = reconcileReferences('- `' + missing + '` —— 打算改但没打开', fakeDeps())

  const ref = find(refs, missing)
  assert.ok(ref, '应留下一条可疑：' + JSON.stringify(refs))
  assert.equal(ref.tier, 'suspected', '不存在的路径多半是假设/举例，不能进 confirmed')
  assert.match(ref.reason, /不存在/)
})

test('两段相对路径 src/policy.ts ⇒ suspected（缩写不因文件存在而升级）', () => {
  const block = '- 先看 `src/policy.ts` 里的策略'
  const refs = reconcileReferences(block, fakeDeps({ existing: ['src/policy.ts'] }))

  assert.equal(refs.length, 1)
  assert.equal(refs[0].tier, 'suspected', '裸相对路径无从确定根在哪，存在也不能确证')
  assert.match(refs[0].reason, /缩写/)
})

test('URL 与 github.com/... ⇒ noise，且不把 URL 里的路径片段当文件', () => {
  const block = '出处：https://github.com/acme-app/src/checkpoint-block.ts\n'
    + '也可看 github.com/acme-app/src/checkpoint-block.ts\n'
    + '或 www.example.com/acme-app/src/checkpoint-block.ts'
  const refs = reconcileReferences(block, fakeDeps({ existing: [EVENT_PATH] }))

  assert.equal(refs.length, 3, 'URL 被整段抹掉后应只剩三条 noise：' + JSON.stringify(refs))
  for (const ref of refs) {
    assert.equal(ref.tier, 'noise')
    assert.match(ref.reason, /URL/)
  }
})

test('通配符 *.md / src/**/*.ts ⇒ suspected，绝不 confirmed', () => {
  const block = '- 规则写在 `*.md`\n- 产物在 `src/**/*.ts`'
  const refs = reconcileReferences(block, fakeDeps())

  assert.equal(refs.length, 2, JSON.stringify(refs))
  for (const ref of refs) {
    assert.equal(ref.tier, 'suspected', '通配符指向一组文件，不能当具体引用')
    assert.match(ref.reason, /通配符/)
  }
  assert.equal(confirmedOnly(refs).length, 0)
})

test('没展开的 ~/ 路径 ⇒ suspected（即便 exists 说是真也不能确证）', () => {
  const home = '~/project/config.json'
  const refs = reconcileReferences('- 配置在 `' + home + '`', fakeDeps({ existing: [home] }))

  assert.equal(refs.length, 1, JSON.stringify(refs))
  assert.equal(refs[0].tier, 'suspected')
  assert.match(refs[0].reason, /未展开/)
  assert.equal(confirmedOnly(refs).length, 0)
})

test('纯目录名 / 少于 6 个字符 ⇒ noise', () => {
  const block = '- 目录 `src/lib/`\n- 还有个 `/x.ts`'
  const refs = reconcileReferences(block, fakeDeps())

  const dir = find(refs, 'src/lib/')
  const short = find(refs, '/x.ts')
  assert.ok(dir, JSON.stringify(refs))
  assert.ok(short, JSON.stringify(refs))
  assert.equal(dir.tier, 'noise')
  assert.match(dir.reason, /目录/)
  assert.equal(short.tier, 'noise')
  assert.match(short.reason, /太短/)
})

test('混合输入：一条 confirmed、一条 suspected、一条 noise ⇒ confirmedOnly 只回一条', () => {
  const missing = '/work/acme-app/src/missing.ts'
  const block = '# 摘要\n'
    + '- 改过 `./src/reconcile.ts`\n'
    + '- 可能还要看 `' + missing + '`\n'
    + '- 出处 https://example.com/issue/42'
  const deps = fakeDeps({ existing: ['./src/reconcile.ts'] })
  const refs = reconcileReferences(block, deps)

  assert.equal(refs.length, 3, JSON.stringify(refs))
  const confirmed = confirmedOnly(refs)
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].path, './src/reconcile.ts')
  assert.deepEqual(
    [...new Set(refs.map((ref) => ref.tier))].sort(),
    ['confirmed', 'noise', 'suspected'],
  )
})

test('空串 / 纯英文段落 ⇒ []，不抛', () => {
  assert.deepEqual(reconcileReferences('', fakeDeps()), [])
  assert.deepEqual(reconcileReferences('   \n\n  ', fakeDeps()), [])
  const english = 'This paragraph describes the intent behind the module, and nothing else.'
  assert.deepEqual(reconcileReferences(english, fakeDeps()), [])
})

test('超长正文 ⇒ []（不扫描，也不抛）', () => {
  // 带上真实路径：如果上限没生效，会扫出一条 confirmed——这条测试才有分辨力。
  const huge = ('- `' + EVENT_PATH + '`\n').repeat(60_000)
  assert.ok(huge.length > 1_000_000)
  assert.deepEqual(reconcileReferences(huge, fakeDeps({ existing: [EVENT_PATH] })), [])
})

test('同一路径出现多次 ⇒ 只回一条，且取最严重的档', () => {
  const block = '`src/policy.ts` … `./src/policy.ts` … `src/policy.ts`'
  const deps = fakeDeps({ existing: ['./src/policy.ts'] })
  const refs = reconcileReferences(block, deps)

  assert.equal(refs.length, 1, '同一路径只许一条：' + JSON.stringify(refs))
  assert.equal(refs[0].tier, 'confirmed', '缩写与明确写法指向同一处时取更确凿的那档')
  assert.equal(refs[0].path, './src/policy.ts')
  assert.match(refs[0].reason, /同一路径/)
  assert.match(refs[0].reason, /3 次/)
})

test('缩写路径若索引里确实读过 ⇒ 也放行', () => {
  const deps = fakeDeps({ read: ['src/policy.ts'], existing: ['src/policy.ts'] })
  assert.deepEqual(reconcileReferences('`src/policy.ts`', deps), [])
})

test('Windows 绝对路径也是明确写法 ⇒ confirmed', () => {
  const win = 'E:\\dsh\\dsh-workspace\\projects\\t3\\src\\reconcile.ts'
  const refs = reconcileReferences('- 产物 `' + win + '`', fakeDeps({ existing: [win] }))

  assert.equal(refs.length, 1, JSON.stringify(refs))
  assert.equal(refs[0].tier, 'confirmed')
  assert.equal(refs[0].path, win)
})

test('加粗的绝对路径不被当成通配符 ⇒ confirmed', () => {
  const refs = reconcileReferences('**' + EVENT_PATH + '**', fakeDeps({ existing: [EVENT_PATH] }))

  assert.equal(refs.length, 1, JSON.stringify(refs))
  assert.equal(refs[0].tier, 'confirmed', 'Markdown 加粗不是通配符')
  assert.equal(refs[0].path, EVENT_PATH)
})
