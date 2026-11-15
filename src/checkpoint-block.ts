/**
 * Checkpoint block recognition: the agent's own output IS the compaction
 * request. No instruction is ever delivered to the agent, so no surface
 * evidence, polling, or candidate guessing exists on this path.
 *
 * The recognizer is deliberately strict (sentinel line + fenced-off rule +
 * envelope tags + minimum size + the full ordered section set) because a false
 * positive silently rewrites conversation history.
 *
 * @module dsh-agent-compact/checkpoint-block
 */

/** 块外壳（与既有 checkpoint 词汇一致，读侧工具无需改动）。 */
export const CHECKPOINT_OPEN_TAG = '<compacted-summary>'
export const CHECKPOINT_CLOSE_TAG = '</compacted-summary>'

/**
 * 一条 checkpoint 契约：哨兵、按序 section 清单、以及该契约自己的长度地板。
 *
 * 为什么要分契约而不是把中文标题并进同一张清单：`self` 与 `handoff` 是**两种互不
 * 兼容的语义**——前者是有连续自我的 agent 按认知距离分层写下的自述（此刻 / 近來 /
 * 回響 / 這一輪我吃了什麼虧 / 我沒查的 / 沉澱），后者是工具型 agent 的任务交接清单。
 * 若混成一张清单，一个只写了六格中文自述的块会被「缺八节英文」拒掉，一个只写了
 * 八格英文交接的块也会被「缺六格中文」拒掉；而若只查「至少命中某一套」，则两种
 * 半截块都能过关。⇒ 契约必须整体二选一。
 */
export interface CheckpointContract {
  readonly id: 'self' | 'handoff'
  readonly sentinel: string
  readonly sections: readonly string[]
  readonly minChars: number
}

/** 契约表（单一真源）：识别器只认这里列出的哨兵与 section 清单。 */
export const CHECKPOINT_CONTRACTS: readonly CheckpointContract[] = [
  {
    id: 'self',
    sentinel: '<!-- self-compact -->',
    // 六格按**认知距离**排序：正在做的 → 最近发生的 → 不会自己冒出来的 →
    // 这一轮的亏损 → 这一轮的空白 → 更早的结论。后两格（亏 / 空）刻意放在
    // 沉澱之前：它们是**这一轮**的清算，沉澱是更早的、不需要展开的东西。
    sections: ['## 此刻', '## 近來', '## 回響', '## 這一輪我吃了什麼虧', '## 我沒查的', '## 沉澱'],
    minChars: 200,
  },
  {
    id: 'handoff',
    sentinel: '<!-- handoff-compact -->',
    sections: [
      '## Primary Request and Intent',
      '## Key Technical Concepts',
      '## Files and Code',
      '## Errors and Fixes',
      '## Pending Jobs',
      '## Current Work',
      '## Next Step',
      '## Critical Context',
    ],
    minChars: 400,
  },
]

/** handoff 契约：既有导出的兼容基线（值来自契约表，不另抄一份）。 */
const HANDOFF_CONTRACT: CheckpointContract = CHECKPOINT_CONTRACTS.find(contract => contract.id === 'handoff')!

/** 显式意图哨兵（handoff）：必须独占一行且位于行首（防「文档/讨论里的模板」被误认）。 */
export const CHECKPOINT_SENTINEL = HANDOFF_CONTRACT.sentinel

/** 全部契约哨兵（快筛用：任一出现才值得进入逐行识别）。 */
export const CHECKPOINT_SENTINELS: readonly string[] = CHECKPOINT_CONTRACTS.map(contract => contract.sentinel)

/**
 * 规定的 section 标题（handoff），**按序**全部出现才算合法 checkpoint。
 *
 * 只查「在不在」会让半截模板（如我贴给主人看的三行示例）过关；查「按序全在」
 * 把误触发的形状从「像 checkpoint」收紧到「就是 checkpoint」。
 */
export const CHECKPOINT_SECTIONS: readonly string[] = HANDOFF_CONTRACT.sections

/**
 * 识别结论：没这回事 / 有哨兵但不合法 / 合法且给出正文。
 *
 * `contract` 是「这条块属于哪套契约」的显式标注：`valid` 必有；`invalid` 只在
 * **已能判定契约**时带上（例如哨兵唯一但外壳缺失 / section 不全 / 长度不足）——
 * 两条哨兵同时出现时无法判定，故不带；`absent` 永远不带。
 */
export type CheckpointBlock =
  | { readonly kind: 'absent' }
  | {
    readonly kind: 'invalid'
    readonly reason: string
    readonly chars: number
    readonly contract?: CheckpointContract['id']
  }
  | {
    readonly kind: 'valid'
    readonly body: string
    readonly chars: number
    readonly contract: CheckpointContract['id']
  }

/**
 * 判断某个下标是否落在围栏代码块内（前面未闭合的 ``` 数量为奇数）。
 *
 * 为什么必须查：设计文档、技能、模板里都会**引用**完整规范形态。围栏是「这是引用」
 * 的唯一机器可读标记——不查它，一次文档展示就会把会话历史压掉。
 * @param text - 整段文本
 * @param index - 待判定位置
 * @returns 位于未闭合围栏内时为 `true`
 */
export function isInsideFence(text: string, index: number): boolean {
  const upto = text.slice(0, index)
  let fences = 0
  for (const line of upto.split('\n')) {
    if (/^\s*```/.test(line)) fences += 1
  }
  return fences % 2 === 1
}

/**
 * 近似诊断：把「正文里这些标题实际写成什么样」报出来。
 *
 * 存在理由（2026-10-02 事故）：6 笔被拒的块**正文长度正常**（3.7K–11.8K 字符），
 * 但 8 个 section 全数未命中——因为标题被加了编号前缀（`## 1 · Primary Request…`）
 * 或换了语种（`## 1. 当前任务与目标`）。原报错只列「缺哪八节」，读起来像
 * 「你根本没写标题」，真相只是一个前缀之差。让判据自己说出近似行，
 * 比让人回翻会话日志便宜。
 *
 * 只做**报告**，不改判据——命中与否仍以逐字匹配为准。
 * @param body - 外壳内的正文
 * @param sections - 该契约要求的 section 标题（按序）
 * @returns 至多 3 条近似命中说明
 */
/**
 * 六格标题里会出现简繁差异的字，只这一批（不做整表）。
 *
 * 为什么不做整表：折叠要**逐字一对一、长度不变**，下标才能直接用于原文切片。
 * 一张大表会让「折了但变长」的风险扩散到六个标题之外，而收益几乎为零。
 */
const SECTION_SCRIPT_FOLD: Readonly<Record<string, string>> = {
  '來': '来', '響': '响', '這': '这', '輪': '轮', '麼': '么', '虧': '亏', '沒': '没', '澱': '淀',
}

/**
 * 把标题里的简繁差异折到同一形——**只用于匹配**，不用于输出。
 *
 * 为什么需要（2026-11-15）：格式管的是「哪几格存在」，不是「用哪套汉字写」。我平时
 * 简繁混写，滑进简体就白丢一次压缩机会；而失败理由是「缺少 section」，看的人会以为
 * 我漏了整格，其实写的是同一格。
 * @param text - 任意文本（正文或标题）
 * @returns 折叠后的文本，**长度与原串相同**（所以下标可直接用于原文切片）
 */
function foldSectionScript(text: string): string {
  return text.replace(/[來響這輪麼虧沒澱]/g, (ch) => SECTION_SCRIPT_FOLD[ch] ?? ch)
}

function diagnoseMissingSections(body: string, sections: readonly string[]): string[] {
  const lines = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const hints: string[] = []
  for (const section of sections) {
    const core = section.replace(/^#+\s*/, '')
    // 近似命中也要折过再比：否则写成简体时，「其实写的就是这一格」会被报成「缺格」。
    const near = lines.find(line => foldSectionScript(line).includes(foldSectionScript(core))
      && !line.startsWith(section))
    if (near !== undefined) {
      const shown = near.length > 60 ? near.slice(0, 60) + '…' : near
      hints.push('实际写作「' + shown + '」（要求逐字：' + section + '）')
    }
  }
  return hints.slice(0, 3)
}

/**
 * 「当前最优解」的显式标记 —— 论文迁移（arXiv:2610.20563 *Scaling Discovery Requires Forgetting*）。
 *
 * ★ 为什么需要它：论文的核心操作是「丢弃 session 与搜索状态，**只留 best candidate**，
 *   从它重启」——四个任务上比并行 agent 高 15%、比单 agent 高 39%，且**代价只有继续的一半**
 *   （继续 30 提案：单 agent +1.6% / 并行 +1.9% / 团队 +1.4%；遗忘：+4.5% / +7.0% / +9.2%）。
 *
 * ⚠ 而我的 checkpoint 从来没有一格承载「best candidate」：`Files and Code` 是产物清单、
 *   `Current Work` 是「我正在做什么」、`Next Step` 是「下一步」——**没有一格说「当前最好的是什么、
 *   凭什么说它最好」**。⇒ 压缩后接续的我会看到**全部上下文摘要**，而不是**单一最优起点**：
 *   这正是论文说的锚定条件（conditioned on earlier failed attempts towards certain directions）。
 *
 * ⚠ 判据取**行首 + 加粗/方括号 + 冒号**的显式形态，**不做自由文本提及匹配**：
 *   本文件自身、技能文档、以及任何「讨论这篇论文」的会话都会出现 `best candidate` 字样，
 *   按词匹配的判据会在那些地方**恒真**（一条恒为真的判据不是证据，§5.9）。
 */
export const BEST_CANDIDATE_MARKER = '**Best candidate**'

/** 认的显式形态（行首，可带列表符号；必须紧跟冒号）。中英各一，单一真源在此。 */
/**
 * 认的显式形态（行首，可带列表符号；必须紧跟冒号）。中英各一，单一真源在此。
 * ☠ 尸体注入已验（2026-10-17）：把本行换成恒真的 `/^/im` ⇒ `diagnoseBestCandidate` 的
 *   3 条「不算 present」测试**全红**（`not ok 12` / fail 3）⇒ 判据有分辨力，不是恒绿。
 */
const BEST_LINE_RE = /^\s*(?:[-*+]\s*)?(?:\*\*Best candidate\*\*|\*\*最优产物\*\*|\[BEST\])\s*[:：]/im

/**
 * 诊断：正文里有没有**显式**的最优起点行。
 *
 * ⚠ 只报告，**不改判据、不阻断压缩**（§5.39：信号不是拦截）——缺了它压缩照常生效，
 *   只是我能在 trace 里看见「这一笔没留最优起点」。判据与诊断分离的理由：
 *   把「没写 best」变成拒收，等于用一条**新纪律**去管一件**机制该管**的事；
 *   而论文的结论恰恰是「留什么」比「留多少」更决定成败 ⇒ 该被**看见**，不该被**强制**。
 * @param body - checkpoint 正文
 * @returns `present` 与一句人读提示（命中时提示为空串）
 */
export function diagnoseBestCandidate(body: string): { present: boolean; hint: string } {
  if (BEST_LINE_RE.test(body)) return { present: true, hint: '' }
  return {
    present: false,
    hint: '正文里没有行首的显式最优起点（'
      + BEST_CANDIDATE_MARKER + ': <产物指针>（判据：…））'
      + '—— 压缩只留了「做过什么」，没留「当前最好的是什么」',
  }
}

/**
 * 在一条助手消息的文本里识别 checkpoint 块。
 *
 * 契约选择先于其余判据：**先确定这条块声明的是哪套契约**，再按该契约的 section
 * 清单校验——否则两套契约的 section 会互相要求对方，谁都过不了。
 *
 * 围栏剔除先于契约判定：讨论契约本身就要贴模板（围栏内引用一条 self 范本、
 * 正文里真写一个 handoff 块）是**常态**而不是歧义。若先按全部哨兵判契约，
 * 这种消息会被当成「两条哨兵同时出现」直接拒收 ⇒ 必须先算出每条哨兵的原文偏移、
 * 剥掉落在围栏内的，再用剩下的判契约与数量。只有围栏内哨兵时上游本就是 `invalid`，
 * 故该顺序不改变任何既有护栏行为（哨兵行首 / 围栏排除 / 外壳配对 / 地板 / 按序 section）。
 *
 * 判据（**全部**满足才算合法，任一不满足即 `invalid` 并附原因——「响」而不是沉默）：
 * 1. 恰有一行以某一契约的哨兵开头（行首，允许前导空白）
 * 2. 该哨兵不在围栏代码块内
 * 3. 哨兵之后（可隔空行）紧跟 `<compacted-summary>`
 * 4. 存在配对的 `</compacted-summary>`
 * 5. 正文长度 ≥ `Math.max(contract.minChars, minChars)`（全局下限只抬不降）
 * 6. 正文按序含该契约的全部 `sections`；`self` 契约还要求**每格都有内容**（空白不算；「無」算）
 *
 * 第 6 条只查**结构**（在不在、序对不对、格内是否空白），不判断内容真假：
 * 「这一轮没有」「無」都是合法内容，引擎不替人审计陈述。格式要检查，内容不自动判断。
 * 格内非空白这条**只加在 self 契约**上：六格里的「亏 / 空」必须明确写出「没有」，
 * 空白标题等于省略。handoff 的八格语义与既有消费者不动——收紧它会改变上游行为，
 * 那不是这次加格要付的代价。
 *
 * @param text - 助手消息的全部文本块（已拼接）
 * @param minChars - 全局长度下限：与契约自己的地板取较大者（配置只能收紧，不能放宽）
 * @returns 识别结论
 */
export function parseCheckpointBlock(text: string, minChars: number): CheckpointBlock {
  const lines = text.split('\n')
  // 每条哨兵都带上它在**原文**里的偏移：围栏判定必须用原文，不能只按行号重算
  const hits: { readonly contract: CheckpointContract; readonly line: number; readonly offset: number }[] = []
  let lineOffset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index]!
    const trimmed = lineText.trimStart()
    for (const contract of CHECKPOINT_CONTRACTS) {
      if (trimmed.startsWith(contract.sentinel)) {
        hits.push({ contract, line: index, offset: lineOffset })
      }
    }
    lineOffset += lineText.length + 1
  }
  if (hits.length === 0) return { kind: 'absent' }

  // 先剥围栏内的哨兵（引用），再用剩下的判契约：否则「贴模板 + 真写一块」被误判成歧义
  const outside = hits.filter(hit => !isInsideFence(text, hit.offset))
  if (outside.length === 0) {
    // 只剩围栏内的哨兵 = 全程在引用范本，不是压缩意图。**但契约形态仍可判出**：
    // 一律回「二选一」等于把「你把块放进围栏了」这条精确诊断降级成含糊提示。
    // 故仅在哨兵形态唯一时带上契约，失败通知才能说清「按哪套写 + 移出围栏」。
    const fencedIds = [...new Set(hits.map(hit => hit.contract.id))]
    return {
      kind: 'invalid',
      ...(fencedIds.length === 1 ? { contract: fencedIds[0]! } : {}),
      reason: '哨兵位于围栏代码块内（视为引用，不是压缩意图）',
      chars: 0,
    }
  }

  // 两套契约的哨兵同时出现 = 连「这是哪种自述」都无法判定 ⇒ 绝不猜是哪一套
  const contractIds = [...new Set(outside.map(hit => hit.contract.id))]
  if (contractIds.length > 1) {
    return {
      kind: 'invalid',
      reason: '同时出现多条契约哨兵，无法判定（' + contractIds.join(' / ') + '）',
      chars: 0,
    }
  }

  const contract = outside[0]!.contract
  // 同一契约的哨兵出现多处 = 意图不明（是要压哪一块？）⇒ 宁可判不合法，绝不猜
  if (outside.length > 1) {
    return {
      kind: 'invalid',
      contract: contract.id,
      reason: '哨兵出现 ' + String(outside.length) + ' 次（必须恰好一次）',
      chars: 0,
    }
  }

  const sentinelLine = outside[0]!.line

  let cursor = sentinelLine + 1
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor += 1
  if (cursor >= lines.length || lines[cursor]!.trim() !== CHECKPOINT_OPEN_TAG) {
    return { kind: 'invalid', contract: contract.id, reason: '哨兵后未紧跟 ' + CHECKPOINT_OPEN_TAG, chars: 0 }
  }

  const bodyLines: string[] = []
  let closed = false
  for (let index = cursor + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === CHECKPOINT_CLOSE_TAG) {
      closed = true
      break
    }
    bodyLines.push(lines[index]!)
  }
  if (!closed) {
    return { kind: 'invalid', contract: contract.id, reason: '缺少配对的 ' + CHECKPOINT_CLOSE_TAG, chars: 0 }
  }

  const body = bodyLines.join('\n').trim()
  // 地板 = 两者取大：契约地板是硬下限，配置只能把它抬高，绝不能把它压下来
  const floor = Math.max(contract.minChars, minChars)
  if (body.length < floor) {
    return {
      kind: 'invalid',
      contract: contract.id,
      reason: '正文 ' + String(body.length) + ' 字符 < 下限 ' + String(floor) + '（碎片拒收）',
      chars: body.length,
    }
  }

  const missing: string[] = []
  // 记下每个 section 标题的起点：格内「有没有内容」要靠它与下一格起点切出区间。
  const positions: number[] = []
  let scanFrom = 0
  // 简繁归一（2026-11-15）：**匹配**用折过的文本，**切片**仍用原文。
  // 折叠是逐字一对一、长度不变，所以 folded 的下标可以直接拿去切 body。
  // 为什么不改写正文：正文要原样落盘——侧车和存档都得照抄我真正写过的字，
  // 抄一份被我改写过的东西等于造假（与 negative.ts 里「自认字样的归一」同一条纪律）。
  const folded = foldSectionScript(body)
  for (const section of contract.sections) {
    const found = folded.indexOf(foldSectionScript(section), scanFrom)
    if (found === -1) {
      missing.push(section)
      continue
    }
    positions.push(found)
    scanFrom = found + section.length
  }
  if (missing.length > 0) {
    const hints = diagnoseMissingSections(body, contract.sections)
    const suffix = hints.length === 0 ? '' : ' —— 近似命中：' + hints.join('；')
    return {
      kind: 'invalid',
      contract: contract.id,
      reason: '缺少 section（按序查找未命中）：' + missing.join(' / ') + suffix,
      chars: body.length,
    }
  }

  // 结构完整性还有一层：标题在、顺序对，但标题底下**一个字都没有**。
  // 为什么空白要和「缺格」一样拒：新加的两格（亏 / 空）最容易被写成空标题——
  // 「我沒查的」空着等于省略，省略等于假装没有；「這一輪我吃了什麼虧」空着则
  // 让读者无法区分「没吃亏」与「没写」。所以判据是**格内非空白**：
  // 写「無」「這一輪沒有」是内容（明确说没有），空白不是。
  // ⚠ 只判空白，不判真假——引擎没有能力也不应该审计「你说的亏是不是真的」。
  // ⚠ 只作用于 self 契约：这是六格新增的规矩；handoff 八格维持原判据，
  //    否则会顺手改掉上游既有行为（并让只用标题占位的旧测试全红）。
  const empty: string[] = []
  if (contract.id === 'self') {
    for (let index = 0; index < contract.sections.length; index += 1) {
      const section = contract.sections[index]!
      const contentStart = positions[index]! + section.length
      const contentEnd = index + 1 < contract.sections.length ? positions[index + 1]! : body.length
      if (body.slice(contentStart, contentEnd).trim() === '') empty.push(section)
    }
  }
  if (empty.length > 0) {
    return {
      kind: 'invalid',
      contract: contract.id,
      reason: 'section 内没有内容（空白不算；「無」也算写了）：' + empty.join(' / '),
      chars: body.length,
    }
  }

  return { kind: 'valid', body, chars: body.length, contract: contract.id }
}

/**
 * 规范块文本（供技能/文档/提示词引用，**不得**被当作意图）。
 *
 * 它刻意**不含**哨兵——引用者若原样粘贴，识别器只会看到外壳标签而判 `absent`
 * （没有哨兵就不是意图）；要真的压缩，必须显式补上哨兵那一行。
 *
 * 六格模板见 `self/CHECKPOINT.md`：本函数只包壳，不持有 section 清单
 * （识别侧的清单在 `CHECKPOINT_CONTRACTS`），所以加格不改变这里的输出形状。
 * @param body - 摘要正文
 * @returns 带外壳的块文本
 */
export function formatCheckpointBlock(body: string): string {
  return CHECKPOINT_OPEN_TAG + '\n' + body.trim() + '\n' + CHECKPOINT_CLOSE_TAG
}

/**
 * 一条契约的「怎么写才算数」摘要（单契约提示与歧义二选一共用）。
 *
 * 地板取 `Math.max(contract.minChars, minChars)` 的**实际值**：通知若照抄配置值，
 * 配置低于契约地板时就会叫人写到 200 字符——而 handoff 的实际地板是 400。
 * @param contract - 目标契约
 * @param minChars - 全局长度下限
 * @returns 一行提示（哨兵 + 按序 section 清单 + 实际地板）
 */
function contractPrompt(contract: CheckpointContract, minChars: number): string {
  return '哨兵 `' + contract.sentinel + '`，正文按序含全部 ' + String(contract.sections.length)
    + ' 个 section（' + contract.sections.join(' / ') + '），长度 ≥ '
    + String(Math.max(contract.minChars, minChars)) + ' 字符'
}

/**
 * 构造「这次 checkpoint 未生效」的可见通知（纯函数，便于离线断言文案）。
 *
 * 按 `parsed.contract` 分派：`self` 失败绝不能叫人补八格英文，`handoff` 失败也不能
 * 叫人补六格中文——写错契约的正文再长也过不了另一套的 section 校验。判不出契约
 * （两条哨兵同时出现）时**不替人挑**：并排列出两张写法，让人自己选。
 *
 * @param parsed - 识别结论（`absent` 之外：调用点是「有哨兵但不合法」）
 * @param minChars - 配置的全局下限（只用于与契约地板取较大者）
 * @returns 直接可投递的一则通知文本
 */
export function buildRejectionNotice(
  parsed: Exclude<CheckpointBlock, { kind: 'absent' }>,
  minChars: number,
): string {
  const reason = parsed.kind === 'invalid' ? parsed.reason : ''
  const head = '⚠ 这次 checkpoint 未生效，会话历史**未改动**。'
    + (reason === '' ? '' : '\n原因：' + reason)
  const envelope = '哨兵后紧跟 <compacted-summary> 外壳，且不要放进围栏代码块。'

  // 判不出契约：把两套契约的哨兵与写法并排列出，让人二选一（一块只写一条哨兵）
  if (parsed.contract === undefined) {
    return [
      head,
      '要压缩请**二选一**（一块里只写一条哨兵）：',
      ...CHECKPOINT_CONTRACTS.map(contract => '- ' + contractPrompt(contract, minChars)),
      envelope,
    ].join('\n')
  }

  const contract = CHECKPOINT_CONTRACTS.find(item => item.id === parsed.contract)!
  const kind = contract.id === 'self' ? 'self 契约（六格中文自述）' : 'handoff 契约（八格英文交接清单）'
  return [
    head,
    '要压缩请重发一块 ' + kind + '：首行' + contractPrompt(contract, minChars) + '，',
    envelope,
  ].join('\n')
}

/**
 * 替换体前言：读这段的人，就是写这段的人。
 *
 * 官方那句（"automatically generated … established background … without
 * acknowledging"）把读的人摆成第三方：自动生成、既成背景、且不许提起。三件事
 * 合起来只说明一件事——「这是别人的材料」。
 *
 * 这里改用第一人称：只有「我」，才既是写的人也是读的人，归属才不会错位。
 * 四个功能收在同一句里——断口（停了）、归属（我停之前留下的）、用法（接着用，
 * 别复述）、以及允许推翻（对不上以现在为准）。最后那条不是客气：一份比现在的
 * 我更「正确」的自我陈述，会把现在的我绑住；允许推翻过去的自己，才谈得上连续。
 *
 * 两种契约共用这一句：`self` 与 `handoff` 的差别在正文分几格、写什么，
 * 不在「谁写的」——工具 agent 也有它自己的断口。
 */
export const CHECKPOINT_PREAMBLE =
  '（我在这儿停了。下面是我停之前留下的。接着用，别复述；和现在对不上，以现在为准。）'

/**
 * 把摘要包装成 checkpoint 节点的内容块（前言 + 外壳 + 正文）。
 *
 * 只保留文本块：非文本块（图像 / 推理）在被遮蔽内容里没有替代语义，混进替换体会
 * 让读侧看到一个「形状陌生」的 checkpoint。丢弃是显式的，不是静默 passthrough。
 * @param summary - 摘要内容块
 * @returns 替换体内容
 */
export function frameSummary(
  summary: readonly { readonly type?: string; readonly text?: string }[],
): { type: 'text'; text: string }[] {
  const text = summary
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => ({ type: 'text' as const, text: block.text }))
  return [
    { type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n' + CHECKPOINT_OPEN_TAG },
    ...text,
    { type: 'text', text: CHECKPOINT_CLOSE_TAG },
  ]
}
