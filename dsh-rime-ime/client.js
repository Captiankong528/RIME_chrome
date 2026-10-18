/**
 * RIME 输入法插件的 Client 半边（浏览器里跑的那一半）。
 *
 * 它做四件事：
 *   1. 在 DSH 的会话输入框（Lexical contenteditable）上截获按键，翻成 RIME 按键串；
 *   2. 把按键送给 Worker 里的 librime（引擎字节由 Host 的 /rime-ime 路由供给）；
 *   3. 把候选窗画在输入卡片上方（`conversation.input.overlay` 槽位）；
 *   4. 把选中的词通过 `inputActions.insertText` 上屏——走宿主自己的编辑器 API，
 *      不去改 DOM，所以草稿、撤销、占位符、提交全都和平常一样。
 *
 * 另外注册一个「中/EN」状态胶囊到 `conversation.input.right`，点它切换输入法，
 * 点方案名打开方案菜单。
 *
 * 这个文件是纯 JS（没有构建步骤），由 dsh 的 Client 模块加载器以
 * `window.__ModuleLoader__.load({ id, factory })` 的形式装进页面；React 从模块表里取。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-rime-ime',
  factory (require) {
    const React = require('react')
    const { useEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    /** Host 路由前缀（页面相对路径：App 的路由是 document-relative 的）。 */
    const BASE = 'rime-ime/'
    /** locale 命名空间。 */
    const NS = 'rime-ime'
    /** localStorage 前缀。 */
    const STORAGE = 'dsh-rime-ime.'

    const OP = {
      STATUS: 'status',
      INIT: 'init',
      LOAD_SCHEMA: 'loadSchema',
      PROCESS: 'process',
      SELECT_CANDIDATE: 'selectCandidate',
      CHANGE_PAGE: 'changePage',
      SET_OPTION: 'setOption',
      SET_PAGE_SIZE: 'setPageSize',
      RESET: 'reset'
    }

    /** librime 回传的 state 枚举（见上游 wasm/api.cpp） */
    const RIME_STATE = { COMMITTED: 0, ACCEPTED: 1, REJECTED: 2, UNHANDLED: 3 }

    /**
     * 随包分发的方案。targets 是运行所需的全部 schemas/<target>/ 目录
     * （含反查依赖）；与 scripts/prepare-assets.mjs 里的 TARGETS 必须一致。
     */
    const SCHEMAS = [
      { id: 'luna_pinyin', name: '朙月拼音', group: '音码', targets: ['luna-pinyin', 'stroke'] },
      { id: 'luna_pinyin_fluency', name: '朙月拼音·语句流', group: '音码', targets: ['luna-pinyin', 'stroke'] },
      { id: 'pinyin_simp', name: '袖珍简拼', group: '音码', targets: ['pinyin-simp', 'stroke'] },
      { id: 'double_pinyin', name: '自然码双拼', group: '双拼', targets: ['double-pinyin', 'luna-pinyin', 'stroke'] },
      { id: 'double_pinyin_flypy', name: '小鹤双拼', group: '双拼', targets: ['double-pinyin', 'luna-pinyin', 'stroke'] },
      { id: 'double_pinyin_mspy', name: '微软双拼', group: '双拼', targets: ['double-pinyin', 'luna-pinyin', 'stroke'] },
      { id: 'double_pinyin_abc', name: '智能ABC双拼', group: '双拼', targets: ['double-pinyin', 'luna-pinyin', 'stroke'] },
      { id: 'double_pinyin_pyjj', name: '拼音加加双拼', group: '双拼', targets: ['double-pinyin', 'luna-pinyin', 'stroke'] },
      { id: 'wubi86', name: '86五笔', group: '形码', targets: ['wubi', 'pinyin-simp', 'stroke'] },
      { id: 'wubi_pinyin', name: '86五笔·拼音', group: '形码', targets: ['wubi', 'pinyin-simp', 'stroke'] },
      { id: 'wubi_trad', name: '86五笔·繁体', group: '形码', targets: ['wubi', 'pinyin-simp', 'stroke'] },
      { id: 'stroke', name: '五笔画', group: '形码', targets: ['stroke', 'luna-pinyin'] }
    ]

    /**
     * 简繁开关。librime 每次 set_ime 都会把开关重置回方案 yaml 的 reset 值
     * （朙月拼音 reset 成繁体），所以装载方案之后必须按用户偏好重新下发一遍。
     */
    const TRAD_SIMP = {
      luna_pinyin: binaryVariants(),
      luna_pinyin_fluency: binaryVariants(),
      double_pinyin: binaryVariants(),
      double_pinyin_flypy: binaryVariants(),
      double_pinyin_mspy: binaryVariants(),
      double_pinyin_abc: binaryVariants(),
      double_pinyin_pyjj: binaryVariants()
    }

    function binaryVariants () {
      return [
        { name: '简', options: { simplification: true } },
        { name: '繁', options: { simplification: false } }
      ]
    }

    /** 浏览器语言是不是繁体地区（zh-TW / zh-HK / zh-MO / zh-Hant 系） */
    function prefersTraditional (locale) {
      const tags = String(locale || '').toLowerCase().split(/[-_]/).filter(Boolean)
      return tags.some(tag => tag === 'tw' || tag === 'hk' || tag === 'mo' || tag === 'hant')
    }

    function tradSimpVariant (schemaId, locale, preference) {
      const variants = TRAD_SIMP[schemaId]
      if (!variants) return null
      if (preference && preference !== 'auto') {
        const picked = variants.find(variant => variant.name === preference)
        if (picked) return picked
      }
      return variants.find(variant => variant.name === '繁' && prefersTraditional(locale)) || variants[0]
    }

    /* ------------------------------------------------------------------ *
     * DOM 键盘事件 → RIME 按键串
     * 映射照抄 reference/my_rime 的实现，保证与扩展版行为一致。
     * ------------------------------------------------------------------ */

    const RIME_KEY_MAP = {
      Escape: 'Escape',
      F4: 'F4',
      Backspace: 'BackSpace',
      Delete: 'Delete',
      Tab: 'Tab',
      Enter: 'Return',
      Home: 'Home',
      End: 'End',
      PageUp: 'Page_Up',
      PageDown: 'Page_Down',
      Alt: 'Alt_L',
      ArrowUp: 'Up',
      ArrowRight: 'Right',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      '~': 'asciitilde',
      '`': 'quoteleft',
      '!': 'exclam',
      '@': 'at',
      '#': 'numbersign',
      $: 'dollar',
      '%': 'percent',
      '^': 'asciicircum',
      '&': 'ampersand',
      '*': 'asterisk',
      '(': 'parenleft',
      ')': 'parenright',
      '-': 'minus',
      _: 'underscore',
      '+': 'plus',
      '=': 'equal',
      '{': 'braceleft',
      '[': 'bracketleft',
      '}': 'braceright',
      ']': 'bracketright',
      ':': 'colon',
      ';': 'semicolon',
      '"': 'quotedbl',
      "'": 'apostrophe',
      '|': 'bar',
      '\\': 'backslash',
      '<': 'less',
      ',': 'comma',
      '>': 'greater',
      '.': 'period',
      '?': 'question',
      '/': 'slash',
      ' ': 'space'
    }

    /** 未进入组字状态时也允许透传给 librime 的 Ctrl 组合 */
    const CONTROL_ALLOWLIST = new Set(['`'])

    /**
     * 把 DOM 键盘事件翻译成 librime 的按键串。
     * @returns {{rimeKey: string, printable: boolean, raw: string, modified: boolean}|null}
     */
    function buildRimeKey (event, composing) {
      const { code, key } = event
      const printable = key.length === 1
      const hasShift = event.shiftKey
      const isShortcut = event.ctrlKey || event.metaKey || event.altKey || (hasShift && !printable)

      if (!composing) {
        // 没在组字时，只接管可打印字符和 F4（切换方案）
        if (!printable && key !== 'F4') return null
        if (isShortcut && !hasShift && !(event.ctrlKey && CONTROL_ALLOWLIST.has(key))) return null
        if (hasShift && !printable) return null
      }

      let rimeKey
      if (isShortcut || !printable) {
        const base = /^[0-9a-z]$/i.test(key) ? key : RIME_KEY_MAP[key]
        if (base === undefined) return null
        const named = key === 'Alt' && code === 'AltRight' ? 'Alt_R' : base
        const modifiers = []
        if (event.ctrlKey) modifiers.push('Control')
        if (event.metaKey) modifiers.push('Meta')
        if (event.altKey && key !== 'Alt') modifiers.push('Alt')
        if (hasShift) modifiers.push('Shift')
        modifiers.push(named)
        rimeKey = `{${modifiers.join('+')}}`
      } else if (code.startsWith('Numpad')) {
        rimeKey = `{KP_${code.substring(6)}}`
      } else {
        rimeKey = key
      }

      return {
        rimeKey,
        printable,
        raw: key,
        modified: Boolean(event.ctrlKey || event.metaKey || event.altKey)
      }
    }

    /** 找到键盘事件真正落在哪个可编辑元素上（穿透 Shadow DOM） */
    function editableFromEvent (event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      for (const node of path) {
        if (node && node.nodeType === 1 && node.isContentEditable) return node
      }
      const active = document.activeElement
      return active && active.isContentEditable ? active : null
    }

    /** 只接管会话输入框：宿主给输入卡片打了 data-composer-card，Lexical 自己打 data-lexical-editor */
    function isComposerEditor (element) {
      if (!element || !element.isContentEditable) return false
      if (element.closest('[data-composer-card]')) return true
      return element.hasAttribute('data-lexical-editor')
    }

    function swallow (event) {
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
    }

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */

    function readPref (key, fallback) {
      try {
        const raw = window.localStorage.getItem(STORAGE + key)
        return raw === null ? fallback : JSON.parse(raw)
      } catch (error) {
        return fallback
      }
    }

    function writePref (key, value) {
      try {
        window.localStorage.setItem(STORAGE + key, JSON.stringify(value))
      } catch (error) {
        /* 存不住不影响这次会话 */
      }
    }

    function createStore (initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set (next) {
          const value = typeof next === 'function' ? next(state) : { ...state, ...next }
          if (!value || value === state) return
          state = value
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.warn('[rime-ime] store listener failed', error)
            }
          }
        },
        subscribe (listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }

    function schemaById (id) {
      return SCHEMAS.find(schema => schema.id === id) || null
    }

    function schemaName (id) {
      const schema = schemaById(id)
      return schema ? schema.name : id
    }

    function schemaShortName (id) {
      const schema = schemaById(id)
      if (!schema) return id
      return schema.name.split('·')[0]
    }

    async function fetchText (url) {
      const response = await fetch(url, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`读取 ${url} 失败（HTTP ${response.status}）`)
      return response.text()
    }

    async function fetchBuffer (url) {
      const response = await fetch(url, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`读取 ${url} 失败（HTTP ${response.status}）`)
      return response.arrayBuffer()
    }

    /* ------------------------------------------------------------------ *
     * 引擎宿主：Worker + librime
     * ------------------------------------------------------------------ */

    class EngineHost {
      constructor ({ base, onStatus, log }) {
        this.base = base
        this.onStatus = onStatus
        this.log = log
        this.worker = null
        this.starting = null
        this.initing = null
        this.seq = 0
        this.pending = new Map()
        this.loadedSchemaId = null
        this.objectUrls = []
        this.schemaNames = {}
        this.pageSize = 5
        this.fileCache = new Map()
        this.manifest = null
      }

      get absoluteBase () {
        try {
          return new URL(this.base, document.baseURI).href
        } catch (error) {
          return this.base
        }
      }

      /** 取齐 rime.js / rime.wasm / rime.data / worker.js，然后起 Worker 并 boot */
      start () {
        if (this.worker) return Promise.resolve()
        if (this.starting) return this.starting
        this.starting = (async () => {
          const startedAt = Date.now()
          const [workerSource, rimeSource, wasm, data] = await Promise.all([
            fetchText(`${this.base}engine/worker.js`),
            fetchText(`${this.base}engine/rime.js`),
            fetchBuffer(`${this.base}engine/rime.wasm`),
            fetchBuffer(`${this.base}engine/rime.data`)
          ])
          this.log('engine-assets', {
            ms: Date.now() - startedAt,
            wasmBytes: wasm.byteLength,
            dataBytes: data.byteLength
          })

          const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
          const rimeUrl = URL.createObjectURL(new Blob([rimeSource], { type: 'text/javascript' }))
          this.objectUrls = [workerUrl, rimeUrl]

          const worker = new Worker(workerUrl)
          worker.onmessage = event => this.onMessage(event)
          worker.onerror = event => {
            const message = event && event.message ? event.message : '引擎 Worker 加载失败'
            this.failAll(message)
          }
          this.worker = worker
          worker.postMessage({
            channel: 'rime-engine',
            op: 'boot',
            payload: {
              rimeJsUrl: rimeUrl,
              wasm,
              data,
              baseUrl: this.absoluteBase
            }
          }, [wasm, data])
        })().catch((error) => {
          this.starting = null
          throw error
        })
        return this.starting
      }

      onMessage (event) {
        const message = event.data
        if (!message || message.channel !== 'rime-engine') return
        if (message.event === 'status') {
          this.onStatus({ state: message.state, message: message.message || '' })
          return
        }
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.ok) waiter.resolve(message.result)
        else waiter.reject(new Error(message.error))
      }

      failAll (message) {
        this.onStatus({ state: 'error', message })
        for (const waiter of this.pending.values()) waiter.reject(new Error(message))
        this.pending.clear()
      }

      rpc (op, payload) {
        if (!this.worker) return Promise.reject(new Error('引擎 Worker 尚未就绪'))
        return new Promise((resolve, reject) => {
          const id = ++this.seq
          this.pending.set(id, { resolve, reject })
          this.worker.postMessage({ channel: 'rime-engine', id, op, payload: payload || {} })
        })
      }

      /** INIT 只做一次：把方案显示名与候选数交给 wasm 侧 */
      init () {
        if (this.initing) return this.initing
        this.initing = (async () => {
          await this.start()
          await this.rpc(OP.INIT, { schemaNames: this.schemaNames, pageSize: this.pageSize })
        })().catch((error) => {
          this.initing = null
          throw error
        })
        return this.initing
      }

      async readManifest () {
        if (this.manifest) return this.manifest
        const raw = await fetchText(`${this.base}schemas/manifest.json`)
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) throw new Error('schemas/manifest.json 格式不对')
        this.manifest = parsed
        return parsed
      }

      /** 读一个方案需要的全部预编译文件（按方案 id 缓存一次） */
      async readSchemaFiles (schema) {
        if (this.fileCache.has(schema.id)) return this.fileCache.get(schema.id)
        const promise = (async () => {
          const manifest = await this.readManifest()
          const files = []
          for (const target of schema.targets) {
            const entry = manifest.find(item => item.target === target)
            if (!entry) throw new Error(`schemas/manifest.json 里没有 ${target}，请先运行 scripts/prepare-assets.mjs`)
            for (const name of entry.files) {
              files.push({ name, data: await fetchBuffer(`${this.base}schemas/${target}/${name}`) })
            }
          }
          return files
        })()
        this.fileCache.set(schema.id, promise)
        promise.catch(() => this.fileCache.delete(schema.id))
        return promise
      }

      dispose () {
        for (const url of this.objectUrls) {
          try {
            URL.revokeObjectURL(url)
          } catch (error) { /* ignore */ }
        }
        this.objectUrls = []
        if (this.worker) {
          try {
            this.worker.terminate()
          } catch (error) { /* ignore */ }
        }
        this.worker = null
        this.starting = null
        this.initing = null
        this.pending.clear()
      }
    }

    /* ------------------------------------------------------------------ *
     * 输入控制器：按键 → 引擎 → 候选窗 → 上屏
     * ------------------------------------------------------------------ */

    class Controller {
      constructor ({ host, store, log, t }) {
        this.host = host
        this.store = store
        this.log = log
        this.t = t
        this.insert = null
        this.composing = false
        this.targetEl = null
        this.queue = Promise.resolve()
        this.mounted = 0
        this.started = null
        this.selfTested = false
        this.commits = 0
        this.destroyed = false
        this.pageSize = 5
        this.noticeSeq = 0
        this.composeLogs = 0
        this.loggedMiss = false
        this.probeDone = false
        this.keySeen = false
        /** 启动后跑一次自检（同时预热引擎）；Host 的 config 可以把它关掉 */
        this._selfTest = true
      }

      setInsert (fn) {
        this.insert = fn
      }

      mount () {
        this.mounted += 1
        this.start().catch(() => { /* 失败已经写进 store 与日志 */ })
      }

      unmount () {
        this.mounted = Math.max(0, this.mounted - 1)
      }

      /* ---------------- 引擎 ---------------- */

      start () {
        if (!this.store.get().enabled) return Promise.resolve()
        if (this.started) return this.started
        this.started = (async () => {
          await this.host.init()
          await this.ensureSchema(this.store.get().schemaId)
          if (this.selfTestEnabled) await this.selfTest()
          this.probeKeys()
        })().catch((error) => {
          this.started = null
          this.fail(error)
          throw error
        })
        return this.started
      }

      set selfTestEnabled (value) {
        this._selfTest = Boolean(value)
      }

      get selfTestEnabled () {
        return Boolean(this._selfTest)
      }

      fail (error) {
        const message = String((error && error.message) || error)
        this.store.set({ engine: 'error', engineMessage: message, notice: { text: message, kind: 'error' } })
        this.log('engine-error', message)
      }

      /**
       * 一条一闪而过的提示（切换方案、上屏失败等）。
       * 带序号：1.5 秒后只有「还是这一条」才清掉，别把之后的内容顶掉。
       */
      notice (text, kind, ttl) {
        if (!text) return
        const seq = ++this.noticeSeq
        this.store.set({ notice: { text: String(text), kind: kind || 'info', seq } })
        window.setTimeout(() => {
          if (this.destroyed) return
          const current = this.store.get().notice
          if (current && current.seq === seq) this.store.set({ notice: null })
        }, ttl || 1800)
      }

      /** 装载方案（幂等）：set_ime 会把开关重置，所以装载后补一刀简繁 */
      async ensureSchema (schemaId) {
        if (!schemaId) return
        if (this.host.loadedSchemaId === schemaId) return
        const schema = schemaById(schemaId)
        if (!schema) throw new Error(`未注册的方案：${schemaId}`)
        this.store.set({ engine: 'loading', engineMessage: this.t('loading', { name: schema.name }) })
        this.onStatus({ state: 'loading', message: this.t('loading', { name: schema.name }) })
        const files = await this.host.readSchemaFiles(schema)
        const variant = tradSimpVariant(schemaId, navigator.language, this.store.get().tradSimpPref)
        await this.host.rpc(OP.LOAD_SCHEMA, {
          id: schemaId,
          files,
          options: variant ? { ...variant.options } : null
        })
        this.host.loadedSchemaId = schemaId
        this.store.set({ engine: 'ready', engineMessage: '' })
        if (variant) this.store.set({ tradSimpActive: variant.name })
      }

      onStatus (status) {
        if (!status) return
        const patch = { engine: status.state, engineMessage: status.message || '' }
        if (status.state === 'error') patch.notice = { text: status.message || this.t('engineError'), kind: 'error' }
        this.store.set(patch)
      }

      /** 启动后跑一次「nihao + 空格 → 你好」，把结果写进诊断日志（同时预热引擎） */
      async selfTest () {
        if (this.selfTested) return
        this.selfTested = true
        const schemaBefore = this.store.get().schemaId
        try {
          let committed = ''
          for (const key of ['n', 'i', 'h', 'a', 'o']) {
            const result = await this.host.rpc(OP.PROCESS, { input: key })
            if (result && result.committed) committed += result.committed
          }
          const space = await this.host.rpc(OP.PROCESS, { input: '{space}' })
          if (space && space.committed) committed += space.committed
          if (space && !space.committed) await this.host.rpc(OP.PROCESS, { input: '{space}' }).catch(() => {})
          await this.host.rpc(OP.PROCESS, { input: '{Escape}' }).catch(() => {})
          this.log('selftest', { schemaId: schemaBefore, committed, ok: committed.indexOf('你好') !== -1 })
        } catch (error) {
          this.log('selftest-error', String((error && error.message) || error))
        }
      }

      /* ---------------- 开关与设置 ---------------- */

      toggle () {
        const enabled = !this.store.get().enabled
        this.store.set({ enabled, notice: null })
        writePref('enabled', enabled)
        this.log('toggle', { enabled })
        if (enabled) this.start().catch(() => {})
        else this.reset(true)
        return enabled
      }

      toggleMenu () {
        this.store.set(state => ({ ...state, menuOpen: !state.menuOpen }))
      }

      closeMenu () {
        if (this.store.get().menuOpen) this.store.set({ menuOpen: false })
      }

      async setSchema (schemaId) {
        if (!schemaId || schemaId === this.store.get().schemaId) {
          this.closeMenu()
          return
        }
        this.closeMenu()
        this.enqueue(async () => {
          this.reset(true)
          await this.ensureSchema(schemaId)
          this.store.set({ schemaId, tradSimpActive: '' })
          writePref('schemaId', schemaId)
          await this.applyTradSimp()
          this.notice(this.t('switched', { name: schemaName(schemaId) }), 'info')
        })
      }

      async setTradSimp (name) {
        this.store.set({ tradSimpPref: name })
        writePref('tradSimp', name)
        this.closeMenu()
        this.enqueue(() => this.applyTradSimp())
      }

      /** 把当前偏好对应的简繁开关下发到引擎；没有简繁开关的方案什么都不做 */
      async applyTradSimp () {
        const schemaId = this.store.get().schemaId
        if (!TRAD_SIMP[schemaId]) {
          this.store.set({ tradSimpActive: '' })
          this.closeMenu()
          return
        }
        const variant = tradSimpVariant(schemaId, navigator.language, this.store.get().tradSimpPref)
        if (!variant) return
        for (const [option, value] of Object.entries(variant.options)) {
          await this.host.rpc(OP.SET_OPTION, { option, value })
        }
        this.store.set({ tradSimpActive: variant.name })
        this.closeMenu()
      }

      /**
       * 引擎回报「这次按键改了哪些开关」时同步状态：librime 的约定是
       * 'name' = 打开、'!name' = 关闭。
       */
      syncTradSimpFromOptions (updatedOptions) {
        const variants = TRAD_SIMP[this.store.get().schemaId]
        if (!variants) return
        const state = {}
        for (const item of updatedOptions) {
          if (typeof item !== 'string' || !item) continue
          if (item.startsWith('!')) state[item.slice(1)] = false
          else state[item] = true
        }
        const hit = variants.find(variant => Object.keys(state).every(option => variant.options[option] === undefined || variant.options[option] === state[option]))
        if (hit) this.store.set({ tradSimpActive: hit.name })
      }

      /* ---------------- 键盘 ---------------- */

      onKeyDown (event) {
        if (event.isTrusted) this.keySeen = true
        if (event.isComposing || event.keyCode === 229) return

        // 全局开关：Ctrl/Cmd + Shift + Space（输入法关着也能用）
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.code === 'Space' || event.key === ' ')) {
          this.toggle()
          swallow(event)
          return
        }

        if (this.store.get().menuOpen && event.key === 'Escape') {
          this.closeMenu()
          swallow(event)
          return
        }

        if (!this.store.get().enabled) return

        const element = editableFromEvent(event)
        if (!isComposerEditor(element)) {
          // 打开了输入法却打不进字时，这条日志是第一现场：焦点到底落在谁身上
          if (!this.loggedMiss && event.key && event.key.length === 1) {
            this.loggedMiss = true
            const active = document.activeElement
            this.log('key-not-composer', {
              key: event.key,
              active: active ? active.tagName : null,
              editable: Boolean(active && active.isContentEditable),
              inCard: Boolean(active && active.closest && active.closest('[data-composer-card]'))
            })
          }
          return
        }
        if (this.composing && this.targetEl && this.targetEl !== element) this.reset(true)

        const info = buildRimeKey(event, this.composing)
        if (!info) return

        this.targetEl = element
        swallow(event)
        this.enqueue(() => this.process(info))
      }

      onKeyUp (event) {
        if (!this.store.get().enabled || !this.composing) return
        if (event.isComposing || event.keyCode === 229) return
        const name = RIME_KEY_MAP[event.key] || event.key
        if (!/^[A-Za-z0-9_]+$/.test(name)) return
        this.enqueue(async () => {
          if (!this.composing) return
          const result = await this.host.rpc(OP.PROCESS, { input: `{Release+${name}}` })
          this.apply(result, { printable: false, raw: event.key })
        })
      }

      enqueue (task) {
        this.queue = this.queue
          .then(() => (this.destroyed ? undefined : task()))
          .catch(error => {
            this.fail(error)
          })
        return this.queue
      }

      /* ---------------- 键入链路自检 ---------------- */

      /**
       * 引擎就绪后，如果用户还没开始打字、而输入框已经拿到焦点，就合成一次
       * 「按 n」的 keydown，看候选窗到底出不出来，再按 Esc 收掉。
       *
       * 为什么值得常驻：这条链路（window capture → 按键翻译 → 引擎 → 候选窗）
       * 只有在真实按键时才会跑到，出问题时页面上一片安静。这里用 isTrusted 区分
       * 真实按键，用户已经打过字就完全不插手；探测本身不往草稿里写任何东西。
       */
      probeKeys () {
        if (this.probeDone || this.keySeen || this.destroyed) return
        const attempt = () => {
          if (this.probeDone || this.keySeen || this.destroyed) return true
          const active = document.activeElement
          if (!active || !isComposerEditor(active)) return false
          this.probeDone = true
          this.runKeyProbe().catch(() => {})
          return true
        }
        if (attempt()) return
        const onFocus = () => {
          if (!attempt()) return
          window.removeEventListener('focusin', onFocus, true)
        }
        window.addEventListener('focusin', onFocus, true)
        window.setTimeout(() => window.removeEventListener('focusin', onFocus, true), 30000)
      }

      async runKeyProbe () {
        const dispatch = (key, code) => {
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true
          }))
        }
        try {
          // 给「点一下输入框就开始打字」的人让路：真按键一到就放弃这次探测
          await new Promise(resolve => window.setTimeout(resolve, 400))
          if (this.keySeen || this.destroyed) {
            this.log('key-probe', { skipped: 'user typed first' })
            return
          }
          dispatch('n', 'KeyN')
          await new Promise(resolve => window.setTimeout(resolve, 300))
          const state = this.store.get()
          const composition = state.composition
          this.log('key-probe', {
            composing: this.composing,
            preedit: composition ? (composition.head || '') + (composition.body || '') + (composition.tail || '') : null,
            candidates: composition ? composition.candidates.slice(0, 3).map(item => item.text) : []
          })
          dispatch('Escape', 'Escape')
        } catch (error) {
          this.log('key-probe-error', String((error && error.message) || error))
        }
      }

      /* ---------------- 引擎交互 ---------------- */

      async process (info) {
        await this.start()
        const result = await this.host.rpc(OP.PROCESS, { input: info.rimeKey })
        this.apply(result, info)
      }

      selectCandidate (index) {
        this.enqueue(async () => {
          await this.start()
          const result = await this.host.rpc(OP.SELECT_CANDIDATE, { index })
          this.apply(result, { printable: false, raw: '' })
        })
      }

      changePage (backward) {
        this.enqueue(async () => {
          await this.start()
          const result = await this.host.rpc(OP.CHANGE_PAGE, { backward })
          this.apply(result, { printable: false, raw: '' })
        })
      }

      apply (result, info) {
        if (!result) return

        if (Array.isArray(result.updatedOptions) && result.updatedOptions.length) {
          this.syncTradSimpFromOptions(result.updatedOptions)
        }

        if (result.state === RIME_STATE.ACCEPTED) {
          const starting = !this.composing
          this.composing = true
          if (starting && (this.composeLogs = (this.composeLogs || 0) + 1) <= 10) {
            this.log('compose-start', {
              key: info && info.raw,
              preedit: (result.head || '') + (result.body || '') + (result.tail || ''),
              candidates: Array.isArray(result.candidates) ? result.candidates.slice(0, 3).map(item => item.text) : []
            })
          }
          if (result.committed) this.commit(result.committed)
          this.render(result)
          return
        }

        const wasComposing = this.composing
        this.composing = false
        this.store.set({ composition: null })

        if (result.state === RIME_STATE.COMMITTED) {
          if (result.committed) this.commit(result.committed)
          return
        }

        if (result.state === RIME_STATE.REJECTED) {
          // F4 切换方案：librime 把新方案 id 通过 updatedSchema 带回来
          if (result.updatedSchema) {
            const next = String(result.updatedSchema).split('/')[0]
            if (next && next !== this.store.get().schemaId) this.enqueue(() => this.setSchema(next))
          }
          return
        }

        // UNHANDLED：按键没被方案消费，原样放行。
        // 带 Ctrl/Alt/Cmd 的组合键不能放行：{Control+Shift+4} 这类是方案自己声明的
        // 开关（librime 的 key_binder 切简繁），引擎只切开关、不消费这次按键。
        if (result.state === RIME_STATE.UNHANDLED && info && info.printable && info.raw && !info.modified) {
          this.commit(info.raw)
        } else if (wasComposing && result.state === RIME_STATE.UNHANDLED) {
          this.store.set({ composition: null })
        }
      }

      render (result) {
        const candidates = Array.isArray(result.candidates) ? result.candidates : []
        const head = result.head || ''
        const body = result.body || ''
        const tail = result.tail || ''
        if (!head && !body && !tail && candidates.length === 0) {
          this.store.set({ composition: null })
          return
        }
        this.store.set({
          composition: {
            head,
            body,
            tail,
            candidates,
            selectLabels: Array.isArray(result.selectLabels) ? result.selectLabels : null,
            highlighted: Number(result.highlighted) || 0,
            page: Number(result.page) || 0,
            isLastPage: Boolean(result.isLastPage)
          },
          notice: null
        })
      }

      /** 清掉当前组字：需要时给引擎发个 Escape 复位 */
      reset (notifyEngine) {
        const wasComposing = this.composing
        this.composing = false
        this.store.set({ composition: null })
        if (notifyEngine && wasComposing) {
          this.host.rpc(OP.PROCESS, { input: '{Escape}' }).catch(() => {})
        }
      }

      commit (text) {
        if (!text) return
        let inserted = false
        try {
          inserted = this.insert ? Boolean(this.insert(text)) : false
        } catch (error) {
          this.log('commit-error', String((error && error.message) || error))
        }
        if (!inserted) {
          this.log('commit-failed', { text })
          this.notice(this.t('insertFailed'), 'error')
          return
        }
        this.commits += 1
        if (this.commits <= 5) this.log('commit', { text })
      }

      dispose () {
        this.destroyed = true
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    const PANEL_CSS = `
.rime-ime-panel{position:absolute;left:0;bottom:calc(100% + 8px);z-index:30;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:max-content;min-width:180px;max-width:min(560px,100%);padding:8px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 10px 30px rgba(16,24,40,.18);font-size:13px;line-height:1.45;pointer-events:auto;user-select:none;-webkit-user-select:none}
.rime-ime-panel--idle{visibility:hidden;pointer-events:none}
.rime-ime-preedit{display:flex;align-items:baseline;gap:1px;white-space:pre;letter-spacing:.4px;font-size:14px}
.rime-ime-preedit .body{color:var(--dsw-alias-brand-primary);border-bottom:2px solid var(--dsw-alias-brand-primary)}
.rime-ime-preedit .ghost{color:var(--dsw-alias-label-secondary)}
.rime-ime-cands{display:flex;flex-wrap:wrap;gap:2px}
.rime-ime-cand{display:flex;align-items:baseline;gap:4px;padding:2px 7px;border-radius:6px;cursor:pointer;white-space:nowrap}
.rime-ime-cand.active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.rime-ime-cand .idx{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rime-ime-cand .text{font-size:16px}
.rime-ime-cand .comment{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rime-ime-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rime-ime-pager{display:flex;gap:4px}
.rime-ime-pager button{font:inherit;line-height:14px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.rime-ime-pager button:disabled{opacity:.4;cursor:default}
.rime-ime-notice{font-size:13px}
.rime-ime-notice.error{color:var(--dsw-alias-state-error-primary)}
.rime-ime-menu{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto}
.rime-ime-menu-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rime-ime-menu-caption{padding:6px 2px 2px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rime-ime-menu-item{display:block;width:100%;text-align:left;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.rime-ime-menu-item.on{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rime-ime-menu-foot{display:flex;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
`

    const PILL_CSS = `
.rime-ime-status{display:inline-flex;align-items:center;gap:4px;height:100%}
.rime-ime-pill{min-width:30px;height:24px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.rime-ime-pill.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.rime-ime-schema{display:inline-flex;align-items:center;gap:3px;height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.rime-ime-schema:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rime-ime-caret{font-size:9px;opacity:.7}
`

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    function compositionCandidates (composition) {
      return h('div', { className: 'rime-ime-preedit', key: 'preedit' }, [
        composition.head ? h('span', { className: 'ghost', key: 'head' }, composition.head) : null,
        composition.body ? h('span', { className: 'body', key: 'body' }, composition.body) : null,
        composition.tail ? h('span', { className: 'ghost', key: 'tail' }, composition.tail) : null
      ])
    }

    function candidateRow (composition) {
      return h('div', { className: 'rime-ime-cands', key: 'cands' }, composition.candidates.map((candidate, index) => {
        const label = (composition.selectLabels && composition.selectLabels[index]) || String(index + 1)
        return h('div', {
          key: index,
          className: 'rime-ime-cand' + (index === composition.highlighted ? ' active' : ''),
          title: candidate.comment || candidate.text,
          onMouseDown: (event) => {
            event.preventDefault()
            event.stopPropagation()
            controller.selectCandidate(index)
          }
        }, [
          h('span', { className: 'idx', key: 'idx' }, label),
          h('span', { className: 'text', key: 'text' }, candidate.text),
          candidate.comment ? h('span', { className: 'comment', key: 'comment' }, candidate.comment) : null
        ])
      }))
    }

    function compositionFoot (state, composition) {
      const paged = composition.page > 0 || !composition.isLastPage
      return h('div', { className: 'rime-ime-foot', key: 'foot' }, [
        h('span', { key: 'page' }, paged ? t('page', { page: composition.page + 1 }) : t('candidateCount', { count: composition.candidates.length })),
        paged
          ? h('span', { className: 'rime-ime-pager', key: 'pager' }, [
              h('button', {
                key: 'prev',
                type: 'button',
                disabled: composition.page === 0,
                onMouseDown: (event) => {
                  event.preventDefault()
                  controller.changePage(true)
                }
              }, '‹'),
              h('button', {
                key: 'next',
                type: 'button',
                disabled: composition.isLastPage,
                onMouseDown: (event) => {
                  event.preventDefault()
                  controller.changePage(false)
                }
              }, '›')
            ])
          : null,
        h('span', { key: 'hint' }, t('hint'))
      ])
    }

    function schemaMenu (state) {
      const groups = []
      for (const schema of SCHEMAS) {
        const last = groups[groups.length - 1]
        if (!last || last.title !== schema.group) groups.push({ title: schema.group, items: [schema] })
        else last.items.push(schema)
      }
      const variants = TRAD_SIMP[state.schemaId] || []
      return h('div', { className: 'rime-ime-menu', key: 'menu' }, [
        h('div', { className: 'rime-ime-menu-head', key: 'head' }, [
          h('span', { key: 'title' }, t('schema')),
          h('span', { key: 'engine' }, t('engine.' + state.engine))
        ]),
        ...groups.map(group => h('div', { key: group.title }, [
          h('div', { className: 'rime-ime-menu-caption', key: 'caption' }, group.title),
          ...group.items.map(schema => h('button', {
            key: schema.id,
            type: 'button',
            className: 'rime-ime-menu-item' + (schema.id === state.schemaId ? ' on' : ''),
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => controller.setSchema(schema.id)
          }, schema.name))
        ])),
        variants.length
          ? h('div', { key: 'variants' }, [
              h('div', { className: 'rime-ime-menu-caption', key: 'caption' }, t('variant')),
              h('div', { key: 'items', style: { display: 'flex', gap: '4px' } }, [
                h('button', {
                  key: 'auto',
                  type: 'button',
                  className: 'rime-ime-menu-item' + (state.tradSimpPref === 'auto' ? ' on' : ''),
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => controller.setTradSimp('auto')
                }, t('variantAuto')),
                ...variants.map(variant => h('button', {
                  key: variant.name,
                  type: 'button',
                  className: 'rime-ime-menu-item' + (state.tradSimpPref === variant.name ? ' on' : ''),
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => controller.setTradSimp(variant.name)
                }, variant.name))
              ])
            ])
          : null,
        h('div', { className: 'rime-ime-menu-foot', key: 'foot' }, [
          h('button', {
            key: 'toggle',
            type: 'button',
            className: 'rime-ime-menu-item',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => controller.toggle()
          }, state.enabled ? t('disable') : t('enable')),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'rime-ime-menu-item',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => controller.closeMenu()
          }, t('close'))
        ])
      ])
    }

    /** 候选窗 / 方案菜单：注册进 `conversation.input.overlay`，浮在输入卡片上方 */
    function ImePanel (props) {
      const state = useSyncExternalStore(store.subscribe, store.get, store.get)
      const actionsRef = useRef(props.inputActions)
      actionsRef.current = props.inputActions
      const panelRef = useRef(null)

      useEffect(() => {
        controller.setInsert((text) => {
          const actions = actionsRef.current
          if (!actions || !text) return false
          try {
            if (actions.insertText(text, actions.captureInsertion())) return true
            // 草稿在两次调用之间变过（罕见）：换一个最新光标再试一次
            return Boolean(actions.insertText(text, actions.captureInsertion()))
          } catch (error) {
            log('insert-error', String((error && error.message) || error))
            return false
          }
        })
        controller.mount()
        return () => {
          controller.setInsert(null)
          controller.unmount()
        }
      }, [])

      useEffect(() => {
        if (!panelRef.current) return
        if (loggedLayout) return
        loggedLayout = true
        try {
          const anchor = panelRef.current.parentElement
          const rect = anchor ? anchor.getBoundingClientRect() : null
          log('layout', rect
            ? {
                anchor: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                panel: (() => {
                  const own = panelRef.current.getBoundingClientRect()
                  return { top: Math.round(own.top), left: Math.round(own.left), width: Math.round(own.width), height: Math.round(own.height) }
                })(),
                viewport: { width: window.innerWidth, height: window.innerHeight }
              }
            : null)
        } catch (error) { /* ignore */ }
      })

      const composition = state.composition
      const visible = Boolean(composition || state.notice || state.menuOpen)

      // 没有内容时也把容器留在 DOM 里（visibility:hidden）：绝对定位不占流，
      // 但这样位置是稳定的，也便于一次性把几何信息写进诊断日志。
      return h('div', {
        ref: panelRef,
        className: 'rime-ime-panel' + (visible ? '' : ' rime-ime-panel--idle'),
        'data-rime-ime': 'panel',
        onMouseDown: (event) => event.preventDefault(),
        onContextMenu: (event) => event.preventDefault()
      }, [
        h('style', { key: 'css' }, PANEL_CSS),
        !visible
          ? null
          : state.menuOpen
            ? schemaMenu(state)
            : composition
              ? h('div', { key: 'composition', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
                  compositionCandidates(composition),
                  candidateRow(composition),
                  compositionFoot(state, composition)
                ])
              : h('div', { key: 'notice', className: 'rime-ime-notice' + (state.notice && state.notice.kind === 'error' ? ' error' : '') }, state.notice ? state.notice.text : '')
      ])
    }

    /** 中/EN 胶囊 + 方案入口：注册进 `conversation.input.right`（输入框工具行） */
    function ImeStatus () {
      const state = useSyncExternalStore(store.subscribe, store.get, store.get)
      const rootRef = useRef(null)

      useEffect(() => {
        if (loggedPillLayout || !rootRef.current) return
        loggedPillLayout = true
        try {
          const own = rootRef.current.getBoundingClientRect()
          const card = rootRef.current.closest('[data-composer-card]')
          const rect = card ? card.getBoundingClientRect() : null
          log('layout-pill', {
            pill: { top: Math.round(own.top), left: Math.round(own.left), width: Math.round(own.width), height: Math.round(own.height) },
            card: rect
              ? {
                  top: Math.round(rect.top),
                  left: Math.round(rect.left),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                  bottom: Math.round(rect.bottom)
                }
              : null,
            viewport: { width: window.innerWidth, height: window.innerHeight }
          })
        } catch (error) { /* ignore */ }
      })

      return h('div', { ref: rootRef, className: 'rime-ime-status', title: t('toggleHint') }, [
        h('style', { key: 'css' }, PILL_CSS),
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'rime-ime-pill' + (state.enabled ? ' on' : ''),
          'aria-pressed': state.enabled,
          'aria-label': t('toggleHint'),
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => controller.toggle()
        }, state.enabled ? '中' : 'EN'),
        h('button', {
          key: 'schema',
          type: 'button',
          className: 'rime-ime-schema',
          'aria-label': t('schema'),
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => controller.toggleMenu()
        }, [schemaShortName(state.schemaId), h('span', { key: 'caret', className: 'rime-ime-caret' }, '▾')])
      ])
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */

    /** 页面级单例：两个槽位组件共享同一份状态与同一个控制器 */
    let store = null
    let controller = null
    let t = () => ''
    let log = () => {}
    let loggedLayout = false
    let loggedPillLayout = false

    const DICT = {
      zh: {
        enable: '开启输入法',
        disable: '关闭输入法',
        schema: '输入方案',
        variant: '简繁',
        variantAuto: '跟随系统',
        close: '收起',
        hint: '空格上屏 · Esc 取消',
        page: '第 {page} 页',
        candidateCount: '{count} 个候选',
        loading: '正在装载 {name}…',
        switched: '已切换到 {name}',
        insertFailed: '无法把候选写进输入框，请点一下输入框再试。',
        engineError: 'RIME 引擎出错',
        toggleHint: '中/EN（Ctrl+Shift+Space）',
        'engine.idle': '未启动',
        'engine.loading': '装载中',
        'engine.ready': '就绪',
        'engine.error': '出错'
      },
      en: {
        enable: 'Enable input method',
        disable: 'Disable input method',
        schema: 'Input schema',
        variant: 'Traditional / simplified',
        variantAuto: 'Follow system',
        close: 'Close',
        hint: 'Space commits · Esc cancels',
        page: 'Page {page}',
        candidateCount: '{count} candidates',
        loading: 'Loading {name}…',
        switched: 'Switched to {name}',
        insertFailed: 'Could not write the candidate into the composer. Click the composer and try again.',
        engineError: 'RIME engine error',
        toggleHint: '中/EN (Ctrl+Shift+Space)',
        'engine.idle': 'Idle',
        'engine.loading': 'Loading',
        'engine.ready': 'Ready',
        'engine.error': 'Error'
      }
    }

    function makeTranslator (ctx) {
      let bound = null
      try {
        const locale = ctx.get('locale')
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          const disposers = []
          for (const [id, dict] of Object.entries(DICT)) {
            disposers.push(locale.register(NS, id, dict))
          }
          bound = locale.bind(NS)
          ctx.effect(() => () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch (error) { /* ignore */ }
            }
          })
        }
      } catch (error) {
        console.warn('[rime-ime] locale unavailable', error)
      }
      return (key, params) => {
        let text = bound ? bound(key) : undefined
        if (!text || text === key) {
          text = DICT.zh[key] !== undefined ? DICT.zh[key] : key
        }
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.replaceAll('{' + name + '}', String(value))
          }
        }
        return text
      }
    }

    /** 页面事件 → Host 诊断日志（/rime-ime/diagnostics） */
    function makeLogger () {
      let seq = 0
      let ready = false
      return (event, detail) => {
        seq += 1
        const payload = { source: 'client', event, detail: detail === undefined ? null : detail, seq }
        if (!ready) {
          ready = true
          payload.origin = location.origin
          payload.href = location.href
          payload.userAgent = navigator.userAgent
        }
        try {
          fetch(`${BASE}diagnostics`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
          }).catch(() => {})
        } catch (error) { /* 日志写不进去不影响输入 */ }
      }
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        log = makeLogger()
        t = makeTranslator(ctx)
        loggedLayout = false
        loggedPillLayout = false

        let config = { defaultSchemaId: 'luna_pinyin', pageSize: 5, selfTest: true }

        store = createStore({
          enabled: readPref('enabled', true),
          schemaId: readPref('schemaId', config.defaultSchemaId),
          tradSimpPref: readPref('tradSimp', 'auto'),
          tradSimpActive: '',
          engine: 'idle',
          engineMessage: '',
          composition: null,
          notice: null,
          menuOpen: false
        })

        const host = new EngineHost({
          base: BASE,
          onStatus: (status) => controller && controller.onStatus(status),
          log
        })

        controller = new Controller({
          host,
          store,
          log,
          t: (key, params) => t(key, params)
        })
        controller.pageSize = config.pageSize
        host.pageSize = config.pageSize
        host.schemaNames = Object.fromEntries(SCHEMAS.map(schema => [schema.id, schema.name]))

        // 配置与自检开关由 Host 下发；拿不到就用默认值，不影响输入
        fetch(`${BASE}config.json`, { cache: 'no-cache' })
          .then(response => (response.ok ? response.json() : null))
          .then((remote) => {
            if (!remote || typeof remote !== 'object') return
            config = { ...config, ...remote }
            controller.selfTestEnabled = remote.selfTest !== false
            if (Number.isFinite(remote.pageSize) && remote.pageSize >= 1) {
              controller.pageSize = remote.pageSize
              host.pageSize = remote.pageSize
            }
            if (typeof remote.defaultSchemaId === 'string' && !readPref('schemaId', null)) {
              store.set({ schemaId: remote.defaultSchemaId })
            }
            log('config', config)
            controller.start().catch(() => {})
          })
          .catch((error) => {
            log('config-error', String((error && error.message) || error))
            controller.start().catch(() => {})
          })

        // 键盘：window capture 阶段先拿到，必要时把事件吞掉
        ctx.effect(() => {
          const onKeyDown = (event) => {
            try {
              controller.onKeyDown(event)
            } catch (error) {
              log('keydown-error', String((error && error.message) || error))
            }
          }
          const onKeyUp = (event) => {
            try {
              controller.onKeyUp(event)
            } catch (error) { /* ignore */ }
          }
          window.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('keyup', onKeyUp, true)
          return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('keyup', onKeyUp, true)
            controller.dispose()
            host.dispose()
          }
        }, 'rime-ime: keyboard')

        ctx.slots.register({ name: 'conversation.input.overlay', id: 'rime-ime', order: 20 }, ImePanel)
        ctx.slots.register({ name: 'conversation.input.right', id: 'rime-ime', order: 100 }, ImeStatus)

        log('client-ready', { base: BASE, enabled: store.get().enabled, schemaId: store.get().schemaId })
      }
    }
  }
})
