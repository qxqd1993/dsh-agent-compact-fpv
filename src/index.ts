/**
 * Agent-driven compaction backend for DeepSeek Harness — **标记即压缩**（0.2.0）.
 *
 * 设计主张（2026-09-27 重设计）：压缩不是「引擎要 agent 总结」，而是「agent 的输出
 * 本身就是压缩请求」。引擎在旁路观察会话事件流；看到一条助手消息里含**合法
 * checkpoint 块**时，把该消息**之前**的历史替换成这份摘要。
 *
 * ⇒ 投递链整体不存在：没有 `agent.send` 指令、没有表层取证、没有等待轮询、没有候选猜测。
 * 三次历史事故（入队未进表层 / 指令被重试吃掉 / 重启后孤儿 checkpoint）长在同一条链上，
 * 它们不是被修好，是被**删掉**。成本同时少一笔全上下文请求（实测意图请求 563k tok）。
 *
 * 框架自动压缩**不存在**：`compactIfNeeded` 恒返回 null，引擎不注册任何 pressure /
 * overflow **压缩**监听（AGENTS.md §2.4「禁止框架自动压缩」）。压缩只由 agent 说了算。
 * 唯一挂在 `agent/pre-step` 上的监听器是**水位提醒**（只告知、绝不压缩，见
 * `water-level.ts`）——框架可以提醒，但不能代劳。
 *
 * 事件序列与官方 compaction 事务**字节兼容**（`compaction/start` → `compaction/summary`
 * → `user/message` 三键 replace → `compaction/end`），且闭合在提交那一刻的回合内
 * （满足 0.1.7 读侧硬判据）。
 *
 * @module dsh-agent-compact
 */

// 只剩**类型**指向宿主：运行期原语全部在本插件的 `vendor.ts` 里（出处与抄法见该文件顶部）。
// 为什么类型留着：tsc 用宿主的类型定义做契约漂移检查（`package.json` 的
// `_comment_typeResolution` 明确要求「对宿主契约报错即说明有漂移，必须修源码」），
// 而 `.d.ts` 里的 `import type` 在运行期被擦除、不参与模块解析——装不进 DSH 的是
// **运行期** import，不是类型引用。
import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine, CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ManualCompactionError, createUserMessage, errorChain } from './vendor.ts'
import { createArchiveDispatcher } from './archive.ts'
import { CHECKPOINT_SENTINELS, buildRejectionNotice, diagnoseBestCandidate, frameSummary, parseCheckpointBlock } from './checkpoint-block.ts'
import type { CheckpointBlock } from './checkpoint-block.ts'
import { assistantTextOf, latestCompactionEndSeq, selectMarkerSpan } from './marker.ts'
import { compactableHeadSeq, compactSurfaceRegion, inspectCompactionEntryState } from './region.ts'
import { Config, resolveConfig } from './config.ts'
import type { CompactConfig, ResolvedCompactConfig } from './config.ts'
import { sessionTagOf, trace } from './trace.ts'
import { VERSION } from './version.ts'
import {
  INITIAL_GAUGE_STATE,
  WARN_HARD,
  WARN_HIGH,
  WARN_LOW,
  advanceGauge,
  buildWaterLevelNotice,
} from './water-level.ts'
import type { GaugeState } from './water-level.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-compact': { kind: 'dsh-agent-compact' }
  }
}

export { Config, DEFAULT_MIN_CHECKPOINT_CHARS, resolveConfig } from './config.ts'
export type { CompactConfig, ResolvedCompactConfig } from './config.ts'
export {
  CHECKPOINT_CONTRACTS,
  CHECKPOINT_SECTIONS,
  CHECKPOINT_SENTINEL,
  CHECKPOINT_SENTINELS,
  formatCheckpointBlock,
  isInsideFence,
  parseCheckpointBlock,
} from './checkpoint-block.ts'
export type { CheckpointBlock, CheckpointContract } from './checkpoint-block.ts'
export { assistantTextOf, latestCompactionEndSeq, selectMarkerSpan } from './marker.ts'
export type { MarkerSpan } from './marker.ts'

// 转出侧车轨迹原语（2026-09-14）：让消费方（`dsh-compact-provider` 的工具入口）用**同一份**
// 路径解析/序列化/追加实现写同一个文件——避免两套判据互相漂移（§5.22 规则 4）。
// 走主入口转出而非 package.json 子路径导出：消费方副本的 package.json 由 pnpm 重写，
// 新增子路径导出**不会**同步过去（实测 False）。
export {
  BUILD as compactTraceBuild,
  appendTraceEntry,
  buildStamp,
  compactionTracePath,
  parseTraceEntries,
  readTraceEntries,
  resolveHome as compactTraceResolveHome,
  serializeTraceEntry,
  trace as compactTrace,
} from './trace.ts'
export type { TraceEntry, TracePhase } from './trace.ts'

/** 会话事件视图（宽松结构断言：只需要 seq 与按 seq 取事件）。 */
interface SessionView {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
  readonly id: string
  readonly surface: { readonly nodes: readonly SessionSeq[] }
}

/**
 * 宿主 `tool-result-pruner` 服务在本引擎里用到的**最小结构面**。
 *
 * 为什么按结构声明而不是 import 它的类型：那个包的**类型副本不在本仓 `node_modules`**
 * 里（宿主封在 app.asar；本机 `node_modules/@deepseek-ai` 下没有它），tsc 会以
 * TS2307 拒绝。这里只用一个方法，按结构声明即可——`ctx.get(服务名)` 走的是
 * `get(name: string): any` 重载，运行期不依赖任何类型身份。
 */
interface ToolResultPrunerFacade {
  pruneSession(session: Session): {
    readonly pruned: readonly unknown[]
    readonly charsRemoved: number
  }
}

/** 进程内一次性告警去重（同一 seq 只在首次报告）。 */
const reported = new WeakMap<object, Set<number>>()

/**
 * 标记驱动压缩引擎。
 *
 * 两条入口共用同一个事务：
 * - **标记路径**（主路径，零额外请求）：agent 在自己任意一轮的输出里写合法 checkpoint 块。
 * - **工具路径**（显式）：调用方直接把摘要交给 {@link AgentCompactEngine.compactWithSummary}。
 */
export class AgentCompactEngine {
  static inject = ['agents', 'tokenMeter', 'sessions']

  static Config = Config

  /**
   * cordis 上下文。
   *
   * 宿主的 `CompactionEngine` 从 `Service` 继承了 `ctx` 字段；删掉继承后自己持有
   * （本类全程只用 `this.ctx.get / on / logger / tokenMeter / agents / sessions`）。
   */
  readonly ctx: Context

  /** 已解析的部署配置。 */
  readonly config: ResolvedCompactConfig

  /**
   * 存档派发器（**非阻塞**）：调用即返回，存档在后台跑完并自落轨迹。
   *
   * 为什么不让 `commit` 直接 `await checkpoint.create()`（0.2.1 的写法）：线上实测
   * 那一等就是 **27,270 ms**，而事务本身只 66 ms。存档是保命网、不是前置条件，
   * 却让每次压缩白等二十多秒（完整归因见 `archive.ts` 顶部）。
   */
  private readonly archiveDispatch: (trigger: string) => void

  /**
   * 每个会话的水位状态机状态（WeakMap：会话被回收即释放）。
   *
   * 两个桶（trace / notice）分开存档——共用的话，60 写了 trace 就会吃掉 65 的提醒
   * （细节与重置语义见 `water-level.ts` 顶部）。
   */
  private readonly gaugeStates = new WeakMap<object, GaugeState>()

  /** 已经为「分母未知」记过一笔的会话（每一步都记会刷屏，只记首次）。 */
  private readonly gaugeUnavailableReported = new WeakSet<object>()

  constructor(ctx: Context, config: CompactConfig = {}) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    // 注册为 `ctx.compaction`（**解析完配置之后**：配置非法时不要留下半构造的服务）。
    //
    // 宿主 `CompactionEngine` 的构造函数只有一句 `super(ctx, 'compaction')`；而 cordis
    // `Service` 构造函数在这里的**服务语义**就是 `ctx.reflect.provide('compaction', this)`
    // （`ctx.provide` 是它的 mixin，见 cordis `ReflectService` 的 `mixin('reflect', [...])`）。
    // 少掉的只是 `Service` 的**诊断**元数据（`symbols.tracker` / `name` / isolate 过滤），
    // 前提已核实：全 DSH 没有任何 `instanceof CompactionEngine` 检查（唯一引用方
    // `dsh-compaction-basic` 只是 `extends`），`/compact` 命令只调
    // `ctx.compaction.compactNow(...)` —— 鸭子类型安全。
    ctx.provide('compaction', this)
    this.archiveDispatch = createArchiveDispatcher({
      create: async (reason: string): Promise<void> => {
        const checkpoint = this.ctx.get('checkpoint') as
          | { create(reason: string): Promise<unknown> }
          | undefined
        if (checkpoint === undefined) {
          // 派发前已查过；走到这里说明服务在派发后被卸载——响亮，不假装成功
          throw new Error('checkpoint service disappeared after dispatch')
        }
        await checkpoint.create(reason)
      },
      trace: (entry) => {
        trace(entry)
      },
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
    })
    // 水位提醒也只在标记路径开启时注册：提醒里给的出路之一是「写一块 checkpoint」，
    // 而标记路径关着时那块 checkpoint 不会生效——说了做不到，比不说更糟。
    if (this.config.enabled) {
      this.registerMarkerPath()
      this.registerWaterLevelGauge()
    }
  }

  /**
   * 本引擎**没有自动路径**：不因步间压力或请求溢出自行压缩。
   *
   * 「何时压」是 agent 的决策（AGENTS.md §2.4：主人 2026-08-16「不要开自动压缩，
   * 别让框架强制影响你的决策」）。保留该实现只为满足 seam 契约——恒返回 `null`。
   * @returns 恒为 `null`（永不自动压缩）
   */
  compactIfNeeded(
    _agent: unknown,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  /**
   * 本引擎**没有引擎发起的压缩**：没有摘要可压。摘要只能来自 agent 自己的输出
   * （标记路径）或显式调用方（工具路径）。
   * @throws {@link ManualCompactionError} 恒抛（`summary` 类），附替代路径说明
   */
  compactNow(): Promise<CompactionResult | null> {
    return Promise.reject(new ManualCompactionError(
      'summary',
      'agent-driven compaction has no engine-initiated path: the summary must come from the '
      + 'agent\'s own output (checkpoint block) or from an explicit caller. '
      + 'There is no replay summarizer in this backend.',
    ))
  }

  /**
   * 本引擎不做「按 replay 重放总结一个区间」——那条路径需要独立的全量载荷请求，
   * 与「压缩由 agent 自己的输出供给」互斥。
   * @throws {@link ManualCompactionError} 恒抛（`summary` 类）
   */
  compactRegion(): Promise<CompactionResult> {
    return Promise.reject(new ManualCompactionError(
      'summary',
      'this backend compacts only with a caller-provided checkpoint; range compaction '
      + 'via a replay summarizer is not implemented.',
    ))
  }

  /**
   * 显式入口：用调用方供给的摘要立即压缩「该消息之前」的历史。
   *
   * 与标记路径共用同一事务（同一区间规则、同一事件序列、同一幂等语义）——两条入口
   * 只有「摘要从哪来」不同。
   * @param agent - 会话属主（提供 session 与路由信息）
   * @param summary - checkpoint 正文（调用方负责其内容与体量）
   * @param beforeSeq - 区间终点取「该 seq 在表层的前一个节点」；缺省用 surface 末节点
   * @param sourceCommandId - 事务来源标识（记账用）
   * @returns 压缩结果；无可压区间时为 `null`
   * @throws 事务失败时（摘要不小于被替换内容 / 区间失衡 / 写盘失败）
   */
  async compactWithSummary(
    agent: Agent,
    summary: string,
    beforeSeq?: number,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    const session = agent.session as unknown as SessionView
    // 先剪枝、再取表层/起点：剪枝会把工具结果节点原位替换成**新 seq** 的替换体，
    // 反过来（先定区间再剪）会让区间里的 seq 失效。
    this.pruneBeforeCompaction(session as unknown as Session, 'tool')
    const nodes = session.surface.nodes
    const headSeq = compactableHeadSeq(session as unknown as Session)
    const markerSeq = beforeSeq ?? nodes[nodes.length - 1] ?? 0
    const span = selectMarkerSpan(nodes, markerSeq, headSeq)
    if (span.kind === 'skip') {
      trace({
        phase: 'skipped',
        trigger: 'tool',
        session: sessionTagOf(session),
        chars: summary.length,
        note: span.reason,
      })
      return null
    }
    const startedAt = Date.now()
    const { result, txnMs } = await this.commit(
      session as unknown as Session, span.start as SessionSeq, span.end as SessionSeq,
      agent, summary, 'tool', sourceCommandId,
    )
    trace({
      phase: 'committed', trigger: 'tool', session: sessionTagOf(session),
      chars: summary.length, txnMs, totalMs: Date.now() - startedAt,
      bestCandidate: diagnoseBestCandidate(summary).present,
      note: 'shadowed ' + String(result.shadowedSeqs.length) + ' nodes (seqs '
        + String(result.shadowedRange.start) + '-' + String(result.shadowedRange.end) + ')',
    })
    return result
  }

  /**
   * 注册标记路径：观察助手消息，识别合法 checkpoint 块并提交事务。
   *
   * 为什么用 `session/event` + `setImmediate`：监听器跑在 `session.append` 内部，
   * 就地再 append 会 reenter（§5.12 规则 4 的同一课）；推迟一个宏任务后，
   * 提交时读到的回合状态就是真实状态（回合内 / 回合间都可提交）。
   */
  private registerMarkerPath(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const data = event.data as { message?: { content?: unknown } } | undefined
      const text = assistantTextOf(data?.message?.content)
      // 快筛：没有哨兵就不是压缩意图——绝大多数消息在这里返回，零后续成本
      if (!CHECKPOINT_SENTINELS.some(s => text.includes(s))) return
      const parsed = parseCheckpointBlock(text, this.config.minCheckpointChars)
      if (parsed.kind === 'absent') return
      setImmediate(() => {
        void this.handleMarker(session as unknown as SessionView, event.seq, parsed)
      })
    })
  }

  /**
   * 注册水位提醒：每个 step 算一次上下文水位，过水位就按状态机出声，然后**停住**。
   *
   * 为什么挂在 `agent/pre-step`：这是官方 `compaction-basic` 做压力检查的同一时机
   * （它的 `_registerAutomaticCompaction` 里那个监听器）。差别只有一件事：它在这一步
   * **压缩**，我们只**提醒**——「框架可以提醒，但不能代劳」。
   *
   * 监听器绝不拦 step：任何异常都只落一笔 `water-level-failed`，然后照常 `next()`。
   */
  private registerWaterLevelGauge(): void {
    this.ctx.on('agent/pre-step', ({ agent }, next) => {
      try {
        this.observeWaterLevel(agent)
      } catch (error: unknown) {
        // 观测不得反噬：提醒链路的异常只能记账，不能把这一步拦下来。
        trace({
          phase: 'water-level-failed',
          session: sessionTagOf(agent.session),
          error: errorChain(error),
        })
      }
      return next()
    })
  }

  /**
   * 一个 step 的水位观测：算百分比 → 推状态机 → 写 trace 或注入告知。
   *
   * 分子用 `tokenMeter.measure(...).totalTokens`（与 compaction-basic 的阈值判据同源：
   * 下一次请求的估计压力）；分母用 `tokenMeter.contextPressure(...).contextWindow`
   * （最近一次请求记录下来的窗口容量）。为什么分子不取 `projectedTokens`：服务上的
   * `contextPressure()` 只暴露 `pressureTokens` / `contextWindow`，不暴露它。
   * 为什么分母不用 `llm.resolveModelInfo`：那要多注入一个 `llm` 服务、每步 await 一次
   * 模型元数据；而这两个数宿主已经算好并缓存在会话投影里（状态栏用的也是它们）。
   *
   * 代价写清楚：**分母是 last-wins**——换模型后要等下一次请求才更新，这一步的水位
   * 可能短暂地按旧窗口算。水位本来就是代理指标（见 `water-level.ts` 顶部），
   * 这一点误差不影响「该不该出声」的判据。
   * @param agent - 即将进入下一个 step 的 agent。
   */
  private observeWaterLevel(agent: Agent): void {
    const session = agent.session
    const { contextWindow } = this.ctx.tokenMeter.contextPressure(session)
    if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      // 分母未知（会话还没有 request/context 记录）：算不出百分比。
      // 不静默——每个会话只记一笔，说明「这段水位里压力计是瞎的」。
      if (!this.gaugeUnavailableReported.has(session)) {
        this.gaugeUnavailableReported.add(session)
        trace({
          phase: 'water-level-skipped',
          session: sessionTagOf(session),
          note: 'contextWindow 未知（尚无 request/context 记录），本会话的水位提醒暂不可用',
        })
      }
      return
    }

    const { totalTokens } = this.ctx.tokenMeter.measure(session)
    const waterLevel = (totalTokens / contextWindow) * 100
    const previous = this.gaugeStates.get(session) ?? INITIAL_GAUGE_STATE
    const decision = advanceGauge(waterLevel, previous)
    this.gaugeStates.set(session, decision.state)
    if (decision.kind === 'none') return

    const rounded = Math.round(decision.waterLevel * 10) / 10
    if (decision.kind === 'trace') {
      trace({
        phase: 'water-level',
        trigger: 'water-level',
        session: sessionTagOf(session),
        waterLevel: rounded,
        bucket: decision.bucket,
        stepSize: decision.stepSize,
        note: String(totalTokens) + '/' + String(contextWindow) + ' tok',
      })
      return
    }

    // 提醒档：状态机已把两个计数一起推到同档 ⇒ **不再补 trace**（一条通知足够）。
    try {
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text: buildWaterLevelNotice(decision.waterLevel) }],
          source: { kind: 'dsh-agent-compact' },
        }),
        'next-step',
        false,
      )
    } catch (error: unknown) {
      // 提醒投递失败：留证，但绝不因为「喊不出来」而中断会话。
      trace({
        phase: 'water-level-failed',
        session: sessionTagOf(session),
        waterLevel: rounded,
        error: errorChain(error),
      })
    }
  }

  /** 处理一条含哨兵的助手消息：幂等 → 解析结论 → 提交或响亮报告。 */
  private async handleMarker(
    session: SessionView,
    markerSeq: number,
    parsed: Exclude<CheckpointBlock, { kind: 'absent' }>,
  ): Promise<void> {
    const sid = sessionTagOf(session)
    if (parsed.kind === 'invalid') {
      trace({
        phase: 'rejected', trigger: 'marker', session: sid, seqFloor: markerSeq,
        chars: parsed.chars, error: parsed.reason,
      })
      // 「响」优先：写坏一块 checkpoint 不能静默——下个 step 我会看到原因并重写
      this.notifyOnce(session, markerSeq, buildRejectionNotice(parsed, this.config.minCheckpointChars))
      return
    }

    // 幂等：已处理过的标记消息，其 seq 必然小于此后写入的 compaction/end seq
    const boundary = latestCompactionEndSeq(session)
    if (boundary !== undefined && markerSeq < boundary) {
      trace({
        phase: 'skipped', trigger: 'marker', session: sid, seqFloor: markerSeq,
        note: '已处理过（幂等：seq ' + String(markerSeq) + ' < compaction/end ' + String(boundary) + '）',
      })
      return
    }

    const agent = this.ctx.agents.get(session.id as never)
    if (agent === undefined) {
      // 拿不到属主就压不了：如实记账，不猜、不静默
      trace({
        phase: 'skipped', trigger: 'marker', session: sid, seqFloor: markerSeq,
        note: 'agents 注册表里没有该会话的 agent（无法提交事务）',
      })
      return
    }

    // 先剪枝、再取起点与区间（理由见 {@link pruneBeforeCompaction}）：区间必须建立在
    // **剪枝之后**的表层上——剪枝会把工具结果原位替换成新 seq 的替换体，旧 seq 会失效。
    this.pruneBeforeCompaction(session as unknown as Session, 'marker')
    const headSeq = compactableHeadSeq(session as unknown as Session)
    const span = selectMarkerSpan(session.surface.nodes, markerSeq, headSeq)
    if (span.kind === 'skip') {
      trace({ phase: 'skipped', trigger: 'marker', session: sid, seqFloor: markerSeq, note: span.reason })
      return
    }

    trace({
      phase: 'detected', trigger: 'marker', session: sid, seqFloor: markerSeq,
      chars: parsed.chars, agentId: agent.id,
    })
    const startedAt = Date.now()
    try {
      const { result, txnMs } = await this.commit(
        session as unknown as Session,
        span.start as SessionSeq,
        span.end as SessionSeq,
        agent,
        parsed.body,
        'marker',
      )
      trace({
        phase: 'committed', trigger: 'marker', session: sid, seqFloor: markerSeq,
        chars: parsed.chars, txnMs, totalMs: Date.now() - startedAt,
        bestCandidate: diagnoseBestCandidate(parsed.body).present,
        note: 'shadowed ' + String(result.shadowedSeqs.length) + ' nodes (seqs '
          + String(result.shadowedRange.start) + '-' + String(result.shadowedRange.end) + ')',
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      trace({ phase: 'abort', trigger: 'marker', session: sid, seqFloor: markerSeq, chars: parsed.chars, error: message })
      this.notifyOnce(session, markerSeq, [
        '⚠ 这次 checkpoint 未生效，会话历史**未改动**。',
        '原因：' + message,
      ].join('\n'))
    }
  }

  /**
   * 一个事务：压缩前保命存档 → 表层替换 → flush。两条入口共用。
   *
   * 返回值带**阶段耗时**（2026-09-27 线上首笔实测驱动）：侧车原先只写 `waitedMs: 0`
   * 这个硬编码占位，于是「detected 到 committed 之间那 21.9 秒花在哪」答不出来——
   * §5.22 五问之⑤（耗时与预算）形同虚设。现按「存档 / 事务」两段如实计时。
   */
  private async commit(
    session: Session,
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    body: string,
    trigger: 'marker' | 'tool',
    sourceCommandId?: string,
  ): Promise<{ result: CompactionResult; txnMs: number }> {
    // 存档**不等**（2026-09-27 线上实测）：等它要 27,270 ms，而事务本身只 66 ms。
    // 语义安全：存档内容是 storages + AGENTS.md，而压缩只改**会话事件流**，
    // 两者无因果关系 ⇒ 并行不产生竞态。
    this.dispatchArchive(trigger)
    const blocks: ContentBlock[] = [{ type: 'text', text: body }]
    const txnStartedAt = Date.now()
    const result = await compactSurfaceRegion(
      {
        meter: this.ctx.tokenMeter,
        // 供给式摘要：不建 replay 载荷、不调 LLM——摘要就在手上
        summarize: () => Promise.resolve({
          summary: blocks,
          rawOutput: blocks,
          provider: agent.options.provider ?? '',
          model: agent.options.model ?? '',
        }),
      },
      session,
      start,
      end,
      agent,
      {
        owner: inspectCompactionEntryState(session as never).openTurn === null ? null : 'current-turn',
        stability: 'selected-span',
        ...(sourceCommandId === undefined ? {} : { sourceCommandId: sourceCommandId as never }),
        flush: async () => { await this.ctx.sessions.flush(session) },
      },
    )
    return { result, txnMs: Date.now() - txnStartedAt }
  }

  /**
   * 压缩前先跑一遍**模型无关**的 tool-result 剪枝。
   *
   * 为什么必须补这一调：`tool-result-pruner` 在宿主里是**独立服务**
   * （`ctx.get('toolResultPruner')`），**它自己不会跑**——官方 `dsh-compaction-basic`
   * 在「压力已达标、还没选区间」那一刻主动调 `pruneSession(agent.session)`，随后重新
   * 计量再选区间（其 `index.ts` 的 `compactPressure`，rc.3 第 346-350 行；另一处是
   * `compactIfNeeded` 的 `context-overflow` 分支，第 303 行）。换成标记驱动引擎后
   * **没有任何人再调它** ⇒ 悄悄少了一道防线：本来能靠裁剪省下的上下文，变成了
   * 「必须整段换摘要」。
   *
   * 为什么是「选区间之前」：剪枝对工具结果是**原位 replace**（替换体是新 seq），
   * 先定区间再剪枝会让区间里的 seq 失效或不平衡。所以调用点必须在
   * `compactableHeadSeq` / `selectMarkerSpan` 之前（两条入口都这么调）。
   * 官方第二处（溢出恢复）本引擎没有对应路径：`compactIfNeeded` 恒 null，无自动压缩。
   *
   * **失败不阻断压缩**（与官方的差别，故意的）：官方那条调用外面裹着 pre-step 监听器
   * 的 try/catch（失败就 warn 并跳过**那一步**）；本引擎的入口是 agent 自己写下的
   * checkpoint——让一次**可选**的裁剪失败去丢掉一次压缩请求，是用优化换主功能。
   * 故这里只如实记账（`prune-skipped` / `prune-failed`），主事务照走：裁剪本身对每个
   * 节点是「append + replace」同步原子落盘，失败也留得下一致的表层。
   * @param session - 要压缩的会话（剪枝直接改它的表层）。
   * @param trigger - 本次压缩的入口（记账用）。
   */
  private pruneBeforeCompaction(session: Session, trigger: 'marker' | 'tool'): void {
    const pruner = this.ctx.get('toolResultPruner') as ToolResultPrunerFacade | undefined
    if (pruner === undefined) {
      trace({
        phase: 'prune-skipped',
        trigger,
        session: sessionTagOf(session),
        note: 'toolResultPruner 服务不在本组合（未挂载 dsh-compaction-tool-result-pruner？）',
      })
      return
    }
    try {
      const result = pruner.pruneSession(session)
      if (result.pruned.length === 0) return
      trace({
        phase: 'pruned',
        trigger,
        session: sessionTagOf(session),
        note: '裁掉 ' + String(result.pruned.length) + ' 条工具结果，省 ' + String(result.charsRemoved) + ' 字符',
      })
    } catch (error: unknown) {
      trace({
        phase: 'prune-failed',
        trigger,
        session: sessionTagOf(session),
        error: errorChain(error),
      })
    }
  }

  /**
   * 派发一次压缩前存档（**不阻塞**，立即返回）。
   *
   * 服务不在本组合时**留证而不是静默**（§5.10：静默失败是死亡温床）——跳过行写明原因，
   * 于是「为什么这次没存档」一条 `tail` 可答；原先的 `if (checkpoint === undefined) return`
   * 是无声的，从侧车上看与「存档成功」无从区分。
   */
  private dispatchArchive(trigger: string): void {
    if ((this.ctx.get('checkpoint') as unknown) === undefined) {
      trace({
        phase: 'archive-skipped',
        note: 'checkpoint 服务不在本组合（未挂载 dsh-agent-checkpoint？）',
      })
      return
    }
    this.archiveDispatch(trigger)
  }

  /** 注入一条可见的失败告知（同 seq 只报一次；投递绝不反噬主流程）。 */
  private notifyOnce(session: SessionView, seq: number, text: string): void {
    const seen = reported.get(session as unknown as object) ?? new Set<number>()
    if (seen.has(seq)) return
    seen.add(seq)
    reported.set(session as unknown as object, seen)
    const agent = this.ctx.agents.get(session.id as never)
    if (agent === undefined) return
    try {
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-agent-compact' },
        }),
        'next-step',
        false,
      )
    } catch {
      // 告知是尽力而为：投递失败不得影响会话本身
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// seam 的编译期护栏（删掉 `extends CompactionEngine` 之后补回来）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 只取宿主 compaction seam 的三个方法。
 *
 * 为什么不是整类：宿主的 `CompactionEngine` 还从 `Service` 继承了 `name` 与几个
 * symbol 键方法（`symbols.filter` / `symbols.extend` / `symbols.resolveConfig`），
 * 那是基类私产、不是 seam 契约；本引擎不 isolate、不 `extend`，用不到。
 */
type CompactionSeam = Pick<CompactionEngine, 'compactIfNeeded' | 'compactNow' | 'compactRegion'>

/** 编译期断言：`T` 必须为 `true`（不满足时这里报错，而不是让漂移潜伏）。 */
type Assert<T extends true> = T

/**
 * 本类必须仍满足宿主的 compaction seam。
 *
 * 删掉继承后编译器不再替我们检查这三个方法的签名；这条断言把它们钉回宿主契约
 * （`/compact` 会按鸭子类型调 `compactNow`）。指向宿主的只有**类型**，运行期零依赖。
 */
type _CompactionSeamHolds = Assert<
  AgentCompactEngine extends CompactionSeam ? true : false
>

// 构建自报（可维护性，2026-09-14）：进程加载即落一行轨迹，声明「我是哪个构建 +
// 我贡献什么 + 我依赖什么服务」。排障第一步历来是「线上跑的是哪个构建」。
trace({
  phase: 'boot',
  note: 'v' + VERSION + ' inject=agents,tokenMeter,sessions;path=marker-driven(agent output);auto=none;'
    + 'gauge=water-level(' + String(WARN_LOW) + '/' + String(WARN_HIGH) + '/' + String(WARN_HARD) + ')',
})

export default AgentCompactEngine
