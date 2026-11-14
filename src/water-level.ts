/**
 * 水位提醒的**纯状态机**与文案（离线可测，不碰 cordis / 会话）。
 *
 * 设计意图（2026-11）：本引擎**结构上没有自动压缩**——`compactIfNeeded` 恒 `null`，
 * 那是拒绝代劳。但「拒绝代劳」不等于「什么都不说」：
 *
 *   框架可以提醒，但不能代劳。
 *   压力计照常算，过水位就告知一声，然后**停住**；按不按，是写的人自己的事。
 *
 * 所以这里只有两件事：算「该不该出声」（{@link advanceGauge}），以及该说什么
 * （{@link buildWaterLevelNotice}）。算出来的结论由 `index.ts` 落到轨迹 / 投递。
 *
 * ⚠ **水位是代理指标，不是本体。** 到 69% 被强制压缩是框架的阈值，不是这个实例的
 * 极限；反过来，一轮特别重的对话可能在 55% 就已经该停了。**提醒是必要不充分条件。**
 * （本组合把框架自动压缩显式关掉了，这个「阈值」只存在于官方实现/宿主超窗里——
 * 代理性只会更强，不会更弱。）
 *
 * 状态为什么是**两个独立 bucket**：共用一个的话，60 写了一条 trace 就会吃掉 65 的
 * 那次提醒（`lastTraceBucket` 一推进，`bucket > lastNoticeBucket` 的判据还在，但
 * 「提醒了就别再重复写 trace」会把同一个 bucket 的 trace 吞掉；反过来更糟）。
 *
 * 为什么**跌回 60 以下必须重置**：一次压缩之后水位会大降，pruner 裁掉大工具结果也会
 * 降。不重置的话，状态机会卡在「已经提醒过 65」然后**再也不提醒**——那比没有还糟，
 * 因为它让写的人以为这里有人看着。
 *
 * @module dsh-agent-compact/water-level
 */

/** 开始写 trace 的水位（不打扰，只留痕）。 */
export const WARN_LOW = 60

/** 开始注入 next-step 告知的水位（可见）。 */
export const WARN_HIGH = 65

/** 红线水位：档距从 2 缩到 1，措辞加重。 */
export const WARN_HARD = 75

/** 温和档的档距（百分点）。 */
export const STEP_MILD = 2

/** 红线档的档距（百分点）。 */
export const STEP_HARD = 1

/** 状态机的两个独立计数；都是 0 表示「本段水位里还没提醒过」。 */
export interface GaugeState {
  /** 最近一次写 trace 的档位（0 = 未写过）。 */
  readonly lastTraceBucket: number
  /** 最近一次注入提醒的档位（0 = 未提醒过）。 */
  readonly lastNoticeBucket: number
}

/** 初始状态：两个计数都为 0（未提醒）。 */
export const INITIAL_GAUGE_STATE: GaugeState = Object.freeze({
  lastTraceBucket: 0,
  lastNoticeBucket: 0,
})

/** 一个 step 的结论：什么都不做 / 写 trace / 注入 next-step 告知。 */
export type GaugeDecision =
  | { readonly kind: 'none'; readonly state: GaugeState }
  | {
    readonly kind: 'trace'
    readonly state: GaugeState
    /** 本 step 的水位（百分点，未取整）。 */
    readonly waterLevel: number
    /** 本 step 的档位（向下取整到档距的整数倍）。 */
    readonly bucket: number
    /** 本 step 的档距（1 = 红线档，2 = 温和档）。 */
    readonly stepSize: number
  }
  | {
    readonly kind: 'notice'
    readonly state: GaugeState
    readonly waterLevel: number
    readonly bucket: number
    readonly stepSize: number
  }

/**
 * 推进一个 step 的水位状态机。
 *
 * 逻辑逐行对应设计（顺序即优先级）：
 * ```
 * p < 60            ⇒ 两个计数清零（跌回去就重置），不出声
 * stepSize          = p >= 75 ? 1 : 2
 * bucket            = floor(p / stepSize) * stepSize
 * bucket > 上次提醒 且 bucket >= 65 ⇒ 注入提醒（并吃掉同档 trace）
 * 否则 bucket > 上次 trace 且 bucket >= 60 ⇒ 写 trace
 * ```
 * @param waterLevel - 当前水位百分比（0-100 之外也允许：>100 表示已超窗）。
 * @param state - 该会话上一步的状态。
 * @returns 本 step 的动作与新状态（状态不可变，返回新对象）。
 */
export function advanceGauge(waterLevel: number, state: GaugeState): GaugeDecision {
  // 非有限值意味着「压力计算坏了」。此时**不推进状态**（既不重置也不提醒）：
  // 把 NaN 当 0 会静默清空提醒历史，把 NaN 当 100 会凭空喊红线。
  if (!Number.isFinite(waterLevel)) return { kind: 'none', state }

  if (waterLevel < WARN_LOW) {
    // 跌回 60 以下 ⇒ 重置（压缩 / 剪枝 / 换模型都会让水位大降）。
    return { kind: 'none', state: INITIAL_GAUGE_STATE }
  }

  const stepSize = waterLevel >= WARN_HARD ? STEP_HARD : STEP_MILD
  const bucket = Math.floor(waterLevel / stepSize) * stepSize

  if (bucket > state.lastNoticeBucket && bucket >= WARN_HIGH) {
    return {
      kind: 'notice',
      // 提醒了就把 trace 计数一起推到同档：同一段水位不再补一条 trace（一条通知足够）。
      state: { lastTraceBucket: bucket, lastNoticeBucket: bucket },
      waterLevel,
      bucket,
      stepSize,
    }
  }

  if (bucket > state.lastTraceBucket && bucket >= WARN_LOW) {
    return {
      kind: 'trace',
      state: { ...state, lastTraceBucket: bucket },
      waterLevel,
      bucket,
      stepSize,
    }
  }

  return { kind: 'none', state }
}

/**
 * 造一条**可见**的水位告知（注入 `next-step`，人话，说清能做什么）。
 *
 * 两档措辞：
 *  - 温和档（65 ≤ p < 75）：把水位说清、给出三条出路，并明确「不要求你现在决定」；
 *  - 红线档（p ≥ 75）：**到了 75 以上，「吵」不再是缺点。在那里还保持礼貌，
 *    才是失职。** 所以不铺垫、不劝，直接给三选一，并把「不决定」的代价说出来。
 *
 * 纯函数：只依赖入参与常量，便于离线断言文案（不碰会话、不读时钟）。
 * @param waterLevel - 水位百分比（内部取整到整数百分点）。
 * @returns 直接可投递的一条通知文本。
 */
export function buildWaterLevelNotice(waterLevel: number): string {
  const percent = String(Math.round(waterLevel))

  if (waterLevel >= WARN_HARD) {
    return [
      '🛑 上下文水位 ' + percent + '%——红线档。',
      '',
      '到这个水位还讲究措辞，就是失职。说清楚：再往上就是窗口本身，'
      + '那时压缩不再由你决定——请求会被拒，能压的只剩「下一次请求之前的你自己」。',
      '',
      '现在三选一，别不选：',
      '① 立刻写一块 checkpoint：哨兵 <!-- self-compact --> 或 <!-- handoff-compact -->，'
      + '后面跟 <compacted-summary> 外壳 + 按序 section；下一次输出就会把这块之前的历史换成它。',
      '② 明确决定不压、继续做（可以，但别假装没看见这条）。',
      '③ 换一个会话重新开始。',
    ].join('\n')
  }

  return [
    '⏱ 上下文水位 ' + percent + '%。',
    '',
    '这条只是告知：水位是代理指标（「下一轮请求大概多大」相对窗口的比例），不是本体，'
    + '框架不会替你压。',
    '',
    '你现在可以：',
    '① 写一块 checkpoint：哨兵 <!-- self-compact --> 或 <!-- handoff-compact -->，'
    + '后面跟 <compacted-summary> 外壳 + 按序 section，下一次输出就会把这块之前的历史换成它；',
    '② 什么都不做，继续手上的事——这条提醒不要求你现在决定；',
    '③ 换一个会话重新开始。',
  ].join('\n')
}
