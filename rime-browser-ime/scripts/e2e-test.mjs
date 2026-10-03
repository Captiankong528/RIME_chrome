/**
 * 端到端验证：用真实 Chrome 以 unpacked 方式加载扩展，在演练场页面里
 * 模拟敲入 "nihao" + 空格，检查 textarea 是否变成「你好」。
 *
 * 用法:
 *   node scripts/e2e-test.mjs                 # 默认 headless
 *   HEADLESS=0 node scripts/e2e-test.mjs      # 弹出真实窗口，方便肉眼看候选窗
 *   CHROME_PATH=... node scripts/e2e-test.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { closeSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { existsSync } from 'node:fs'

// 简繁默认值表和扩展用的是同一份：期望值从它推出来，脚本里不另写一套「zh-TW 该出繁体」
await import(new URL('../src/common/const.js', import.meta.url).href)
const { prefersTraditional } = globalThis.RIME_CONST

const ROOT = path.resolve(import.meta.dirname, '..')
/**
 * 被加载的扩展目录。默认是源码目录；用 EXT_ROOT 指向打包产物，
 * 就能把「真正要发出去的那份字节」跑一遍，而不是只测源码树：
 *   EXT_ROOT=dist/rime-browser-ime-0.1.0-unpacked node scripts/e2e-test.mjs
 */
const EXT_ROOT = process.env.EXT_ROOT ? path.resolve(ROOT, process.env.EXT_ROOT) : ROOT
const PORT = Number(process.env.CDP_PORT || 9333)
const PROFILE = path.join(ROOT, '.tmp', `profile-${Date.now()}`)
const HEADLESS = process.env.HEADLESS !== '0'
/**
 * 浏览器界面语言。不设就用 Chrome 的默认值（一般是 en-US → 简体）；
 * 验证繁体那一支：
 *   RIME_LANG=zh-TW node scripts/e2e-test.mjs
 * 断言表里的期望值由页面**实际**报出来的 navigator.language 推导，
 * 所以 RIME_LANG 被 Chrome 忽略时脚本会直接报错，而不是悄悄测了个空。
 */
const LANG = process.env.RIME_LANG || ''
/**
 * 可选：跑完自动截一张图（相对扩展目录），用来肉眼确认候选窗和状态栏长什么样。
 *   SHOT=docs/status-bar.png node scripts/e2e-test.mjs
 */
const SHOT = process.env.SHOT || ''
/**
 * 必须用支持 `--load-extension` 的 Chromium 内核：品牌版 Google Chrome 从 137 起
 * 移除了该开关，用它跑这个脚本加载不上扩展。
 *
 * Chrome for Testing 刻意放在扩展目录**外面**（`RIME_chrome/.tools/`）：
 * 它解压后 600+ MB，塞进要「加载已解压」的目录既脏又容易被误打包。
 * 兼容旧位置 `.cache/chrome-for-testing/`。
 */
const CFT = [
  path.resolve(ROOT, '..', '.tools', 'chrome-for-testing', 'chrome-win64', 'chrome.exe'),
  path.join(ROOT, '.cache', 'chrome-for-testing', 'chrome-win64', 'chrome.exe')
].find(p => existsSync(p))
const CHROME = process.env.CHROME_PATH || [
  CFT,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(p => existsSync(p))

if (CHROME && /Google\\Chrome\\Application/i.test(CHROME)) {
  console.warn('⚠️  用的是品牌版 Google Chrome：Chrome 137+ 已移除 --load-extension，' +
    '扩展很可能加载不上。建议改用 .cache/chrome-for-testing/ 里的构建。\n')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------------------------------------------ *
 * 极简 CDP 客户端
 * ------------------------------------------------------------------ */

class Cdp {
  constructor (ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.events = []
    ws.onmessage = event => this.dispatch(JSON.parse(event.data))
  }

  static async connect (url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败: ' + url)) }
    })
    return new Cdp(ws)
  }

  dispatch (msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}`))
      else resolve(msg.result)
      return
    }
    if (!msg.method) return
    this.events.push(msg)
    for (const fn of this.handlers.get(msg.method) || []) fn(msg.params, msg.sessionId)
  }

  on (method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }

  send (method, params = {}, sessionId) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close () {
    try { this.ws.close() } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

async function waitFor (label, fn, { timeout = 60000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (e) {
      last = e.message
    }
    await sleep(interval)
  }
  throw new Error(`等待「${label}」超时（最后结果：${last}）`)
}

async function evaluate (cdp, sessionId, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  }, sessionId)
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result.value
}

const VK = { ' ': 32 }
function keyParams (ch, type) {
  if (ch === ' ') {
    return { type, key: ' ', code: 'Space', windowsVirtualKeyCode: VK[' '], nativeVirtualKeyCode: VK[' '] }
  }
  const upper = ch.toUpperCase()
  const vk = upper.charCodeAt(0)
  return {
    type,
    key: ch,
    // 数字键的 code 是 Digit2 而不是 Key2，写错 Chrome 会警告
    code: /[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + upper,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  }
}

async function typeText (cdp, sessionId, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', keyParams(ch, 'rawKeyDown'), sessionId)
    await sleep(60)
    await cdp.send('Input.dispatchKeyEvent', keyParams(ch, 'keyUp'), sessionId)
    await sleep(140)
  }
}

/**
 * 按一次切简繁的组合键。方案 yaml 的 key_binder 同时绑了
 * Control+Shift+4 和 Control+Shift+dollar，两种拼法都真机按一遍。
 * CDP 的 modifiers 是位掩码：1=Alt、2=Ctrl、4=Meta、8=Shift。
 */
async function pressSimplificationToggle (cdp, sessionId, key = '4') {
  const params = {
    key,
    code: 'Digit4',
    windowsVirtualKeyCode: 52,
    nativeVirtualKeyCode: 52,
    modifiers: 2 | 8
  }
  await cdp.send('Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' }, sessionId)
  await sleep(80)
  await cdp.send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, sessionId)
  await sleep(300)
}

/**
 * 在当前方案上敲一串输入 + 一个确认键，返回 textarea 内容。
 * 和 checkSwitchSchema 的区别是**不切换方案**——切方案会把开关重置回默认值，
 * 那样就测不出「运行中按 Ctrl+Shift+4 改过简繁」了。
 */
async function commitProbe (cdp, sessionId, input, key = ' ') {
  await clearPad(cdp, sessionId)
  await typeText(cdp, sessionId, input)
  await typeText(cdp, sessionId, key)
  await sleep(600)
  return evaluate(cdp, sessionId, 'document.getElementById("ta").value')
}

/**
 * 用真实的鼠标事件点状态栏上的一个按钮。
 *
 * 状态栏的 Shadow DOM 是 closed 的，外面查不到节点，所以坐标由状态栏自己报出来
 * （StatusBar.buttons()）；这里再按视口坐标点下去，走的是和用户完全一样的路径。
 *
 * @param {string} key 'schema' / 'schema:<方案id>' / 'tradSimp:<variant 名>' / 'collapse'
 */
async function clickStatusBar (cdp, sessionId, key) {
  const raw = await evaluate(cdp, sessionId,
    `JSON.stringify((RIME_CS.controller.statusBar.buttons() || []).find(b => b.key === ${JSON.stringify(key)}) || null)`)
  const button = JSON.parse(raw)
  if (!button) throw new Error(`状态栏里找不到按钮 ${key}（可能是面板没打开或被收起了）`)

  const x = button.rect.left + button.rect.width / 2
  const y = button.rect.top + button.rect.height / 2
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
  await sleep(30)
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  await sleep(40)
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
  await sleep(250)
  return button
}

/**
 * 用真实的鼠标事件点扩展页面（设置页 / 工具栏面板）上的一个元素。
 *
 * 这些页面是**普通 DOM**（不是状态栏那种 closed shadow root），所以按选择器取坐标就够；
 * 点下去走的是和用户完全一样的路径，比直接 `node.click()` 多验一层「按钮真的在那个位置、
 * 没被别的元素盖住、mousedown 没把面板关掉」。
 */
async function clickElement (cdp, sessionId, selector) {
  const raw = await evaluate(cdp, sessionId,
    `JSON.stringify((function () {
       const node = document.querySelector(${JSON.stringify(selector)})
       if (!node) return null
       const rect = node.getBoundingClientRect()
       return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
     })())`)
  const point = JSON.parse(raw)
  if (!point) throw new Error(`页面上找不到 ${selector}`)

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId)
  await sleep(30)
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  await sleep(40)
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
  await sleep(250)
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const consoleLog = []

/**
 * 全局失败标记。放在模块作用域而不是 main() 里，因为下面的 checkSwitchSchema()
 * 这类辅助函数要能置位它。
 */
let failed = false

/**
 * 浏览器语言是不是「繁体地区」。在 main() 里从页面读 navigator.language 之后填上，
 * 后面所有简繁相关的期望值都由它决定（扩展里的 offscreen 看的是同一个值）。
 */
let traditional = false

function attachDiagnostics (cdp, sessionId, tag) {
  cdp.on('Runtime.consoleAPICalled', (params, sid) => {
    if (sid !== sessionId) return
    const text = (params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ')
    consoleLog.push(`[${tag}:${params.type}] ${text}`)
  })
  cdp.on('Runtime.exceptionThrown', (params, sid) => {
    if (sid !== sessionId) return
    const d = params.exceptionDetails
    consoleLog.push(`[${tag}:exception] ${d.exception?.description || d.text}`)
  })
}

/**
 * 清空 textarea 并复位引擎。用 Escape 而不是直接重置 controller：
 * 走的是和真实用户按 Esc 完全相同的那条路径（content -> SW -> offscreen -> worker）。
 */
async function clearPad (cdp, sessionId) {
  await evaluate(cdp, sessionId,
    'RIME_CS.controller.request("process", { input: "{Escape}" })' +
    '.then(() => { document.getElementById("ta").value = ""; return "ok" })')
  await sleep(200)
}

/**
 * 切换输入方案，返回引擎自报的方案 id。
 * 走的是和设置页下拉框完全相同的接口（LOAD_SCHEMA + 通知 background 存设置）。
 */
async function switchSchema (cdp, sessionId, id) {
  return evaluate(cdp, sessionId,
    `RIME_CS.controller.switchSchema(${JSON.stringify(id)})` +
    '.then(() => RIME_CS.controller.request("status", {}))' +
    '.then(r => r.schemaId)' +
    '.catch(e => "err:" + e.message)')
}

async function checkSwitchSchema (cdp, pageSession, { id, input, expect }) {
  const schemaId = await switchSchema(cdp, pageSession, id)
  if (schemaId !== id) {
    failed = true
    console.error(`❌ 切换到 ${id} 失败：引擎自报 ${JSON.stringify(schemaId)}`)
    return
  }

  // 切过来之前先复位，免得上一个方案残留的组字状态影响这次敲键
  await clearPad(cdp, pageSession)
  await typeText(cdp, pageSession, input)
  const composing = await evaluate(cdp, pageSession, 'RIME_CS.controller.composing')
  if (!composing) {
    failed = true
    console.error(`❌ ${id}：敲 "${input}" 后没有进入组字状态，候选链路断了`)
    return
  }

  // 只断言可观测结果：按键被接管（组字中）且最终上屏内容符合该方案的键位映射。
  // 不去读 controller 的内部候选数组——那是实现细节，不是契约。
  await typeText(cdp, pageSession, ' ')
  await sleep(600)
  const got = await evaluate(cdp, pageSession, 'document.getElementById("ta").value')
  if (got !== expect) {
    failed = true
    console.error(`❌ ${id}：期望上屏 ${JSON.stringify(expect)}，实际 ${JSON.stringify(got)}`)
    return
  }
  console.log(`✅ ${id}：组字中 -> ${input} + 空格 -> ${got}`)
}

/**
 * 全方案遍历：14 个方案此前从未在真实浏览器里切换过。
 *
 * 每个方案都用「一组输入串 + 该方案实际认的确认键 -> 确切上屏文本」来断言。
 * 这些期望值是离线用同一份 wasm + 同一批预编译方案跑出来的（见 CHANGELOG.md「e2e 重跑 + 全方案覆盖」一节），
 * 所以这里断言它，检查的就是**浏览器侧那一段**：schemas/manifest.json 的映射、
 * offscreen 读文件的路径、跨进程传 ArrayBuffer 有没有把词典弄坏。
 * 如果只是「textarea 非空就算过」，上面任何一环坏掉都测不出来。
 *
 * 确认键各不相同是 librime 的正常语义，不是 bug：
 *   - 空格在多数方案上确认首候选，但在语句流/注音上只翻页、不确认；
 *   - 自然码双拼的回车是「原样上屏编码」，所以那个方案改用空格 + 另一个输入串；
 *   - pyjj 的 nihao 按空格得到「你哈哦」（逐字），而不是整句「你好」。
 *
 * 小鹤双拼那一行按浏览器语言分成两种期望：朙月拼音系的词库是繁体的，
 * 简体靠 simplification 开关转换，默认值跟随浏览器语言（见 common/const.js）。
 */
function schemaCases (traditional) {
  return {
    luna_pinyin: { input: 'nihao', key: ' ', expect: '你好' },
    luna_pinyin_fluency: { input: 'nihao', key: '\r', expect: '你好' },
    pinyin_simp: { input: 'nh', key: ' ', expect: '你好' },
    terra_pinyin: { input: 'nihao', key: ' ', expect: '你好' },
    double_pinyin: { input: 'nihk', key: ' ', expect: '你好' },
    double_pinyin_flypy: { input: 'nihk', key: ' ', expect: traditional ? '你壞' : '你坏' },
    double_pinyin_mspy: { input: 'nihk', key: ' ', expect: '你好' },
    double_pinyin_abc: { input: 'nihk', key: ' ', expect: '你好' },
    double_pinyin_pyjj: { input: 'nihao', key: ' ', expect: '你哈哦' },
    bopomofo: { input: 'su3cl3', key: '\r', expect: '你好' },
    bopomofo_express: { input: 'su3cl3', key: '\r', expect: '你好' },
    wubi86: { input: 'wqiy', key: ' ', expect: '你' },
    wubi_pinyin: { input: 'nihao', key: ' ', expect: '你好' },
    wubi_trad: { input: 'nihao', key: ' ', expect: '你好' },
    stroke: { input: 'hpsh', key: ' ', expect: '紅皮書' }
  }
}

async function checkAllSchemas (cdp, pageSession, traditional) {
  console.log('\n== 全部方案遍历（15 个）==')
  const SCHEMA_CASES = schemaCases(traditional)
  const schemas = JSON.parse(await evaluate(cdp, pageSession,
    'JSON.stringify(globalThis.RIME_CONST.SCHEMAS.map(s => s.id))'))
  let ok = 0
  const problems = []

  for (const id of schemas) {
    const probe = SCHEMA_CASES[id]
    if (!probe) { problems.push(`${id}: 断言表里没有这个方案`); continue }

    const schemaId = await switchSchema(cdp, pageSession, id)
    if (schemaId !== id) {
      problems.push(`${id}: 切换后引擎自报 ${JSON.stringify(schemaId)}`)
      console.log(`  ✗ ${id.padEnd(22)} 切换失败`)
      continue
    }

    await clearPad(cdp, pageSession)
    await typeText(cdp, pageSession, probe.input)
    const composing = await evaluate(cdp, pageSession, 'RIME_CS.controller.composing')
    if (!composing) {
      problems.push(`${id}: 敲 "${probe.input}" 未进入组字`)
      console.log(`  ✗ ${id.padEnd(22)} 敲 "${probe.input}" 无候选`)
      continue
    }

    await typeText(cdp, pageSession, probe.key)
    await sleep(500)
    const got = await evaluate(cdp, pageSession, 'document.getElementById("ta").value')
    if (got !== probe.expect) {
      problems.push(`${id}: 期望 ${JSON.stringify(probe.expect)}，实际 ${JSON.stringify(got)}`)
      console.log(`  ✗ ${id.padEnd(22)} ${probe.input} -> ${JSON.stringify(got)}（期望 ${JSON.stringify(probe.expect)}）`)
      continue
    }
    ok++
    console.log(`  ✓ ${id.padEnd(22)} ${probe.input.padEnd(7)} -> ${got}`)
  }

  console.log(`  小计：${ok}/${schemas.length} 个方案在真实浏览器里装载 + 打字上屏成功`)
  if (problems.length) {
    failed = true
    console.error('❌ 有方案未通过：')
    for (const p of problems) console.error('   - ' + p)
  }

  // 收尾：切回默认方案，别把引擎留在最后一个方案上
  await switchSchema(cdp, pageSession, 'luna_pinyin')
}

async function main () {
  if (!CHROME) throw new Error('找不到 Chrome，请用 CHROME_PATH 指定')
  await mkdir(path.dirname(PROFILE), { recursive: true })

  // 一个极简的本地页面：用来触发 content script，从而把 MV3 的 service worker 唤醒。
  // MV3 的 SW 是事件驱动的，没事件时根本不会出现在 CDP 的 target 列表里。
  const TEST_PORT = PORT + 1
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>rime e2e</title><body><input id="probe" type="text"></body>')
  })
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve))
  const testPageUrl = `http://127.0.0.1:${TEST_PORT}/`

  const args = [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_ROOT}`,
    `--disable-extensions-except=${EXT_ROOT}`,
    // Chrome 137+ 默认忽略 --load-extension（品牌版的安全策略），
    // 下面这个 feature 开关可以把命令行加载能力放回来
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    // 在进程权限不完整的环境里（沙箱 / 作业对象限制），crashpad 处理器起不来，
    // Chrome 会 "crash server failed to launch, self-terminating" 直接自杀。
    // --no-sandbox 能让它越过这一步。
    '--no-sandbox',
    '--disable-crash-reporter',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--enable-logging=stderr',
    '--log-level=0',
    testPageUrl
  ]
  if (HEADLESS) args.unshift('--headless=new')
  if (LANG) args.unshift(`--lang=${LANG}`, `--accept-lang=${LANG}`)

  console.log('启动 Chrome:', CHROME)
  console.log('加载扩展目录:', EXT_ROOT, EXT_ROOT === ROOT ? '(源码树)' : '(打包产物)')

  // Chrome 的 stderr 走**文件**而不是管道：在受限沙箱下，Node 用 stdio:'pipe'
  // 创建子进程会因为打不开命名管道而直接 `spawn EPERM`。写文件两种模式下都能跑，
  // 所以这个脚本不再需要提权。（只在失败时才读它。）
  const stderrLog = path.join(ROOT, '.tmp', `chrome-stderr-${Date.now()}.log`)
  const stderrFd = openSync(stderrLog, 'w')
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', stderrFd] })
  closeSync(stderrFd)

  const readStderrTail = (lines = 40) => {
    try {
      return readFileSync(stderrLog, 'utf8').split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  let cdp = null

  try {
    const version = await waitFor('DevTools 端口', async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      return res.ok ? res.json() : null
    }, { timeout: 30000 })

    cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    await cdp.send('Target.setDiscoverTargets', { discover: true })

    // 1) 等扩展的 service worker 被本地页面的 content script 唤醒
    const swTarget = await waitFor('扩展 service worker', async () => {
      const { targetInfos } = await cdp.send('Target.getTargets')
      return targetInfos.find(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('service-worker.js'))
    }, { timeout: 40000 }).catch(async error => {
      const { targetInfos } = await cdp.send('Target.getTargets')
      console.error('当前全部 target:')
      for (const t of targetInfos) console.error(`  - [${t.type}] ${t.url}`)
      throw error
    })
    const extensionId = new URL(swTarget.url).host
    console.log('扩展已加载, id =', extensionId)

    const { sessionId: swSession } = await cdp.send('Target.attachToTarget', {
      targetId: swTarget.targetId,
      flatten: true
    })
    await cdp.send('Runtime.enable', {}, swSession)
    attachDiagnostics(cdp, swSession, 'sw')

    // SW 只用来做诊断（收集它的控制台），不用它求值：
    // module service worker 的 Runtime.evaluate 上下文里拿不到 chrome API

    // 2) 打开演练场
    const playground = `chrome-extension://${extensionId}/src/playground/playground.html`
    const { targetId: pageTarget } = await cdp.send('Target.createTarget', { url: playground })
    await waitFor('演练场页面加载', async () => {
      const { targetInfos } = await cdp.send('Target.getTargets')
      const t = targetInfos.find(x => x.targetId === pageTarget)
      return t && t.url === playground
    })
    const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId: pageTarget, flatten: true })
    await cdp.send('Runtime.enable', {}, pageSession)
    await cdp.send('Page.enable', {}, pageSession)
    attachDiagnostics(cdp, pageSession, 'page')

    // content script 在演练场里以普通 <script> 注入，所以能直接从主世界看到控制器
    await waitFor('content script 就绪', () => evaluate(cdp, pageSession, 'Boolean(globalThis.RIME_CS && RIME_CS.controller)'))

    // 浏览器语言：扩展的 offscreen 就是按它算简繁默认值的，这里也读同一个值来推期望
    const pageLocale = await evaluate(cdp, pageSession, 'navigator.language')
    traditional = prefersTraditional(pageLocale)
    console.log(`浏览器语言 = ${pageLocale} -> 简繁默认 = ${traditional ? '繁体' : '简体'}`)
    if (LANG && String(pageLocale).toLowerCase() !== LANG.toLowerCase()) {
      failed = true
      console.error(`❌ 要求 RIME_LANG=${LANG}，但页面报的是 ${pageLocale}，这一轮没测到想测的那一支`)
    }

    // 3) 打开开关：演练场是扩展页面，有完整的 chrome API。
    //    这里不用 SW 求值是因为 module service worker 的 evaluate 上下文里没有 chrome。
    //    写 storage 会触发演练场里 bootstrap.js 注册的 storage.onChanged。
    await evaluate(cdp, pageSession,
      'chrome.storage.local.set({ enabled: true, schemaId: "luna_pinyin", pageSize: 5 })')
    const enabled = await waitFor('开关生效', async () => {
      const on = await evaluate(cdp, pageSession, 'RIME_CS.controller.enabled')
      return on === true ? true : null
    }, { timeout: 10000, interval: 200 })
    console.log('已开启输入法，等待引擎就绪…')

    // 直接用控制器探活：它走的就是 content -> SW -> offscreen -> worker 那条真实链路，
    // 同时也顺带把引擎冷启动跑起来
    const engineState = await waitFor('RIME 引擎就绪', async () => {
      const raw = await evaluate(cdp, pageSession,
        'RIME_CS.controller.request("status", {}).then(r => "ready|" + r.schemaId + "|" + r.pageSize).catch(e => "err|" + e.message)')
      if (String(raw).startsWith('ready')) return raw
      process.stdout.write(`\r  引擎: ${raw}                    `)
      return null
    }, { timeout: 180000, interval: 1000 })
    process.stdout.write('\n')
    console.log('引擎就绪:', engineState)

    // 确认 offscreen 宿主确实存在
    const { targetInfos } = await cdp.send('Target.getTargets')
    const offscreen = targetInfos.find(t => t.url.includes('/src/offscreen/offscreen.html'))
    console.log('offscreen 宿主:', offscreen ? '已创建' : '未找到')

    // 4) 在 textarea 里敲 "nihao" + 空格
    await evaluate(cdp, pageSession, 'document.getElementById("ta").focus(); document.getElementById("ta").value = ""; "ok"')
    await typeText(cdp, pageSession, 'nihao')

    const preedit = await evaluate(cdp, pageSession, 'JSON.stringify({ composing: RIME_CS.controller.composing, visible: RIME_CS.controller.window.visible })')
    console.log('组字中:', preedit)

    await typeText(cdp, pageSession, ' ')
    await sleep(800)

    const value = await evaluate(cdp, pageSession, 'document.getElementById("ta").value')
    console.log('\ntextarea 内容 =', JSON.stringify(value))

    if (value !== '你好') {
      failed = true
      console.error(`❌ 期望 "你好"，实际 ${JSON.stringify(value)}`)
    } else {
      console.log('✅ 输入链路正常：nihao + 空格 -> 你好')
    }

    // 4a) 简繁默认值：朙月拼音的词库是繁体系，简体靠 simplification 开关转换，
    //     默认值跟随浏览器语言（zh-TW / zh-HK / zh-MO / zh-Hant 才出繁体）。
    console.log('\n== 简繁默认值 ==')
    await checkSwitchSchema(cdp, pageSession, {
      id: 'luna_pinyin',
      input: 'hanzi',
      expect: traditional ? '漢字' : '汉字'
    })

    // 4a2) 运行中按 Ctrl+Shift+4 切到另一边（方案 yaml 的 key_binder 绑定的开关）。
    //      顺带守住一条：这个组合键回到 content script 时是 UNHANDLED + 可打印键，
    //      绝不能把 '4' 打进页面。
    console.log('\n== Ctrl+Shift+4 切简繁 ==')
    await evaluate(cdp, pageSession, 'document.getElementById("ta").value = ""; "ok"')
    await pressSimplificationToggle(cdp, pageSession, '4')
    const stray = await evaluate(cdp, pageSession, 'document.getElementById("ta").value')
    if (stray !== '') {
      failed = true
      console.error(`❌ Ctrl+Shift+4 在页面上留下了 ${JSON.stringify(stray)}，应当什么都不留`)
    } else {
      console.log('✅ Ctrl+Shift+4 没有把字符打进页面')
    }
    const flipped = await commitProbe(cdp, pageSession, 'hanzi')
    const otherScript = traditional ? '汉字' : '漢字'
    if (flipped !== otherScript) {
      failed = true
      console.error(`❌ Ctrl+Shift+4 之后期望 ${JSON.stringify(otherScript)}，实际 ${JSON.stringify(flipped)}`)
    } else {
      console.log(`✅ Ctrl+Shift+4 切换生效：hanzi + 空格 -> ${flipped}`)
    }
    // 再按一次（这次走 Control+Shift+dollar 那条绑定）应当切回默认
    await pressSimplificationToggle(cdp, pageSession, '$')
    const back = await commitProbe(cdp, pageSession, 'hanzi')
    const defaultScript = traditional ? '漢字' : '汉字'
    if (back !== defaultScript) {
      failed = true
      console.error(`❌ 再按一次 Ctrl+Shift+$ 应当切回 ${JSON.stringify(defaultScript)}，实际 ${JSON.stringify(back)}`)
    } else {
      console.log(`✅ Ctrl+Shift+$ 切回默认：hanzi + 空格 -> ${back}`)
    }

    // 再验证一次候选选择（数字键 2）
    await evaluate(cdp, pageSession, 'document.getElementById("ta").value = ""; "ok"')
    await typeText(cdp, pageSession, 'nihao')
    await typeText(cdp, pageSession, '2')
    await sleep(600)
    const second = await evaluate(cdp, pageSession, 'document.getElementById("ta").value')
    console.log('按 2 选第二个候选 ->', JSON.stringify(second))

    // 4a3) 状态栏：选输入法 + 选简繁。真机鼠标点它（不是直接调 API），
    //      覆盖的是「Shadow DOM 里的按钮、坐标、焦点、storage 落地」这一整条。
    console.log('\n== 状态栏（点着用）==')
    const barKeys = JSON.parse(await evaluate(cdp, pageSession,
      'JSON.stringify(RIME_CS.controller.statusBar.buttons().map(b => b.key))'))
    if (!barKeys.includes('schema') || !barKeys.includes('tradSimp:auto')) {
      failed = true
      console.error(`❌ 状态栏没有正常出现，按钮只有 ${barKeys}`)
    } else {
      console.log(`✅ 状态栏已出现：${barKeys.join(' / ')}`)
    }

    // 选输入法：点方案按钮 → 面板里点「小鹤双拼」
    await clickStatusBar(cdp, pageSession, 'schema')
    await clickStatusBar(cdp, pageSession, 'schema:double_pinyin_flypy')
    const switchedFromBar = await waitFor('状态栏切换方案', async () => {
      const id = await evaluate(cdp, pageSession, 'RIME_CS.controller.schemaId')
      const name = await evaluate(cdp, pageSession, 'RIME_CS.controller.statusBar.state.schemaName')
      return id === 'double_pinyin_flypy' && name === '小鹤双拼' ? `${id} / ${name}` : null
    }, { timeout: 20000, interval: 300 })
    console.log(`✅ 状态栏里选了「小鹤双拼」：${switchedFromBar}`)

    // 选简繁：点「繁」→ 打的字就该是繁体，并且偏好落进 storage
    await clickStatusBar(cdp, pageSession, 'tradSimp:繁')
    const barTrad = await commitProbe(cdp, pageSession, 'vuhk')
    if (barTrad !== '住壞') {
      failed = true
      console.error(`❌ 状态栏点「繁」之后 vuhk + 空格 上屏 ${JSON.stringify(barTrad)}，期望 "住壞"`)
    } else {
      console.log('✅ 状态栏点「繁」：vuhk + 空格 -> 住壞')
    }
    const storedPref = await evaluate(cdp, pageSession,
      'chrome.storage.local.get("statusBarTradSimp").then(v => v.statusBarTradSimp)')
    if (storedPref !== '繁') {
      failed = true
      console.error(`❌ 偏好没落进 storage：${JSON.stringify(storedPref)}`)
    } else {
      console.log('✅ 偏好「繁」已经存进 chrome.storage.local')
    }

    // 点「跟随」：回到浏览器语言对应的字形
    await clickStatusBar(cdp, pageSession, 'tradSimp:auto')
    const localeDefaultText = traditional ? '住壞' : '住坏'
    const barAuto = await commitProbe(cdp, pageSession, 'vuhk')
    if (barAuto !== localeDefaultText) {
      failed = true
      console.error(`❌ 点「跟随」之后期望 ${JSON.stringify(localeDefaultText)}，实际 ${JSON.stringify(barAuto)}`)
    } else {
      console.log(`✅ 点「跟随」回到语言默认：vuhk + 空格 -> ${barAuto}`)
    }

    // 点状态栏不能把输入框的焦点抢走
    await evaluate(cdp, pageSession, 'document.getElementById("ta").focus(); "ok"')
    await clickStatusBar(cdp, pageSession, 'tradSimp:auto')
    const activeId = await evaluate(cdp, pageSession, 'document.activeElement && document.activeElement.id')
    if (activeId !== 'ta') {
      failed = true
      console.error(`❌ 点完状态栏焦点跑到了 ${JSON.stringify(activeId)}，输入框应当仍是 ta`)
    } else {
      console.log('✅ 点状态栏没有把焦点从输入框抢走')
    }

    // 收起 / 展开：收起后只剩那颗小胶囊
    await clickStatusBar(cdp, pageSession, 'collapse')
    const collapsedKeys = JSON.parse(await evaluate(cdp, pageSession,
      'JSON.stringify(RIME_CS.controller.statusBar.buttons().map(b => b.key))'))
    if (collapsedKeys.includes('schema') || !collapsedKeys.includes('collapse')) {
      failed = true
      console.error(`❌ 收起之后按钮不对：${collapsedKeys}`)
    } else {
      console.log(`✅ 收起后只剩胶囊：${collapsedKeys.join(' / ')}`)
    }
    await clickStatusBar(cdp, pageSession, 'collapse')
    const expandedKeys = JSON.parse(await evaluate(cdp, pageSession,
      'JSON.stringify(RIME_CS.controller.statusBar.buttons().map(b => b.key))'))
    if (!expandedKeys.includes('schema')) {
      failed = true
      console.error(`❌ 展开之后方案按钮没回来：${expandedKeys}`)
    } else {
      console.log('✅ 再点一次又展开了')
    }

    // 从状态栏切回朙月拼音，后面的段落照旧（也顺便验一下来回切）
    await clickStatusBar(cdp, pageSession, 'schema')
    await clickStatusBar(cdp, pageSession, 'schema:luna_pinyin')
    const backFromBar = await waitFor('状态栏切回朙月拼音', async () => {
      const id = await evaluate(cdp, pageSession, 'RIME_CS.controller.schemaId')
      return id === 'luna_pinyin' ? id : null
    }, { timeout: 20000, interval: 300 })
    console.log(`✅ 状态栏切回 ${backFromBar}`)

    // 4b) 切换输入方案。
    //     这里特意挑两个「同一个按键串映射到不同结果」的方案：
    //     自然码双拼 vuhk -> 煮好，而小鹤双拼 vuhk -> 住坏 / 住壞。
    //     如果切换只是改了状态、引擎实际没换，第二段就会退回「煮好」而被抓出来。
    //     （早先用的是 nihk -> 你好 / 你坏，但加入简繁功能后两个方案都出「你好」，
    //      区分度没了，所以换成 vuhk。）
    //     这一条覆盖的是 14 个从未真机验证过的方案里最有代表性的双拼族。
    console.log('\n== 切换输入方案 ==')
    await checkSwitchSchema(cdp, pageSession, { id: 'double_pinyin', input: 'vuhk', expect: '煮好' })
    await checkSwitchSchema(cdp, pageSession, {
      id: 'double_pinyin_flypy',
      input: 'vuhk',
      expect: traditional ? '住壞' : '住坏'
    })

    // 切回默认方案，确认能来回切（这也是设置页下拉框能做的事情）
    const backToDefault = await switchSchema(cdp, pageSession, 'luna_pinyin')
    if (backToDefault !== 'luna_pinyin') {
      failed = true
      console.error(`❌ 切回 luna_pinyin 失败：引擎自报 ${JSON.stringify(backToDefault)}`)
    } else {
      await clearPad(cdp, pageSession)
      await typeText(cdp, pageSession, 'nihao')
      await typeText(cdp, pageSession, ' ')
      await sleep(600)
      const roundTrip = await evaluate(cdp, pageSession, 'document.getElementById("ta").value')
      if (roundTrip !== '你好') {
        failed = true
        console.error(`❌ 切回朙月拼音后 nihao 上屏 ${JSON.stringify(roundTrip)}，期望 "你好"`)
      } else {
        console.log('✅ 切回 luna_pinyin：nihao + 空格 -> 你好')
      }
    }

    // 4c) 全部 15 个方案逐个在真实浏览器里切换 + 打字
    await checkAllSchemas(cdp, pageSession, traditional)

    // 5) 真实 HTTP 页面：这才是有内容脚本隔离世界和页面 CSP 的生产场景
    console.log('\n== 普通网页（http://127.0.0.1） ==')
    const { targetInfos: pages } = await cdp.send('Target.getTargets')
    const httpTarget = pages.find(t => t.type === 'page' && t.url.startsWith(testPageUrl))
    if (!httpTarget) {
      failed = true
      console.error('❌ 找不到测试页面 target')
    } else {
      const { sessionId: httpSession } = await cdp.send('Target.attachToTarget', {
        targetId: httpTarget.targetId,
        flatten: true
      })
      await cdp.send('Runtime.enable', {}, httpSession)
      attachDiagnostics(cdp, httpSession, 'http')

      // 注意：内容脚本跑在隔离世界，而 Runtime.evaluate 默认在主页世界求值，
      // 所以这里看不到 RIME_CS。真正要断言的是「按键被接管并上屏」这个可观测结果。
      await evaluate(cdp, httpSession, 'document.getElementById("probe").focus(); "ok"')
      await sleep(400)
      await typeText(cdp, httpSession, 'nihao')
      const midway = await evaluate(cdp, httpSession, 'document.getElementById("probe").value')
      console.log('组字中 input 内容 =', JSON.stringify(midway), '（应仍为空，说明按键被拦下了）')

      // 状态栏也在这一页上：宿主元素挂在页面 DOM 里（影子根是 closed 的，
      // 主世界看不到里面，但能确认它确实被建出来了 = content script 那条路活着）
      const barProbe = await evaluate(cdp, httpSession,
        'JSON.stringify((function () {' +
        ' var host = document.querySelector(\'[data-rime-ime="status-bar"]\');' +
        ' return { found: Boolean(host), shadowClosed: host ? host.shadowRoot === null : null }' +
        ' })())')
      const barState = JSON.parse(barProbe)
      if (!barState.found) {
        failed = true
        console.error('❌ 普通网页上没有状态栏（content script 里的状态栏没建出来）')
      } else {
        console.log(`✅ 普通网页上状态栏也在（影子根 closed = ${barState.shadowClosed}）`)
      }

      await typeText(cdp, httpSession, ' ')
      await sleep(800)
      const httpValue = await evaluate(cdp, httpSession, 'document.getElementById("probe").value')
      console.log('上屏后 input 内容 =', JSON.stringify(httpValue))
      if (httpValue !== '你好') {
        failed = true
        console.error(`❌ 普通网页上期望 "你好"，实际 ${JSON.stringify(httpValue)}`)
      } else {
        console.log('✅ 普通网页上同样正常：nihao + 空格 -> 你好')
      }
    }

    // 5b) 工具栏面板（清单里的 action.default_popup）。
    //     点扩展图标不再直接切中/英，而是弹出这个小设置页；这里把它当普通标签页打开
    //     （同一个 URL、同一份脚本、同一套 chrome API），再用真实鼠标点它。
    //     覆盖的是「面板 -> background -> storage -> 广播 -> 网页」这条完整回路。
    console.log('\n== 工具栏面板（action.default_popup）==')
    const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`
    const { targetId: popupTarget } = await cdp.send('Target.createTarget', { url: popupUrl })
    const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', {
      targetId: popupTarget,
      flatten: true
    })
    await cdp.send('Runtime.enable', {}, popupSession)
    await cdp.send('Page.enable', {}, popupSession)
    attachDiagnostics(cdp, popupSession, 'popup')

    try {
      // 面板的控件是静态 HTML，模块脚本是 defer 的：只等 #toggle 出现会抢在脚本之前
      // （RIME_CONST 还没挂上）。等「方案下拉框被脚本填满」才是真的就绪。
      await waitFor('面板加载', () => evaluate(cdp, popupSession,
        'Boolean(globalThis.RIME_CONST && document.querySelectorAll("#schema option").length)'))

      const panel = JSON.parse(await evaluate(cdp, popupSession, `JSON.stringify({
        schemas: document.querySelectorAll('#schema option').length,
        groups: document.querySelectorAll('#schema optgroup').length,
        expected: RIME_CONST.SCHEMAS.length,
        current: document.getElementById('schema').value,
        tradSimpOptions: document.getElementById('trad-simp-field').hidden
          ? 0 : document.getElementById('trad-simp').options.length,
        toggle: document.getElementById('toggle').textContent
      })`))

      if (panel.schemas !== panel.expected || panel.groups < 2 || panel.current !== 'luna_pinyin') {
        failed = true
        console.error(`❌ 面板的方案下拉框不对：${JSON.stringify(panel)}`)
      } else {
        console.log(`✅ 面板列全了 ${panel.schemas} 个方案 / ${panel.groups} 个分组，当前 ${panel.current}`)
      }

      // 朙月拼音有简繁开关：那一行应当出现「跟随 + 简 + 繁」三项
      if (panel.tradSimpOptions !== 3) {
        failed = true
        console.error(`❌ 面板上简繁那一行有 ${panel.tradSimpOptions} 项，期望 3 项（跟随 / 简体 / 繁体）`)
      } else {
        console.log('✅ 面板上的简繁下拉框是「跟随 + 简 + 繁」三项')
      }

      // 用真实鼠标点开关：面板 -> background 落 storage，并且广播到网页那一侧
      if (panel.toggle !== '停用输入法') {
        failed = true
        console.error(`❌ 输入法本来是开着的，面板上却写着 ${JSON.stringify(panel.toggle)}`)
      }
      await clickElement(cdp, popupSession, '#toggle')
      await waitFor('面板把输入法关掉', async () => {
        const on = await evaluate(cdp, popupSession, 'chrome.storage.local.get("enabled").then(v => Boolean(v.enabled))')
        return on === false ? true : null
      }, { timeout: 10000, interval: 200 })
      await waitFor('网页那一侧跟着关掉', async () => {
        const on = await evaluate(cdp, pageSession, 'RIME_CS.controller.enabled')
        return on === false ? true : null
      }, { timeout: 10000, interval: 200 })
      console.log('✅ 面板上点「停用输入法」：storage 与网页两侧都关了')

      await clickElement(cdp, popupSession, '#toggle')
      await waitFor('面板把输入法开回来', async () => {
        const on = await evaluate(cdp, popupSession, 'chrome.storage.local.get("enabled").then(v => Boolean(v.enabled))')
        return on === true ? true : null
      }, { timeout: 10000, interval: 200 })
      await waitFor('网页那一侧跟着开回来', async () => {
        const on = await evaluate(cdp, pageSession, 'RIME_CS.controller.enabled')
        return on === true ? true : null
      }, { timeout: 10000, interval: 200 })
      console.log('✅ 再点一次开回来：两边都恢复了')

      // 面板里换方案：走的是 background 的 setSettings（和设置页下拉框同一条路）
      const pickSchema = id => evaluate(cdp, popupSession,
        `(function () {
           const select = document.getElementById('schema')
           select.value = ${JSON.stringify(id)}
           select.dispatchEvent(new Event('change'))
           return 'ok'
         })()`)
      const storedSchema = () => evaluate(cdp, popupSession,
        'chrome.storage.local.get("schemaId").then(v => v.schemaId)')

      await pickSchema('double_pinyin_flypy')
      await waitFor('面板切换方案', async () => (await storedSchema()) === 'double_pinyin_flypy' ? true : null,
        { timeout: 30000, interval: 300 })
      await waitFor('网页跟着换方案', async () => {
        const id = await evaluate(cdp, pageSession, 'RIME_CS.controller.schemaId')
        return id === 'double_pinyin_flypy' ? true : null
      }, { timeout: 30000, interval: 300 })
      console.log('✅ 面板里切到「小鹤双拼」：storage 与网页两侧都跟上了')

      // 切回默认方案，别把引擎留在别的方案上
      await pickSchema('luna_pinyin')
      await waitFor('面板切回默认方案', async () => (await storedSchema()) === 'luna_pinyin' ? true : null,
        { timeout: 30000, interval: 300 })
      await waitFor('网页切回默认方案', async () => {
        const id = await evaluate(cdp, pageSession, 'RIME_CS.controller.schemaId')
        return id === 'luna_pinyin' ? true : null
      }, { timeout: 30000, interval: 300 })
      console.log('✅ 面板里切回朙月拼音')

      // 底部链接去完整设置页（候选数 / 自检 / 使用说明都在那边）
      await clickElement(cdp, popupSession, '#open-options')
      const optionsTarget = await waitFor('面板打开完整设置页', async () => {
        const { targetInfos } = await cdp.send('Target.getTargets')
        return targetInfos.find(t => t.url.endsWith('/src/options/options.html'))
      }, { timeout: 15000, interval: 300 })
      console.log('✅ 面板里的「打开完整设置页」把设置页开起来了')
      await cdp.send('Target.closeTarget', { targetId: optionsTarget.targetId })
    } finally {
      try { await cdp.send('Target.closeTarget', { targetId: popupTarget }) } catch (e) { /* ignore */ }
    }

    // 6) 可选截图：让候选窗和状态栏同框，肉眼确认样子
    if (SHOT) {
      await evaluate(cdp, pageSession, 'document.getElementById("ta").focus(); document.getElementById("ta").value = ""; "ok"')
      await typeText(cdp, pageSession, 'nihao')
      await sleep(500)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pageSession)
      const target = path.resolve(ROOT, SHOT)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(shot.data, 'base64'))
      console.log(`📷 截图已保存：${SHOT}`)
      await evaluate(cdp, pageSession, 'RIME_CS.controller.request("process", { input: "{Escape}" })')
    }

    if (consoleLog.length) {
      console.log('\n--- 页面/后台控制台 ---')
      for (const line of consoleLog.slice(0, 60)) console.log(line)
    }
  } catch (error) {
    failed = true
    console.error('\n❌ 测试失败:', error.message)
    if (consoleLog.length) {
      console.log('--- 控制台 ---')
      for (const line of consoleLog.slice(0, 80)) console.log(line)
    }
    const tail = readStderrTail(40)
    if (tail.trim()) {
      console.log('--- Chrome stderr（尾部）---')
      console.log(tail)
    }
  } finally {
    if (cdp) cdp.close()
    try { chrome.kill() } catch (e) { /* ignore */ }
    await sleep(600)
    try { server.close() } catch (e) { /* ignore */ }
    try { await rm(PROFILE, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    try { await rm(stderrLog, { force: true }) } catch (e) { /* ignore */ }
  }

  process.exit(failed ? 1 : 0)
}

main()
