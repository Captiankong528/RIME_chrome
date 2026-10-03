/**
 * 候选窗。
 *
 * 用 Shadow DOM 承载，页面样式进不来，我们的样式也污染不到页面。
 * 定位在视口坐标系（position: fixed），随滚动/改变尺寸时由调用方重新 show()。
 */
globalThis.RIME_CS = globalThis.RIME_CS || {}

;(function (NS) {
  const STYLE = `
    :host { all: initial; }
    .wrap {
      position: fixed;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: min(92vw, 720px);
      padding: 6px 9px;
      background: #ffffff;
      color: #1f2329;
      border: 1px solid #d5dae1;
      border-radius: 9px;
      box-shadow: 0 8px 28px rgba(16, 24, 40, .18);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
            "PingFang SC", "Hiragino Sans GB", sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .preedit {
      display: flex;
      align-items: baseline;
      font-size: 15px;
      letter-spacing: .4px;
      white-space: pre;
    }
    .preedit .body {
      color: #1e5bd6;
      border-bottom: 2px solid #1e5bd6;
    }
    .preedit .ghost { color: #98a2b3; }
    .cands {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 2px 4px;
    }
    .cand {
      display: flex;
      align-items: baseline;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
    }
    .cand:hover { background: #f2f5fa; }
    .cand.active { background: #e6efff; }
    .cand .idx { color: #98a2b3; font-size: 12px; }
    .cand .text { font-size: 17px; }
    .cand .comment { color: #98a2b3; font-size: 12px; }
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: #667085;
      font-size: 12px;
    }
    .pager { display: flex; align-items: center; gap: 4px; }
    .pager button {
      font: inherit;
      color: #667085;
      background: transparent;
      border: 1px solid #d5dae1;
      border-radius: 4px;
      padding: 0 5px;
      cursor: pointer;
      line-height: 16px;
    }
    .pager button:disabled { opacity: .4; cursor: default; }
    .msg { color: #667085; font-size: 13px; }
    .error { color: #d92d20; font-size: 13px; }
  `

  class CandidateWindow {
    constructor (handlers = {}) {
      this.onSelect = handlers.onSelect || (() => {})
      this.onPage = handlers.onPage || (() => {})
      this.host = null
      this.root = null
      this.wrap = null
      this.anchor = null
      this.visible = false
    }

    ensure () {
      if (this.host && this.host.isConnected) return
      const host = document.createElement('div')
      host.setAttribute('data-rime-ime', 'candidate-window')
      // all: initial 挡住页面继承下来的字体/颜色/行高等
      host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;'
      const root = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent = STYLE
      const wrap = document.createElement('div')
      wrap.className = 'wrap'
      wrap.style.display = 'none'
      root.append(style, wrap)
      // 挂在 <html> 而不是 <body> 下：页面给 body 加 transform/filter 时，
      // position: fixed 会以那个元素为包含块，候选窗就会跟着页面一起偏移
      ;(document.documentElement || document.body).appendChild(host)
      this.host = host
      this.root = root
      this.wrap = wrap

      // 在候选窗上按下鼠标不能把输入框的焦点抢走
      wrap.addEventListener('mousedown', event => event.preventDefault())
    }

    /** 显示消息型内容（加载中 / 报错） */
    showMessage (text, anchor, kind) {
      this.ensure()
      this.wrap.replaceChildren(this.el('div', kind === 'error' ? 'error' : 'msg', text))
      this.anchor = anchor
      this.render()
    }

    /**
     * @param {object} state
     * @param {string} state.head 编码串里被选中部分之前的部分
     * @param {string} state.body 被选中（正在编辑）的部分
     * @param {string} state.tail 之后的部分
     * @param {{text: string, comment?: string}[]} state.candidates
     * @param {string[]} [state.selectLabels]
     * @param {number} state.highlighted
     * @param {number} state.page
     * @param {boolean} state.isLastPage
     * @param {{left:number,top:number,height:number}} anchor
     */
    show (state, anchor) {
      this.ensure()
      this.anchor = anchor

      const wrap = this.wrap
      wrap.replaceChildren()

      const preedit = this.el('div', 'preedit')
      if (state.head) preedit.append(this.el('span', 'ghost', state.head))
      if (state.body) preedit.append(this.el('span', 'body', state.body))
      if (state.tail) preedit.append(this.el('span', 'ghost', state.tail))
      wrap.append(preedit)

      const cands = this.el('div', 'cands')
      state.candidates.forEach((candidate, index) => {
        const item = this.el('div', 'cand' + (index === state.highlighted ? ' active' : ''))
        const label = (state.selectLabels && state.selectLabels[index]) || String(index + 1)
        item.append(this.el('span', 'idx', label))
        item.append(this.el('span', 'text', candidate.text))
        if (candidate.comment) item.append(this.el('span', 'comment', candidate.comment))
        item.title = candidate.comment || candidate.text
        item.addEventListener('mousedown', event => {
          event.preventDefault()
          event.stopPropagation()
        })
        item.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          this.onSelect(index)
        })
        cands.append(item)
      })
      wrap.append(cands)

      if (state.page > 0 || !state.isLastPage) {
        const foot = this.el('div', 'foot')
        foot.append(this.el('span', '', `第 ${state.page + 1} 页`))
        const pager = this.el('div', 'pager')
        const prev = this.el('button', '', '‹')
        const next = this.el('button', '', '›')
        prev.disabled = state.page === 0
        next.disabled = state.isLastPage
        prev.addEventListener('click', event => {
          event.preventDefault()
          this.onPage(true)
        })
        next.addEventListener('click', event => {
          event.preventDefault()
          this.onPage(false)
        })
        pager.append(prev, next)
        foot.append(pager)
        wrap.append(foot)
      }

      this.render()
    }

    hide () {
      if (!this.host) return
      this.visible = false
      if (this.wrap) this.wrap.style.display = 'none'
    }

    destroy () {
      if (this.host) this.host.remove()
      this.host = null
      this.root = null
      this.wrap = null
      this.visible = false
    }

    /** 按当前 anchor 重新摆放，并夹在视口内 */
    render () {
      const wrap = this.wrap
      if (!wrap || !this.anchor) return
      wrap.style.display = ''
      wrap.style.left = '-9999px'
      wrap.style.top = '0px'

      const rect = wrap.getBoundingClientRect()
      const margin = 6
      const gap = 4
      let left = this.anchor.left
      let top = this.anchor.top + this.anchor.height + gap

      if (top + rect.height > window.innerHeight - margin) {
        const above = this.anchor.top - rect.height - gap
        // 下面放不下就翻到光标上方；上方也放不下就贴底
        top = above >= margin ? above : Math.max(margin, window.innerHeight - rect.height - margin)
      }
      if (left + rect.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - rect.width - margin)
      }
      if (left < margin) left = margin
      if (top < margin) top = margin

      wrap.style.left = Math.round(left) + 'px'
      wrap.style.top = Math.round(top) + 'px'
      this.visible = true
    }

    el (tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text != null) node.textContent = text
      return node
    }
  }

  NS.CandidateWindow = CandidateWindow
})(globalThis.RIME_CS)
