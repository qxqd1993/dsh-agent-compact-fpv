/**
 * 宿主原语的**运行时副本**——因为这些包封在 `app.asar` 里，外部插件 import 不到。
 *
 * 来源与核对义务
 * ---------------
 * 下面每一项都是从 **DSH 0.2.2-rc.3** 的 `app.asar` 里读出来抄的（本机实测的宿主版本：
 * `app.asar/dsh/package.json` 的 `version` = `0.2.2-rc.3`；任务书写的 rc.1 与现场不符，
 * 见交付报告）。**升级 DSH 时必须回来逐项核对——它们可能已经变了。** 判据很简单：
 * 宿主读的是它**自己那份**，本文件这一份一旦漂移，本插件就会按旧契约写事件。
 *
 * 每一项的原文件（ASAR 内部路径，即 `app.asar/dsh/` 之下）：
 *
 *  - `toolPairingBalancedBefore` / `toolPairingBalancedAfter`
 *      `node_modules/@deepseek-ai/dsh-compaction/lib/types/tool-pairing.js`（4473 B）
 *      来源：抄（逐行）。这是**真逻辑**——工具调用 / 结果在表层上的配对平衡折叠，
 *      没有等价「纯结构」写法（区间切在工具调用中间会让会话不可重放）。
 *  - `errorChain`
 *      `node_modules/@deepseek-ai/dsh-llm/lib/types/error.js`（10016 B，函数在 145-188 行）
 *      来源：抄（逐行）。诊断渲染：cause 链 + AggregateError 成员，循环引用标记、
 *      恶意 getter 兜底。只用于把失败原因写进 `compaction/end.error` 与失败通知。
 *  - `createUserMessage`（含私有的 `deepFreeze`）
 *      `node_modules/@deepseek-ai/dsh-llm/lib/types/message.js`（3713 B）
 *      `node_modules/@deepseek-ai/dsh-util-values/lib/index.js`（`deepFreeze`，809-845 行）
 *      来源：等价重写。宿主是两层：
 *        `createMessage(input) = deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`
 *        `createUserMessage(input) = createMessage({...input, role:'user'})`
 *      其中 `brandString` 在运行期是**恒等函数**（`dsh-brand/lib/index.js`：`return value`），
 *      `randomUUID` 只是 `@deepseek-ai/dsh-util-crypto` 的 UUID 来源。故这边等价于
 *      「`structuredClone` 一份 + 打上 `role:'user'` + 用 `node:crypto` 的 `randomUUID()`
 *      造 `id` + 深冻结」。**不能省掉 `id`**：宿主 `assertMessageEventShape` 会以
 *      「lacks an identified message」拒收无 `id` 的 user 消息。
 *  - `CompactionId`
 *      `node_modules/@deepseek-ai/dsh-compaction/lib/types/brand.js`（258 B）
 *      来源：自写（恒等函数）。品牌是**纯类型层**的（`type CompactionId = Branded<'CompactionId'>`），
 *      运行时 `CompactionId(id) === id`。这里保留同名函数，让调用点读起来与宿主一致。
 *  - `compactCheckpointSource` / `isCompactCheckpointSource`
 *      `node_modules/@deepseek-ai/dsh-compaction/lib/types/checkpoint.js`（1532 B）
 *      来源：自写（纯结构）。**读侧判据只有 `source.kind === 'compact-checkpoint'`**
 *      （宿主 `isCompactCheckpointSource` 全文就是这个比较），不需要同一个类实例，
 *      故「冻结的纯对象」即为等价物。
 *  - `ManualCompactionError`
 *      `node_modules/@deepseek-ai/dsh-compaction/lib/index.js`（`class ManualCompactionError`）
 *      来源：同形状重写（`name` + `code` + `cause`）。注意一个**已知代价**：宿主的
 *      `dsh-command-compact` 用 `error instanceof ManualCompactionError` 判它**自己那份**类，
 *      本插件抛的这份不会被认出来——`/compact` 手动路径已决定不用，故接受（错误文本照旧可读）。
 *
 * @module dsh-agent-compact/vendor
 */

import { randomUUID } from 'node:crypto'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {
  CompactionCheckpointSource,
  CompactionId as CompactionIdType,
  ManualCompactionErrorCode,
} from '@deepseek-ai/dsh-compaction'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

// ─────────────────────────────────────────────────────────────────────────────
// CompactionId：品牌恒等函数（宿主 brand.js 全部内容就是 `return id`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一个裸字符串标成宿主的 `CompactionId`。
 *
 * 为什么不用宿主的 `CompactionId` 值导出：它在 `app.asar` 里，插件运行期解析不到；
 * 而它**运行时什么都不做**，所以这里的恒等函数在语义上逐字节等价。
 * @param id - 不透明的压缩事务标识。
 * @returns 同一个字符串（仅类型层加了品牌）。
 */
export function CompactionId(id: string): CompactionIdType {
  return id as CompactionIdType
}

// ─────────────────────────────────────────────────────────────────────────────
// compactCheckpointSource：checkpoint 消息的来源标记（纯结构）
// ─────────────────────────────────────────────────────────────────────────────

/** checkpoint 来源的判别标记（与宿主同一个字面量）。 */
const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'compact-checkpoint' } as const)

/**
 * 造一条与某次压缩事务关联的 checkpoint 来源。
 *
 * 读侧（宿主 `isCompactCheckpointSource`）只判 `kind`，故冻结的纯对象即是等价物——
 * 不需要与宿主共享类或原型。
 * @param compactionId - 所属压缩事务的标识。
 * @param sourceCommandId - 发起本次压缩的手动命令（有则带）。
 * @returns 冻结的来源对象（结构同宿主 `CompactionCheckpointSource`）。
 */
export function compactCheckpointSource(
  compactionId: CompactionIdType,
  sourceCommandId?: CommandId,
): CompactionCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_MARKER,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

/**
 * 判一条持久化的消息来源是不是压缩 checkpoint（宿主谓词的同款实现）。
 *
 * 本插件目前只在写入侧使用来源构造器；这个谓词留给侧车/工具侧的只读判断，
 * 判据与宿主完全一致：只看 `kind`。
 * @param source - 从 user 消息恢复出来的来源。
 * @returns 是否带 checkpoint 标记。
 */
export function isCompactCheckpointSource(
  source: MessageSource,
): source is CompactionCheckpointSource {
  return source.kind === 'compact-checkpoint'
}

// ─────────────────────────────────────────────────────────────────────────────
// ManualCompactionError：同形状的错误分类（宿主 dsh-compaction/lib/index.js）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 预期内的压缩失败（供调用方分类）。
 *
 * 形状与宿主逐字段一致：`name` 固定、`code` 是那六个闭区间取值、`cause` 走
 * `ErrorOptions`。宿主内部（`compaction-basic` / `region`）用 `code` 区分
 * busy / changed / summary / commit / persistence，本插件的 `region.ts` 同样这么用。
 */
export class ManualCompactionError extends Error {
  override readonly name = 'ManualCompactionError'

  /**
   * @param code - 稳定的失败分类（`busy` 也可能来自共享的锁检查，不限手动路径）。
   * @param message - 保留为 Error 的后端诊断文本。
   * @param options - 原始失败（cause）。
   */
  constructor(
    readonly code: ManualCompactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// deepFreeze + createUserMessage（宿主 dsh-llm/lib/types/message.js）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 原地深冻结一个对象图，但**不冻结 AbortSignal**（宿主 `dsh-util-values` 同款）。
 *
 * 为什么照抄这个细节：消息里可能挂着 `signal`，冻结它会让整个取消机制失效；
 * 宿主显式跳过 `AbortSignal`，这里保持一致。
 * @param value - 要冻结的值。
 * @returns 同一个值（其可达子对象已被冻结）。
 */
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  type Task =
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  const pending: Task[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      /* v8 ignore next -- 循环上界由捕获的键数决定。 */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

/** 新建 user 消息的入参（= 宿主 `Omit<UserMessage, 'id' | 'role'>`）。 */
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>

/**
 * 造一条带身份的 user 消息并深冻结（宿主 `createUserMessage` 的等价物）。
 *
 * 等价性依据（逐项）：
 *  ① `role: 'user'`——宿主 `createUserMessage` 只做 `createMessage({...input, role:'user'})`；
 *  ② `id`——宿主 `createMessage` 用 `brandString(randomUUID())`，而 `brandString` 运行期恒等，
 *     故这里直接用 `node:crypto` 的 `randomUUID()`（宿主 `dsh-util-crypto` 也是这个来源）；
 *  ③ `structuredClone`——宿主先克隆，保证消息与调用方对象图不共享可变子节点；
 *  ④ `deepFreeze`——宿主克隆后立即深冻结，读侧（`adoptSessionEvent`）也按冻结语义处理。
 * @param input - 完整的 content 与 source（不接受自带 `id`/`role`）。
 * @returns 冻结的、带新身份的用户消息。
 */
export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  const message = deepFreeze(structuredClone({
    ...input,
    role: 'user' as const,
    id: randomUUID(),
  }))
  return message as T & Pick<UserMessage, 'id' | 'role'>
}

// ─────────────────────────────────────────────────────────────────────────────
// errorChain（宿主 dsh-llm/lib/types/error.js）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一个被抛出的值渲染成带完整 `cause` 链的字符串。
 *
 * 宿主原文注释的要点照旧成立：只为**诊断呈现**（通知 / 日志），绝不解析结果；
 * 需要分类时走 `error.code`。AggregateError 的成员用 `[a; b]` 展开，
 * 包装器重复自己的 cause 时不重复渲染（`HarnessError` 那种形态）。
 * @param value - catch 到的任意值。
 * @returns 最外层消息在前，逐层 cause 以 `: ` 相接。
 */
export function errorChain(value: unknown): string {
  // 记录当前递归路径（退出时移除），只把**真环**标成循环；菱形共享的 cause 仍完整渲染。
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause)
      // 像 `new HarnessError(String(value), code, { cause: value })` 这种包装器会逐字重复
      // 自己的 cause；再渲染一遍只是噪音。
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      // 只有敌意 coercion / 敌意 getter 会走到这里：本函数喂给 UI 通知与日志，
      // 任何异常都不得逃出。内层各自捕获，故只有坏的那一节塌掉，不是整条链。
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// toolPairingBalancedBefore / After（宿主 dsh-compaction/lib/types/tool-pairing.js）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个会话表层上的工具配对折叠状态（宿主同构）。 */
interface BalanceCache {
  /** 折叠所对应的表层代次（`replaceGeneration`）；代次一变即整表重建。 */
  readonly generation: number
  /** `cutBalanced[i]` = 第 i 个表层节点**之前**那道切口是否平衡；下标 0 恒为 true。 */
  readonly cutBalanced: boolean[]
  /** 表层 seq → 其在 `cutBalanced` 中的下标。 */
  readonly indexBySeq: Map<SessionSeq, number>
  /** 折叠到当前表层末尾时仍处于「已调用未出结果」状态的数量。 */
  inProgressToolCalls: number
}

/** 每个会话的折叠缓存（WeakMap：会话被回收即释放，不跨会话串味）。 */
const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

/**
 * 单个表层事件对「进行中的工具调用数」的增量。
 * @param event - 会话日志事件。
 * @returns 助手消息按其中 tool-call 块数增加；工具结果减一；其余为零。
 */
function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/**
 * 把缓存尚未覆盖的表层 seq 折叠进平衡状态。
 *
 * 先校验未见的尾部再改动活缓存：一次损坏的 append 不得留下「只推进了一半」的状态。
 * @param session - 提供 `eventAt`。
 * @param cache - 要推进的缓存（原地修改）。
 * @param seqs - 当前表层节点（按表层顺序）。
 * @returns 推进后的同一个缓存。
 */
function extendCache(session: Session, cache: BalanceCache, seqs: readonly SessionSeq[]): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${String(seq)} has no matching session event (corrupt surface)`)
    }
    inProgressToolCalls += eventDelta(event)
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${String(seq)} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }
  tail.forEach((seq, offset) => { cache.indexBySeq.set(seq, processed + offset) })
  cache.cutBalanced.push(...pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

/**
 * 取与当前表层同步的平衡状态（按需折叠；代次变了就重建）。
 * @param session - 提供表层节点与代次。
 * @returns 与当前表层一致的缓存。
 */
function balanceCache(session: Session): BalanceCache {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)
  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    // 重建就是从空表层状态开始的同一次折叠——它唯一的前导切口显然平衡。
    const rebuilt = extendCache(session, {
      generation,
      cutBalanced: [true],
      indexBySeq: new Map<SessionSeq, number>(),
      inProgressToolCalls: 0,
    }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

/**
 * 取某 seq 位置（加偏移）那道切口的平衡性；seq 不在当前表层即报错。
 * @param cache - 当前表层的缓存。
 * @param seq - 表层 seq。
 * @param offset - 0 = 该节点**之前**的切口；1 = 该节点**之后**的切口。
 * @returns 该切口处没有未配对的工具调用时为 true。
 * @throws seq 不在当前表层时。
 */
function cutBalance(cache: BalanceCache, seq: SessionSeq, offset: number): boolean {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${String(seq)} not found`)
  }
  return balanced
}

/**
 * 当前表层某 seq **之前**那道切口是否工具配对平衡。
 * @param session - 被检查的会话。
 * @param seq - 要检查的前导切口所在的表层 seq。
 * @returns 该切口处没有未回应的工具调用时为 true。
 * @throws seq 不在当前表层、表层 seq 没有对应日志事件、或工具结果没有前置调用时。
 */
export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * 当前表层某 seq **之后**那道切口是否工具配对平衡。
 * @param session - 被检查的会话。
 * @param seq - 要检查的后继切口所在的表层 seq。
 * @returns 该切口处没有未回应的工具调用时为 true。
 * @throws seq 不在当前表层、表层 seq 没有对应日志事件、或工具结果没有前置调用时。
 */
export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 1)
}
