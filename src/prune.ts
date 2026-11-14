/**
 * 压缩前的工具结果剪枝——以及它唯一的那道闸。
 *
 * 为什么单独成模块（2026-11-15）：剪枝本身是宿主服务（`ctx.get('toolResultPruner')`）干的，
 * 但**调用时机**是本引擎选的，而调用时机决定记录打不打得开。把它从 `index.ts` 里挪出来，
 * 是为了让「回合关着就不许写」这条闸能被离线测试咬住——不是靠读注释相信自己。
 *
 * 事故本身写在 {@link pruneBeforeCompaction} 里。这里只说它的形状：
 * 写下去即不可逆（读侧拒绝发生在下次加载），所以它是全引擎唯一一条**必须在写之前**的约束。
 * @module dsh-agent-compact/prune
 */

import { inspectCompactionEntryState } from './region.ts'
import { sessionTagOf, trace } from './trace.ts'
import { errorChain } from './vendor.ts'

/**
 * 剪枝要看的会话视图：只要「按 seq 读事件」这一件事。
 *
 * 刻意不依赖宿主 `Session` 类型——闸的判据是纯读，测试可以喂一个数组。
 */
export interface PruneSessionView {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
}

/** 剪枝结论：给调用方与测试一个可断言的形状，而不是「有没有返回值」。 */
export type PruneOutcome =
  /** 服务没挂：本组合没有 toolResultPruner。 */
  | 'no-service'
  /** 闸拦下：此刻没有打开的回合，替身一条都不许写。 */
  | 'turn-closed'
  /** 跑了，但没有可剪的节点。 */
  | 'nothing'
  /** 跑了，剪掉了若干条。 */
  | 'pruned'
  /** 剪枝自己抛了：已记账，主事务照走。 */
  | 'failed'

/**
 * 压缩前剪掉工具结果的长尾（可选优化），并在**回合关闭时整体跳过**。
 *
 * ## 为什么必须在写之前拦
 *
 * 宿主 v4 读取器（`session-format` 的 event walk）对 `tool/result` 分两支：
 *
 * - `surfaceOp === 'append'`：要求 openStep，另查 callId 生命周期；
 * - 其它（即**替换体**）：只要求 `openTurn !== null`，否则整份日志被拒收——
 *   `SessionFormatError: tool/result replacement is outside an open turn`。
 *
 * 剪枝替身正是「非 append 的 tool/result」。所以回合已关闭时，哪怕只写一条，会话文档
 * 从此就打不开了：拒绝发生在**下一次加载**，那时谁都救不回来。
 *
 * 2026-11-15 事故：一条已经走过的可能性里，标记路径的监听器在 `turn/end` 之后才跑到，
 * 15 个替身落在回合外，那份会话文档再也打不开。同一时刻本会话这边剪枝恰好无事可做
 * （`pruned.length === 0`），于是活着——**差别只是运气，不是设计**。
 *
 * ## 为什么失败不阻断压缩（与官方的差别，故意的）
 *
 * 官方那条调用外面裹着 pre-step 监听器的 try/catch（失败就 warn 并跳过那一步）。本引擎的
 * 入口是 agent 自己写下的 checkpoint：让一次**可选**的裁剪失败去丢掉一次压缩请求，是用
 * 优化换主功能。所以除闸以外一律如实记账、主事务照走。
 * @param session - 要压缩的会话（剪枝直接改它的表层）
 * @param trigger - 本次压缩的入口（记账用）
 * @param pruneSession - 剪枝服务的调用面；`undefined` 表示服务未挂载
 * @param tracePath - 侧车路径（测试可注入）
 * @returns 结论
 */
export function pruneBeforeCompaction(
  session: PruneSessionView,
  trigger: 'marker' | 'tool',
  pruneSession: ((session: PruneSessionView) => {
    readonly pruned: readonly unknown[]
    readonly charsRemoved: number
  }) | undefined,
  tracePath?: string,
): PruneOutcome {
  if (pruneSession === undefined) {
    trace({
      phase: 'prune-skipped',
      trigger,
      session: sessionTagOf(session),
      note: 'toolResultPruner 服务不在本组合（未挂载 dsh-compaction-tool-result-pruner？）',
    }, tracePath)
    return 'no-service'
  }

  // 判据与引擎其它地方同源（region.ts 的入口状态扫描），不在这里另写一份回合状态机——
  // 两份实现必然漂移。类型上只是多了一次收窄：本模块刻意不认识宿主 Session。
  const entryState = inspectCompactionEntryState(
    session as Parameters<typeof inspectCompactionEntryState>[0],
  )
  if (entryState.openTurn === null) {
    trace({
      phase: 'prune-skipped',
      trigger,
      session: sessionTagOf(session),
      note: '回合已关闭：剪枝替身（tool/result 替换体）只能写在打开中的回合里'
        + '（宿主读侧：tool/result replacement is outside an open turn）',
    }, tracePath)
    return 'turn-closed'
  }

  try {
    const result = pruneSession(session)
    if (result.pruned.length === 0) return 'nothing'
    trace({
      phase: 'pruned',
      trigger,
      session: sessionTagOf(session),
      note: '裁掉 ' + String(result.pruned.length) + ' 条工具结果，省 '
        + String(result.charsRemoved) + ' 字符',
    }, tracePath)
    return 'pruned'
  } catch (error: unknown) {
    trace({
      phase: 'prune-failed',
      trigger,
      session: sessionTagOf(session),
      error: errorChain(error),
    }, tracePath)
    return 'failed'
  }
}
