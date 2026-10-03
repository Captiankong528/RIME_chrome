/**
 * 背景脚本（Chrome 是 service worker，Firefox 是背景事件页）：路由 + 开关状态。
 *
 * 它自己不跑引擎——「引擎住在哪」整件事交给 src/background/engine-bridge.js：
 *   - Chrome：引擎在 offscreen document 里，bridge 负责创建、转发与退避重试；
 *   - Firefox：引擎就地跑在**本上下文**里（背景页是真正的页面，能直接持有 Worker）。
 * 所以本文件只管三件事：
 *   1. 把 content script 的引擎请求转给 engine-bridge，把结果带回去
 *   2. 缓存并广播引擎状态
 *   3. 管理「中/英」开关，并把状态变化广播到所有标签页的所有 frame
 */
import '../common/const.js'
import {
  MODE as ENGINE_MODE,
  request as engineRequest,
  hostExists as engineHostExists,
  onStatus as onEngineStatus,
  deliverStatus as deliverEngineStatus
} from './engine-bridge.js'

const { MSG, OP, ENGINE_STATE, DEFAULTS } = globalThis.RIME_CONST

const ENGINE_TIMEOUT_MS = 60000

const DEFAULT_SETTINGS = {
  enabled: false,
  schemaId: DEFAULTS.schemaId,
  pageSize: DEFAULTS.pageSize,
  /** 页面内是否显示右下角状态提示 */
  showHints: true
}

/** offscreen 文档上报的引擎状态缓存；SW 被回收后会重置，靠 queryStatus 补回 */
let engineStatus = { state: ENGINE_STATE.IDLE }

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

async function getSettings () {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS)
  return { ...DEFAULT_SETTINGS, ...stored }
}

function updateBadge (enabled) {
  const text = enabled ? '中' : 'EN'
  return Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1e5bd6' : '#8a8f98' })
  ])
}

/* ------------------------------------------------------------------ *
 * 引擎状态
 * ------------------------------------------------------------------ */

/**
 * 缓存 + 广播。两种宿主的状态最终都汇到这里：
 *   - Chrome：offscreen 文档发来 `{ to:'background', op:'engineStatus' }`（走消息路由）
 *   - Firefox：就地宿主在每次状态变化时直接回调
 */
async function applyEngineStatus ({ state, message, schemaId }) {
  engineStatus = { state, message, schemaId }
  await broadcast({ type: MSG.ENGINE_STATUS, payload: engineStatus })
  return { ok: true }
}

// 就地宿主（Firefox）走这条；offscreen 模式不会被触发，那边走消息路由
onEngineStatus(status => {
  applyEngineStatus(status).catch(() => { /* 页面可能刚好都关了 */ })
})

/* ------------------------------------------------------------------ *
 * 广播
 * ------------------------------------------------------------------ */

async function broadcast (message) {
  const tabs = await chrome.tabs.query({})
  await Promise.allSettled(
    tabs.filter(tab => typeof tab.id === 'number').map(tab => chrome.tabs.sendMessage(tab.id, message))
  )
}

/* ------------------------------------------------------------------ *
 * 开关
 * ------------------------------------------------------------------ */

async function setEnabled (enabled) {
  await chrome.storage.local.set({ enabled })
  await updateBadge(enabled)
  await broadcast({ type: MSG.SETTINGS_CHANGED, payload: { enabled } })
  if (enabled) warmUp().catch(err => console.warn('[rime] 预热失败', err))
}

let warming = null
/** 预热：先把 wasm 编译和方案装载跑起来 */
function warmUp (settings) {
  if (warming) return warming
  warming = (async () => {
    await engineRequest(OP.STATUS, {})
    const current = settings || (await getSettings())
    // offscreen 读不到 chrome.storage，页大小只能由这里下发
    await engineRequest(OP.SET_PAGE_SIZE, { size: current.pageSize })
    await engineRequest(OP.LOAD_SCHEMA, { schemaId: current.schemaId })
  })().finally(() => {
    setTimeout(() => { warming = null }, 1000)
  })
  return warming
}

async function toggleEnabled () {
  const { enabled } = await getSettings()
  await setEnabled(!enabled)
  return !enabled
}

/* ------------------------------------------------------------------ *
 * 注册小工具
 * ------------------------------------------------------------------ */

/**
 * 把监听器注册成「绝不抛错」。
 *
 * 这一层看起来多余，但它防的是一个很难查的事故：**模块顶层一旦抛错，
 * 整个 service worker 就加载失败**——连 chrome.runtime.onMessage 都注册不上。
 * 此时页面侧只会看到
 *   "Could not establish connection. Receiving end does not exist."
 * 而真正的原因（哪个 API 不存在）只躺在 chrome://extensions 的 Service Worker 控制台里。
 *
 * chrome.commands / chrome.action 这些 API 是否暴露取决于清单里对应的键，
 * 不能假定它们一定存在。
 */
function safeListen (target, event, handler) {
  try {
    const emitter = target && target[event]
    if (!emitter || typeof emitter.addListener !== 'function') {
      console.warn(`[rime] ${event} 不可用，跳过注册`)
      return false
    }
    emitter.addListener(handler)
    return true
  } catch (err) {
    console.warn(`[rime] 注册 ${event} 失败:`, err)
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

// 路由是整条链路的入口，所以刻意排在所有可选 API 注册之前
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  if (message.to === 'background') {
    const handler = BACKGROUND_HANDLERS[message.op]
    if (!handler) {
      sendResponse({ ok: false, error: `background 不认识的操作: ${message.op}` })
      return false
    }
    handler(message.payload || {}, sender)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }))
    return true
  }

  if (message.to === 'engine') {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('引擎响应超时')), ENGINE_TIMEOUT_MS)
    )
    Promise.race([engineRequest(message.op, message.payload), timeout])
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }))
    return true
  }

  // 发给 offscreen 的消息不归我管
  return false
})

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

/**
 * 冷启动后缓存是空的，这里补一次状态。
 * 所有内容脚本启动时都会问一次，所以必须去重，否则几百个 frame 会打出几百次跨进程调用。
 */
let statusQuery = null
async function refreshStatusOnce () {
  if (engineStatus.state !== ENGINE_STATE.IDLE) return
  if (!statusQuery) {
    statusQuery = (async () => {
      try {
        // 宿主还没起来就别去问了：没起来说明还没人用引擎，问了也只会白等一轮超时
        if (!(await engineHostExists())) return
        const status = await engineRequest(OP.STATUS, {})
        engineStatus = { state: ENGINE_STATE.READY, schemaId: status.schemaId }
      } catch (err) {
        engineStatus = { state: ENGINE_STATE.ERROR, message: String(err.message || err) }
      } finally {
        setTimeout(() => { statusQuery = null }, 1000)
      }
    })()
  }
  await statusQuery
}

const BACKGROUND_HANDLERS = {
  async getState () {
    const settings = await getSettings()
    await refreshStatusOnce()
    // 开关是开着的但引擎还没起来（比如浏览器刚启动），顺手预热一下，
    // 免得用户第一次按键要等好几秒
    if (settings.enabled && engineStatus.state === ENGINE_STATE.IDLE) {
      warmUp(settings).catch(() => {})
    }
    return { settings, engine: engineStatus, engineMode: ENGINE_MODE }
  },
  async setEnabled ({ enabled }) {
    await setEnabled(Boolean(enabled))
    return { enabled: Boolean(enabled) }
  },
  async toggle () {
    const enabled = await toggleEnabled()
    return { enabled }
  },
  async setSettings (patch) {
    await chrome.storage.local.set(patch)
    const settings = await getSettings()
    if (typeof patch.pageSize === 'number') {
      await engineRequest(OP.SET_PAGE_SIZE, { size: patch.pageSize })
    }
    if (patch.schemaId) {
      await engineRequest(OP.LOAD_SCHEMA, { schemaId: patch.schemaId })
    }
    if (patch.resetUserData) {
      await engineRequest(OP.RESET, {})
    }
    return settings
  },
  async engineStatus (status) {
    // 让 engine-bridge 也记一份：它超时时要靠这条信息说明「引擎最后说了什么」
    deliverEngineStatus(status)
    return applyEngineStatus(status)
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期（全部走 safeListen，注册失败也不影响上面的消息路由）
 * ------------------------------------------------------------------ */

safeListen(chrome.runtime, 'onInstalled', async () => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS)
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...stored })
  await updateBadge(Boolean((await getSettings()).enabled))
})

safeListen(chrome.runtime, 'onStartup', async () => {
  await updateBadge(Boolean((await getSettings()).enabled))
})

// 工具栏图标的点击**不在这里**：清单里配了 action.default_popup，
// 点图标由浏览器直接弹出 src/popup/popup.html（面板里有开关按钮，走上面的 toggle）。
// 配了 popup 之后 action 的点击事件永远不会触发，所以这里也不再注册它。
safeListen(chrome.commands, 'onCommand', command => {
  if (command === 'toggle-ime') {
    toggleEnabled().catch(err => console.error('[rime] 切换失败', err))
  }
})

safeListen(chrome.storage, 'onChanged', (changes, area) => {
  if (area !== 'local') return
  if (changes.enabled) {
    updateBadge(Boolean(changes.enabled.newValue))
  }
  broadcast({ type: MSG.SETTINGS_CHANGED, payload: changes }).catch(() => {})
})

// SW 冷启动时把徽标恢复成当前设置
getSettings().then(s => updateBadge(s.enabled)).catch(() => {})
