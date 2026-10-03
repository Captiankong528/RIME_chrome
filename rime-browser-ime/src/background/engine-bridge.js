/**
 * 引擎通道：把一条引擎请求送到真正跑着 librime 的地方。
 *
 * 两套宿主靠**能力探测**选择，而不是嗅探浏览器名字（这样将来谁先补上 API 都不会选错）：
 *
 *   - 有 `chrome.offscreen.createDocument` → Chrome 那条路。引擎住在 offscreen
 *     document 里，中间必须经过一次 runtime.sendMessage；而且 `createDocument()`
 *     resolve ≠ 对面的 onMessage 已注册，所以请求要带退避重试。
 *
 *   - 没有 → Firefox 那条路。背景页（事件页）是一个真正的页面，可以直接持有
 *     Worker，于是引擎就地跑在本模块所在的上下文里，直接函数调用，一跳都不需要，
 *     也就没有「消息没投递」这回事。
 *
 * 代价写在 docs/ARCHITECTURE.md 的「Firefox：引擎为什么住在背景页」一节：
 * 事件页空闲会被卸载，引擎跟着死，下次按键要重新编译 wasm（用户词典在 IndexedDB
 * 里，不会丢）。
 */
import '../common/const.js'
import { createEngineHost } from '../engine/host.js'

/** @type {'offscreen'|'local'} */
export const MODE = typeof chrome !== 'undefined' &&
  chrome.offscreen &&
  typeof chrome.offscreen.createDocument === 'function'
  ? 'offscreen'
  : 'local'

/* ------------------------------------------------------------------ *
 * 状态上报
 * ------------------------------------------------------------------ */

let statusHandler = () => {}
/** 最近一次引擎状态。超时类错误要把「引擎最后说了什么」一起带出来才有得查 */
let lastStatus = {}

/**
 * 注册状态回调。两种模式最终都会调用它：
 *   - local：宿主直接回调；
 *   - offscreen：宿主先把状态发给 background，再由下面的 deliverStatus 转进来。
 */
export function onStatus (fn) {
  statusHandler = typeof fn === 'function' ? fn : () => {}
}

function reportStatus (status) {
  if (status && typeof status === 'object') lastStatus = status
  statusHandler(status)
}

/** 供 background 的消息路由在收到 offscreen 的状态消息时调用 */
export function deliverStatus (status) {
  reportStatus(status)
}

/* ------------------------------------------------------------------ *
 * Chrome：offscreen document
 * ------------------------------------------------------------------ */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html'
/** 等 offscreen 文档把消息监听器注册上来的上限 */
const OFFSCREEN_READY_TIMEOUT_MS = 15000

let creating = null
/** 本 SW 生命周期内是否成功建过 offscreen 文档 */
let offscreenCreated = false

/**
 * chrome.offscreen.hasDocument() 标注为 @since Chrome 150，不能当硬依赖。
 * 拿不到就退回自己记的状态，最坏情况下多调一次 createDocument——
 * 那会抛「只能有一个 offscreen 文档」，下面的 catch 会把它当成「已存在」。
 */
async function hasOffscreen () {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      return await chrome.offscreen.hasDocument()
    } catch (err) {
      // 落到下面的兜底
    }
  }
  return offscreenCreated
}

async function ensureOffscreen () {
  if (await hasOffscreen()) return
  if (creating) return creating
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: '在 Web Worker 中运行 librime(WebAssembly) 输入法引擎，需要比 service worker 更长的生命周期。'
    })
    .then(() => {
      offscreenCreated = true
    })
    .catch(err => {
      const message = String((err && err.message) || err)
      // 已经有文档了（可能是上个 SW 生命周期建的），不算失败：
      // 后面的 sendMessage 照样能送达
      if (/single offscreen|already exists|Only a single/i.test(message)) {
        offscreenCreated = true
        return
      }
      throw new Error(`创建 offscreen 文档失败：${message}`)
    })
    .finally(() => {
      creating = null
    })
  return creating
}

/**
 * 只有「对面根本没人接收」才值得重试——这类错误意味着消息压根没被投递，
 * 重发不会造成重复处理。业务错误（引擎报错）直接抛出去。
 */
const NOT_DELIVERED = /Receiving end does not exist|Could not establish connection|message port closed/i

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 把一条请求发给 offscreen 引擎并等结果。
 *
 * 这里必须带退避重试，否则第一次按键几乎必然失败：
 * `chrome.offscreen.createDocument()` resolve 的时候，offscreen 文档的模块脚本
 * 未必已经执行到 `chrome.runtime.onMessage.addListener`（那之前还有 createWorker()、
 * 错误监听注册、引擎启动）。在这个窗口里 sendMessage，Chrome 抛的正是
 * "Could not establish connection. Receiving end does not exist."，
 * 然后被原样回传给页面——看起来像 service worker 挂了，其实只是慢了几十毫秒。
 */
async function requestOffscreen (op, payload) {
  await ensureOffscreen()

  const deadline = Date.now() + OFFSCREEN_READY_TIMEOUT_MS
  let lastError = null

  for (;;) {
    try {
      const res = await chrome.runtime.sendMessage({ to: 'offscreen', op, payload })
      if (res) {
        if (!res.ok) throw new Error(res.error || '引擎执行失败')
        return res.result
      }
      lastError = new Error('offscreen 返回了空响应')
    } catch (err) {
      const message = String((err && err.message) || err)
      // 引擎本身报的错不该重试
      if (!NOT_DELIVERED.test(message)) throw err
      lastError = err
    }

    if (Date.now() >= deadline) {
      // 把引擎上报过的最后状态一并带出来：如果 offscreen 是加载期就崩了，
      // 这条信息往往就是唯一线索
      const detail = lastStatus && lastStatus.message ? `；引擎最后状态：${lastStatus.message}` : ''
      throw new Error(`offscreen 文档一直没有响应（等待 ${OFFSCREEN_READY_TIMEOUT_MS} ms）` +
        `${detail}；原始错误：${lastError ? lastError.message : '未知'}`)
    }
    await delay(200)
  }
}

/* ------------------------------------------------------------------ *
 * Firefox：背景页就地当宿主
 * ------------------------------------------------------------------ */

/** @type {ReturnType<typeof createEngineHost>|null} */
let localHost = null

/**
 * 惰性创建。刻意不在模块顶层创建：背景事件页会因为「改一次设置」这类无关事件
 * 被唤醒，那时不该白白编译 2.8 MB 的 wasm。真正要用引擎时再建——
 * 用户一开开关，background 的 warmUp() 就会发 STATUS，宿主随之诞生。
 */
function getLocalHost () {
  if (!localHost) {
    localHost = createEngineHost({ onStatus: reportStatus })
  }
  return localHost
}

async function requestLocal (op, payload) {
  const host = getLocalHost()
  // 等第一次 INIT 落定再把请求交给 Worker：否则首个 LOAD_SCHEMA 可能赶在
  // 「方案显示名 + 页大小」交给 api.cpp 之前，方案名会缺。
  await host.ready()
  return host.request(op, payload)
}

/* ------------------------------------------------------------------ *
 * 对外
 * ------------------------------------------------------------------ */

/** 引擎宿主是否已经起来（用来决定要不要去问状态） */
export async function hostExists () {
  if (MODE === 'offscreen') return hasOffscreen()
  return Boolean(localHost)
}

/**
 * 把一条请求送给引擎并等结果。
 * @param {string} op 见 common/const.js 的 OP
 * @param {object} [payload]
 */
export async function request (op, payload) {
  if (MODE === 'offscreen') return requestOffscreen(op, payload)
  return requestLocal(op, payload)
}
