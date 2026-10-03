/**
 * content script 入口：装配控制器、挂全局监听、和 background 同步开关状态。
 *
 * 每个 frame（含 iframe）都会跑一份，这样焦点在 iframe 里时也能正常输入。
 */
;(function (NS) {
  const { MSG, STORAGE_KEYS } = globalThis.RIME_CONST

  const controller = new NS.ImeController()
  NS.controller = controller

  /** 用回调式 sendMessage，避免扩展被重新加载时抛出 promise 异常 */
  function safeSend (message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            resolve(null)
            return
          }
          resolve(response)
        })
      } catch (e) {
        resolve(null)
      }
    })
  }

  async function syncState () {
    const response = await safeSend({ to: 'background', op: 'getState' })
    if (!response || !response.ok) return
    const { settings, engine } = response.result
    controller.setSettings(settings)
    controller.setEnabled(Boolean(settings.enabled))
    if (engine) controller.handleEngineStatus(engine)
  }

  /* ---------------- 状态栏偏好 ---------------- */

  /**
   * 状态栏自己那两个偏好（简繁 / 是否收起）直接存在 chrome.storage.local：
   * content script 本来就有 storage 权限，而它们是**每个标签页自己的界面状态**，
   * 让 background 再转发一层没有意义。跨标签页同步靠下面的 storage.onChanged。
   */
  async function syncStatusBarPrefs () {
    try {
      const stored = await chrome.storage.local.get({
        [STORAGE_KEYS.tradSimp]: 'auto',
        [STORAGE_KEYS.collapsed]: false
      })
      controller.setStatusBarPrefs({
        tradSimp: stored[STORAGE_KEYS.tradSimp],
        collapsed: stored[STORAGE_KEYS.collapsed]
      })
    } catch (e) {
      // 拿不到就用默认值（跟随浏览器语言、展开）
    }
  }

  /* ---------------- 键盘 ---------------- */

  // 捕获阶段拦截，抢在页面自己的处理器之前
  window.addEventListener('keydown', event => controller.onKeydown(event), true)
  window.addEventListener('keyup', event => controller.onKeyup(event), true)

  /* ---------------- 候选窗跟随 ---------------- */

  // 滚动事件的触发频率远高于渲染帧率，用 rAF 压一下，
  // 免得每次滚动都重建一次镜像 div
  let repositionScheduled = false
  const reposition = () => {
    if (repositionScheduled) return
    repositionScheduled = true
    requestAnimationFrame(() => {
      repositionScheduled = false
      controller.reposition()
    })
  }
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition, true)

  /* ---------------- 和 background 的消息 ---------------- */

  chrome.runtime.onMessage.addListener(message => {
    if (!message || typeof message !== 'object') return
    if (message.type === MSG.SETTINGS_CHANGED) {
      applySettings(message.payload || {})
      return
    }
    if (message.type === MSG.ENGINE_STATUS) {
      controller.handleEngineStatus(message.payload || {})
    }
  })

  /** 广播和 storage 变更两种来源统一在这里落地 */
  function applySettings (payload) {
    const value = key => {
      const item = payload[key]
      if (!item) return undefined
      return item !== null && typeof item === 'object' && 'newValue' in item ? item.newValue : item
    }
    const enabled = value('enabled')
    if (typeof enabled === 'boolean') controller.setEnabled(enabled)
    const schemaId = value('schemaId')
    const pageSize = value('pageSize')
    if (schemaId || typeof pageSize === 'number') controller.setSettings({ schemaId, pageSize })

    // 状态栏的两个偏好也走同一条路：storage 变更（别的标签页改的）会到这里
    const tradSimp = value(STORAGE_KEYS.tradSimp)
    const collapsed = value(STORAGE_KEYS.collapsed)
    if (typeof tradSimp === 'string' || typeof collapsed === 'boolean') {
      controller.setStatusBarPrefs({ tradSimp, collapsed })
    }
  }

  // 有些宿主（例如扩展自己的演练场页面）收不到 tabs.sendMessage 广播，
  // 直接监听 storage 变化作为兜底
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') applySettings(changes)
    })
  } catch (e) { /* 无 storage 权限时忽略 */ }

  /* ---------------- 生命周期 ---------------- */

  window.addEventListener('pagehide', () => controller.reset(false), true)
  window.addEventListener('pageshow', () => syncState(), true)

  // 先读状态栏偏好再同步开关：不然 setEnabled(true) 会先用「跟随语言」下发一遍简繁，
  // 读完偏好又下发一遍，白跑一趟
  ;(async () => {
    await syncStatusBarPrefs()
    await syncState()
  })()
})(globalThis.RIME_CS)
