/**
 * 「这个会话读过哪些路径的**内容**」的索引。
 *
 * 为什么需要它：否定判断（「那个文件没动」「没有新增」）只有在**看过内容**之后才有依据。
 * 2026-11-15 的事故是拿 `Get-ChildItem` 给的 mtime 回答了「内容有没有变」——那不是证据，
 * 只是「有人写过」的时间戳。本模块把「内容被读过」单独记下来，供负面判断的检测器查。
 *
 * 判据刻意从严：只有 `read`（取 `file_path`）与 `grep`（取 `path`，它命中的是内容）算
 * 直接读过。目录列举（`glob`、`Get-ChildItem`、`ls`、`dir`、`find`）给的是**文件名与
 * mtime**，不是内容；把列举当内容，就是把「有人写过」当成「写了什么」——那正是事故原句。
 *
 * shell（`pwsh`/`bash` 等）另算，但只认「读内容」的动词（见 {@link SHELL_READ_VERBS}）：
 * 命令里出现 Get-Content/cat/type/head/tail/more/Select-String/grep/rg/findstr/sls/gc，
 * 且路径是它后面的参数，才算读过。Get-ChildItem/Get-Item/Test-Path/Resolve-Path/stat
 * 这些只取名字与元数据，仍然不算——「shell 里出现路径就算」会把事故那条重新放回来
 * （`Get-ChildItem notes; Get-Content x.md` 是两件事）。
 *
 * 容错也是判据的一部分：索引只是提示，不是判决，任何形状不对的事件都只能跳过，
 * 绝不能让一次压缩因为读不懂一条事件而失败。
 *
 * @module dsh-agent-compact/read-index
 */

/** 会话事件视图：只要能按 seq 读事件（测试可喂数组，运行时喂 `session.eventAt`）。 */
export interface SessionEventView {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
}

/** 已读索引的对外读面；写面只有 {@link noteToolCall}。 */
export interface ReadIndex {
  /** 这个路径的内容是否在本会话被读过。 */
  hasReadContent(pathish: string): boolean
  /** 已读路径（规范化后），供诊断与呈现。 */
  paths(): readonly string[]
  /** 建索引时推断出的会话工作目录；推不出来回 `undefined`（同样是规范化后的形式）。 */
  cwd(): string | undefined
}

/** 索引的可变内部状态；对外只暴露问题，不暴露集合本身。 */
interface IndexState {
  /** 规范化之后的绝对路径（小写、`/` 分隔），同一个写法只存一次。 */
  readonly read: Set<string>
  /** 会话 cwd（规范化后）。未知时为 `undefined`：相对路径只能按字面比对。 */
  cwd: string | undefined
}

/**
 * 状态与索引对象的关联。用 WeakMap 而不是把状态挂在对象上：对外类型只有问题，
 * 内部字段不该出现在 `paths()` 的诊断输出或对象的枚举属性里。
 */
const stateByIndex = new WeakMap<ReadIndex, IndexState>()

/** 直接读取内容的工具 → 参数里放路径的字段。这张表就是「算读过」的完整名单。 */
const CONTENT_READING_TOOLS: ReadonlyMap<string, string> = new Map([
  ['read', 'file_path'],
  ['grep', 'path'],
])

/** 参数里放整条命令字符串的 shell 工具；命令本身有没有读内容，要看动词。 */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'pwsh',
  'powershell',
  'bash',
  'sh',
  'zsh',
  'cmd',
  'shell',
])

/**
 * shell 里「读内容」的动词（小写比较；PowerShell 与 cmd 不区分大小写）。
 *
 * 反例故意不在这里：Get-ChildItem / ls / dir / find / Get-Item / Test-Path /
 * Resolve-Path / stat——它们只给文件名、存在性或元数据。`find` 在 Unix 上确实可以配
 * `-exec cat` 读内容，但只看动词分不出「找文件」与「找内容」，宁可不算。
 */
const SHELL_READ_VERBS: ReadonlySet<string> = new Set([
  'get-content',
  'gc',
  'cat',
  'type',
  'head',
  'tail',
  'more',
  'select-string',
  'sls',
  'grep',
  'rg',
  'findstr',
])

/** shell 词法单位：`text` 已去掉引号，`quoted` 表示它是否来自引号内。 */
interface ShellToken {
  readonly text: string
  readonly quoted: boolean
}

/**
 * 把一条 shell 命令切成「语句段」，每段是一串 token。
 *
 * 切分点是引号外的换行、`;`、`&&`、`||`、`|`、`&`。为什么必须切：`Get-ChildItem
 * notes; Get-Content x.md` 是两件事，若把整条命令当一个作用域，`notes` 会沾到
 * Get-Content 的光；反过来，`Get-Content x.md; Get-ChildItem y.md` 里的 y.md 也会被
 * 误记成读过。管道也切段：`cat x.md | grep foo` 的 x.md 由 cat 段负责。
 *
 * 引号内的分隔符不切；引号内的词也不会被当成动词（`Write-Host "Get-Content x.md"`
 * 只是打印字符串，不是读文件）。不展开变量与命令替换，也不处理转义空格——见
 * {@link isShellPathArgument} 的边界说明。
 */
function shellSegments(command: string): readonly (readonly ShellToken[])[] {
  const segments: ShellToken[][] = []
  let current: ShellToken[] = []
  let token = ''
  let tokenStarted = false
  let tokenQuoted = false
  let quote: '"' | "'" | null = null

  const pushToken = (): void => {
    if (tokenStarted && token !== '') current.push({ text: token, quoted: tokenQuoted })
    token = ''
    tokenStarted = false
    tokenQuoted = false
  }
  const pushSegment = (): void => {
    pushToken()
    if (current.length > 0) segments.push(current)
    current = []
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote !== null) {
      // 引号内：除了收尾引号，别的都原样进 token（含换行与分隔符）。
      if (char === quote) quote = null
      else token += char
      tokenStarted = true
      tokenQuoted = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      tokenStarted = true
      tokenQuoted = true
      continue
    }
    if (char === '#' && !tokenStarted) {
      // PowerShell 注释到行尾；注释里的路径与动词都不该参与判断。
      while (index + 1 < command.length && command[index + 1] !== '\n') index += 1
      continue
    }
    if (char === '\n' || char === '\r' || char === ';') {
      pushSegment()
      continue
    }
    if (char === '|') {
      if (command[index + 1] === '|') index += 1
      pushSegment()
      continue
    }
    if (char === '&') {
      if (command[index + 1] === '&') index += 1
      pushSegment()
      continue
    }
    if (char === ' ' || char === '\t') {
      pushToken()
      continue
    }
    token += char
    tokenStarted = true
  }
  pushSegment()
  return segments
}

/** 去掉 token 两端的命令语法符号（子表达式括号、块花括号、数组逗号），不碰路径内部。 */
function trimShellToken(text: string): string {
  return text.replace(/^[({[]+/, '').replace(/[)}\],]+$/, '')
}

/** 这个 token 是不是「读内容」动词；引号里的词不算（那只是字符串）。 */
function isShellReadVerb(token: ShellToken): boolean {
  if (token.quoted) return false
  return SHELL_READ_VERBS.has(trimShellToken(token.text).toLowerCase())
}

/**
 * 从一个 token 里拆出候选路径。
 *
 * PowerShell 用逗号分隔数组参数（`Get-Content a.md,b.md`），所以未加引号的 token 按
 * 逗号拆；引号里的逗号保留（它可能是文件名的一部分）。
 */
function shellPathCandidates(token: ShellToken): readonly string[] {
  const text = trimShellToken(token.text)
  if (text === '') return []
  const pieces = token.quoted ? [text] : text.split(',')
  return pieces.map(piece => trimShellToken(piece)).filter(piece => piece !== '')
}

/**
 * 候选 token 是否像「被读的路径」。
 *
 * 只收文件形状：有扩展名，且不是开关、通配符、变量、URL、目录。刻意不收无扩展名的
 * 文件名（`Makefile`）与带空格的转义写法：前者分不出文件/目录，后者本解析器不展开。
 * 这个取舍与 negative.ts 的路径抽取一致——漏记只会少提醒一句。
 */
function isShellPathArgument(text: string): boolean {
  if (text === '' || text.startsWith('-')) return false
  if (text.startsWith('>') || text.startsWith('<')) return false
  if (/[*?]/.test(text)) return false
  if (/^[$%]/.test(text)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return false
  if (/[\\/]$/.test(text)) return false
  const base = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
  if (base === '' || base === '.' || base === '..') return false
  return /\.[A-Za-z0-9]{1,8}$/.test(base)
}

/**
 * 从一条 shell 命令里取出「被读过内容」的路径。
 *
 * 简化规则（实测日志里够用，边界如实记）：先按语句段切开，再在**同一段内**找读内容
 * 动词；动词之后的所有 token 都算它的作用范围，其中像路径的收下。不区分「第一个参数」
 * 与「后面的参数」——`Select-String -Pattern x -Path y.md` 与 `grep -n foo y.md` 都能
 * 命中；代价是 `-Pattern foo.md` 这种参数值若长得像路径也会被多记一次（方向安全：
 * 只会漏提醒，不会凭空指控）。`python -c "open('x.md')"` 不认：没有动词表里的动词。
 * @param command - shell 工具收到的命令字符串（可多行）
 * @returns 候选路径（未规范化）
 */
function shellReadPaths(command: string): readonly string[] {
  const out: string[] = []
  for (const segment of shellSegments(command)) {
    for (let index = 0; index < segment.length; index += 1) {
      if (!isShellReadVerb(segment[index]!)) continue
      for (let next = index + 1; next < segment.length; next += 1) {
        for (const candidate of shellPathCandidates(segment[next]!)) {
          if (isShellPathArgument(candidate)) out.push(candidate)
        }
      }
    }
  }
  return out
}

/** 把 unknown 收窄成普通对象；数组、null、基本类型都不是事件数据。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 去掉尾端多余分隔符，但保留 `e:/` 这种磁盘根。
 * 尾端斜线在 Windows 上不改变指向，`hasReadContent('…/a.md/')` 应该命中 `…/a.md`。
 */
function trimTrailingSeparators(path: string): string {
  let out = path
  while (out.length > 1 && out.endsWith('/')) {
    if (/^[a-z]:\/$/.test(out)) break
    out = out.slice(0, -1)
  }
  return out
}

/** 把绝对路径的 `.`/`..` 折叠掉；`prefix` 是根（`e:/`、`/` 或 UNC 的 host/share）。 */
function collapseSegments(prefix: string, rest: string): string {
  const out: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // 根之上再 `..` 仍然是根（Windows/Linux 一致），不补出负层级。
      if (out.length > 0) out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length === 0 ? prefix : prefix + out.join('/')
}

/** 只折叠绝对路径；相对路径与 `~/x` 保持字面（不知道根，猜不得）。 */
function collapseDotSegments(path: string): string {
  if (path.startsWith('//')) {
    // UNC：`//host/share/…` 的 host/share 是根的一部分，只折叠它后面的段落。
    const parts = path.split('/')
    if (parts.length >= 4) {
      const host = parts[2]
      const share = parts[3]
      if (host !== undefined && share !== undefined) {
        return collapseSegments('//' + host + '/' + share + '/', parts.slice(4).join('/'))
      }
    }
    return path
  }
  const drive = /^([a-z]:)\//.exec(path)
  if (drive !== null) {
    const prefix = drive[1]!
    return collapseSegments(prefix + '/', path.slice(prefix.length + 1))
  }
  if (path.startsWith('/')) return collapseSegments('/', path.slice(1))
  return path
}

/**
 * `file://` 转成普通路径：读取工具的参数偶尔会带 URL 形式，若不剥掉就永远对不上。
 * 百分号解码失败时保留原样——宁可对不上，也不要为了一条提示抛错。
 */
function stripFileUrl(url: string): string {
  let rest = url.slice('file://'.length)
  if (rest.startsWith('/')) {
    // `file:///E:/x` 的第三条斜线属于 URL，不属于路径。
    if (/^\/[A-Za-z]:\//.test(rest)) rest = rest.slice(1)
  } else if (rest !== '' && !/^[A-Za-z]:[\\/]/.test(rest)) {
    // `file://server/share/x`：server 是主机，换回 UNC 形状。
    rest = '//' + rest
  }
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // 保留原字符串。
  }
  return rest
}

/**
 * 规范化路径，作为索引键。
 *
 * Windows 大小写不敏感（一律转小写）、`/` 与 `\` 互等、剥掉 `file://`、相对路径用 cwd
 * 补成绝对、去尾端多余分隔符、折叠 `.`/`..`。`~/` 不展开（拿不到家目录），保留字面值，
 * 至少同一个写法能互相命中。
 * @param raw - 工具参数里的路径或查询字符串
 * @param cwd - 已知的会话 cwd（规范化后）
 * @returns 规范化键；不是字符串或空字符串时 `undefined`
 */
function canonicalPath(raw: unknown, cwd: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  let path = raw.trim()
  if (path === '') return undefined

  if (/^file:\/\//i.test(path)) path = stripFileUrl(path)
  path = path.replace(/\\/g, '/')
  // 只有磁盘代号时补回根斜线，让 `c:` 与 `c:/` 等价。
  if (/^[A-Za-z]:$/.test(path)) path = path + '/'

  const absolute = /^[A-Za-z]:\//.test(path) || path.startsWith('/')
  const tilde = path === '~' || path.startsWith('~/')
  if (!absolute && !tilde && cwd !== undefined) {
    path = cwd.endsWith('/') ? cwd + path : cwd + '/' + path
  }

  return trimTrailingSeparators(collapseDotSegments(path).toLowerCase())
}

/**
 * 解析工具调用参数。
 *
 * 正规事件里 `arguments` 是模型原样吐出的 JSON 字符串；这里也容忍已经是对象的情况，
 * 只为了不让一个形状差异白白丢掉一条读取记录。解析失败就当这次调用没有参数。
 */
function argumentsOf(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === 'string') {
    if (args === '') return undefined
    try {
      return asRecord(JSON.parse(args))
    } catch {
      return undefined
    }
  }
  return asRecord(args)
}

/**
 * 采纳一个 cwd，并把**先于它**落下的相对路径补成绝对。
 *
 * 真实 v4 日志里 cwd 可能来自较晚的 `tool/result`（甚至第一条 shell 调用之后才出现）；
 * 若只把 cwd 存下来，早先那条相对路径会永远按字面比对，后面用绝对路径查就永远对不上
 * ——这正是「早上明明读过、索引却说没读过」的另一种形状。绝对键与 `~/x` 不受影响。
 */
function adoptCwd(state: IndexState, cwd: string): void {
  state.cwd = cwd
  const rebased = new Set<string>()
  for (const key of state.read) {
    const absolute = canonicalPath(key, cwd)
    rebased.add(absolute ?? key)
  }
  state.read.clear()
  for (const key of rebased) state.read.add(key)
}

/**
 * 把一条工具调用并进索引（内部版，直接改状态）。
 * @param state - 索引状态
 * @param toolName - 工具名；只认 {@link CONTENT_READING_TOOLS} 与 {@link SHELL_TOOLS}
 * @param argsJson - 原始参数（JSON 字符串，或已是对象）
 * @param explicitCwd - 调用方当下知道的 cwd；有给就以它为准（并记下来给后续相对路径用）
 */
function noteCall(state: IndexState, toolName: unknown, argsJson: unknown, explicitCwd?: unknown): void {
  if (typeof toolName !== 'string') return
  if (explicitCwd !== undefined) {
    const cwd = canonicalPath(explicitCwd, undefined)
    // 调用方给的是「这一笔发生时」的 cwd，比会话开头记下的更接近事实。
    if (cwd !== undefined) adoptCwd(state, cwd)
  }

  const name = toolName.trim().toLowerCase()
  const field = CONTENT_READING_TOOLS.get(name)
  const shell = SHELL_TOOLS.has(name)
  if (field === undefined && !shell) return

  const args = argumentsOf(argsJson)
  if (args === undefined) return

  if (field !== undefined) {
    const path = canonicalPath(args[field], state.cwd)
    if (path !== undefined) state.read.add(path)
    return
  }

  const command = args.command
  if (typeof command !== 'string' || command.trim() === '') return
  for (const raw of shellReadPaths(command)) {
    const path = canonicalPath(raw, state.cwd)
    if (path !== undefined) state.read.add(path)
  }
}

/** 用状态造出只读索引对象，并登记 WeakMap。 */
function createIndex(state: IndexState): ReadIndex {
  const index: ReadIndex = {
    hasReadContent(pathish: string): boolean {
      const key = canonicalPath(pathish, state.cwd)
      return key !== undefined && state.read.has(key)
    },
    paths(): readonly string[] {
      // 排序只是为了让诊断输出稳定；集合本身没有顺序语义。
      return [...state.read].sort()
    },
    cwd(): string | undefined {
      return state.cwd
    },
  }
  stateByIndex.set(index, state)
  return index
}

/**
 * cwd 的来源：`session` 事件的 `data.cwd` / `data.meta.cwd`，或 `tool/result` 的
 * `data.meta.cwd`。只认这几种明确字段——猜别人的事件字段等于制造第二个 mtime。
 */
function cwdFromEvent(event: { readonly type?: string; readonly data?: unknown }): string | undefined {
  const data = asRecord(event.data)
  if (data === undefined) return undefined
  if (event.type === 'session') {
    if (typeof data.cwd === 'string' && data.cwd.trim() !== '') return data.cwd
    const meta = asRecord(data.meta)
    if (meta !== undefined && typeof meta.cwd === 'string' && meta.cwd.trim() !== '') return meta.cwd
    return undefined
  }
  if (event.type === 'tool/result') {
    const meta = asRecord(data.meta)
    if (meta !== undefined && typeof meta.cwd === 'string' && meta.cwd.trim() !== '') return meta.cwd
  }
  return undefined
}

/**
 * 一次全扫建立索引。
 *
 * 事件按 seq 递增扫一遍：先取第一个能拿到的 cwd（`session` 事件或 `tool/result` 的
 * meta），再把之后遇到的每一条读取调用并进去。cwd 晚到时，之前按字面记下的相对路径
 * 会被 {@link adoptCwd} 补成绝对，所以顺序不会把早先的读取记录作废。
 * @param view - 会话事件视图
 * @param cwd - 调用方已知的 cwd（优先于事件里找到的）
 * @returns 新索引
 */
export function buildReadIndex(view: SessionEventView, cwd?: string): ReadIndex {
  const state: IndexState = { read: new Set<string>(), cwd: canonicalPath(cwd, undefined) }
  const index = createIndex(state)

  let count = 0
  try {
    if (view !== null && view !== undefined && typeof view.seq === 'number' && Number.isFinite(view.seq)) {
      count = Math.max(0, Math.floor(view.seq))
    }
  } catch {
    // seq 是坏的：当这个会话没有事件，索引为空。
  }

  for (let seq = 0; seq < count; seq += 1) {
    let event: { readonly type?: string; readonly data?: unknown } | undefined
    try {
      event = view.eventAt(seq)
    } catch {
      // 读一条事件就炸，跳过它；索引坏掉不能让压缩流程出事。
      continue
    }
    if (event === null || typeof event !== 'object') continue
    try {
      if (state.cwd === undefined) {
        const sessionCwd = cwdFromEvent(event)
        if (sessionCwd !== undefined) {
          const canonicalCwd = canonicalPath(sessionCwd, undefined)
          if (canonicalCwd !== undefined) adoptCwd(state, canonicalCwd)
        }
      }
      if (event.type !== 'tool/call') continue
      const data = asRecord(event.data)
      if (data === undefined) continue
      noteCall(state, data.name, data.arguments)
    } catch {
      // 单条事件形状坏掉只跳过它，不影响其它事件。
      continue
    }
  }
  return index
}

/**
 * 增量：把一条新落的 `tool/call` 并进索引（原地更新，返回同一个对象）。
 *
 * 引擎可以在事件流上边走边喂，不必每次重建整份索引。未经 {@link buildReadIndex}
 * 建立的索引（没有内部状态可更新）会原样返回——宁可少记，也不要为此抛错。
 * @param index - 要更新的索引
 * @param toolName - 工具名
 * @param argsJson - 工具参数（模型吐出的 JSON 字符串）
 * @param cwd - 这次调用发生时的 cwd（可选）
 * @returns 同一个索引对象
 */
export function noteToolCall(
  index: ReadIndex,
  toolName: string,
  argsJson: string,
  cwd?: string,
): ReadIndex {
  const state = stateByIndex.get(index)
  if (state === undefined) return index
  try {
    noteCall(state, toolName, argsJson, cwd)
  } catch {
    // 索引是提示，不是判决：一条记不上，不影响压缩主流程。
  }
  return index
}
