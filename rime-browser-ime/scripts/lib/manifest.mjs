/**
 * Chrome 清单 → Firefox 清单。
 *
 * 单独成文件是为了让**构建脚本和静态自检用同一份转换**：
 * 如果转换只写在 build 里，check.mjs 就只能去读产物，一旦产物没生成就查不了；
 * 反过来，两边各写一套「删掉 offscreen、换成 background.scripts」也没意义。
 *
 * 差异清单（每一条都有原因，别随手改）：
 *   - background.service_worker → background.scripts
 *     Firefox 不支持 MV3 的 service worker（bug 1573659），只支持背景**页面**。
 *     用「scripts + type: module」而不是 page，是因为它和 SW 那份共享同一个入口文件。
 *   - 去掉 minimum_chrome_version：对 Firefox 无意义，留着只会误导。
 *   - permissions 去掉 offscreen：Firefox 没有这个 API，留着会在安装时报未知权限。
 *   - 加 browser_specific_settings.gecko：没有 id 就无法签名分发；
 *     strict_min_version 卡 109（MV3 从 109 开始）。
 *   - persistent 一律不写：MV3 下写 true 会直接报错。
 */

/**
 * 扩展在 Gecko 里的身份。**一旦发布就不能改**：改了等于换一个扩展，
 * 用户那边会变成「装两个」，覆盖升级也失效。往 AMO 提交前请换成自己的。
 */
export const GECKO_ID = 'rime-browser-ime@example.com'

/** Firefox 的 MV3 从 109 开始；wasm-unsafe-eval 需要 102+，两者取高者 */
export const GECKO_MIN_VERSION = '109.0'

/**
 * @param {object} chromeManifest manifest.json 的内容
 * @returns {object} Firefox 版清单（不修改入参）
 */
export function buildFirefoxManifest (chromeManifest) {
  const manifest = structuredClone(chromeManifest)

  delete manifest.minimum_chrome_version
  if (Array.isArray(manifest.permissions)) {
    manifest.permissions = manifest.permissions.filter(p => p !== 'offscreen')
  }

  const worker = manifest.background?.service_worker
  if (!worker) throw new Error('Chrome 清单里没有 background.service_worker，无法推导 Firefox 的背景脚本')
  manifest.background = {
    scripts: [worker],
    // 入口用的是 ES module 语法（import '../common/const.js'），必须声明
    type: 'module'
  }

  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION
    }
  }

  return manifest
}

/** 序列化成扩展根目录那种手写风格（2 空格缩进 + 结尾换行） */
export function serializeManifest (manifest) {
  return JSON.stringify(manifest, null, 2) + '\n'
}
