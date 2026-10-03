/**
 * content script 冒烟测试：按键映射 + 引擎返回值状态机。
 *
 * 这两段是纯逻辑（不碰真实 DOM），但直接决定打字手感，所以单独离线测。
 * 做法是把 src/content 下的文件按 manifest 的顺序用 vm 跑起来，
 * 再用桩替换掉候选窗、光标定位和 chrome API。
 *
 * 用法: node scripts/content-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(import.meta.dirname, '..')

/* ------------------------------------------------------------------ *
 * 搭环境
 * ------------------------------------------------------------------ */

globalThis.RIME_CS = {}
globalThis.RIME_CONST = undefined
// caret.js 的 isEditable 用到 Node.ELEMENT_NODE
globalThis.Node = { ELEMENT_NODE: 1 }

// 简繁偏好里的 'auto' 要看浏览器语言，而本机的区域设置不该决定断言结果：钉成 zh-CN（简体）
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true
})

const load = rel => {
  const file = path.join(ROOT, rel)
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
}

// 按 manifest 里 content_scripts 的顺序加载
load('src/common/const.js')
load('src/content/caret.js')
load('src/content/candidate-window.js')
load('src/content/status-bar.js')
// 状态栏的 DOM 那半边要真浏览器才测得了（e2e 里点它）；离线这层换成记录替身，
// 测的是「控制器怎么用它」：什么时候显示、下了哪些开关、偏好怎么读写
const RealStatusBar = globalThis.RIME_CS.StatusBar
const statusBarStub = { instances: [], handlers: null }
class FakeStatusBar {
  constructor (handlers) {
    statusBarStub.handlers = handlers
    statusBarStub.instances.push(this)
    this.calls = []
    this.state = {}
    this.visible = false
  }

  show () { this.visible = true; this.calls.push('show') }
  hide () { this.visible = false; this.calls.push('hide') }
  setState (patch) { Object.assign(this.state, patch); this.calls.push('setState') }
  destroy () { this.calls.push('destroy') }
  buttons () { return [] }
}
globalThis.RIME_CS.StatusBar = FakeStatusBar
load('src/content/ime.js')

const { ImeController } = globalThis.RIME_CS
const { RIME_STATE, ENGINE_STATE } = globalThis.RIME_CONST

/** 记下所有发往 background 的请求，并允许逐条改返回值 */
const sent = []
let respond = () => ({ ok: true, result: { state: RIME_STATE.UNHANDLED } })
/** 状态栏偏好写进 storage 的内容 */
const storageWrites = []

// request() 走 chrome.runtime.sendMessage
globalThis.chrome = {
  runtime: {
    sendMessage: async message => {
      sent.push(message)
      return respond(message)
    }
  },
  storage: {
    local: {
      set: async patch => { storageWrites.push(patch) },
      get: async defaults => ({ ...defaults })
    }
  }
}

let failures = 0
function check (label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
  }
}

/** 造一个 KeyboardEvent 的替身 */
function ev (patch) {
  return {
    code: 'KeyA',
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 65,
    target: null,
    preventDefault () { this.defaultPrevented = true },
    stopPropagation () { this.propagationStopped = true },
    defaultPrevented: false,
    propagationStopped: false,
    ...patch
  }
}

/** 造一个可编辑元素的替身 */
function editable (tag = 'INPUT') {
  return {
    nodeType: 1,
    tagName: tag,
    isContentEditable: false,
    disabled: false,
    readOnly: false,
    isConnected: true,
    getAttribute: () => 'text',
    focus () {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 })
  }
}

/* ------------------------------------------------------------------ *
 * 1. 按键映射
 * ------------------------------------------------------------------ */

console.log('\n== 按键映射（未组字） ==')
{
  const c = new ImeController({ schemaId: 'luna_pinyin' })

  const plain = c.buildRimeKey(ev({ key: 'a', code: 'KeyA' }))
  check('a -> "a"', plain && plain.rimeKey === 'a', plain)

  const upper = c.buildRimeKey(ev({ key: 'A', code: 'KeyA', shiftKey: true }))
  check('Shift+A -> "A"（交给 librime 当 shift+a）', upper && upper.rimeKey === 'A', upper)

  const space = c.buildRimeKey(ev({ key: ' ', code: 'Space', keyCode: 32 }))
  check('空格 -> " "', space && space.rimeKey === ' ', space)

  const digit = c.buildRimeKey(ev({ key: '1', code: 'Digit1', keyCode: 49 }))
  check('1 -> "1"', digit && digit.rimeKey === '1', digit)

  const numpad = c.buildRimeKey(ev({ key: '1', code: 'Numpad1', keyCode: 97 }))
  check('小键盘 1 -> "{KP_1}"', numpad && numpad.rimeKey === '{KP_1}', numpad)

  const f4 = c.buildRimeKey(ev({ key: 'F4', code: 'F4', keyCode: 115 }))
  check('F4 -> "{F4}"（切换方案）', f4 && f4.rimeKey === '{F4}', f4)

  const ctrlC = c.buildRimeKey(ev({ key: 'c', code: 'KeyC', ctrlKey: true }))
  check('Ctrl+C 不接管（留给页面复制）', ctrlC === null, ctrlC)

  const metaC = c.buildRimeKey(ev({ key: 'c', code: 'KeyC', metaKey: true }))
  check('Meta+C 不接管', metaC === null, metaC)

  const ctrlBacktick = c.buildRimeKey(ev({ key: '`', code: 'Backquote', ctrlKey: true }))
  check('Ctrl+` 放行 -> "{Control+quoteleft}"', ctrlBacktick && ctrlBacktick.rimeKey === '{Control+quoteleft}', ctrlBacktick)

  const ctrlShift4 = c.buildRimeKey(ev({ key: '4', code: 'Digit4', keyCode: 52, ctrlKey: true, shiftKey: true }))
  check('Ctrl+Shift+4 -> "{Control+Shift+4}"（切简繁）',
    ctrlShift4 && ctrlShift4.rimeKey === '{Control+Shift+4}' && ctrlShift4.modified === true, ctrlShift4)

  const backspace = c.buildRimeKey(ev({ key: 'Backspace', code: 'Backspace', keyCode: 8 }))
  check('未组字时 Backspace 不接管', backspace === null, backspace)

  const arrow = c.buildRimeKey(ev({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }))
  check('未组字时方向键不接管', arrow === null, arrow)

  const shift = c.buildRimeKey(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true, keyCode: 16 }))
  check('单按 Shift 不接管', shift === null, shift)
}

console.log('\n== 按键映射（组字中） ==')
{
  const c = new ImeController({ schemaId: 'luna_pinyin' })
  c.composing = true

  const backspace = c.buildRimeKey(ev({ key: 'Backspace', code: 'Backspace', keyCode: 8 }))
  check('Backspace -> "{BackSpace}"', backspace && backspace.rimeKey === '{BackSpace}', backspace)

  const enter = c.buildRimeKey(ev({ key: 'Enter', code: 'Enter', keyCode: 13 }))
  check('Enter -> "{Return}"', enter && enter.rimeKey === '{Return}', enter)

  const escape = c.buildRimeKey(ev({ key: 'Escape', code: 'Escape', keyCode: 27 }))
  check('Escape -> "{Escape}"（取消组字）', escape && escape.rimeKey === '{Escape}', escape)

  const pageUp = c.buildRimeKey(ev({ key: 'PageUp', code: 'PageUp', keyCode: 33 }))
  check('PageUp -> "{Page_Up}"', pageUp && pageUp.rimeKey === '{Page_Up}', pageUp)

  const minus = c.buildRimeKey(ev({ key: '-', code: 'Minus', keyCode: 189 }))
  check('- -> "-"（librime 的上一页）', minus && minus.rimeKey === '-', minus)

  const ctrlShiftA = c.buildRimeKey(ev({ key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true }))
  check('Ctrl+Shift+A -> "{Control+Shift+a}"', ctrlShiftA && ctrlShiftA.rimeKey === '{Control+Shift+a}', ctrlShiftA)

  const altRight = c.buildRimeKey(ev({ key: 'Alt', code: 'AltRight', altKey: true, keyCode: 18 }))
  check('右 Alt -> "{Alt_R}"', altRight && altRight.rimeKey === '{Alt_R}', altRight)
}

console.log('\n== 拦截策略 ==')
{
  const c = new ImeController({ schemaId: 'luna_pinyin' })
  c.setEnabled(true)

  const editableTarget = editable()
  const e1 = ev({ key: 'a', code: 'KeyA', target: editableTarget })
  c.onKeydown(e1)
  check('开启后在输入框里接管并 preventDefault', e1.defaultPrevented && e1.propagationStopped)

  const e2 = ev({ key: 'a', code: 'KeyA', target: { nodeType: 1, tagName: 'DIV', isContentEditable: false } })
  c.onKeydown(e2)
  check('非可编辑元素不接管', !e2.defaultPrevented)

  const e3 = ev({ key: 'a', code: 'KeyA', target: editableTarget, ctrlKey: true })
  c.onKeydown(e3)
  check('Ctrl+A 组合不接管', !e3.defaultPrevented)

  const e4 = ev({ key: 'a', code: 'KeyA', target: editableTarget, isComposing: true })
  c.onKeydown(e4)
  check('页面自带输入法组字中（isComposing）让行', !e4.defaultPrevented)

  const disabled = new ImeController({ schemaId: 'luna_pinyin' })
  const e5 = ev({ key: 'a', code: 'KeyA', target: editableTarget })
  disabled.onKeydown(e5)
  check('关闭时不接管任何按键', !e5.defaultPrevented)

  const password = editable()
  password.getAttribute = () => 'password'
  const e6 = ev({ key: 'a', code: 'KeyA', target: password })
  c.onKeydown(e6)
  check('密码框不接管', !e6.defaultPrevented)
}

console.log('\n== Shadow DOM ==')
{
  const c = new ImeController({ schemaId: 'luna_pinyin' })
  c.setEnabled(true)

  const inner = editable()
  const host = { nodeType: 1, tagName: 'MY-INPUT', isContentEditable: false }

  // 键盘事件穿出 shadow root 后 target 会变成宿主，composedPath()[0] 才是内部 input
  const e = ev({
    key: 'a',
    code: 'KeyA',
    target: host,
    composedPath: () => [inner, { nodeType: 1 }, { nodeType: 1 }, host]
  })
  c.onKeydown(e)
  check('宿主不可编辑但内部 input 可编辑时仍然接管', e.defaultPrevented)
  check('接管的元素是 shadow 内部的 input', c.target === inner, c.target && c.target.tagName)

  // 没有 composedPath 的环境要退回 event.target
  const fallback = ev({ key: 'b', code: 'KeyB', target: inner })
  c.onKeydown(fallback)
  check('没有 composedPath 时退回 event.target', fallback.defaultPrevented)

  const closed = ev({
    key: 'c',
    code: 'KeyC',
    target: inner,
    composedPath: () => { throw new Error('closed shadow root') }
  })
  c.onKeydown(closed)
  check('composedPath 抛错时不崩，退回 event.target', closed.defaultPrevented)
}

console.log('\n== 候选窗定位 ==')
{
  globalThis.window = { innerWidth: 800, innerHeight: 600 }
  const { CandidateWindow } = globalThis.RIME_CS

  function place (anchor, size) {
    const w = new CandidateWindow()
    w.wrap = {
      style: {},
      getBoundingClientRect: () => ({ width: size.w, height: size.h })
    }
    w.anchor = anchor
    w.render()
    return { left: parseInt(w.wrap.style.left, 10), top: parseInt(w.wrap.style.top, 10), visible: w.visible }
  }

  const below = place({ left: 100, top: 100, height: 20 }, { w: 200, h: 80 })
  check('下方放得下 -> 贴在光标下方', below.top === 124 && below.left === 100, below)

  const above = place({ left: 100, top: 500, height: 20 }, { w: 200, h: 80 })
  check('下方放不下 -> 翻到光标上方', above.top === 416, above)

  const pinned = place({ left: 100, top: 300, height: 20 }, { w: 200, h: 700 })
  check('上下都放不下 -> 贴住视口上边距', pinned.top === 6, pinned)

  const clipped = place({ left: 700, top: 100, height: 20 }, { w: 200, h: 80 })
  check('右侧溢出 -> 往左夹进视口', clipped.left === 594, clipped)

  const negative = place({ left: -50, top: -30, height: 20 }, { w: 200, h: 80 })
  check('坐标为负 -> 夹到边距内', negative.left === 6 && negative.top === 6, negative)
}

/* ------------------------------------------------------------------ *
 * 2. 引擎返回值 -> 页面行为
 * ------------------------------------------------------------------ */

function harness () {
  const c = new ImeController({ schemaId: 'luna_pinyin' })
  const shown = []
  const inserted = []
  const switched = []
  c.target = editable()
  c.window = {
    visible: false,
    anchor: null,
    show: state => { shown.push(state); c.window.visible = true },
    hide: () => { c.window.visible = false },
    showMessage: () => {},
    render: () => {},
    destroy: () => {}
  }
  c.insert = text => inserted.push(text)
  // 真实的 switchSchema 是 async 的，桩也必须返回 Promise：
  // 它是被 enqueue 链起来的，返回值会被当成 thenable 使用。
  c.switchSchema = async id => { switched.push(id); c.schemaId = id }
  globalThis.RIME_CS.getCaretRect = () => ({ left: 0, top: 0, height: 16 }) // eslint-disable-line
  return { c, shown, inserted, switched }
}

console.log('\n== 状态机 ==')
{
  const { c, shown, inserted, switched } = harness()
  c.apply({ state: RIME_STATE.ACCEPTED, head: '', body: 'ni hao', tail: '', candidates: [{ text: '你好' }], highlighted: 0, page: 0, isLastPage: true }, { printable: true, raw: 'o' })
  check('ACCEPTED -> 进入组字并显示候选窗', c.composing === true && shown.length === 1 && c.window.visible)
  check('ACCEPTED 的 preedit 原样传给了候选窗', shown[0].body === 'ni hao' && shown[0].candidates[0].text === '你好')

  c.apply({ state: RIME_STATE.ACCEPTED, committed: '你', head: '好', body: '', tail: '', candidates: [] }, { printable: true, raw: 'h' })
  check('ACCEPTED 带 committed 时先上屏那一段', inserted[0] === '你')

  c.apply({ state: RIME_STATE.COMMITTED, committed: '你好' }, { printable: false, raw: '' })
  check('COMMITTED -> 上屏并收窗', inserted[1] === '你好' && c.composing === false && !c.window.visible)

  c.apply({ state: RIME_STATE.UNHANDLED }, { printable: true, raw: ',' })
  check('UNHANDLED + 可打印键 -> 原样放行', inserted[2] === ',')

  c.apply({ state: RIME_STATE.UNHANDLED }, { printable: false, raw: 'ArrowLeft' })
  check('UNHANDLED + 功能键 -> 不上屏', inserted.length === 3)

  // {Control+Shift+4} 这类组合键是方案自己声明的开关（简繁），引擎只切开关、不消费按键，
  // 回到这里是 UNHANDLED；可打印但带修饰键，绝不能把 '4' 打进页面
  c.apply({ state: RIME_STATE.UNHANDLED }, { printable: true, raw: '4', modified: true })
  check('UNHANDLED + 带 Ctrl 的可打印键 -> 不上屏', inserted.length === 3)

  c.apply({ state: RIME_STATE.REJECTED, updatedSchema: 'double_pinyin/somewhere' }, { printable: false, raw: '' })
  // 切换方案现在是 enqueue 进队列的（保证和正在处理的按键串行），所以要等队列排空。
  // 直接调 apply 不会自动跑队列——真实环境里 apply 本身就在队列任务里，下一轮才轮到它。
  await c.queue
  check('REJECTED + updatedSchema -> 切换方案（F4）', switched[0] === 'double_pinyin', switched)

  const { c: c2, inserted: ins2 } = harness()
  c2.composing = true
  c2.apply({ state: RIME_STATE.REJECTED }, { printable: true, raw: 'Escape' })
  check('REJECTED 无 updatedSchema -> 收窗且不上屏', c2.composing === false && ins2.length === 0)
}

console.log('\n== 状态栏（输入法 / 简繁）==')
{
  const { STORAGE_KEYS } = globalThis.RIME_CONST
  check('状态栏模块导出了 StatusBar 类', typeof RealStatusBar === 'function')
  check('窗口桩（没有 self/top）不会被当成顶层 frame', RealStatusBar.isTopFrame() === false,
    { got: RealStatusBar.isTopFrame(), windowType: typeof window })

  const { c } = harness()
  const bar = statusBarStub.instances.at(-1)
  c.engineState = ENGINE_STATE.READY
  // harness() 为了方便测状态机把 switchSchema 桩掉了；这一节要测的正是真实的切换
  // （装载方案 → 重新下发简繁 → 状态栏换一套 variant），所以换回原型上的实现
  c.switchSchema = ImeController.prototype.switchSchema.bind(c)
  const engineOps = () => sent.filter(m => m.to === 'engine')
  const optionsSent = () => engineOps().filter(m => m.op === 'setOption').map(m => ({ ...m.payload }))
  sent.length = 0

  // 1) 打开输入法：先确保方案装载完，再按「跟随浏览器语言」下发简繁
  c.setEnabled(true)
  await c.queue
  check('打开时先确保方案装载，再下发简繁',
    engineOps().some(m => m.op === 'loadSchema') && engineOps().some(m => m.op === 'setOption'),
    engineOps().map(m => m.op))
  check('zh-CN + 跟随语言 → 下发 simplification=true',
    optionsSent().some(p => p.option === 'simplification' && p.value === true), optionsSent())
  check('状态栏显示当前生效的是「简」', c.tradSimpActive === '简' && bar.state.activeName === '简', bar.state)
  check('状态栏拿到方案名与可选项', bar.state.schemaName === '朙月拼音' &&
    bar.state.variants.map(v => v.name).join('/') === '简/繁', bar.state.variants.map(v => v.name))

  // 2) 在状态栏里点「繁」：偏好写进 storage，开关立刻下发
  sent.length = 0
  storageWrites.length = 0
  statusBarStub.handlers.onSelectTradSimp('繁')
  await c.queue
  check('点「繁」下发 simplification=false',
    optionsSent().some(p => p.option === 'simplification' && p.value === false), optionsSent())
  check('点「繁」把偏好写进 storage',
    storageWrites.some(w => w[STORAGE_KEYS.tradSimp] === '繁'), storageWrites)
  check('状态栏切到「繁」', c.tradSimpActive === '繁' && bar.state.preference === '繁', bar.state)

  // 3) 引擎自己改开关（Ctrl+Shift+4 走方案里的 key_binder）也要同步到状态栏
  c.apply({ state: RIME_STATE.UNHANDLED, updatedOptions: ['simplification'] },
    { printable: true, raw: '4', modified: true })
  check('引擎回报 simplification 打开 → 状态栏变「简」', c.tradSimpActive === '简', c.tradSimpActive)
  check('Ctrl+Shift+4 不会把键打进页面（带修饰键的 UNHANDLED）', c.target.value === undefined || c.target.value === '')
  c.apply({ state: RIME_STATE.UNHANDLED, updatedOptions: ['!simplification'] },
    { printable: true, raw: '4', modified: true })
  check('引擎回报 !simplification → 状态栏变回「繁」', c.tradSimpActive === '繁', c.tradSimpActive)

  // 4) 换到注音：三个开关（zh_hans / zh_hant / zh_hant_tw）必须整组下发
  respond = message => message.op === 'loadSchema'
    ? { ok: true, result: { schemaId: 'bopomofo', written: [] } }
    : { ok: true, result: { option: 'x', value: true } }
  sent.length = 0
  await c.switchSchema('bopomofo')
  const bopomofo = optionsSent()
  check('注音：按偏好下发 zh_hant=true 并把另外两个显式关掉',
    bopomofo.some(p => p.option === 'zh_hant' && p.value === true) &&
    bopomofo.some(p => p.option === 'zh_hans' && p.value === false) &&
    bopomofo.some(p => p.option === 'zh_hant_tw' && p.value === false), bopomofo)
  check('状态栏换成注音那套 variant「简/臺/繁」',
    bar.state.variants.map(v => v.name).join('/') === '简/臺/繁', bar.state.variants.map(v => v.name))

  // 5) 没有简繁开关的方案：一个开关都不下发，简繁那组整个不显示
  sent.length = 0
  await c.switchSchema('pinyin_simp')
  check('袖珍简拼没有简繁开关 → 不下发 setOption', optionsSent().length === 0, optionsSent())
  check('状态栏的简繁组收起', bar.state.variants.length === 0 && bar.state.activeName === '')

  // 6) 收起 / 展开
  storageWrites.length = 0
  statusBarStub.handlers.onToggleCollapse(true)
  check('收起状态栏会写进 storage',
    storageWrites.some(w => w[STORAGE_KEYS.collapsed] === true), storageWrites)
  check('收起状态传给了状态栏', bar.state.collapsed === true)

  // 7) 别的标签页改了偏好 → storage 变更 → 这边跟着换
  respond = () => ({ ok: true, result: {} })
  c.setStatusBarPrefs({ tradSimp: 'auto' })
  await c.queue
  check('外部把偏好改回「跟随」', c.tradSimpPreference === 'auto' && bar.state.preference === 'auto',
    { preference: c.tradSimpPreference })

  // 8) 关掉输入法时状态栏收起
  c.setEnabled(false)
  check('关闭输入法后状态栏隐藏', bar.visible === false && bar.calls.includes('hide'))
}

console.log('\n== 上屏注入 ==')
{
  const { c, inserted } = harness()
  c.composing = true

  // 桩掉 execCommand，验证走的是「原生 setter + InputEvent」这条退路
  const events = []
  let value = 'AB'
  const input = {
    tagName: 'INPUT',
    isContentEditable: false,
    isConnected: true,
    value,
    selectionStart: 1,
    selectionEnd: 1,
    focus () {},
    dispatchEvent (e) { events.push(e); return true }
  }
  globalThis.document = {
    execCommand: () => false,
    createElement: () => ({ style: {}, remove () {}, appendChild () {}, setAttribute () {} }),
    createTextNode: () => ({}),
    body: { appendChild () {}, },
    documentElement: { appendChild () {} }
  }
  globalThis.InputEvent = class { constructor (type, init) { this.type = type; Object.assign(this, init) } }
  globalThis.HTMLInputElement = { prototype: {} }
  globalThis.HTMLTextAreaElement = { prototype: {} }
  Object.defineProperty(globalThis.HTMLInputElement.prototype, 'value', {
    configurable: true,
    set (v) { value = v },
    get () { return value }
  })

  c.target = input
  c.insert = ImeController.prototype.insert.bind(c)
  c.insert('好')

  check('退路注入把文本插到了光标处', value === 'A好B', value)
  check('并且派发了 bubbles 的 input 事件', events.length === 1 && events[0].type === 'input' && events[0].bubbles === true,
    events.map(e => e.type))
  check('光标停在插入内容之后', input.selectionStart === 2, input.selectionStart)
}

console.log('\n== 富文本（contenteditable）上屏 ==')
{
  // 复刻真实 InputEvent 的契约：preventDefault() 之后 defaultPrevented 变 true
  class FakeInputEvent {
    constructor (type, init = {}) {
      this.type = type
      Object.assign(this, init)
      this.defaultPrevented = false
    }

    preventDefault () { this.defaultPrevented = true }
  }
  globalThis.InputEvent = FakeInputEvent

  const insertedNodes = []
  const range = {
    deleteContents () {},
    insertNode (node) { insertedNodes.push(node) },
    setStartAfter () {},
    collapse () {}
  }
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges () {},
    addRange () {}
  }
  globalThis.window = { innerWidth: 800, innerHeight: 600, getSelection: () => selection }

  const c = new ImeController({ schemaId: 'luna_pinyin' })

  /**
   * 造一个 contenteditable 替身。onBeforeInput 模拟「页面自己的富文本编辑器」
   * （Slate / ProseMirror 那一类）：它会在 beforeinput 里 preventDefault，
   * 然后自己把文本写进模型。
   */
  function ce (onBeforeInput, { execResult = true } = {}) {
    const calls = { exec: 0, beforeinput: [], input: [] }
    const el = {
      tagName: 'DIV',
      isContentEditable: true,
      isConnected: true,
      focus () {},
      dispatchEvent (e) {
        if (e.type === 'beforeinput') {
          calls.beforeinput.push(e)
          if (onBeforeInput) onBeforeInput(e)
        }
        if (e.type === 'input') calls.input.push(e)
        return !e.defaultPrevented
      }
    }
    globalThis.document = {
      execCommand: () => { calls.exec++; return execResult },
      createTextNode: text => ({ text })
    }
    insertedNodes.length = 0
    return { el, calls }
  }

  // 1) 页面在 beforeinput 里接管：我们一个字都不许再动 DOM，否则会写重
  {
    const { el, calls } = ce(e => e.preventDefault())
    c.target = el
    c.insert('你好')
    check('页面接管时我们不再自己插 DOM', calls.exec === 0 && insertedNodes.length === 0 && calls.input.length === 0,
      { exec: calls.exec, nodes: insertedNodes.length, input: calls.input.length })
    check('派发出去的 beforeinput 形状正确',
      calls.beforeinput.length === 1 &&
      calls.beforeinput[0].inputType === 'insertText' &&
      calls.beforeinput[0].data === '你好' &&
      calls.beforeinput[0].bubbles === true &&
      calls.beforeinput[0].cancelable === true,
      calls.beforeinput[0])
  }

  // 2) 页面没接管（普通 contenteditable）：照旧走 execCommand
  {
    const { el, calls } = ce(null)
    c.target = el
    c.insert('你好')
    check('页面没接管时照旧走 execCommand', calls.beforeinput.length === 1 && calls.exec === 1 && insertedNodes.length === 0, calls)
  }

  // 3) execCommand 也失败：退回 Range 插入 + 手动派发 input
  {
    const { el, calls } = ce(null, { execResult: false })
    c.target = el
    c.insert('你好')
    check('execCommand 失败后退回 Range 插入', calls.exec === 1 && insertedNodes.length === 1, calls)
    check('并且手动派发带 insertText/data 的 input 事件',
      calls.input.length === 1 && calls.input[0].inputType === 'insertText' && calls.input[0].data === '你好',
      calls.input.map(e => e.inputType))
  }

  // 4) 老浏览器没有 InputEvent 构造器：直接跳到 execCommand，不许抛
  {
    const { el, calls } = ce(null)
    globalThis.InputEvent = function () { throw new Error('no InputEvent ctor') }
    c.target = el
    let threw = false
    try { c.insert('你好') } catch (e) { threw = true }
    check('没有 InputEvent 构造器时不抛，直接走 execCommand', !threw && calls.exec === 1 && insertedNodes.length === 0,
      { threw, exec: calls.exec })
    globalThis.InputEvent = FakeInputEvent
  }
}

console.log(`\n${failures === 0 ? '✅ content script 逻辑全部通过' : `❌ ${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
