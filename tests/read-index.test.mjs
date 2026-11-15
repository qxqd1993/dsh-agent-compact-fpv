/**
 * read-index.ts 判据离线单测
 *
 * 最重要的那一条是「只有列举过 → 仍然算没读过内容」：2026-11-15 的事故就是用
 * `Get-ChildItem` 的 mtime 回答了「内容有没有变」。列举给的是文件名与时间戳，不是内容；
 * 这条红了，就表示判据退回了事故当天的形状。同一组事件加上一条 `read` 的对照组，
 * 用来证明上面那条不是「反正永远为假」。
 *
 * 运行：node tests/read-index.test.mjs（先 npx tsc -p tsconfig.json）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReadIndex, noteToolCall } from '../lib/read-index.js'

/** 造一个按 seq 取事件的视图（事件数组下标即 seq） */
const view = events => ({ seq: events.length, eventAt: seq => events[seq] })

/** 造一条 tool/call 事件（arguments 是模型原样吐出的 JSON 字符串） */
const call = (name, args) => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'call-' + name, name, arguments: JSON.stringify(args) },
})

/** 造第一行 session 事件 */
const session = data => ({ type: 'session', data })

describe('read / grep · 算读过内容', () => {
  test('read（file_path）→ hasReadContent 为真，paths 给规范化路径', () => {
    const index = buildReadIndex(view([
      call('read', { file_path: 'E:\\Proj\\Notes\\Todo.MD' }),
    ]))
    assert.equal(index.hasReadContent('E:\\Proj\\Notes\\Todo.MD'), true)
    assert.deepEqual(index.paths(), ['e:/proj/notes/todo.md'])
  })

  test('grep（path）→ 算读过（它命中的是内容）', () => {
    const index = buildReadIndex(view([
      session({ cwd: 'E:\\proj' }),
      call('grep', { pattern: 'TODO', path: 'notes' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes'), true)
  })

  test('只有 read/grep 算；write 之类带 file_path 的调用不算', () => {
    const index = buildReadIndex(view([
      session({ cwd: 'E:\\proj' }),
      call('write', { file_path: 'notes\\todo.md' }),
      call('edit', { file_path: 'notes\\todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), false)
    assert.deepEqual(index.paths(), [])
  })
})

describe('列举工具 · 不算读过内容（事故那条）', () => {
  // 这组事件里每一个工具参数都「提到」同一个文件，但没有一个看过它的内容。
  const enumerated = () => [
    session({ cwd: 'E:\\proj' }),
    call('glob', { pattern: 'notes/*.md', path: 'E:\\proj\\notes' }),
    call('Get-ChildItem', { path: 'notes\\todo.md' }),
    call('ls', { path: 'notes\\todo.md' }),
    call('dir', { path: 'notes\\todo.md' }),
    call('find', { path: 'notes\\todo.md' }),
    call('pwsh', { command: 'Get-ChildItem notes\\todo.md | Select LastWriteTime' }),
    call('bash', { command: 'stat notes/todo.md' }),
  ]

  test('Get-ChildItem / glob / ls / dir / find / shell 列举过 → 仍为假，paths 为空', () => {
    const index = buildReadIndex(view(enumerated()))
    assert.equal(
      index.hasReadContent('E:\\proj\\notes\\todo.md'),
      false,
      '列举只证明「有人写过」，不证明「写了什么」；把它算成读过就是事故原句的形状',
    )
    assert.deepEqual(index.paths(), [])
  })

  test('对照组：同一批列举事件多一条 read → 就变真（上面的判据不是恒假）', () => {
    const index = buildReadIndex(view([
      ...enumerated(),
      call('read', { file_path: 'notes\\todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
    assert.deepEqual(index.paths(), ['e:/proj/notes/todo.md'])
  })
})

describe('规范化 · Windows 语义', () => {
  test('大小写不敏感（一律小写比对）', () => {
    const index = buildReadIndex(view([
      call('read', { file_path: 'e:/proj/Notes/TODO.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\PROJ\\notes\\todo.MD'), true)
  })

  test('/ 与 \\ 互等', () => {
    const index = buildReadIndex(view([
      session({ cwd: 'E:\\proj' }),
      call('read', { file_path: 'notes/todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
    assert.equal(index.hasReadContent('e:/proj/notes/todo.md'), true)
  })

  test('相对路径用 buildReadIndex 的 cwd 补成绝对', () => {
    const index = buildReadIndex(view([
      call('read', { file_path: 'notes\\todo.md' }),
    ]), 'E:\\proj')
    assert.equal(index.hasReadContent('e:/proj/notes/todo.md'), true)
  })

  test('cwd 来自 session 事件的 data.cwd', () => {
    const index = buildReadIndex(view([
      session({ cwd: 'E:\\proj' }),
      call('read', { file_path: './notes/../notes/todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
  })

  test('cwd 也可来自 session 事件的 data.meta.cwd', () => {
    const index = buildReadIndex(view([
      session({ meta: { cwd: 'E:\\proj' } }),
      call('read', { file_path: 'notes/todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
  })

  test('cwd 也可来自 tool/result 的 data.meta.cwd', () => {
    const index = buildReadIndex(view([
      { type: 'tool/result', data: { meta: { cwd: 'E:\\proj' } } },
      call('read', { file_path: 'notes/todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
  })

  test('cwd 取第一个拿到的；明确传入的 cwd 优先于事件', () => {
    const firstWins = buildReadIndex(view([
      session({ cwd: 'E:\\first' }),
      { type: 'tool/result', data: { meta: { cwd: 'E:\\second' } } },
      call('read', { file_path: 'x.md' }),
    ]))
    assert.equal(firstWins.hasReadContent('E:\\first\\x.md'), true)
    assert.equal(firstWins.hasReadContent('E:\\second\\x.md'), false)

    const explicitWins = buildReadIndex(view([
      session({ cwd: 'E:\\session' }),
      call('read', { file_path: 'x.md' }),
    ]), 'E:\\explicit')
    assert.equal(explicitWins.hasReadContent('E:\\explicit\\x.md'), true)
    assert.equal(explicitWins.hasReadContent('E:\\session\\x.md'), false)
  })

  test('file:// 前缀剥掉（含 Windows 磁盘形式）', () => {
    const index = buildReadIndex(view([
      call('read', { file_path: 'file:///E:/proj/notes/todo.md' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
    assert.deepEqual(index.paths(), ['e:/proj/notes/todo.md'])
  })

  test('尾端多余分隔符去掉；磁盘根保留', () => {
    const index = buildReadIndex(view([
      session({ cwd: 'E:\\proj' }),
      call('read', { file_path: 'notes\\todo.md' }),
      call('grep', { path: 'E:\\proj\\' }),
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md\\'), true)
    assert.equal(index.hasReadContent('e:/proj'), true)
  })

  test('没有 cwd 时相对路径按字面比对（不知道根，不猜）', () => {
    const index = buildReadIndex(view([
      call('read', { file_path: './notes/todo.md' }),
    ]))
    // 相对路径的 `.` 不折叠：没有根就没有可靠的「上层」语义，宁可对不上。
    assert.equal(index.hasReadContent('./notes/todo.md'), true)
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), false)
  })
})

describe('容错 · 坏事件只跳过，不抛', () => {
  test('形状不对的事件全部跳过，其中唯一合法的一条照记', () => {
    const index = buildReadIndex(view([
      null,
      42,
      '不是事件',
      {},
      { type: 'tool/call' },
      { type: 'tool/call', data: null },
      { type: 'tool/call', data: { name: 7, arguments: '{}' } },
      { type: 'tool/call', data: { name: 'read', arguments: 'not-json' } },
      { type: 'tool/call', data: { name: 'read', arguments: { file_path: 42 } } },
      { type: 'session', data: { cwd: 42 } },
      call('read', { file_path: 'ok.md' }),
    ]), 'E:\\proj')
    assert.equal(index.hasReadContent('E:\\proj\\ok.md'), true)
    assert.deepEqual(index.paths(), ['e:/proj/ok.md'])
  })

  test('eventAt 抛错、seq 坏掉 → 回空索引，不抛', () => {
    assert.doesNotThrow(() => buildReadIndex({ seq: 3, eventAt() { throw new Error('boom') } }))
    const empty = buildReadIndex({ seq: 3, eventAt() { throw new Error('boom') } })
    assert.deepEqual(empty.paths(), [])

    const badSeq = buildReadIndex({ seq: Number.NaN, eventAt() { throw new Error('不该被调用') } })
    assert.deepEqual(badSeq.paths(), [])
  })

  test('noteToolCall 坏参数 / 非本模块建的索引 → 不抛、回同一个对象', () => {
    const index = buildReadIndex(view([session({ cwd: 'E:\\proj' })]))
    assert.doesNotThrow(() => noteToolCall(index, 'read', '{'))
    assert.doesNotThrow(() => noteToolCall(index, 'read', ''))
    assert.doesNotThrow(() => noteToolCall(index, 'read', 'null'))
    assert.doesNotThrow(() => noteToolCall(index, 'read', '[]'))
    assert.deepEqual(index.paths(), [])

    const foreign = { hasReadContent: () => false, paths: () => [] }
    const returned = noteToolCall(foreign, 'read', JSON.stringify({ file_path: 'a.md' }))
    assert.equal(returned, foreign)
  })
})

describe('noteToolCall · 增量更新', () => {
  test('原地更新、返回同一对象、立刻可查', () => {
    const index = buildReadIndex(view([session({ cwd: 'E:\\proj' })]))
    assert.equal(index.hasReadContent('E:\\proj\\src\\a.ts'), false)

    const same = noteToolCall(index, 'read', JSON.stringify({ file_path: 'src/a.ts' }))
    assert.equal(same, index)
    assert.equal(index.hasReadContent('E:\\proj\\src\\a.ts'), true)
    assert.deepEqual(index.paths(), ['e:/proj/src/a.ts'])
  })

  test('增量也只认 read/grep；列举工具并不进来', () => {
    const index = buildReadIndex(view([session({ cwd: 'E:\\proj' })]))
    noteToolCall(index, 'grep', JSON.stringify({ path: 'notes' }))
    for (const name of ['glob', 'Get-ChildItem', 'ls', 'dir', 'find', 'write']) {
      noteToolCall(index, name, JSON.stringify({ path: 'notes\\todo.md', file_path: 'notes\\todo.md' }))
    }
    assert.equal(index.hasReadContent('E:\\proj\\notes'), true)
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), false)
    assert.deepEqual(index.paths(), ['e:/proj/notes'])
  })

  test('noteToolCall 可补 cwd：相对路径也能并成绝对键', () => {
    const index = buildReadIndex(view([]))
    noteToolCall(index, 'read', JSON.stringify({ file_path: './src/a.ts' }), 'E:\\proj')
    assert.equal(index.hasReadContent('e:\\proj\\src\\a.ts'), true)
  })
})

describe('shell · 只认「读内容」动词', () => {
  /** 用一条或多条 pwsh 命令建索引 */
  const shellIndex = (...commands) => buildReadIndex(view([
    session({ cwd: 'E:\\proj' }),
    ...commands.map(command => call('pwsh', { command })),
  ]))

  test('Get-Content x.md → 算读过（真实日志里漏的就是这一条）', () => {
    const index = shellIndex('Get-Content x.md')
    assert.equal(index.hasReadContent('E:\\proj\\x.md'), true)
    assert.deepEqual(index.paths(), ['e:/proj/x.md'])
  })

  test('读内容动词表逐个认（含 bash/cmd 与别名）', () => {
    const commands = [
      'Get-Content x.md',
      'Get-Content -Path x.md',
      'Get-Content -Raw x.md',
      'gc x.md',
      'cat x.md',
      'type x.md',
      'head x.md',
      'tail x.md',
      'more x.md',
      'Select-String -Path x.md',
      'grep foo x.md',
      'rg foo x.md',
      'findstr foo x.md',
      'sls x.md',
    ]
    for (const command of commands) {
      const index = shellIndex(command)
      assert.equal(index.hasReadContent('E:\\proj\\x.md'), true, command)
    }
  })

  test('列举／取元数据的动词仍然不算（Get-ChildItem x.md → 假）', () => {
    const commands = [
      'Get-ChildItem x.md',
      'ls x.md',
      'dir x.md',
      'find x.md',
      'Get-Item x.md',
      'Test-Path x.md',
      'Resolve-Path x.md',
      'stat x.md',
    ]
    for (const command of commands) {
      const index = shellIndex(command)
      assert.equal(index.hasReadContent('E:\\proj\\x.md'), false, command)
      assert.deepEqual(index.paths(), [], command)
    }
  })

  test('一条命令两件事：Get-ChildItem x.md; Get-Content y.md → 只有 y 算', () => {
    // 列举那一半故意用「像文件」的路径 x.md：若实现退化成「命令里出现路径就算」，
    // x.md 会被错误记成读过，这条直接红。
    const index = shellIndex('Get-ChildItem x.md; Get-Content y.md')
    assert.equal(index.hasReadContent('E:\\proj\\x.md'), false)
    assert.equal(index.hasReadContent('E:\\proj\\y.md'), true)

    // 反过来也不能把列举路径带上：作用域是逐段的，不是整条命令
    const reverse = shellIndex('Get-Content y.md; Get-ChildItem z.md')
    assert.equal(reverse.hasReadContent('E:\\proj\\y.md'), true)
    assert.equal(reverse.hasReadContent('E:\\proj\\z.md'), false)
  })

  test('多行脚本：列举一行、读取一行，互不串味', () => {
    const index = shellIndex('Get-ChildItem notes\\a.md\nGet-Content notes\\todo.md')
    assert.equal(index.hasReadContent('E:\\proj\\notes\\a.md'), false)
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
  })

  test('大小写混写（PowerShell 不区分大小写）', () => {
    const index = shellIndex('gEt-CoNtEnT Notes\\Todo.MD')
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
  })

  test('引号里的动词只是字符串：Write-Host "Get-Content x.md" 不算', () => {
    const index = shellIndex('Write-Host "Get-Content x.md"')
    assert.equal(index.hasReadContent('E:\\proj\\x.md'), false)
  })

  test('不认识的解释器不可蒙混：python -c "open(\'x.md\')" 不算', () => {
    const index = shellIndex('python -c "open(\'x.md\')"')
    assert.equal(index.hasReadContent('E:\\proj\\x.md'), false)
  })

  test('引号包住的路径照常算；无扩展名的裸词不算', () => {
    const quoted = shellIndex('Get-Content "notes/compact verify.md"')
    assert.equal(quoted.hasReadContent('E:\\proj\\notes\\compact verify.md'), true)

    const bare = shellIndex('Get-Content notes')
    assert.equal(bare.hasReadContent('E:\\proj\\notes'), false)
  })

  test('noteToolCall 也认 shell 读内容动词（增量）', () => {
    const index = buildReadIndex(view([session({ cwd: 'E:\\proj' })]))
    noteToolCall(index, 'pwsh', JSON.stringify({ command: 'Get-Content src/a.ts' }))
    assert.equal(index.hasReadContent('E:\\proj\\src\\a.ts'), true)
  })
})

describe('cwd() · 暴露给接线', () => {
  test('session 事件里的 cwd 以规范化形式暴露', () => {
    const index = buildReadIndex(view([session({ cwd: 'E:\\Proj' })]))
    assert.equal(index.cwd(), 'e:/proj')
  })

  test('推不出来时是 undefined', () => {
    assert.equal(buildReadIndex(view([])).cwd(), undefined)
    assert.equal(buildReadIndex(view([{ type: 'tool/result', data: {} }])).cwd(), undefined)
  })

  test('cwd 晚到：先落下的相对读取会补成绝对', () => {
    const index = buildReadIndex(view([
      call('pwsh', { command: 'Get-Content notes/todo.md' }),
      { type: 'tool/result', data: { meta: { cwd: 'E:\\proj' } } },
    ]))
    assert.equal(index.hasReadContent('E:\\proj\\notes\\todo.md'), true)
    assert.deepEqual(index.paths(), ['e:/proj/notes/todo.md'])
  })

  test('真实形状：cwd 只在这次 pwsh 调用的 tool/result meta 里（seq 在调用之后）', () => {
    const index = buildReadIndex(view([
      session({}),
      call('pwsh', { command: 'Get-Content notes/compact-verify.md' }),
      { type: 'tool/result', data: { meta: { cwd: 'E:\\dsh\\dsh-workspace\\dsh-dialog-thread1' } } },
    ]))
    assert.equal(
      index.hasReadContent('E:\\dsh\\dsh-workspace\\dsh-dialog-thread1\\notes\\compact-verify.md'),
      true,
    )
    assert.equal(index.cwd(), 'e:/dsh/dsh-workspace/dsh-dialog-thread1')
  })
})
