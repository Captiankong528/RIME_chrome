/**
 * RIME 引擎 Worker（DSH Desktop 插件版）。
 *
 * 与浏览器扩展版的差别只有一处：**它自己不发网络请求**。
 *
 * 扩展里的 worker 直接 `importScripts('rime.js')`，让 emscripten 从扩展目录里
 * 拉 rime.wasm / rime.data；在 DSH Desktop 里这条路不稳：渲染进程的请求带一个
 * 代际令牌头（`x-dsh-desktop-renderer`）才被放行，Worker 起的子请求未必排得上。
 * 所以这里改成「页面把字节喂进来」：
 *
 *   1. 页面在主线程 fetch 好 worker.js 源码、rime.js 源码、rime.wasm、rime.data；
 *   2. 用 Blob URL 起 worker，再 postMessage 把这些字节发过来；
 *   3. worker 自己把 wasm/data 交给 emscripten（wasmBinary / getPreloadedPackage），
 *      于是运行时不产生任何网络请求。方案文件同样由页面取好再发。
 *
 * 对外协议（postMessage）：
 *   boot  { channel: 'rime-engine', op: 'boot', payload: { rimeJsUrl, wasm, data, baseUrl } }
 *   请求  { channel: 'rime-engine', id, op, payload }
 *   响应  { channel: 'rime-engine', id, ok: true, result }
 *         { channel: 'rime-engine', id, ok: false, error }
 *   事件  { channel: 'rime-engine', event: 'status', ... }
 *
 * 整个文件包在 IIFE 里：importScripts 会把 rime.js 的 var 声明注入全局作用域，
 * 我们自己的 let/const 若也在全局词法环境里，重名就是 SyntaxError。
 */
;(function () {
  const RIME_SHARED = '/usr/share/rime-data'
  const RIME_USER = '/rime'

  /** 请求串行队列：librime 的会话不是可重入的 */
  let queue = Promise.resolve()

  let runtimeReady = false
  const runtimeWaiters = []

  let bootstrapped = false
  let currentSchema = null
  let pageSize = 5
  /** @type {Record<string, string>} schemaId -> 显示名 */
  let schemaNames = {}

  let persistTimer = null

  function postEvent (payload) {
    self.postMessage({ channel: 'rime-engine', event: 'status', ...payload })
  }

  /* ---------------------------------------------------------------- *
   * 1. boot：收到字节后给 Module 打补丁，再加载 emscripten 产物
   * ---------------------------------------------------------------- */

  function boot (payload) {
    const { rimeJsUrl, wasm, data, baseUrl } = payload || {}
    if (!rimeJsUrl) throw new Error('引擎 boot 缺少 rime.js')
    if (!wasm) throw new Error('引擎 boot 缺少 rime.wasm')

    self.Module = {
      /** 有它 emscripten 就不去 fetch wasm */
      wasmBinary: wasm,
      /** 有它 emscripten 就不去 fetch rime.data（预置数据包） */
      getPreloadedPackage: () => data,
      /** 兜底：万一还有别的资源，按页面给的绝对前缀解 */
      locateFile: (path) => new URL(path, baseUrl || self.location.href).href,
      print (text) {
        console.log('[librime]', text)
      },
      printErr (text) {
        // glog 的格式形如 `I20230901 12:00:00.000000 1234 foo.cc:12] message`
        const match = /^([EWID])\S+ \S+ \S+ (.*)$/.exec(text)
        if (!match) {
          console.warn('[librime]', text)
          return
        }
        const log = { E: console.error, W: console.warn, I: console.info, D: console.debug }[match[1]]
        log('[librime]', match[2])
      },
      onRuntimeInitialized () {
        runtimeReady = true
        while (runtimeWaiters.length) runtimeWaiters.shift()()
      },
      onAbort (what) {
        postEvent({ state: 'error', message: 'librime 运行时中止: ' + what })
      }
    }

    // 会同步求值 rime.js；wasm 与预置数据已经就位，靠 onRuntimeInitialized 通知
    importScripts(rimeJsUrl)
  }

  function whenRuntimeReady () {
    if (runtimeReady) return Promise.resolve()
    return new Promise(resolve => runtimeWaiters.push(resolve))
  }

  /* ---------------------------------------------------------------- *
   * 2. 基础工具
   * ---------------------------------------------------------------- */

  function ccall (name, returnType, argTypes, args) {
    return self.Module.ccall(name, returnType, argTypes, args)
  }

  function fs () {
    return self.Module.FS
  }

  /** 把 emscripten 的 syncfs 回调风格包成 Promise。read=true 表示从 IndexedDB 读回内存 */
  function syncUserDirectory (read) {
    return new Promise((resolve, reject) => {
      fs().syncfs(read, err => (err ? reject(err) : resolve()))
    })
  }

  function pathExists (p) {
    try {
      fs().lookupPath(p)
      return true
    } catch (e) {
      return false
    }
  }

  /* ---------------------------------------------------------------- *
   * 3. 启动流程
   * ---------------------------------------------------------------- */

  async function bootstrap () {
    if (bootstrapped) return
    await whenRuntimeReady()

    const FS = fs()
    // 用户目录挂在 IndexedDB 上，让词频/用户词典跨会话保留
    if (!pathExists(RIME_USER)) {
      FS.mkdir(RIME_USER)
      FS.mount(IDBFS, {}, RIME_USER) // eslint-disable-line no-undef
    }
    await syncUserDirectory(true)

    // api.cpp 的 init(): 填 RimeTraits 并 api->setup()
    ccall('init', 'null', [], [])
    for (const [id, name] of Object.entries(schemaNames)) {
      ccall('set_schema_name', 'null', ['string', 'string'], [id, name])
    }
    ccall('set_page_size', 'null', ['number'], [pageSize])

    bootstrapped = true
    postEvent({ state: 'ready' })
  }

  /* ---------------------------------------------------------------- *
   * 4. 操作实现
   * ---------------------------------------------------------------- */

  /**
   * 下发一组开关取值（例如简繁）。
   *
   * 必须在 set_ime 之后调用：set_ime 会 destroy + create session，开关会被重置回
   * 方案 yaml 里 switches 的 reset 值——朙月拼音的 simplification 就是 0 =「漢字」。
   */
  function applyOptions (options) {
    if (!options) return null
    const applied = {}
    for (const [option, value] of Object.entries(options)) {
      ccall('set_option', 'null', ['string', 'number'], [option, value ? 1 : 0])
      applied[option] = Boolean(value)
    }
    return applied
  }

  /**
   * 把预编译好的方案文件写进 librime 的共享目录，然后选中该方案。
   * 预编译文件来自 @rime-contrib/* 包（上游用原生 rime_api_console 部署好的产物），
   * 所以浏览器里不需要再跑一次完整部署。
   */
  async function loadSchema ({ id, files, options }) {
    await bootstrap()
    const FS = fs()
    const dir = `${RIME_SHARED}/build`
    if (!pathExists(dir)) FS.mkdirTree(dir)

    const written = []
    for (const file of files) {
      const target = `${dir}/${file.name}`
      if (pathExists(target)) continue
      FS.writeFile(target, new Uint8Array(file.data))
      written.push(file.name)
    }

    ccall('set_ime', 'null', ['string'], [id])
    currentSchema = id
    const applied = applyOptions(options)

    // set_ime 会在用户目录里写 session 相关文件，落回 IndexedDB
    await syncUserDirectory(false)

    return { schemaId: id, written, options: applied }
  }

  /** 词频写入不必卡住按键，攒一下再落盘 */
  function schedulePersist () {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      syncUserDirectory(false).catch(err => console.warn('[librime] 持久化失败', err))
    }, 400)
  }

  async function processKey (input) {
    await bootstrap()
    const result = JSON.parse(ccall('process', 'string', ['string'], [input]))
    if (result.committed) schedulePersist()
    return result
  }

  async function selectCandidate (index) {
    await bootstrap()
    const result = JSON.parse(ccall('select_candidate_on_current_page', 'string', ['number'], [index]))
    if (result.committed) schedulePersist()
    return result
  }

  async function changePage (backward) {
    await bootstrap()
    return JSON.parse(ccall('change_page', 'string', ['boolean'], [Boolean(backward)]))
  }

  async function setOption (option, value) {
    await bootstrap()
    ccall('set_option', 'null', ['string', 'number'], [option, value ? 1 : 0])
    return { option, value: Boolean(value) }
  }

  async function setPageSize (size) {
    await bootstrap()
    pageSize = size
    ccall('set_page_size', 'null', ['number'], [size])
    return { pageSize: size }
  }

  async function reset () {
    await whenRuntimeReady()
    if (!bootstrapped) return { reset: true }

    // 清空用户目录（用户词典、词频），再写回 IndexedDB
    const FS = fs()
    const walk = dir => {
      for (const entry of FS.readdir(dir)) {
        if (entry === '.' || entry === '..') continue
        const child = `${dir}/${entry}`
        if (FS.isDir(FS.lstat(child).mode)) {
          walk(child)
          FS.rmdir(child)
        } else {
          FS.unlink(child)
        }
      }
    }
    walk(RIME_USER)
    await syncUserDirectory(false)

    ccall('reset', 'null', [], [])
    bootstrapped = false
    currentSchema = null
    await bootstrap()
    return { reset: true }
  }

  const HANDLERS = {
    /** 启动前的预热：把方案显示名交给 api.cpp，并完成 FS/IDBFS/init */
    init: async ({ schemaNames: names, pageSize: size } = {}) => {
      if (names) schemaNames = names
      if (size) pageSize = size
      await bootstrap()
      return { state: 'ready' }
    },
    loadSchema,
    process: ({ input }) => processKey(input),
    selectCandidate: ({ index }) => selectCandidate(index),
    changePage: ({ backward }) => changePage(backward),
    setOption: ({ option, value }) => setOption(option, value),
    setPageSize: ({ size }) => setPageSize(size),
    reset,
    status: async () => {
      await bootstrap()
      return { state: 'ready', schemaId: currentSchema, pageSize }
    }
  }

  /* ---------------------------------------------------------------- *
   * 5. 消息循环
   * ---------------------------------------------------------------- */

  self.onmessage = event => {
    const msg = event.data
    if (!msg || msg.channel !== 'rime-engine') return

    if (msg.op === 'boot') {
      try {
        boot(msg.payload)
      } catch (error) {
        postEvent({ state: 'error', message: String((error && error.message) || error) })
      }
      return
    }

    if (typeof msg.id === 'undefined') return
    const handler = HANDLERS[msg.op]
    const reply = (ok, payload) => {
      self.postMessage({ channel: 'rime-engine', id: msg.id, ok, ...payload })
    }
    if (!handler) {
      reply(false, { error: `未知操作: ${msg.op}` })
      return
    }
    queue = queue.then(async () => {
      try {
        reply(true, { result: await handler(msg.payload || {}) })
      } catch (err) {
        console.error('[librime]', msg.op, err)
        reply(false, { error: String((err && err.message) || err) })
      }
    })
  }
})()
