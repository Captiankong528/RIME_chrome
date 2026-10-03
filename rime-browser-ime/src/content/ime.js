/**
 * 输入控制器：把 DOM 键盘事件翻译成 librime 的按键序列，再把引擎结果落到页面上。
 *
 * 按键到 RIME 的映射规则、以及 state 的四种取值处理，都照搬参考实现
 * reference/my_rime/src/components/MyPanel.vue，保证行为一致。
 */
globalThis.RIME_CS = globalThis.RIME_CS || {}

;(function (NS) {
  const { OP, RIME_STATE, ENGINE_STATE } = globalThis.RIME_CONST

  /** DOM key -> RIME 键名 */
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

  /** 未进入打字状态时也允许透传给 librime 的 Ctrl 组合 */
  const CONTROL_ALLOWLIST = new Set(['`'])

  /**
   * 取出事件真正的目标元素。
   *
   * 键盘事件从 Shadow DOM 里冒出来时，浏览器会把 target 重定向成宿主元素
   * （`<my-input>` 之类），而宿主通常不是可编辑元素，直接用它判断会导致
   * 整类 Web Component 站点用不了输入法。composedPath()[0] 才是内部的真实节点。
   */
  function resolveTarget (event) {
    if (typeof event.composedPath === 'function') {
      try {
        const path = event.composedPath()
        if (path && path.length) return path[0]
      } catch (e) { /* 少数环境会抛，退回 event.target */ }
    }
    return event.target
  }

  class ImeController {
    constructor (settings = {}) {
      this.enabled = false
      this.schemaId = settings.schemaId || globalThis.RIME_CONST.DEFAULTS.schemaId
      this.pageSize = settings.pageSize || globalThis.RIME_CONST.DEFAULTS.pageSize
      this.engineState = ENGINE_STATE.IDLE
      this.engineMessage = ''

      /** @type {Element|null} 当前接管的可编辑元素 */
      this.target = null
      /** 是否处于组字（preedit）状态 */
      this.composing = false
      /** 串行化对引擎的请求，保证按键顺序 */
      this.queue = Promise.resolve()
      this.destroyed = false

      this.window = new NS.CandidateWindow({
        onSelect: index => this.selectCandidate(index),
        onPage: backward => this.changePage(backward)
      })

      /**
       * 简繁偏好：'auto' = 跟随浏览器语言，或某个 variant 名（'简' / '繁' / '臺' / '港'）。
       * 它是**会话之外**的东西（存在 chrome.storage.local），而 librime 的开关是会话级的
       * ——每次 set_ime 都会回到方案 yaml 的 reset 值，所以每个装载方案的人都要重新下发。
       */
      this.tradSimpPreference = 'auto'
      /** 当前实际生效的 variant 名，只用于状态栏显示 */
      this.tradSimpActive = ''
      this.statusBarCollapsed = false

      /**
       * 状态栏：右下角常驻，选输入法 + 选简繁。
       * 构造它不碰 DOM（StatusBar 是惰性建 DOM 的），离线测试里也不会有问题。
       */
      this.statusBar = new NS.StatusBar({
        onSelectSchema: id => this.selectSchemaFromStatusBar(id),
        onSelectTradSimp: name => this.enqueue(() => this.setTradSimpPreference(name)),
        onToggleCollapse: collapsed => this.setStatusBarCollapsed(collapsed)
      })
    }

    /* ---------------- 开关与设置 ---------------- */

    setEnabled (enabled) {
      if (this.enabled === enabled) return
      this.enabled = enabled
      if (!enabled) {
        this.reset(true)
        this.statusBar.hide()
        return
      }
      this.renderStatusBar()
      this.statusBar.show()
      // 打开时补一刀简繁：引擎可能刚被别的标签页用语言默认值装载过
      this.enqueue(() => this.ensureTradSimpApplied()
        .catch(error => console.warn('[rime] 简繁偏好下发失败', error)))
    }

    setSettings (patch = {}) {
      if (patch.schemaId && patch.schemaId !== this.schemaId) {
        // 走 enqueue：切换必须排在正在处理的按键之后，而且**不能**在这里就改
        // this.schemaId——引擎还没装载完，提前改会让接下来的按键把新方案名发给
        // 一个还在用旧方案的引擎（表现为「切换了但打字还是老方案」）。
        this.enqueue(() => this.switchSchema(patch.schemaId))
      }
      if (typeof patch.pageSize === 'number') this.pageSize = patch.pageSize
    }

    destroy () {
      this.destroyed = true
      this.window.destroy()
      this.statusBar.destroy()
    }

    /* ---------------- 键盘事件 ---------------- */

    /**
     * 把 DOM 键盘事件翻译成 librime 的按键串。
     * @returns {{rimeKey: string, printable: boolean, raw: string, modified: boolean}|null} null 表示不接管
     */
    buildRimeKey (event) {
      const { code, key } = event
      const printable = key.length === 1
      const hasShift = event.shiftKey
      const isShortcut = event.ctrlKey || event.metaKey || event.altKey || (hasShift && !printable)

      if (!this.composing) {
        // 没在组字时，只接管可打印字符和 F4（切换方案）
        if (!printable && key !== 'F4') return null
        // 组合键留给页面，除非显式放行
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
        /** 带 Ctrl / Alt / Cmd：UNHANDLED 时不能把按键原样打进页面（见 apply） */
        modified: Boolean(event.ctrlKey || event.metaKey || event.altKey)
      }
    }

    onKeydown (event) {
      if (!this.enabled) return
      // 页面/系统自带输入法正在组字，让给它们
      if (event.isComposing || event.keyCode === 229) return

      const target = resolveTarget(event)
      if (!NS.isEditable(target)) return
      if (this.composing && this.target && this.target !== target) this.reset(true)

      const info = this.buildRimeKey(event)
      if (!info) return

      this.target = target
      event.preventDefault()
      event.stopPropagation()
      this.enqueue(() => this.process(info))
    }

    onKeyup (event) {
      if (!this.enabled || !this.composing) return
      if (event.isComposing || event.keyCode === 229) return
      const name = RIME_KEY_MAP[event.key] || event.key
      if (!/^[A-Za-z0-9_]+$/.test(name)) return
      this.enqueue(async () => {
        const result = await this.request(OP.PROCESS, { input: `{Release+${name}}` })
        this.apply(result, { printable: false, raw: event.key })
      })
    }

    /* ---------------- 与引擎通信 ---------------- */

    async request (op, payload) {
      const response = await chrome.runtime.sendMessage({
        to: 'engine',
        op,
        // payload 里显式给了 schemaId 就以它为准：switchSchema 会在拿到新的
        // schemaId 之后、更新 this.schemaId 之前就发请求，这里要是无条件覆盖，
        // 就会被旧的 this.schemaId 顶掉，切换方案永远切不动。
        payload: { ...payload, schemaId: payload?.schemaId || this.schemaId }
      })
      if (!response) throw new Error('扩展后台没有响应')
      if (!response.ok) throw new Error(response.error)
      return response.result
    }

    enqueue (task) {
      this.queue = this.queue
        .then(() => (this.destroyed ? undefined : task()))
        .catch(error => this.handleError(error))
      return this.queue
    }

    handleError (error) {
      const raw = String((error && error.message) || error)
      // 这一类是「消息根本没送到」，从页面上完全看不出原因，直接给出下一步动作
      const lost = /Receiving end does not exist|Could not establish connection|message port closed|Extension context invalidated/i
      const message = lost.test(raw)
        ? '扩展后台没有响应。请到 chrome://extensions 看本扩展是否报错，或点一次「重新加载」。'
        : raw
      console.warn('[rime] 引擎调用失败:', raw)
      this.composing = false
      if (this.target && NS.isEditable(this.target)) {
        this.window.showMessage(`RIME: ${message}`, NS.getCaretRect(this.target), 'error')
      }
    }

    /* ---------------- 核心流程 ---------------- */

    async process (info) {
      const result = await this.request(OP.PROCESS, { input: info.rimeKey })
      this.apply(result, info)
    }

    selectCandidate (index) {
      this.enqueue(async () => {
        const result = await this.request(OP.SELECT_CANDIDATE, { index })
        this.apply(result, { printable: false, raw: '' })
      })
    }

    changePage (backward) {
      this.enqueue(async () => {
        const result = await this.request(OP.CHANGE_PAGE, { backward })
        this.apply(result, { printable: false, raw: '' })
      })
    }

    /** 处理一次引擎返回（state 语义见 wasm/api.cpp 的 enum） */
    apply (result, info) {
      if (!result) return

      // 引擎会把「这次按键改动了哪些开关」带回来（api.cpp 的 updatedOptions），
      // 例如用户在打字时按 Ctrl+Shift+4 切简繁。状态栏要跟着变，否则显示的就是旧的。
      if (result.updatedOptions && result.updatedOptions.length) {
        this.syncTradSimpFromOptions(result.updatedOptions)
      }

      if (result.state === RIME_STATE.ACCEPTED) {
        this.composing = true
        // 部分提交：整句还没选完，但已经吐出一段成品
        if (result.committed) this.insert(result.committed)
        this.render(result)
        return
      }

      this.composing = false
      this.window.hide()

      if (result.state === RIME_STATE.COMMITTED) {
        if (result.committed) this.insert(result.committed)
        return
      }
      if (result.state === RIME_STATE.REJECTED) {
        // F4 切换方案：librime 会把新方案 id 通过 updatedSchema 带回来
        if (result.updatedSchema) {
          const next = String(result.updatedSchema).split('/')[0]
          // 同样走 enqueue：这样 F4 连按时，方案装载和 this.schemaId 的更新
          // 都不会交错（我们正跑在队列里，这一条排在当前按键处理之后）
          if (next && next !== this.schemaId) this.enqueue(() => this.switchSchema(next))
        }
        return
      }
      // UNHANDLED：按键没被方案消费，原样放行。
      // 但带 Ctrl/Alt/Cmd 的组合键不能放行：{Control+Shift+4} 这类是方案自己声明的
      // 开关（librime 的 key_binder 切简繁），引擎只切开关、不消费这次按键，
      // 若按「可打印字符」处理就会把 '4' 打进页面。
      if (result.state === RIME_STATE.UNHANDLED && info && info.printable && info.raw && !info.modified) {
        this.insert(info.raw)
      }
    }

    render (result) {
      if (!this.target || !NS.isEditable(this.target)) return
      const anchor = NS.getCaretRect(this.target)
      this.window.show({
        head: result.head || '',
        body: result.body || '',
        tail: result.tail || '',
        candidates: result.candidates || [],
        selectLabels: result.selectLabels,
        highlighted: result.highlighted || 0,
        page: result.page || 0,
        isLastPage: Boolean(result.isLastPage)
      }, anchor)
      this.lastAnchor = anchor
    }

    /** 滚动/改尺寸后重新贴住光标 */
    reposition () {
      if (!this.composing || !this.visible) return
      if (!this.target || !NS.isEditable(this.target)) return
      this.window.anchor = NS.getCaretRect(this.target)
      this.window.render()
    }

    get visible () {
      return this.window.visible
    }

    /** 清掉当前组字：给引擎发个 Escape 让它复位 */
    reset (notifyEngine) {
      const wasComposing = this.composing
      this.composing = false
      this.window.hide()
      if (notifyEngine && wasComposing) {
        this.enqueue(() => this.request(OP.PROCESS, { input: '{Escape}' }).catch(() => {}))
      }
    }

    async switchSchema (schemaId) {
      const previous = this.schemaId
      try {
        // 这里必须显式把新 schemaId 传进 payload：此时 this.schemaId 还是旧的，
        // 而 request() 只在 payload 没给 schemaId 时才回退到 this.schemaId。
        await this.request(OP.LOAD_SCHEMA, { schemaId })
      } catch (error) {
        this.handleError(error)
        return
      }

      this.schemaId = schemaId
      if (!this.composing) this.window.hide()
      this.tradSimpActive = ''

      // 后台把它持久化；失败不回滚——引擎已经在用新方案了，回滚反而两边不一致
      try {
        await chrome.runtime.sendMessage({
          to: 'background',
          op: 'setSettings',
          payload: { schemaId }
        })
      } catch (error) { /* 记不住不影响这次会话 */ }

      // set_ime 会把开关重置回方案 yaml 的 reset 值（朙月拼音就是繁体），
      // 换方案之后必须按用户的偏好重新下发一遍，状态栏也要跟着换一套 variant
      this.renderStatusBar()
      await this.applyTradSimp()

      this.showSwitchNotice(schemaId)
    }

    /**
     * 切换方案后的短暂提示。F4 循环切换时尤其必要——否则界面上只有候选内容变了，
     * 用户不知道当前到底是哪个方案。
     */
    showSwitchNotice (schemaId) {
      if (!this.enabled || !this.target || !NS.isEditable(this.target)) return
      const schemas = (globalThis.RIME_CONST && globalThis.RIME_CONST.SCHEMAS) || []
      const found = schemas.find(s => s.id === schemaId)
      const name = (found && found.name) || schemaId
      this.window.showMessage(`已切换到 ${name}`, NS.getCaretRect(this.target), 'info')

      clearTimeout(this.switchNoticeTimer)
      this.switchNoticeTimer = setTimeout(() => {
        // 这 1.5 秒里界面可能已经被别的东西接管了，各自都别覆盖：
        //   composing            —— 用户开始打字，候选窗正在显示
        //   engineMessageShown   —— 引擎报错/加载中的提示正在显示，它得一直留着
        if (this.composing || this.engineMessageShown) return
        this.window.hide()
      }, 1500)
    }

    /* ---------------- 状态栏：选输入法 / 选简繁 ---------------- */

    /**
     * 状态栏里点了一个输入法。
     * 和 F4、设置页下拉框走的是同一条路（switchSchema），只是入口不同。
     */
    selectSchemaFromStatusBar (schemaId) {
      if (!schemaId || schemaId === this.schemaId) return
      this.enqueue(() => this.switchSchema(schemaId))
    }

    /**
     * 外部（bootstrap 读 storage / storage 变更）送进来的状态栏偏好。
     * @param {{tradSimp?: string, collapsed?: boolean}} patch
     */
    setStatusBarPrefs (patch = {}) {
      const preferenceChanged = typeof patch.tradSimp === 'string' && patch.tradSimp !== this.tradSimpPreference
      if (preferenceChanged) this.tradSimpPreference = patch.tradSimp
      if (typeof patch.collapsed === 'boolean') this.statusBarCollapsed = patch.collapsed
      this.renderStatusBar()
      // 别的标签页改了偏好：这边跟着换，并（引擎在当前方案上时）立刻生效
      if (preferenceChanged) this.applyTradSimpIfCurrent()
    }

    /** 状态栏里点了「跟随 / 简 / 繁 / 臺…」 */
    async setTradSimpPreference (name) {
      this.tradSimpPreference = name === 'auto' ? 'auto' : String(name)
      this.renderStatusBar()
      this.persistStatusBarPrefs({ [globalThis.RIME_CONST.STORAGE_KEYS.tradSimp]: this.tradSimpPreference })
      await this.applyTradSimp()
    }

    /** 状态栏收起/展开 */
    setStatusBarCollapsed (collapsed) {
      this.statusBarCollapsed = Boolean(collapsed)
      this.renderStatusBar()
      this.persistStatusBarPrefs({ [globalThis.RIME_CONST.STORAGE_KEYS.collapsed]: this.statusBarCollapsed })
    }

    persistStatusBarPrefs (patch) {
      try {
        chrome.storage.local.set(patch)
      } catch (error) {
        // 少数宿主没有 storage（例如被注入到奇怪的环境里），记不住不影响这次会话
        console.warn('[rime] 状态栏偏好保存失败', error)
      }
    }

    /**
     * 当前方案 + 当前偏好下该用的简繁 variant。
     * @returns {{name: string, options: Record<string, boolean>}|null} null = 该方案没有简繁开关
     */
    tradSimpVariant () {
      const { TRAD_SIMP, tradSimpDefault } = globalThis.RIME_CONST
      if (!TRAD_SIMP[this.schemaId]) return null
      return tradSimpDefault(this.schemaId, navigator.language, this.tradSimpPreference)
    }

    /** 把偏好的简繁开关下发给引擎。没有简繁开关的方案什么都不做 */
    async applyTradSimp () {
      const variant = this.tradSimpVariant()
      if (!variant) {
        if (this.tradSimpActive) {
          this.tradSimpActive = ''
          this.renderStatusBar()
        }
        return
      }
      // 注音那种多选开关（zh_hans / zh_hant / zh_hant_tw）必须整组下发：
      // 只打开一个会残留上一次的取值
      for (const [option, value] of Object.entries(variant.options)) {
        await this.request(OP.SET_OPTION, { option, value })
      }
      this.tradSimpActive = variant.name
      this.renderStatusBar()
    }

    /**
     * 确保「方案已装载 + 偏好已下发」。
     *
     * 引擎刚冷启动时方案还没装载，而 LOAD_SCHEMA 是幂等的（已装载就秒回），
     * 所以这里直接发一次，省得第一次打字的候选还是语言默认值那套字形。
     *
     * **只在「打开输入法」这类明确的时机调用**：装载方案会改变引擎当前的方案，
     * 如果拿它去响应引擎状态事件，就会和正在进行的切换互相打架（换上来的又被换回去）。
     */
    async ensureTradSimpApplied () {
      if (!this.enabled) return
      const variant = this.tradSimpVariant()
      if (!variant) {
        if (this.tradSimpActive) {
          this.tradSimpActive = ''
          this.renderStatusBar()
        }
        return
      }
      await this.request(OP.LOAD_SCHEMA, { schemaId: this.schemaId })
      await this.applyTradSimp()
    }

    /**
     * 只补简繁开关，**不动方案**。用于引擎状态变化、偏好被别处改掉这类时机。
     * @param {{schemaId?: string}} [status] 引擎自报的状态；它报的要是别的方案，
     *        说明切换还在路上（或别的标签页换了），这时别去改开关，等切换完再说
     */
    applyTradSimpIfCurrent (status) {
      if (!this.enabled) return
      if (status && status.schemaId && status.schemaId !== this.schemaId) return
      this.enqueue(() => this.applyTradSimp()
        .catch(error => console.warn('[rime] 简繁偏好下发失败', error)))
    }

    /**
     * 引擎回报「这次按键改了哪些开关」时同步状态栏。
     * librime 的约定：'name' = 打开，'!name' = 关闭（api.cpp 直接把通知值放进 updatedOptions）。
     * @param {string[]} updatedOptions
     */
    syncTradSimpFromOptions (updatedOptions) {
      const variants = globalThis.RIME_CONST.TRAD_SIMP[this.schemaId]
      if (!variants) return
      const state = {}
      for (const item of updatedOptions) {
        if (typeof item !== 'string' || !item) continue
        if (item.startsWith('!')) state[item.slice(1)] = false
        else state[item] = true
      }
      // 只用「回报过的开关」去比对：没提到的不参与，否则注音那三个选项永远对不上
      const hit = variants.find(variant =>
        Object.keys(state).every(option => variant.options[option] === undefined || variant.options[option] === state[option]))
      if (!hit || hit.name === this.tradSimpActive) return
      this.tradSimpActive = hit.name
      this.renderStatusBar()
    }

    schemaName (schemaId = this.schemaId) {
      const schemas = (globalThis.RIME_CONST && globalThis.RIME_CONST.SCHEMAS) || []
      const found = schemas.find(s => s.id === schemaId)
      return (found && found.name) || schemaId
    }

    renderStatusBar () {
      if (!this.statusBar) return
      const variants = globalThis.RIME_CONST.TRAD_SIMP[this.schemaId] || []
      this.statusBar.setState({
        schemaId: this.schemaId,
        schemaName: this.schemaName(),
        variants,
        preference: this.tradSimpPreference,
        activeName: this.tradSimpActive,
        collapsed: this.statusBarCollapsed
      })
    }

    /* ---------------- 上屏 ---------------- */

    insert (text) {
      const el = this.target
      if (!el || !text || !el.isConnected) return
      if (el.isContentEditable) this.insertIntoContentEditable(el, text)
      else this.insertIntoInput(el, text)
    }

    insertIntoInput (el, text) {
      try {
        el.focus({ preventScroll: true })
      } catch (e) { /* 少数元素不接受 options */ }
      if (execInsertText(text)) return
      // execCommand 被禁用时的退路：走原生 setter + 手动派发 input 事件，
      // 这样 React/Vue 的受控组件也能收到变更
      try {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        const start = el.selectionStart == null ? el.value.length : el.selectionStart
        const end = el.selectionEnd == null ? start : el.selectionEnd
        setter.call(el, el.value.slice(0, start) + text + el.value.slice(end))
        el.selectionStart = el.selectionEnd = start + text.length
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      } catch (error) {
        console.warn('[rime] 无法上屏', error)
      }
    }

    insertIntoContentEditable (el, text) {
      try {
        el.focus({ preventScroll: true })
      } catch (e) { /* ignore */ }
      // 先问一次页面自己的编辑器：富文本编辑器（Slate / ProseMirror / Lexical / Draft.js …）
      // 的文档模型只在 beforeinput 里更新，而下面 execCommand 那条路**不会**派发
      // beforeinput——Chrome 对 execCommand('insertText') 只派发 input。
      // 于是 DOM 里有字、页面模型里没字：占位符不消失、翻译/提交读到的是空内容，
      // 页面下一次按自己的模型重渲染还会把这几个字抹掉。
      // 实测 fanyi.baidu.com/mtpe-individual 的输入框就是这种 Slate 编辑器。
      if (dispatchBeforeInput(el, text)) return
      if (execInsertText(text)) return
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }

    /* ---------------- 引擎状态 ---------------- */

    handleEngineStatus (status) {
      this.engineState = status.state
      this.engineMessage = status.message || ''
      // 注意：这里**不**用 status.schemaId 覆盖 this.schemaId。引擎上报的可能是
      // 上一轮的方案（切换还在路上），照抄回去就会重演「切换了但打字还是老方案」。
      this.renderStatusBar()
      if (status.state === ENGINE_STATE.READY) {
        if (this.engineMessageShown) {
          this.window.hide()
          this.engineMessageShown = false
        }
        // 引擎就绪前下发的简繁开关可能打在了还没装载的方案上，这里补一刀（只改开关）
        this.applyTradSimpIfCurrent(status)
        return
      }
      if (!this.enabled || !this.target || !NS.isEditable(this.target)) return
      const isError = status.state === ENGINE_STATE.ERROR
      this.window.showMessage(
        status.message || (status.state === ENGINE_STATE.LOADING ? '正在加载 RIME 引擎…' : ''),
        NS.getCaretRect(this.target),
        isError ? 'error' : 'info'
      )
      this.engineMessageShown = true
    }
  }

  function execInsertText (text) {
    try {
      return document.execCommand('insertText', false, text)
    } catch (e) {
      return false
    }
  }

  /**
   * 派发一个合成的 beforeinput，把这次输入「交给页面自己的编辑器处理」。
   *
   * 富文本编辑器的模型更新入口就是 beforeinput：它会在那里 preventDefault，
   * 然后自己把文本写进模型并重新渲染 DOM（我们实测 Slate 就是这么做的，
   * 派发完 DOM 和模型都是对的）。所以：
   *   - 页面接管了（defaultPrevented）→ 调用方**不要**再动 DOM，否则会和页面写重；
   *   - 页面没接管（普通 contenteditable）→ 返回 false，调用方照旧走 execCommand。
   *
   * 合成事件没有默认动作，因此对没有监听者的页面是完全无害的空操作。
   *
   * @returns {boolean} 页面接管了这次输入
   */
  function dispatchBeforeInput (target, text) {
    let event
    try {
      event = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true, // 目标可能在 Shadow DOM 里，得让它冒出去
        inputType: 'insertText',
        data: text
      })
    } catch (e) {
      return false // 没有 InputEvent 构造器（很老的浏览器）时退回 execCommand
    }
    try {
      target.dispatchEvent(event)
    } catch (e) {
      return false
    }
    return event.defaultPrevented
  }

  NS.ImeController = ImeController
  NS.RIME_KEY_MAP = RIME_KEY_MAP
})(globalThis.RIME_CS)
