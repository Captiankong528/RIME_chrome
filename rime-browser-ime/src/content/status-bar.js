/**
 * 状态栏：常驻页面右下角的小工具条，用来选输入法（RIME 方案）和简繁。
 *
 * 和候选窗一样用 Shadow DOM 承载（closed），页面样式进不来、我们也不污染页面；
 * 宿主挂在 <html> 下、子元素 position: fixed，所以页面给 body 加 transform 也不会
 * 把我们带着一起偏。
 *
 * 三条约定：
 *   1. **只在顶层 frame 显示**。输入法状态是全局的（同一个引擎、同一份设置），
 *      每个 iframe 都挂一条的话，一个页面上会出现好几条互相重叠的条。
 *   2. **不抢焦点**：mousedown 一律 preventDefault，点状态栏不会让输入框失焦。
 *   3. 本文件只在被 show() 时才碰 document，所以离线测试里构造 ImeController
 *      不会因为 Node 没有 DOM 而炸掉。
 */
globalThis.RIME_CS = globalThis.RIME_CS || {}

;(function (NS) {
  const STYLE = `
    :host { all: initial; }
    .bar {
      position: fixed;
      right: 12px;
      bottom: 12px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      background: #ffffff;
      color: #1f2329;
      border: 1px solid #d5dae1;
      border-radius: 999px;
      box-shadow: 0 4px 16px rgba(16, 24, 40, .16);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
            "PingFang SC", "Hiragino Sans GB", sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .bar button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 999px;
      padding: 3px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bar button:hover { background: #f2f5fa; }
    .bar button.on { background: #e6efff; color: #1e5bd6; }
    .bar .schema {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bar .divider {
      width: 1px;
      height: 14px;
      background: #e4e7ec;
      flex: none;
    }
    /* ---------------- 展开 / 收起 ---------------- */
    .main { display: contents; }
    .bar.collapsed .main { display: none; }
    .bar .chip { min-width: 26px; text-align: center; }
    .bar .collapse { color: #98a2b3; padding: 3px 6px; }
    .panel {
      position: fixed;
      right: 12px;
      bottom: 46px;
      box-sizing: border-box;
      min-width: 168px;
      max-height: min(60vh, 420px);
      overflow: auto;
      padding: 6px;
      background: #ffffff;
      color: #1f2329;
      border: 1px solid #d5dae1;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(16, 24, 40, .18);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
            "PingFang SC", "Hiragino Sans GB", sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .panel[hidden] { display: none; }
    .panel .group-title {
      padding: 4px 8px 2px;
      color: #98a2b3;
      font-size: 12px;
    }
    .panel .item {
      display: block;
      width: 100%;
      text-align: left;
      border-radius: 6px;
      padding: 4px 8px;
      box-sizing: border-box;
    }
    .panel .item.on { background: #e6efff; color: #1e5bd6; }
    .panel .hint {
      padding: 4px 8px;
      color: #98a2b3;
      font-size: 12px;
    }
  `

  class StatusBar {
    constructor (handlers = {}) {
      this.onSelectSchema = handlers.onSelectSchema || (() => {})
      this.onSelectTradSimp = handlers.onSelectTradSimp || (() => {})
      this.onToggleCollapse = handlers.onToggleCollapse || (() => {})
      this.host = null
      this.root = null
      this.bar = null
      this.main = null
      this.schemaButton = null
      this.simplifyGroup = null
      this.panel = null
      this.visible = false
      /** @type {{schemaId: string, schemaName: string, variants: object[], preference: string,
       *           activeName: string, collapsed: boolean}} */
      this.state = {
        schemaId: '',
        schemaName: '',
        variants: [],
        preference: 'auto',
        activeName: '',
        collapsed: false
      }
    }

    /**
     * 顶层 frame 才显示（见文件头的约定 1）。
     *
     * 三个都要相等才算顶层：`window.self === window.top` 单独用不够——
     * 测试里那种 `{innerWidth, innerHeight}` 的窗口桩会让 undefined === undefined 成立。
     */
    static isTopFrame () {
      try {
        return typeof window !== 'undefined' &&
          window.self === window &&
          window.self === window.top
      } catch (e) {
        // 跨域 iframe 里访问 window.top 会抛，那就不是顶层
        return false
      }
    }

    ensure () {
      if (this.host && this.host.isConnected) return
      const host = document.createElement('div')
      host.setAttribute('data-rime-ime', 'status-bar')
      host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;'
      const root = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent = STYLE

      const bar = this.el('div', 'bar')
      // 展开时用 display: contents 让三个子元素直接参与 .bar 的 flex 布局；
      // 收起的隐藏规则写在样式表里（.bar.collapsed .main），这里**不能**用内联样式，
      // 否则内联的 display 会盖掉那条规则，收起就失灵了
      const main = this.el('div', 'main')

      const schemaButton = this.el('button', 'schema', '')
      schemaButton.title = '选择输入法'
      schemaButton.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        this.togglePanel()
      })

      const divider = this.el('div', 'divider')
      const simplifyGroup = this.el('div', 'simplify')
      simplifyGroup.style.display = 'flex'
      simplifyGroup.style.alignItems = 'center'
      simplifyGroup.style.gap = '4px'

      const collapse = this.el('button', 'collapse', '⌄')
      collapse.title = '收起 / 展开状态栏'
      collapse.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        this.onToggleCollapse(!this.state.collapsed)
      })

      main.append(schemaButton, divider, simplifyGroup)
      bar.append(main, collapse)

      const panel = this.el('div', 'panel')
      panel.hidden = true

      root.append(style, bar, panel)
      // 挂在 <html> 而不是 <body> 下：页面给 body 加 transform/filter 时，
      // position: fixed 会以那个元素为包含框，状态栏就会跟着页面一起偏
      ;(document.documentElement || document.body).appendChild(host)

      this.host = host
      this.root = root
      this.bar = bar
      this.main = main
      this.schemaButton = schemaButton
      this.simplifyGroup = simplifyGroup
      this.panel = panel

      // 点状态栏不能把输入框的焦点抢走，否则用户点完就没法接着打字了
      bar.addEventListener('mousedown', event => event.preventDefault())
      panel.addEventListener('mousedown', event => event.preventDefault())

      // 点页面别处收起方案面板。composedPath 能穿透 shadow root 看到 host
      this.onDocumentMouseDown = event => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : []
        if (path.includes(host)) return
        this.closePanel()
      }
      document.addEventListener('mousedown', this.onDocumentMouseDown, true)
    }

    /**
     * 更新状态并重绘。调用方（ImeController）是唯一的状态来源，
     * 这样状态栏本身不必知道引擎、storage 这些东西。
     */
    setState (patch = {}) {
      Object.assign(this.state, patch)
      if (this.bar) this.render()
    }

    show () {
      // 非顶层 frame 干脆不建 DOM，省得每个 iframe 里都留一份
      if (!StatusBar.isTopFrame()) return
      this.ensure()
      this.visible = true
      this.bar.style.display = ''
      this.render()
    }

    hide () {
      this.visible = false
      this.closePanel()
      if (this.bar) this.bar.style.display = 'none'
    }

    destroy () {
      if (this.onDocumentMouseDown) {
        try {
          document.removeEventListener('mousedown', this.onDocumentMouseDown, true)
        } catch (e) { /* ignore */ }
        this.onDocumentMouseDown = null
      }
      if (this.host) this.host.remove()
      this.host = null
      this.root = null
      this.bar = null
      this.main = null
      this.schemaButton = null
      this.simplifyGroup = null
      this.panel = null
      this.visible = false
    }

    /* ---------------- 渲染 ---------------- */

    render () {
      if (!this.bar) return
      const { schemaName, variants, preference, activeName, collapsed } = this.state

      this.bar.classList.toggle('collapsed', Boolean(collapsed))
      this.schemaButton.textContent = collapsed ? '' : `${schemaName || '输入法'} ▾`
      const collapse = this.bar.querySelector('.collapse')
      if (collapse) {
        collapse.textContent = collapsed ? (activeName || '中') : '⌄'
        collapse.title = collapsed ? '展开状态栏（选择输入法 / 简繁）' : '收起状态栏'
      }

      // 简繁：一个「跟随」+ 该方案自己的每个 variant（朙月拼音是 简/繁，注音是 简/臺/繁）。
      // 没有简繁开关的方案（袖珍简拼、86五笔、五笔画）整组不显示。
      this.simplifyGroup.replaceChildren()
      this.simplifyGroup.style.display = variants.length ? 'flex' : 'none'
      if (!variants.length) return

      const auto = this.el('button', 'chip' + (preference === 'auto' ? ' on' : ''), '跟随')
      auto.title = '跟随浏览器语言（' + (activeName ? `当前 ${activeName}` : '默认') + '）'
      auto.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        this.onSelectTradSimp('auto')
      })
      this.simplifyGroup.append(auto)

      for (const variant of variants) {
        const on = variant.name === activeName
        const chip = this.el('button', 'chip' + (on ? ' on' : ''), variant.name)
        chip.title = `简体/繁体：${variant.name}`
        chip.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          this.onSelectTradSimp(variant.name)
        })
        this.simplifyGroup.append(chip)
      }
    }

    togglePanel () {
      this.ensure()
      if (this.panel.hidden) this.openPanel()
      else this.closePanel()
    }

    openPanel () {
      this.renderPanel()
      this.panel.hidden = false
    }

    closePanel () {
      if (this.panel) this.panel.hidden = true
    }

    /** 方案列表：按 SCHEMAS 的 group 分组，和设置页下拉框一致 */
    renderPanel () {
      const panel = this.panel
      if (!panel) return
      const { SCHEMAS } = globalThis.RIME_CONST
      panel.replaceChildren()

      const groups = new Map()
      for (const schema of SCHEMAS) {
        const name = schema.group || '其他'
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(schema)
      }

      for (const [label, list] of groups) {
        panel.append(this.el('div', 'group-title', label))
        for (const schema of list) {
          const on = schema.id === this.state.schemaId
          const item = this.el('button', 'item' + (on ? ' on' : ''), schema.name)
          item.dataset.schemaId = schema.id
          item.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            this.closePanel()
            // 已经选中的再点一次没有意义，但也不必拦着——调用方会走幂等路径
            this.onSelectSchema(schema.id)
          })
          panel.append(item)
        }
      }
      panel.append(this.el('div', 'hint', 'F4 也能在打字时循环切换'))
    }

    /**
     * 给测试和真机 e2e 用：当前点得到的东西 + 它们的视口坐标。
     * Shadow DOM 是 closed 的，脚本没法从外面查 DOM，所以由这里报出来。
     * @returns {{key: string, label: string, active: boolean,
     *            rect: {left: number, top: number, width: number, height: number}}[]}
     */
    buttons () {
      if (!this.bar || !this.visible || this.bar.style.display === 'none') return []
      const out = []
      const add = (key, label, node, active) => {
        if (!node) return
        const rect = node.getBoundingClientRect()
        // 收起状态（display: none / .main 隐藏）下的按钮全都量到 0×0，别报出去，
        // 否则 e2e 会照着 (0,0) 点，点到页面左上角去
        if (!rect.width || !rect.height) return
        out.push({
          key,
          label,
          active: Boolean(active),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        })
      }

      add('schema', this.state.schemaName, this.schemaButton, false)
      for (const control of this.simplifyGroup.querySelectorAll('button')) {
        const label = control.textContent
        add(label === '跟随' ? 'tradSimp:auto' : `tradSimp:${label}`, label, control, control.classList.contains('on'))
      }
      add('collapse', this.bar.querySelector('.collapse')?.textContent || '', this.bar.querySelector('.collapse'), this.state.collapsed)

      if (this.panel && !this.panel.hidden) {
        for (const item of this.panel.querySelectorAll('button.item')) {
          add(`schema:${item.dataset.schemaId}`, item.textContent, item, item.classList.contains('on'))
        }
      }
      return out
    }

    el (tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text != null) node.textContent = text
      return node
    }
  }

  NS.StatusBar = StatusBar
})(globalThis.RIME_CS)
