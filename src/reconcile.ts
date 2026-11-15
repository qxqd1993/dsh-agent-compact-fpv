/**
 * 对账：把 checkpoint 块里出现的路径，对照「本会话真正读过什么」。
 *
 * 为什么值得单独成模块（2026-11-15）：一块我写下的 checkpoint 引用了三个文件路径，
 * 那个会话**一个都没打开过**——写在摘要里的引用与实际读过的内容之间没有任何约束。
 * 事后原型的对账清单跑出 17 条可疑，其中 **12 条是误报**：路径缩写、URL 片段、通配符、
 * 没展开的 `~/`。⇒ 七成误报的清单会被整份忽略。所以这个模块的价值不在「抓多少」，
 * 而在「**只把确证交出去**」：`confirmedOnly` 才是给人看的那一档。
 *
 * 判据上的两刀（相对原型）：
 * 1. **存在性**（{@link reconcileReferences} 的 `deps.exists`）：只有磁盘上真有的路径
 *    才可能是「引用」；不存在的多半是假设、示例或待办。原型缺这一刀，于是把示例也
 *    报成了可疑。这是本模块相对原型的关键改进。
 * 2. **写法明确**：绝对路径，或以 `./`、`../` 起头的相对路径才算明确。裸相对路径
 *    （如 `src/policy.ts`）无从确定根在哪，只是缩写，最高只能到 `suspected`。
 *
 * 纯函数：不读文件、不碰时间、不 console——索引与存在性都由调用方注入，测试可完全离线。
 *
 * @module dsh-agent-compact/reconcile
 */

/** 只要能回答「读过没」——刻意不 import 另一份实现，避免两个模块绑死。 */
export interface ReadIndexLike {
  hasReadContent(pathish: string): boolean
}

/** 三档：只有 confirmed 允许摆到人眼前。 */
export type RefTier = 'confirmed' | 'suspected' | 'noise'

export interface ReconciledRef {
  readonly path: string
  readonly tier: RefTier
  /** 为什么归这一档（一句话，给侧车与人看） */
  readonly reason: string
}

/**
 * 严重度：同一路径重复出现时取大。
 *
 * 顺序是**信任**的顺序，不是概率：confirmed 是唯一敢给人看的，所以它最「严重」；
 * noise 已经被判为非引用，最低。
 */
const TIER_SEVERITY: { readonly [tier in RefTier]: number } = {
  confirmed: 2,
  suspected: 1,
  noise: 0,
}

/**
 * 少于 6 个字符的路径短到无法自证指向何处（`/x.ts`、`a/b`）。
 *
 * 6 是任务给定的线：再短就更像句子里的碎片，而不是一次可核对的引用。
 */
const MIN_PATH_CHARS = 6

/**
 * 超长正文不是一块 checkpoint 的写法：不扫描，直接回空。
 *
 * 为什么要有上限：本函数是纯函数，调用方可能把整段会话误喂进来；百万字符的输入在这里
 * 扫一遍既没有额外信号，也会白占调用方的时间。宁漏勿炸——对账是旁路，不能反过来带倒主流程。
 */
const MAX_BLOCK_CHARS = 1_000_000

/**
 * URL：任何 `scheme://…` 都不算本机路径。
 *
 * 必须**先整段抹掉**再扫候选：否则 `https://github.com/o/r/blob/main/src/x.ts` 里的
 * `src/x.ts` 会被当成一条文件引用——这正是原型 12 条误报里最典型的一类。
 */
const URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`）】\]。，；：！？、]+/g

/** 无协议头的托管地址（`github.com/o/r/...`、`www.example.com/x`）：与 URL 同一类误报。 */
const BARE_URL_RE = /(?<![\w.-])(?:www\.|github\.com\/)[^\s<>"'`）】\]。，；：！？、]+/gi

/**
 * 候选路径词：只抽「像路径」的连续串——必须有盘符、`~/`、显式相对前缀、分隔符，
 * 或以 `*` 起头。
 *
 * 为什么必须要求这些形状：自然语言里的裸单词（`src`、`readme`、`the`）也是 ASCII 词，
 * 全抽出来就是噪声发生器；以分隔符/扩展名作锚，既能抓住 `src/a.ts`，也会把
 * `and/or`、`TCP/IP` 这类非路径抽出来——后者交给 noise 档消化。
 */
const CANDIDATE_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|/|[\w.@+~$\-]+[\\/]|\*[\w.*?@+~/-]*)[\w.@+~$*?/\\-]*`,
  'g',
)

/** 扩展名：最后一段里最后一个点之后是 1–8 个字母开头的字符（`ts`、`mjs`、`d.ts` 的 `ts`）。 */
const EXTENSION_RE = /\.([A-Za-z][A-Za-z0-9]{0,7})$/

/** URL 尾巴上粘着的句读/右括号（以及 Markdown 强调符）属于句子，不属于地址。 */
function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}>*。，；：！？、]+$/, '')
}

/** 路径尾巴上的句点属于句子（“读了 src/a.ts.”），不属于文件名。 */
function trimPath(raw: string): string {
  return raw.replace(/\.+$/, '')
}

/**
 * 抹掉 Markdown 的成对强调符（`**src/a.ts**`）。
 *
 * 不抹的话，开头那个 `*` 会让整条路径被当成通配符，直接降成 suspected——
 * checkpoint 是用 Markdown 写的，加粗路径是常态而非例外。
 */
function stripEmphasis(raw: string): string {
  for (const marker of ['**', '__']) {
    if (raw.length > marker.length * 2 && raw.startsWith(marker) && raw.endsWith(marker)) {
      return raw.slice(marker.length, -marker.length)
    }
  }
  return raw
}

/** 文件名的最后一段（没有分隔符时就是它自己）。 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/)
  return parts[parts.length - 1] ?? ''
}

/** 像文件而不是目录：最后一段带扩展名，或以点开头的 dotfile（`.env`）。 */
function looksLikeFile(path: string): boolean {
  const name = lastSegment(path)
  if (name === '' || name === '.' || name === '..') return false
  if (/^\.[A-Za-z0-9]/.test(name)) return true
  return EXTENSION_RE.test(name)
}

/** 绝对路径：POSIX `/`、Windows `C:\`，以及 UNC `\\server\share`。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
    || path.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(path)
}

/** 显式相对：以 `./` 或 `../` 起头——根本来就写在路径里，不是猜的。 */
function isDotRooted(path: string): boolean {
  return /^\.{1,2}[\\/]/.test(path)
}

/** 通配符：指向一组文件，永远不能升级成 confirmed。 */
function isGlob(path: string): boolean {
  return /[*?]/.test(path)
}

/** 没展开的 `~/`：不知道 home 在哪，也就不知道指向哪个文件。 */
function isUnexpandedHome(path: string): boolean {
  return /^~[\\/]/.test(path)
}

/**
 * 合并用的规范化键：只折叠**确定等价**的写法。
 *
 * - 反复去掉开头的 `./`：`./src/a.ts` 与 `src/a.ts` 是同一处；
 * - 统一分隔符：Windows 的 `\` 与 `/` 同义，并折叠重复分隔符。
 *
 * 刻意不折叠 `../`，也不做大小写归一：POSIX 上 `A.ts` 与 `a.ts` 是两个文件，
 * 误合并会把一条真引用吞掉（宁可少合并，不可多合并）。
 * @param path - 已去掉句读的路径词
 * @returns 合并键
 */
function samePathKey(path: string): string {
  let key = path
  while (key.startsWith('./')) key = key.slice(2)
  return key.replace(/[\\/]+/g, '/')
}

/** 单条候选的结论：要么归某一档，要么整条放行（已读过）。 */
type Verdict = { readonly tier: RefTier; readonly reason: string } | 'skip'

/**
 * 给一条候选路径分档。判据顺序即优先级，任一条命中即返回。
 * @param path - 去掉句读与强调符后的路径词
 * @param index - 「读过什么」的索引
 * @param exists - 路径存在性（调用方注入）
 * @returns 档位与一句话理由；已读过时返回 `'skip'`
 */
function classify(
  path: string,
  index: ReadIndexLike,
  exists: (path: string) => boolean,
): Verdict {
  // 读过就放行，且放在所有分档判据之前：对账只关心「引用过但没读过」的差集。
  // 一个候选哪怕写法再怪，只要索引说读过，它就不是嫌疑（也就不该占一条 noise）。
  if (index.hasReadContent(path)) return 'skip'
  if (/[\\/]$/.test(path)) {
    return { tier: 'noise', reason: '纯目录名，不是文件引用' }
  }
  // 通配符与 `~/` 是**写法**层面的判断，先于「太短」：`*.md` 只有 4 个字符，
  // 但它是一条明确的通配引用，不能因为短就被丢成 noise。
  if (isGlob(path)) {
    return { tier: 'suspected', reason: '通配符写法，指向一组文件而不是一个具体文件' }
  }
  if (isUnexpandedHome(path)) {
    return { tier: 'suspected', reason: '~/ 未展开，无法判断实际路径' }
  }
  if (path.length < MIN_PATH_CHARS) {
    return { tier: 'noise', reason: '太短（少于 6 个字符），无法判定' }
  }
  if (!looksLikeFile(path)) {
    // 无扩展名的斜杠串分不清是目录、路径前缀还是普通词（`and/or`）——不猜。
    return { tier: 'noise', reason: '不像文件路径（没有扩展名，可能是目录或普通词）' }
  }
  if (!isAbsolutePath(path) && !isDotRooted(path)) {
    return { tier: 'suspected', reason: '缩写路径（裸相对路径没有根，无法确定指向哪个文件）' }
  }
  // 关键的一刀：存在性。不存在的路径多半是在假设或举例子，这一刀砍掉一大批误报；
  // 存在的才允许成为 confirmed。这里不碰文件系统，exists 由调用方注入。
  if (exists(path)) {
    return { tier: 'confirmed', reason: '写法明确、索引里没有读取记录，且文件存在' }
  }
  return { tier: 'suspected', reason: '写法明确且未读，但文件不存在（多半是假设或举例）' }
}

/**
 * 对账一块 checkpoint 正文里出现的路径。
 *
 * 同一路径只回一条（`./a.ts` 与 `a.ts` 这类确定等价的写法合并），并取**最严重**的一档；
 * 理由里会说明重复次数。输出顺序按各路径第一次出现的位置。
 *
 * @param blockBody - checkpoint 块的正文（纯文本，已去掉哨兵与外壳也可以）
 * @param deps.index - 「读过什么」的索引
 * @param deps.exists - 路径在磁盘上存不存在（调用方注入，模块本身不碰文件系统）
 * @returns 按档位标注的引用清单（含 noise，供侧车审计；给人看请用 {@link confirmedOnly}）
 */
export function reconcileReferences(
  blockBody: string,
  deps: { index: ReadIndexLike; exists(path: string): boolean },
): ReconciledRef[] {
  // 容错：空串/非字符串/超长都不算「一块正文」。回空而不抛——对账是旁路，
  // 不能因为喂进来的东西形状不对，把调用方的主流程带倒。
  if (typeof blockBody !== 'string' || blockBody === '' || blockBody.length > MAX_BLOCK_CHARS) {
    return []
  }

  const merged = new Map<
    string,
    { ref: ReconciledRef; baseReason: string; count: number; firstIndex: number }
  >()
  const add = (path: string, tier: RefTier, reason: string, position: number): void => {
    if (path === '') return
    const key = samePathKey(path)
    const current = merged.get(key)
    if (current === undefined) {
      merged.set(key, {
        ref: { path, tier, reason },
        baseReason: reason,
        count: 1,
        firstIndex: position,
      })
      return
    }
    current.count += 1
    current.firstIndex = Math.min(current.firstIndex, position)
    // 同一路径可能写成多种形式（`src/a.ts` / `./src/a.ts`）：取最严重的那一档，
    // 否则一条可疑会把同一条更确凿的结论压掉。
    if (TIER_SEVERITY[tier] > TIER_SEVERITY[current.ref.tier]) {
      current.ref = { path, tier, reason }
      current.baseReason = reason
    }
  }

  // URL 先整段抹掉并记成 noise；剩下的文本里才安全地扫文件候选。
  // 抹成等长的空格（而不是一个空格）：候选的下标因此仍是原文下标，输出能按出现顺序排。
  for (const match of blockBody.matchAll(URL_RE)) {
    add(trimUrl(match[0] ?? ''), 'noise', 'URL，不是本机文件路径', match.index ?? 0)
  }
  let text = blockBody.replace(URL_RE, (match) => ' '.repeat(match.length))
  for (const match of text.matchAll(BARE_URL_RE)) {
    add(trimUrl(match[0] ?? ''), 'noise', 'URL，不是本机文件路径', match.index ?? 0)
  }
  text = text.replace(BARE_URL_RE, (match) => ' '.repeat(match.length))

  for (const match of text.matchAll(CANDIDATE_RE)) {
    const raw = match[0]
    if (raw === undefined) continue
    const path = trimPath(stripEmphasis(raw))
    // 只剩标点的碎片（如加粗 URL 拆剩的 `**`）不是路径。
    if (!/[A-Za-z0-9]/.test(path)) continue
    const verdict = classify(path, deps.index, deps.exists)
    if (verdict === 'skip') continue
    add(path, verdict.tier, verdict.reason, match.index ?? 0)
  }

  return [...merged.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((entry) => ({
      path: entry.ref.path,
      tier: entry.ref.tier,
      reason: entry.count > 1
        ? entry.baseReason + '（同一路径共出现 ' + String(entry.count) + ' 次，取最严重的一档）'
        : entry.baseReason,
    }))
}

/** 只留 confirmed。给人看的清单必须走这里：suspected 与 noise 留在侧车，不上桌。 */
export function confirmedOnly(refs: readonly ReconciledRef[]): ReconciledRef[] {
  return refs.filter((ref) => ref.tier === 'confirmed')
}
