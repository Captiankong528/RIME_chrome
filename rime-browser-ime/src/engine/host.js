/**
 * RIME 引擎宿主（平台无关）。
 *
 * 这段逻辑原先长在 src/offscreen/offscreen.js 里。要同时支持 Chrome 与 Firefox
 * 就必须把它抽出来，因为两边「引擎住在哪」根本不同：
 *
 *   - Chrome：MV3 只有 service worker，而 SW 空闲约 30 秒就被回收、CSP 也不允许
 *     在 SW 里编译 wasm，所以引擎必须住在 offscreen document 里。
 *     src/offscreen/offscreen.js 就是这条路的外壳。
 *   - Firefox：没有 chrome.offscreen，但背景页是一个**真正的页面**（事件页），
 *     可以直接持有 Worker，于是引擎就地跑在背景页里，整整少了一跳。
 *     src/background/engine-bridge.js 是这条路。
 *
 * 两边共用的就是本文件：创建 Worker、按需读方案文件、把请求转成对 Worker 的 RPC。
 * 唯一的差异是「状态往哪报」，所以由调用方通过 onStatus 注入。
 *
 * 注意：本文件顶层**不许有副作用**。Chrome 的 service worker 会静态 import 它
 * （即使那条路根本不创建宿主），顶层一旦抛错，整个 SW 就注册不上消息路由。
 */
import '../common/const.js'

/**
 * @param {{ onStatus?: (status: {state: string, message?: string, schemaId?: string}) => void,
 *           locale?: string }} [options]
 */
export function createEngineHost (options = {}) {
  const { onStatus = () => {} } = options
  const { OP, ENGINE_STATE, DEFAULTS, SCHEMAS, tradSimpDefault } = globalThis.RIME_CONST

  /**
   * 浏览器界面语言，只用来决定简繁默认值：zh-TW / zh-HK / zh-MO / zh-Hant 出繁体，
   * 其余（含 en-US / zh-CN）出简体。两种宿主都是普通页面，navigator.language 就是
   * 浏览器界面语言；拿不到时退回 'en'（= 简体），别让整条链路因为 undefined 断掉。
   */
  const locale = options.locale || (globalThis.navigator && globalThis.navigator.language) || 'en'

  /* ---------------------------------------------------------------- *
   * 状态上报
   * ---------------------------------------------------------------- */

  /** @type {{ state: string, message?: string, schemaId?: string }} */
  let engineStatus = { state: ENGINE_STATE.IDLE }

  /**
   * 上报状态。**必须吞掉一切异常**：上报这条链路（Chrome 下是一次
   * runtime.sendMessage）本身会失败，而失败的原因通常正是引擎挂了——
   * 让它反过来把引擎的调用栈带崩，就再也看不到真正的原因了。
   */
  function setStatus (status) {
    engineStatus = status
    try {
      const result = onStatus(status)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch (error) {
      console.warn('[rime] 引擎状态上报失败:', error)
    }
  }

  /* ---------------------------------------------------------------- *
   * Worker RPC
   * ---------------------------------------------------------------- */

  let seq = 0
  const pending = new Map()
  /** Worker 起不来时的原因；有值就说明引擎这条路已经断了 */
  let workerFailure = ''
  /** @type {Worker|null} */
  let worker = null

  function handleWorkerMessage (event) {
    const msg = event.data
    if (!msg || msg.channel !== 'rime-engine') return
    if (msg.event === 'status') {
      setStatus({ state: msg.state, message: msg.message })
      return
    }
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.ok) waiter.resolve(msg.result)
    else waiter.reject(new Error(msg.error))
  }

  function handleWorkerError (event) {
    fail(event && event.message ? event.message : '引擎 Worker 加载失败')
  }

  /** 统一把「这条路走不通了」告知所有等待者，并推给调用方显示出来 */
  function fail (message) {
    workerFailure = message
    setStatus({ state: ENGINE_STATE.ERROR, message })
    for (const waiter of pending.values()) waiter.reject(new Error(message))
    pending.clear()
    return new Error(message)
  }

  /**
   * 这里刻意包一层：如果 new Worker 本身就抛（例如 CSP 不允许），
   * 宿主的外壳会整个失效，连错误都报不出来。
   */
  function createWorker () {
    try {
      // 用 import.meta.url 而不是 chrome.runtime.getURL：本文件在扩展包里，
      // 两种宿主下都会解析成 <扩展根>/src/engine/worker.js，且离线测试里
      // 也能用真实的 file:// URL 把 worker.js 跑起来。
      const instance = new Worker(new URL('./worker.js', import.meta.url))
      instance.onmessage = handleWorkerMessage
      instance.onerror = handleWorkerError
      worker = instance
    } catch (error) {
      worker = null
      fail(`无法创建引擎 Worker：${(error && error.message) || error}`)
    }
  }

  function rpc (op, payload) {
    if (!worker) {
      return Promise.reject(new Error(workerFailure || '引擎 Worker 未就绪'))
    }
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      worker.postMessage({ channel: 'rime-engine', id, op, payload })
    })
  }

  createWorker()

  /* ---------------------------------------------------------------- *
   * 方案文件
   * ---------------------------------------------------------------- */

  /** @type {Map<string, Promise<{name: string, data: ArrayBuffer}[]>>} */
  const schemaFileCache = new Map()

  async function fetchSchemaFiles (targets) {
    const key = targets.join(',')
    if (schemaFileCache.has(key)) return schemaFileCache.get(key)

    const promise = (async () => {
      const manifestUrl = chrome.runtime.getURL('schemas/manifest.json')
      const manifest = await (await fetch(manifestUrl)).json()
      const files = []
      for (const target of targets) {
        const entry = manifest.find(item => item.target === target)
        if (!entry) throw new Error(`schemas/manifest.json 里没有 ${target}，请先运行 scripts/fetch-assets.mjs`)
        for (const name of entry.files) {
          const url = chrome.runtime.getURL(`schemas/${target}/${name}`)
          const res = await fetch(url)
          if (!res.ok) throw new Error(`读取方案文件失败: schemas/${target}/${name}`)
          files.push({ name, data: await res.arrayBuffer() })
        }
      }
      return files
    })()

    schemaFileCache.set(key, promise)
    return promise
  }

  let loadedSchemaId = null
  let loadingSchemaId = null

  /**
   * 宿主自己记住的设置。
   *
   * 不读 chrome.storage 是历史原因：**Chrome 的 offscreen 文档里 chrome.storage 是
   * undefined**（只暴露极少几个 API），在模块顶层读它会让整个文档加载失败。
   * 就地宿主（Firefox 背景页）本来有 storage，但保持「设置一律由调用方随请求下发」
   * 这一条，两种宿主的行为才完全一致，离线测试里也才好替身。
   */
  const settings = {
    schemaId: DEFAULTS.schemaId,
    pageSize: DEFAULTS.pageSize
  }

  async function ensureSchema (schemaId) {
    // 调用方忘了带 schemaId 时退回自己记住的默认方案，别让整条链路因为 undefined 断掉
    if (!schemaId) schemaId = settings.schemaId || DEFAULTS.schemaId
    if (loadedSchemaId === schemaId) return { schemaId, cached: true }
    if (loadingSchemaId === schemaId) return { schemaId, joined: true }

    const schema = SCHEMAS.find(item => item.id === schemaId)
    if (!schema) throw new Error(`未注册的方案: ${schemaId}`)

    loadingSchemaId = schemaId
    setStatus({ state: ENGINE_STATE.LOADING, message: `正在装载 ${schema.name}…` })
    try {
      const files = await fetchSchemaFiles(schema.targets)
      // 简繁默认值按浏览器语言算，跟着方案一起下发：引擎每次 set_ime 都会把开关
      // 重置回方案 yaml 的 reset 值，所以这一刀必须由装载方（我们）补。
      const variant = tradSimpDefault(schemaId, locale)
      const result = await rpc(OP.LOAD_SCHEMA, {
        id: schemaId,
        files,
        options: variant ? { ...variant.options } : null
      })
      loadedSchemaId = schemaId
      setStatus({ state: ENGINE_STATE.READY, schemaId })
      return result
    } catch (err) {
      setStatus({ state: ENGINE_STATE.ERROR, message: String(err.message || err) })
      throw err
    } finally {
      loadingSchemaId = null
    }
  }

  /* ---------------------------------------------------------------- *
   * 启动预热
   * ---------------------------------------------------------------- */

  const schemaNames = Object.fromEntries(SCHEMAS.map(s => [s.id, s.name]))

  let booting = null

  /**
   * 把引擎拉起来。要不要顺带装载方案由调用方决定。
   * @param {{ schemaId?: string, pageSize?: number, autoLoadSchema?: boolean }} [opts]
   */
  function bootstrap (opts = {}) {
    if (opts.schemaId) settings.schemaId = opts.schemaId
    if (opts.pageSize) settings.pageSize = opts.pageSize
    if (booting) return booting

    setStatus({ state: ENGINE_STATE.LOADING, message: '正在加载 RIME 引擎…' })
    booting = (async () => {
      // init 会把方案显示名交给 api.cpp，并顺带做 FS/IDBFS 初始化
      await rpc(OP.INIT, { schemaNames, pageSize: settings.pageSize })
      setStatus({ state: ENGINE_STATE.READY })
      if (opts.autoLoadSchema !== false) {
        await ensureSchema(settings.schemaId)
      }
    })()
      .catch(err => {
        setStatus({ state: ENGINE_STATE.ERROR, message: String((err && err.message) || err) })
        throw err
      })
      // 失败后允许再试（比如浏览器刚好在那一刻被回收/换页）
      .finally(() => { booting = null })

    return booting
  }

  // 宿主一诞生就把 wasm 编译 + rime.data 装载跑起来，省掉第一次按键的等待。
  // 这里刻意不读 chrome.storage，用默认值即可；真正的方案与页大小随后由
  // background 通过 loadSchema / setPageSize 下发。
  const firstInit = bootstrap({ autoLoadSchema: false }).catch(() => { /* 失败已经通过状态广播出去了 */ })

  /**
   * 第一次 INIT 是否已经落定。就地宿主在收到第一个请求前等一下它，
   * 免得方案的显示名/页大小还没交给 api.cpp 就开始装载方案。
   * 失败时不 reject——真正的错误交给具体请求去抛，报错更精确。
   */
  function ready () {
    return firstInit
  }

  /* ---------------------------------------------------------------- *
   * 请求分发
   * ---------------------------------------------------------------- */

  const HANDLERS = {
    async [OP.PROCESS] ({ input, schemaId }) {
      await ensureSchema(schemaId)
      return rpc(OP.PROCESS, { input })
    },
    async [OP.SELECT_CANDIDATE] ({ index, schemaId }) {
      await ensureSchema(schemaId)
      return rpc(OP.SELECT_CANDIDATE, { index })
    },
    async [OP.CHANGE_PAGE] ({ backward, schemaId }) {
      await ensureSchema(schemaId)
      return rpc(OP.CHANGE_PAGE, { backward })
    },
    [OP.SET_OPTION]: payload => rpc(OP.SET_OPTION, payload),
    async [OP.SET_PAGE_SIZE] (payload) {
      settings.pageSize = payload.size
      return rpc(OP.SET_PAGE_SIZE, payload)
    },
    async [OP.RESET] (payload) {
      const result = await rpc(OP.RESET, payload)
      loadedSchemaId = null
      return result
    },
    async [OP.LOAD_SCHEMA] ({ schemaId }) {
      if (schemaId) settings.schemaId = schemaId
      return ensureSchema(schemaId)
    },
    [OP.STATUS]: async ({ schemaId } = {}) => {
      const status = await rpc(OP.STATUS, {})
      if (schemaId) status.loaded = loadedSchemaId === schemaId
      return { ...status, engine: engineStatus }
    }
  }

  /** 执行一条引擎请求（协议与 common/const.js 的 OP 一致） */
  async function request (op, payload) {
    const handler = HANDLERS[op]
    if (!handler) throw new Error(`引擎宿主不认识的操作: ${op}`)
    return handler(payload || {})
  }

  return {
    request,
    bootstrap,
    ready,
    fail,
    get status () { return engineStatus },
    get loadedSchemaId () { return loadedSchemaId },
    get settings () { return { ...settings } }
  }
}
