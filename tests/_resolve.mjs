/**
 * 测试夹具的路径解析与「跳过」策略（2026-11-15）
 *
 * ## 为什么要有这个文件
 *
 * 三个测试档（`archive` / `compact-range` / `owner-turn`）原本把宿主源码树钉死在
 * `E:/alice/deepseek-harness`，那是**另一台机器**的布局。本机没有那个目录，于是它们在
 * 顶部 `process.exit(0)`，而 `node --test` 把退出码 0 记成 **pass**——回归面看起来全绿，
 * 实际上一条断言都没跑。文件头自己写着「假绿」的警告，然后自己踩了。
 *
 * 两件事一起修：
 * 1. **认得本机的真实位置**：宿主包就在本仓的 `node_modules/@deepseek-ai/*` 里
 *    （插件依赖它们），不需要源码树。
 * 2. **跳过默认判红**：缺依赖不是「没事」，是「这个档今天没验任何东西」。
 *    确实要在缺依赖的机器上放行，设 `DSH_ALLOW_TEST_SKIP=1`（会打出一行醒目的 skip）。
 *
 * ## 为什么默认红而不是默认绿
 *
 * 红的代价是噪音，绿的代价是谎。三个档静默跳过这件事已经骗过一次，不能再有第二次。
 *
 * @module tests/_resolve
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件仓根目录（`tests/` 的上一级）。 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析一个宿主包的 `lib/index.js`。
 *
 * **只认 `DSH_HARNESS_ROOT`，不认本目录的 `node_modules`。** 这不是偷懒，是 `package.json`
 * 的 `_comment_typeResolution` 明文规定的：本目录**不得**存在 `@deepseek-ai` 真实副本，
 * 否则会遮蔽宿主 link farm、导致 API/class 身份漂移。
 *
 * 2026-11-15 实测踩过这个坑：本目录确实躺着一批 registry 副本（`dsh-session@0.2.2-rc.2`），
 * 它 `import '@deepseek-ai/dsh-scope'` 而这包没装 —— 文件在、载入就炸。**在，不等于能用。**
 * @param {string} packageName - 例：`dsh-session`（仅用于错误信息）
 * @param {string} sourceTreePath - 源码树形态的相对路径，例：`packages/core/session/lib/index.js`
 * @returns {string | undefined} 存在的绝对路径
 */
export function harnessLib(packageName, sourceTreePath) {
  if (!process.env.DSH_HARNESS_ROOT) return undefined
  const candidate = join(process.env.DSH_HARNESS_ROOT, sourceTreePath)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 解析本插件自己的产物（`lib/xxx.js`）。
 * @param {string} relative - 相对插件根，例：`lib/archive.js`
 * @returns {string | undefined} 存在的绝对路径
 */
export function pluginLib(relative) {
  const candidate = join(process.env.DSH_COMPACT_ROOT ?? repoRoot, relative)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 缺依赖时的收场：**默认判红**，只有显式放行才跳过。
 *
 * 用 `process.exit(1)` 而不是抛异常：`node --test` 对「文件级退出码」的处理更干净
 * （抛错会混在断言失败里，看起来像某条断言坏了，而实际上是整个档没跑）。
 * @param {string} what - 缺了什么
 * @returns {never}
 */
export function skipOrFail(what) {
  if (process.env.DSH_ALLOW_TEST_SKIP === '1') {
    console.error(`[skip] ${what}（已设 DSH_ALLOW_TEST_SKIP=1，本轮不验这个档）`)
    process.exit(0)
  }
  console.error(`[FAIL] ${what}`)
  console.error('这个测试档**没有跑任何断言**。静默跳过会让回归面看起来是绿的——')
  console.error('2026-11-15 实测：三个档这样被记成 pass。所以缺依赖默认判红。')
  console.error('真要在缺依赖的机器上放行：DSH_ALLOW_TEST_SKIP=1')
  process.exit(1)
}

/**
 * 载入一个产物：路径缺失、或**载入本身失败**，都走 {@link skipOrFail}。
 *
 * 为什么还要接住载入失败（2026-11-15 实测）：本机 `node_modules/@deepseek-ai/dsh-session`
 * 是个**只能给 tsc 用的残缺副本**——它 `import '@deepseek-ai/dsh-scope'`，而那个包没装，
 * 于是 `import()` 直接 `ERR_MODULE_NOT_FOUND`。文件在，不等于能用；把这两种情况分开报，
 * 下一个人就不用再查一遍「为什么路径明明存在还加载失败」。
 * @param {string | undefined} absolutePath - 已解析的绝对路径
 * @param {string} what - 给人看的名字
 * @returns {Promise<any>} 模块命名空间
 */
export async function importOrFail(absolutePath, what) {
  if (absolutePath === undefined) {
    skipOrFail(`${what}：没有可用的宿主运行时。`
      + '本机没有 DSH_HARNESS_ROOT 指向的源码树，而本目录的 @deepseek-ai/* 副本是'
      + ' package.json `_comment_typeResolution` 明令不得使用的 registry 副本（会遮蔽宿主）。'
      + '要真跑这个档，把 DSH_HARNESS_ROOT 指到宿主源码树；否则本档验不了东西。')
  }
  try {
    return await import(pathToFileURL(absolutePath).href)
  } catch (error) {
    skipOrFail(`${what}：文件在（${absolutePath}）但载入失败 —— ${error instanceof Error ? error.message : String(error)}`)
  }
}
