/**
 * RIME 引擎 Worker。
 *
 * 这是一个「普通」Worker（不是 module worker），因为上游的 rime.js 是 emscripten
 * 生成的经典脚本：它读取全局的 Module 变量、按相对路径拉取同目录下的
 * rime.wasm / rime.data，并且用 importScripts 加载最省事。
 *
 * 因此本文件必须和 rime.js / rime.wasm / rime.data 放在同一个目录。
 *
 * 整个文件包在一个 IIFE 里：importScripts 会把 rime.js 的 var 声明注入**全局**
 * 作用域，如果我们自己的 let/const 也待在全局词法环境里，一旦重名就是
 * "Identifier has already been declared" 的 SyntaxError。放进函数作用域就彻底隔离了。
 *
 * 对外协议（postMessage）：
 *   请求  { channel: 'rime-engine', id, op, payload }
 *   响应  { channel: 'rime-engine', id, ok: true, result }
 *         { channel: 'rime-engine', id, ok: false, error }
 *   事件  { channel: 'rime-engine', event: 'status', ... }
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

  /* ---------------------------------------------------------------- *
   * 1. 给 Module 打补丁，然后加载 emscripten 产物
   * ---------------------------------------------------------------- */

  self.Module = {
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

  // 会同步求值 rime.js；wasm 与预置数据是异步就绪的，靠 onRuntimeInitialized 通知
  importScripts('rime.js')

  function whenRuntimeReady () {
    if (runtimeReady) return Promise.resolve()
    return new Promise(resolve => runtimeWaiters.push(resolve))
  }

  /* ---------------------------------------------------------------- *
   * 2. 基础工具
   * ---------------------------------------------------------------- */

  function postEvent (payload) {
    self.postMessage({ channel: 'rime-engine', event: 'status', ...payload })
  }

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
   * **必须在 set_ime 之后调用**：set_ime 会 destroy + create session，开关会被重置回
   * 方案 yaml 里 switches 的 reset 值——朙月拼音的 simplification 就是 0 =「漢字」，
   * 所以「切一次方案就回到繁体」这件事只有在这里补一刀才能修正。
   *
   * @param {Record<string, boolean>|null|undefined} options
   * @returns {Record<string, boolean>|null} 实际下发的取值（调用方/测试可核对）
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
   *
   * @param {{ id: string, files: { name: string, data: ArrayBuffer }[],
   *           options?: Record<string, boolean>|null }} payload
   *        options 由 offscreen 按浏览器语言算好（见 common/const.js 的 tradSimpDefault）
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
    if (!msg || msg.channel !== 'rime-engine' || typeof msg.id === 'undefined') return
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
