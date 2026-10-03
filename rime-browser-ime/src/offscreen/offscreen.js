/**
 * 引擎宿主（offscreen document）—— Chrome 那条路的外壳。
 *
 * 引擎本体已经搬到 src/engine/host.js（平台无关，Firefox 的背景页也复用它）。
 * 这里只剩三件只有 offscreen 文档才要做的事：
 *   1. 把宿主的状态转成一条发给 background 的消息
 *   2. 把 background 转发过来的请求交给宿主
 *   3. 接住本页面的未捕获异常——offscreen 是独立页面，异常不会自动冒到别处，
 *      不接住的话用户只会看到「敲了字，什么也没发生」
 *
 * 为什么 Chrome 必须走 offscreen 而不是像 Firefox 那样就地跑在 background 里：
 *   - MV3 的 service worker 空闲约 30 秒被回收，而 librime 初始化要编译 2.8 MB
 *     wasm + 读 1.1 MB 预置数据，每次唤醒重建实例会让第一次按键明显卡顿；
 *   - SW 的 CSP 由浏览器固定，不允许 `wasm-unsafe-eval`，wasm 压根编译不了。
 */
import '../common/const.js'
import { createEngineHost } from '../engine/host.js'

const host = createEngineHost({
  onStatus: status => chrome.runtime.sendMessage({ to: 'background', op: 'engineStatus', payload: status })
})

// 模块级注册：漏网的异常也要变成一条能看见的状态
self.addEventListener('error', event => {
  host.fail(`offscreen 异常：${(event && event.message) || '未知错误'}`)
})
self.addEventListener('unhandledrejection', event => {
  const reason = event && event.reason
  host.fail(`offscreen 未处理的 Promise 拒绝：${(reason && reason.message) || reason}`)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.to !== 'offscreen') return false
  host.request(message.op, message.payload || {})
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }))
  return true // 异步响应
})
