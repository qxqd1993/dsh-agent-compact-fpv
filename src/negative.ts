/**
 * 找出「没有证据的否定判断」。
 *
 * 2026-11-15 的事故原句是这条判据的来源：「`notes\todo.md` …没有当天尾巴，我没动过，
 * 也没往里加东西」。那个会话从头到尾只用 `Get-ChildItem` 看过 mtime 与文件名——**列举
 * 不是内容**。本模块不管句子真假（那需要另一套证据），只问一件事：说这句话之前，
 * 这个路径的内容在会话里被读过没有？没有的话就把它交出来，让侧车去提醒。
 *
 * 纯函数：切句、认否定词、抽路径、查索引。不碰文件系统、不碰时间。
 *
 * @module dsh-agent-compact/negative
 */

import type { ReadIndex } from './read-index.ts'

export interface NegativeClaim {
  /** 原始句子（给侧车照抄，方便下一个我一眼看懂） */
  readonly sentence: string
  /** 被否定、但没读过的路径 */
  readonly path: string
}

/**
 * 否定词固定表。
 *
 * 写死而不是可配置：这是一条保守判据，漏报可接受（顶多少提醒一句），放宽则整个检测器
 * 失去意义。要加词必须同时改测试——否则日后「顺手补一个」就会悄悄放大误报率。
 *
 * 表里只写任务给的繁体原词。简体写法不逐词另列，而是由 {@link foldScript} 在比对时
 * 归一——否则每加一个词就要记得再补一条简繁变体，漏一次就是一次误报。
 */
const NEGATION_MARKERS: readonly string[] = [
  '沒變',
  '沒有',
  '沒動',
  '沒掛',
  '不存在',
  '未改',
  '未變',
  '都沒',
  'unchanged',
  'no change',
  'missing',
  'absent',
]

/**
 * 自认字样：句子自己已经承认「没查／没打开／只看了 mtime」。
 *
 * 出现了就整句放行——自认不是掩盖，反而是下一个我需要的线索。这条比否定词表更不该
 * 靠语感扩充：字样越具体，越不会误放真正的无根据否定。
 *
 * 简繁差异同样交给 {@link foldScript}；这里单列的 `我沒有查` / `未經驗證` 不是简繁
 * 变体，而是中间多一个「有」/「經」的同义写法——归一表跨不过插入的字，只能作为两种
 * 自然说法分别列出。语义仍是同一条：说话人自己承认没查、没验证。
 */
const SELF_ADMISSION_MARKERS: readonly string[] = [
  '我沒查',
  '我沒有查',
  '未驗證',
  '未經驗證',
  '沒有讀',
  '僅憑 mtime',
  '沒有打開',
  'did not read',
  'unverified',
]

/**
 * 简繁归一表：**只用于比对**，绝不改写要回报的原文。
 *
 * 只收两张词表里真正会撞到的字，不引入整张简繁大表——多收一个字，就多一份把形近但
 * 无关的文本吞进判据的风险。除了任务点名的 沒/裡/裏/讀/開/驗/僅/憑，还必须有
 * 變/動/掛（否定词表里就有，少了它 `没变`/`没动`/`没挂` 全部漏掉）、證/經（`验证`
 * 那一组）。`裡`/`裏` 目前没有词表条目直接用到，但事故原句里有「往裏加東西」，留着
 * 是为了同一类句子的稳定性。
 */
const SCRIPT_FOLD: ReadonlyMap<string, string> = new Map([
  ['沒', '没'],
  ['裡', '里'],
  ['裏', '里'],
  ['讀', '读'],
  ['開', '开'],
  ['驗', '验'],
  ['僅', '仅'],
  ['憑', '凭'],
  ['變', '变'],
  ['動', '动'],
  ['掛', '挂'],
  ['證', '证'],
  ['經', '经'],
])

/** 逐字做简繁归一；表外的字原样保留。 */
function foldScript(text: string): string {
  let out = ''
  for (const char of text) {
    out += SCRIPT_FOLD.get(char) ?? char
  }
  return out
}

/** 切句只认这几个：句号、问号、叹号、换行。 */
const SENTENCE_DELIMITER = /[。！？\n]/

/** 反引号片段：助手文本里最明确的「这是路径」标记。 */
const BACKTICK_SPAN = /`([^`\n]+)`/g

/**
 * 裸 token 里的路径形状。
 *
 * 只认「含分隔符且以扩展名结尾」的片段：单独一个 `todo.md` 在散文里太容易是别的东西，
 * 而 `notes\todo.md` 这种形状几乎只会是路径。字符集合刻意不含空白与 CJK，让正则在
 * 「`notes\todo.md` 最后」或「notes\todo.md，没有」这类紧贴中文的句子里停在路径尾端。
 */
const BARE_PATH = /(?:[A-Za-z]:)?[A-Za-z0-9_.~%+@-]*(?:[\\/][A-Za-z0-9_.~%+@-]+)+\.[A-Za-z0-9]{1,8}/g

/**
 * `http(s)` URL 先整段剃掉，免得其中一段（`github.com/a/b.md`）被当成路径。
 * 尾端的标点不吞进来，切句与后续处理才不会被连坐。
 */
const HTTP_URL = /https?:\/\/[^\s，。！？、；：（）【】「」『』“”‘’,;!?()<>"']+/gi

/** 只按句号/问号/叹号/换行切，**不按逗号切**。 */
function sentencesOf(text: string): readonly string[] {
  // 为什么不按逗号：事故原句把路径与否定用逗号连在同一句（「`notes\todo.md` …
  // 没有当天尾巴」），按逗号切会变成「一半只有路径、一半只有否定」，两半都不成立，
  // 真正的命中就漏掉了。
  return text
    .split(SENTENCE_DELIMITER)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
}

/**
 * 标记比对用：简繁归一 + 大小写不敏感 + 空白折叠。
 *
 * 这一层只服务于比较；`sentence` 始终是输入原文的切片，不会被这里改写（侧车要照抄
 * 原句，改写过就成造假）。
 */
function normalizeForMarkers(text: string): string {
  return foldScript(text.toLowerCase().replace(/\s+/g, ' '))
}

/** 两条词表走同一条归一后的比对路径（haystack 与 needle 都归一）。 */
function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystack.includes(normalizeForMarkers(needle))) return true
  }
  return false
}

/** 抽出所有反引号片段的内容（不含反引号本身）。 */
function backtickPathsIn(text: string): readonly string[] {
  const out: string[] = []
  for (const match of text.matchAll(BACKTICK_SPAN)) {
    const span = match[1]
    if (span === undefined) continue
    out.push(span.trim())
  }
  return out
}

/** 抽出裸文本里的路径 token。 */
function barePathsIn(text: string): readonly string[] {
  const out: string[] = []
  for (const match of text.matchAll(BARE_PATH)) {
    const whole = match[0]
    if (whole === undefined) continue
    // `https://` 的那对斜线不是 UNC 开头：前一格是冒号就跳过（URL 主体上面已剃过，
    // 这里是给残留形状的保险）。
    const previous = match.index > 0 ? text[match.index - 1] : ''
    if (previous === ':') continue
    out.push(whole)
  }
  return out
}

/** 取最后一段（文件名）；分隔符可能是 `/` 或 `\`。 */
function baseNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * 扩展名判定。
 *
 * 这是「目录名（无扩展名）」那条排除的执行方式：`notes`、`src/components` 这类没有
 * 扩展名的东西一律不当路径——它们可能是目录，而目录名不是内容。代价是 `Makefile`、
 * `.gitignore` 这种没有「像样扩展名」的文件会漏掉；漏报比误报便宜。
 */
function hasFileExtension(path: string): boolean {
  const base = baseNameOf(path)
  if (base === '' || base === '.' || base === '..') return false
  return /\.[A-Za-z0-9]{1,8}$/.test(base)
}

/** 版本号（`1.2.3`、`v1.2`）不是路径：反引号里的版本号不该被当成文件名。 */
function looksLikeVersion(path: string): boolean {
  return /^v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?$/.test(baseNameOf(path))
}

/**
 * 单段候选（没有分隔符）的域名后缀。
 *
 * 这一小张表只解决一个歧义：反引号里的 `a.md` 是文件、`github.com` 是域名，两者形状
 * 一样。带分隔符的 `host.tld/path` 不需要这张表——那种形状由下面直接判断。刻意不放
 * `.sh`、`.py`、`.pl` 这些同时是扩展名的后缀，免得把 `deploy.sh` 这类文件误杀。
 */
const DOMAIN_SUFFIXES = /\.(?:com|org|net|edu|gov|mil|int|io|dev|ai|app|co|me|info|biz|xyz|cn|tw|hk|jp|kr|uk|de|fr|ru|br|au|ca|us|nl|se|no|fi|dk|cz|gr|pt|il|ae|sg|my|id|th|vn|ph|tr|mx|ar|cl|za|nz)$/i

/**
 * `github.com/foo/bar.md` 这种裸域名不是本地路径；磁盘代号开头则不算域名。
 * 单段候选只有落在 {@link DOMAIN_SUFFIXES} 才算域名（`a.md` 必须活着）。
 */
function isDomainLike(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return false
  const match = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?:[\\/]|$)/.exec(path)
  if (match === null) return false
  const host = match[1]!
  // 主机后面还有路径：`host.tld/...` 是 URL 的常见形状。
  if (host.length !== path.length) return true
  // 只有一段：靠后缀表判断，避免把 `notes.md` 误杀成域名。
  return DOMAIN_SUFFIXES.test(host)
}

/**
 * 路径候选的排除清单。
 *
 * 只认明确路径：通配符、URL、`~/`（未展开）、尾端带分隔符的目录、无扩展名的目录名，
 * 以及版本号，一律不算。这里每多放行一种形状，误报就多一个来源。
 */
function isPathCandidate(raw: string): boolean {
  const path = raw.trim()
  if (path === '') return false
  // 通配符不是具体路径：`src/*.ts` 没法回答「是哪一个文件」。
  if (/[*?]/.test(path)) return false
  // `~/x` 没有展开，和工具实际拿到的绝对路径对不上，放进来只会制造假命中。
  if (path === '~' || /^~[\\/]/.test(path)) return false
  // URL（`file:` 除外：它是路径的 URL 写法，read-index 会剥掉 scheme 后比对）。
  if (/^(?!file:)[A-Za-z][A-Za-z0-9+.-]*:\/\//i.test(path)) return false
  if (/^www\./i.test(path)) return false
  if (isDomainLike(path)) return false
  // 尾端分隔符表示目录；目录名不是内容。
  if (/[\\/]$/.test(path)) return false
  if (looksLikeVersion(path)) return false
  if (!hasFileExtension(path)) return false
  // 裸 token 的另一半条件：必须含分隔符；反引号片段不受此限（`todo.md` 也算明确）。
  return true
}

/** 去重用键：同一路径的大小写、分隔符、尾端斜线差异不该算两条。 */
function dedupeKey(path: string): string {
  return path.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 找出「没有证据的否定判断」。
 *
 * 对每个句子：先找否定词（没有就整句跳过），再看有没有自认字样（有就放行），最后抽出
 * 明确路径逐个问索引。索引说读过就放行；没读过就回报。同一路径在同一段文本里只回报
 * 一次——同一件事提醒两次只会让侧车变吵。
 * @param text - 要检查的文本（助手消息拼接后的字符串）
 * @param index - 本会话的已读索引
 * @returns 命中列表；没有命中就是空数组
 */
export function findUnbackedNegatives(text: string, index: ReadIndex): NegativeClaim[] {
  const claims: NegativeClaim[] = []
  if (typeof text !== 'string' || text === '') return claims

  const reported = new Set<string>()
  for (const sentence of sentencesOf(text)) {
    const markerText = normalizeForMarkers(sentence)
    if (!containsAny(markerText, NEGATION_MARKERS)) continue
    // 句子自己已经承认没查：这不是「假装有证据」，不需要再提醒。
    if (containsAny(markerText, SELF_ADMISSION_MARKERS)) continue

    // 反引号片段先抽，再去掉反引号内容找裸 token，避免同一路径被抽两次。
    const withoutBackticks = sentence.replace(BACKTICK_SPAN, ' ')
    const candidates = [
      ...backtickPathsIn(sentence),
      ...barePathsIn(withoutBackticks.replace(HTTP_URL, ' ')),
    ]

    const seenInSentence = new Set<string>()
    for (const raw of candidates) {
      if (!isPathCandidate(raw)) continue
      const path = raw.trim()
      const key = dedupeKey(path)
      if (key === '' || seenInSentence.has(key) || reported.has(key)) continue
      seenInSentence.add(key)
      // 读过内容 ⇒ 这句否定有依据（真假另外判断，本模块不管）。
      if (index.hasReadContent(path)) continue
      reported.add(key)
      claims.push({ sentence, path })
    }
  }
  return claims
}
