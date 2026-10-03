/**
 * 光标定位与可编辑元素判定。
 *
 * 候选窗要跟着光标走，但浏览器没有「给我输入框里光标的屏幕坐标」这种 API，
 * 所以三种情况分别处理：
 *   - <input>/<textarea>：用镜像 div 复刻排版，再量出光标的偏移
 *   - contenteditable   ：用 Selection/Range 的矩形
 *   - 其他              ：退回元素自身的外框
 */
globalThis.RIME_CS = globalThis.RIME_CS || {}

;(function (NS) {
  /** 复刻输入框排版时需要拷贝的样式属性 */
  const MIRROR_PROPS = [
    'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'textDecoration',
    'letterSpacing', 'wordSpacing', 'tabSize', 'direction'
  ]

  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email'])

  /** 是否是我们可以安全接管文本输入的元素 */
  function isEditable (el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false
    if (el.isContentEditable) return true
    const tag = el.tagName
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly
    if (tag === 'INPUT') {
      if (el.disabled || el.readOnly) return false
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return TEXT_INPUT_TYPES.has(type)
    }
    return false
  }

  function fallbackLineHeight (computed) {
    const lh = parseFloat(computed.lineHeight)
    if (lh && !Number.isNaN(lh)) return lh
    const fs = parseFloat(computed.fontSize)
    return (!fs || Number.isNaN(fs) ? 14 : fs) * 1.2
  }

  /** <input>/<textarea> 的插入符矩形 */
  function caretRectInInput (el) {
    const computed = getComputedStyle(el)
    const isInput = el.tagName === 'INPUT'
    const mirror = document.createElement('div')
    const style = mirror.style
    style.position = 'absolute'
    style.visibility = 'hidden'
    style.top = '0'
    style.left = '-9999px'
    style.whiteSpace = isInput ? 'pre' : 'pre-wrap'
    if (!isInput) style.wordWrap = 'break-word'
    style.overflow = 'hidden'
    for (const prop of MIRROR_PROPS) {
      if (isInput && prop === 'lineHeight') continue
      try { style[prop] = computed[prop] } catch (e) { /* 个别属性在部分浏览器只读 */ }
    }
    if (isInput) {
      // 单行输入框内部是垂直居中的，镜像 div 得把行高撑到内容高度才对得上
      const outer = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
        .reduce((sum, p) => sum + (parseFloat(computed[p]) || 0), 0)
      const lineHeight = fallbackLineHeight(computed)
      if (computed.boxSizing === 'border-box') {
        const height = parseFloat(computed.height) || 0
        const target = outer + lineHeight
        style.lineHeight = height > target ? `${height - outer}px`
          : height === target ? computed.lineHeight
            : '0px'
      } else {
        style.lineHeight = computed.height
      }
    }

    const start = el.selectionStart == null ? 0 : el.selectionStart
    mirror.textContent = el.value.substring(0, start)
    // <input> 里连续空格会被折叠，用不换行空格占位
    if (isInput) mirror.textContent = mirror.textContent.replace(/\s/g, '\u00a0')

    const marker = document.createElement('span')
    // 末尾必须有个字符，否则量不到位置
    marker.textContent = el.value.substring(start) || '.'
    mirror.appendChild(marker)

    const parent = document.body || document.documentElement
    parent.appendChild(mirror)
    const borderLeft = parseFloat(computed.borderLeftWidth) || 0
    const borderTop = parseFloat(computed.borderTopWidth) || 0
    const offsetLeft = marker.offsetLeft + borderLeft - (el.scrollLeft || 0)
    const offsetTop = marker.offsetTop + borderTop - (el.scrollTop || 0)
    // 直接用实际渲染出来的行盒高度，比自己算行高更准
    const height = marker.offsetHeight || fallbackLineHeight(computed)
    mirror.remove()

    const box = el.getBoundingClientRect()
    return { left: box.left + offsetLeft, top: box.top + offsetTop, height }
  }

  /** contenteditable 的插入符矩形 */
  function caretRectInSelection (element) {
    // Shadow DOM 内部的选择：document.getSelection() 拿到的是被重定向到宿主的结果，
    // 得用 ShadowRoot.getSelection()（Chrome 支持，非标准）才准
    let selection = null
    try {
      const root = element && typeof element.getRootNode === 'function' ? element.getRootNode() : null
      if (root && root !== document && typeof root.getSelection === 'function') {
        selection = root.getSelection()
      }
    } catch (e) { /* 落到 document 的 selection */ }
    if (!selection || selection.rangeCount === 0) selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0).cloneRange()
    let rect = range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      // 空行/空节点上折叠的 range 量不出尺寸，临时塞一个零宽字符
      const marker = document.createElement('span')
      marker.textContent = '\u200b'
      try {
        range.insertNode(marker)
        rect = marker.getBoundingClientRect()
        marker.remove()
      } catch (e) {
        return null
      }
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) return null
    return { left: rect.left, top: rect.top, height: rect.height || 16 }
  }

  /**
   * 返回插入符在视口坐标系里的位置。
   * @param {Element} el
   * @returns {{left: number, top: number, height: number}}
   */
  function getCaretRect (el) {
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        return caretRectInInput(el)
      }
      const rect = caretRectInSelection(el)
      if (rect) return rect
    } catch (e) {
      console.warn('[rime] 光标定位失败，退回元素外框', e)
    }
    const box = el.getBoundingClientRect()
    return { left: box.left, top: box.top, height: box.height || 18 }
  }

  NS.isEditable = isEditable
  NS.getCaretRect = getCaretRect
})(globalThis.RIME_CS)
