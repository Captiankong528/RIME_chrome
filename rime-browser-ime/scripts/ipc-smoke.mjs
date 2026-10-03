/**
 * IPC 链路冒烟测试：把 content -> background -> 引擎宿主 -> worker -> librime
 * 整条消息链路跑通。
 *
 * 同一份测试覆盖两种宿主形态，正对应两个浏览器里真实发生的事：
 *   --platform=chrome（默认）background 是 service worker，引擎住在 offscreen 文档里，
 *                          请求要经过一次 runtime.sendMessage，还得扛住「文档还没把
 *                          监听器注册上」的首帧竞态
 *   --platform=firefox       background 是背景页，引擎就地跑在同一个上下文里，一跳都没有
 *
 * 关键点是这里 import 的是**产品代码本体**，没有做任何改写：
 *   src/background/service-worker.js
 *   src/background/engine-bridge.js
 *   src/engine/host.js
 *   src/offscreen/offscreen.js（只有 chrome 形态会加载它）
 *   src/engine/worker.js（由假 Worker 用 vm 加载）
 *
 * 只替换掉浏览器提供的宿主能力：
 *   - chrome.* API（用 AsyncLocalStorage 复刻「发送者收不到自己消息」的语义）
 *   - Worker（在同一个进程里用 vm 加载 worker.js）
 *   - fetch（把 chrome-extension:// 映射到仓库里的真实文件）
 *   - IDBFS（Node 没有 indexedDB，换成内存版）
 *
 * 用法:
 *   node scripts/ipc-smoke.mjs                      # Chrome 形态
 *   node scripts/ipc-smoke.mjs --platform=firefox    # Firefox 形态
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(import.meta.dirname, '..')
const ENGINE = path.join(ROOT, 'src', 'engine')

/**
 * chrome | firefox。唯一作用是有没有 `chrome.offscreen`——
 * engine-bridge 正是靠这个能力探测决定引擎住哪，这里就等于把两个浏览器摆出来。
 */
const PLATFORM = (process.argv.find(arg => arg.startsWith('--platform=')) || '').split('=')[1] ||
  process.env.PLATFORM ||
  'chrome'
if (!['chrome', 'firefox'].includes(PLATFORM)) {
  console.error(`未知的 --platform=${PLATFORM}：只支持 chrome / firefox`)
  process.exit(1)
}
const HAS_OFFSCREEN = PLATFORM === 'chrome'

process.chdir(ENGINE) // rime.data 在 Node 分支按 cwd 相对路径读

/* ------------------------------------------------------------------ *
 * 1. 引擎 Worker 的宿主全局（与浏览器里 worker 拿到的等价）
 * ------------------------------------------------------------------ */

globalThis.self = globalThis
globalThis.require = createRequire(import.meta.url)
globalThis.__dirname = ENGINE
globalThis.importScripts = rel => {
  const file = path.join(ENGINE, rel)
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
}
// offscreen 文档里 self === window，是有 addEventListener 的；
// Node 的 globalThis 没有，补上（同时把注册的回调记下来备查）
const windowListeners = new Map()
globalThis.addEventListener = (type, fn) => {
  if (!windowListeners.has(type)) windowListeners.set(type, [])
  windowListeners.get(type).push(fn)
}
globalThis.removeEventListener = () => {}

/** 在同一个进程里当 Worker 用：加载 worker.js，并把 postMessage 双向接起来 */
class FakeWorker {
  constructor (url) {
    this.onmessage = null
    this.onerror = null
    const file = fileURLToPath(url)
    // worker.js 里 self.postMessage(...) 是「Worker -> 宿主」
    globalThis.postMessage = msg => {
      if (this.onmessage) this.onmessage({ data: msg })
    }
    vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
    // Node 没有 indexedDB；IDBFS.mount 在没有 autoPersist 时就是 MEMFS.mount
    globalThis.IDBFS = {
      ...globalThis.MEMFS,
      mount: mount => globalThis.MEMFS.mount(mount),
      syncfs: (mount, populate, callback) => callback(null)
    }
  }

  /** 宿主 -> Worker；worker.js 把 self.onmessage 当作入口 */
  postMessage (data) {
    queueMicrotask(() => {
      if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data })
    })
  }
}
globalThis.Worker = FakeWorker

/* ------------------------------------------------------------------ *
 * 2. 假装是浏览器：chrome.* API
 * ------------------------------------------------------------------ */

const als = new AsyncLocalStorage()

const listeners = [] // { ctx, fn }
let registeringAs = 'sw'
let offscreenDoc = null
let offscreenImport = null

const storage = new Map()
const storageChangedListeners = []
const badge = { text: undefined, color: undefined }
const commandListeners = []
const actionListeners = []

function fireStorageChanged (patch) {
  const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]))
  for (const fn of storageChangedListeners) fn(changes, 'local')
}

/** 复刻 runtime.sendMessage：发送者自己收不到自己的消息 */
function deliver (message, from) {
  return new Promise(resolve => {
    let settled = false
    const sendResponse = response => {
      if (settled) return
      settled = true
      resolve(response)
    }
    let willRespondAsync = false
    for (const entry of listeners) {
      if (entry.ctx === from) continue
      let returned
      try {
        returned = als.run(entry.ctx, () => entry.fn(message, { id: entry.ctx }, sendResponse))
      } catch (err) {
        console.error('[listener 抛错]', err)
        continue
      }
      if (returned === true) willRespondAsync = true
    }
    if (!willRespondAsync) resolve(undefined)
  })
}

/** 测试用钩子：让接下来 N 次「SW -> offscreen」的投递失败，模拟真实的首帧竞态 */
const hooks = { offscreenFailures: 0 }
/** 统计「发往 offscreen 的消息」条数：firefox 形态下必须是 0（一跳都不该有） */
let offscreenMessages = 0

globalThis.chrome = {
  runtime: {
    getURL: p => `fake-extension://${p}`,
    sendMessage: message => {
      const from = als.getStore() || 'external'
      if (message && message.to === 'offscreen') offscreenMessages++
      if (message && message.to === 'offscreen' && from === 'sw' && hooks.offscreenFailures > 0) {
        hooks.offscreenFailures--
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
      }
      return deliver(message, from)
    },
    onMessage: {
      addListener: fn => listeners.push({ ctx: registeringAs, fn })
    },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    lastError: undefined
  },
  storage: {
    local: {
      get: async defaults => ({ ...defaults, ...Object.fromEntries(storage) }),
      set: async patch => {
        for (const [k, v] of Object.entries(patch)) storage.set(k, v)
        fireStorageChanged(patch)
      }
    },
    onChanged: { addListener: fn => storageChangedListeners.push(fn) }
  },
  // Firefox 形态下这个 API 根本不存在——engine-bridge 就是靠它决定引擎住哪的
  ...(HAS_OFFSCREEN
    ? {
        offscreen: {
          hasDocument: async () => Boolean(offscreenDoc), // Chrome 150+ 才有；这里始终提供
          createDocument: async ({ url }) => {
            if (offscreenDoc) throw new Error('Only a single offscreen document may be created.')
            offscreenDoc = url
            // 真实浏览器里 createDocument 会把页面加载起来；这里等价于 import 那个模块。
            // 注意登记上下文必须用显式变量：als.run 传不进动态 import 的模块体
            registeringAs = 'offscreen'
            try {
              offscreenImport = import('../src/offscreen/offscreen.js')
              await offscreenImport
            } finally {
              registeringAs = 'sw'
            }
          }
        }
      }
    : {}),
  tabs: {
    query: async () => [],
    sendMessage: async () => { throw new Error('没有内容脚本') }
  },
  action: {
    setBadgeText: async ({ text }) => { badge.text = text },
    setBadgeBackgroundColor: async ({ color }) => { badge.color = color },
    onClicked: { addListener: fn => actionListeners.push(fn) }
  },
  commands: {
    onCommand: { addListener: fn => commandListeners.push(fn) }
  }
}

// offscreen.js 用 fetch(chrome.runtime.getURL(...)) 读打包好的方案文件
globalThis.fetch = async url => {
  const file = path.join(ROOT, String(url).replace(/^fake-extension:\/\//, ''))
  if (!existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404') }, arrayBuffer: async () => { throw new Error('404') } }
  }
  const buf = readFileSync(file)
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
}

/* ------------------------------------------------------------------ *
 * 2b. 浏览器语言：offscreen 用它决定简繁默认值
 * ------------------------------------------------------------------ */

// 本机区域设置不该决定断言结果，钉死成 zh-CN（= 简体）。想测繁体改成 'zh-TW' 再跑一遍。
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true
})

/* ------------------------------------------------------------------ *
 * 3. 加载真实的 service worker
 * ------------------------------------------------------------------ */

let failures = 0
function check (label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
  }
}

await import('../src/background/service-worker.js')

const fromContent = (message) => deliver(message, 'content')

async function main () {
  console.log(`\n平台形态: ${PLATFORM}（${HAS_OFFSCREEN ? 'service worker + offscreen 文档' : '背景页就地宿主'}）`)

  console.log('\n== background 路由 ==')
  const initial = await fromContent({ to: 'background', op: 'getState' })
  check('getState 返回默认设置', initial && initial.ok && initial.result.settings.enabled === false,
    initial && initial.result && initial.result.settings)
  check(`getState 报告的宿主模式 = ${HAS_OFFSCREEN ? 'offscreen' : 'local'}`,
    initial && initial.result.engineMode === (HAS_OFFSCREEN ? 'offscreen' : 'local'),
    initial && initial.result && initial.result.engineMode)

  const unknown = await fromContent({ to: 'background', op: 'nonsense' })
  check('未知操作返回结构化错误', unknown && unknown.ok === false && /不认识/.test(unknown.error), unknown)

  console.log('\n== 开关 ==')
  const toggled = await fromContent({ to: 'background', op: 'toggle' })
  check('toggle 把开关打开', toggled && toggled.result.enabled === true, toggled)
  check('徽标变成「中」', badge.text === '中', badge.text)
  const off = await fromContent({ to: 'background', op: 'toggle' })
  check('再 toggle 关回去', off && off.result.enabled === false)
  check('徽标变回「EN」', badge.text === 'EN', badge.text)
  await fromContent({ to: 'background', op: 'toggle' }) // 后面要打字，开着

  console.log(`\n== 引擎宿主（${HAS_OFFSCREEN ? 'offscreen 文档' : '背景页就地'}）==`)
  const { MODE } = await import('../src/background/engine-bridge.js')
  if (HAS_OFFSCREEN) {
    check('engine-bridge 选了 offscreen 模式', MODE === 'offscreen', MODE)
    check('SW 按需创建了 offscreen 文档', offscreenDoc === 'src/offscreen/offscreen.html', offscreenDoc)
  } else {
    check('engine-bridge 选了就地模式', MODE === 'local', MODE)
    check('环境里确实没有 chrome.offscreen', typeof chrome.offscreen === 'undefined')
    check('没有创建任何 offscreen 文档', offscreenDoc === null, offscreenDoc)
  }

  console.log('\n== content -> engine 全链路 ==')
  const t0 = Date.now()
  // content script 的 request() 总会带上 schemaId（{ ...payload, schemaId: this.schemaId }）
  const n = await fromContent({ to: 'engine', op: 'process', payload: { input: 'n', schemaId: 'luna_pinyin' } })
  check(`process('n') 穿过整条链路回来（${Date.now() - t0} ms，含引擎冷启动）`,
    n && n.ok && n.result && n.result.state === 1, n && n.error)
  check('候选列表非空', Boolean(n && n.result && n.result.candidates && n.result.candidates.length),
    n && n.result && n.result.candidates)

  // 两种形态最本质的差别就在这一条上：Chrome 必须跨一次消息通道，
  // Firefox 是同一个上下文里的直接函数调用，一条发往 offscreen 的消息都不该有。
  check(HAS_OFFSCREEN
    ? `请求确实走了 offscreen 消息通道（累计 ${offscreenMessages} 条）`
    : 'Firefox 形态下一跳都没有（发往 offscreen 的消息为 0 条）',
  HAS_OFFSCREEN ? offscreenMessages > 0 : offscreenMessages === 0,
  offscreenMessages)

  // 顺手确认：调用方漏传 schemaId 时不会整条链路断掉
  const noSchema = await fromContent({ to: 'engine', op: 'process', payload: { input: 'i' } })
  check('漏传 schemaId 时回退到默认方案', noSchema && noSchema.ok, noSchema && noSchema.error)

  for (const ch of 'hao') {
    await fromContent({ to: 'engine', op: 'process', payload: { input: ch, schemaId: 'luna_pinyin' } })
  }
  const space = await fromContent({ to: 'engine', op: 'process', payload: { input: ' ', schemaId: 'luna_pinyin' } })
  check('输入 nihao + 空格 -> 上屏「你好」', space && space.ok && space.result.committed === '你好',
    space && space.result && space.result.committed)

  // 简繁默认值也要能穿过这条链路：offscreen 按 navigator.language 算出开关、随方案下发，
  // 引擎在 set_ime 之后应用它。朙月拼音的原生默认是繁体，所以这里打出简体才说明那一刀生效了。
  await fromContent({ to: 'engine', op: 'process', payload: { input: '{Escape}', schemaId: 'luna_pinyin' } })
  for (const ch of 'hanzi') {
    await fromContent({ to: 'engine', op: 'process', payload: { input: ch, schemaId: 'luna_pinyin' } })
  }
  const hanzi = await fromContent({ to: 'engine', op: 'process', payload: { input: ' ', schemaId: 'luna_pinyin' } })
  check('zh-CN 下 hanzi + 空格 -> 上屏「汉字」（简繁默认值穿过 IPC）',
    hanzi && hanzi.ok && hanzi.result.committed === '汉字',
    hanzi && hanzi.result && hanzi.result.committed)

  const sel = await fromContent({ to: 'engine', op: 'selectCandidate', payload: { index: 0, schemaId: 'luna_pinyin' } })
  check('selectCandidate 返回正常', sel && sel.ok !== undefined, sel)

  console.log('\n== 设置变更往下传 ==')
  const settings = await fromContent({ to: 'background', op: 'setSettings', payload: { pageSize: 8 } })
  check('setSettings 返回新设置', settings && settings.ok && settings.result.pageSize === 8, settings && settings.result)

  const status = await fromContent({ to: 'engine', op: 'status', payload: {} })
  check('pageSize 变更传到了引擎', status && status.ok && status.result.pageSize === 8,
    status && status.result)

  console.log('\n== 引擎错误可诊断 ==')
  const bad = await fromContent({ to: 'engine', op: 'loadSchema', payload: { schemaId: '不存在的方案' } })
  check('未知方案返回带原因的失败', bad && bad.ok === false && /未注册/.test(bad.error), bad)

  if (HAS_OFFSCREEN) {
    console.log('\n== 首帧竞态回归测试 ==')
    // 真实场景：createDocument() resolve 时 offscreen 的 onMessage 还没注册上，
    // 此时投递会失败并抛 "Receiving end does not exist."，必须退避重试而不是直接报给用户
    hooks.offscreenFailures = 3
    const raced = await fromContent({ to: 'engine', op: 'process', payload: { input: 'n', schemaId: 'luna_pinyin' } })
    check('offscreen 偶发「没人接收」时重试成功', raced && raced.ok && raced.result.state === 1,
      raced && raced.error)
    check('重试次数已被消耗', hooks.offscreenFailures === 0, hooks.offscreenFailures)
  } else {
    console.log('\n== 就地宿主没有「消息没投递」这种失败模式 ==')
    // 同一条路径在 Firefox 形态下压根不经过消息通道，所以连注入失败的机会都没有：
    // 这不是「碰巧没触发」，而是 offscreenMessages 恒为 0 的直接推论。
    check('引擎请求全链路都不发消息（累计 0 条）', offscreenMessages === 0, offscreenMessages)
  }
  await fromContent({ to: 'engine', op: 'process', payload: { input: '{Escape}', schemaId: 'luna_pinyin' } })
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? `✅ IPC 全链路通过（${PLATFORM} 形态）` : `❌ ${failures} 项失败`}\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(error => {
    console.error('\n❌ IPC 冒烟测试崩溃:', error.message)
    console.error(error.stack)
    process.exit(1)
  })
