/**
 * Firefox 端到端测试：把构建出来的 Firefox 包装进真的 Firefox，真的敲键盘，真的看上屏。
 *
 * 为什么需要它：离线测试（check / engine-smoke / content-smoke / ipc-smoke）里那个
 * 「浏览器」是我们用 Node 假扮的——它证明了我们的逻辑自洽，但证明不了这些**浏览器事实**：
 *   - Firefox 能不能加载这份 MV3 清单（background.scripts + type: module）
 *   - 背景页里 `new Worker(...)` + emscripten 能不能在扩展 CSP 下编译 wasm
 *   - `worker-src`/`script-src 'wasm-unsafe-eval'` 在 Gecko 里到底认不认
 *   - content script 在普通网页上能不能接管按键并上屏
 * 这些正是「port 到 Firefox」这件事的全部风险，所以必须真机跑。
 *
 * 驱动方式：geckodriver + WebDriver（原生 fetch 就够，不引任何依赖）。
 * 装扩展用 Marionette 的临时安装（`moz/addon/install` + temporary: true），
 * 等价于 about:debugging 里「临时载入附加组件」，不需要签名。
 *
 * 用法:
 *   node scripts/e2e-firefox.mjs                                   # 用 dist/<...>-firefox.zip
 *   node scripts/e2e-firefox.mjs --target=dist/rime-browser-ime-0.1.0-firefox
 *   FIREFOX_PATH=... GECKODRIVER_PATH=... node scripts/e2e-firefox.mjs
 *
 * 前置：`.tools/firefox/firefox/firefox.exe` 与 `.tools/geckodriver/geckodriver.exe`
 *      （用 `node .tools/fetch-firefox.mjs` 下载，见 CHANGELOG.md 附录 B「环境陷阱」）。
 *      启动浏览器需要完整进程权限，所以这条命令要在 danger-full-access 下跑。
 */
import { spawn } from 'node:child_process'
import { readFile, mkdir, rm, readdir, stat, writeFile, copyFile, cp } from 'node:fs/promises'
import { existsSync, closeSync, openSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { zip } from './lib/zip.mjs'
import { GECKO_ID } from './lib/manifest.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const TOOLS = path.resolve(ROOT, '..', '.tools')
const TMP = path.join(ROOT, '.tmp')

/**
 * 这套环境有两条互相拉扯的限制，都得照顾到（都是实测出来的，不是猜的）：
 *
 *   1. **geckodriver 的 temp 与 profile 必须在工作区内。**
 *      沙箱不允许它写工作区以外的路径，它只报一句
 *      `Unable to write to temporary directory; consider --profile-root ...`
 *      然后以 code 64 退出。所以下面把 TMP/TEMP/TMPDIR 与 --profile-root
 *      都指到本仓库的 .tmp 下。
 *
 *   2. **Firefox 的程序路径必须纯 ASCII。**
 *      路径里有中文时 Firefox 会一声不响地 exit 1——profile 一个文件都不写、
 *      MOZ_LOG 也是空的，完全没有报错可看。实测（159.0a1）：
 *        程序在 C:\...\Temp\ff-ascii 下 exit=0（截图生成、profile 写了 27 个文件）
 *        程序在 E:\项目文件\... 下 exit=1（profile 空、日志空）
 *      而 **profile 路径含中文没关系**（ASCII 程序 + 中文 profile = 正常）。
 *      我们的工作区恰好叫「项目文件」，所以下面会把 Firefox 复制到 ASCII 目录并缓存。
 *
 * 想换 ASCII 落点用 FIREFOX_ASCII_ROOT。
 */
const ASCII_ROOT = process.env.FIREFOX_ASCII_ROOT || path.join(os.tmpdir(), 'rime-browser-ime-e2e')
const isAscii = value => !/[^\x20-\x7e]/.test(value)

let PORT = Number(process.env.WEBDRIVER_PORT || 0)
let BASE = ''
let SITE_PORT = 0

async function freePort () {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'))

const argTarget = (process.argv.find(a => a.startsWith('--target=')) || '').split('=')[1]
const RAW_TARGET = argTarget || process.env.EXT_ROOT ||
  path.join(ROOT, 'dist', `rime-browser-ime-${manifest.version}-firefox.zip`)
const TARGET = path.resolve(ROOT, RAW_TARGET)

const FIREFOX = process.env.FIREFOX_PATH || [
  path.join(TOOLS, 'firefox', 'firefox', 'firefox.exe'),
  path.join(TOOLS, 'firefox', 'firefox.exe'),
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
].find(p => existsSync(p))

const GECKODRIVER = process.env.GECKODRIVER_PATH || [
  path.join(TOOLS, 'geckodriver', 'geckodriver.exe'),
  path.join(TOOLS, 'geckodriver', 'geckodriver')
].find(p => existsSync(p))

/**
 * 程序路径含非 ASCII 时，复制一份到 ASCII 目录（带缓存，只在来源变化时重拷）。
 * @returns {Promise<string>} 可以直接交给 moz:firefoxOptions.binary 的路径
 */
async function asciiFirefoxBinary (binary) {
  if (isAscii(binary)) return binary

  const install = path.dirname(binary)
  const dest = path.join(ASCII_ROOT, 'firefox')
  const exe = path.join(dest, path.basename(binary))
  const marker = path.join(dest, '.source')

  if (existsSync(exe) && existsSync(marker) && (await readFile(marker, 'utf8')) === install) {
    return exe
  }

  console.log('  Firefox 安装路径含非 ASCII 字符，复制一份到纯 ASCII 目录（首次会慢几秒）：')
  console.log(`    ${install}`)
  console.log(`    → ${dest}`)
  await rm(dest, { recursive: true, force: true })
  await cp(install, dest, { recursive: true })
  await writeFile(marker, install)
  return exe
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0
function check (label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
  }
}

/* ------------------------------------------------------------------ *
 * WebDriver 极简客户端
 * ------------------------------------------------------------------ */

async function wd (method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = json && json.value && (json.value.message || json.value.error)
      ? `${json.value.error}: ${json.value.message}`
      : text.slice(0, 300)
    throw new Error(`${method} ${urlPath} → HTTP ${res.status} ${detail}`)
  }
  return json ? json.value : null
}

const W3C_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'

async function findElement (session, css) {
  const el = await wd('POST', `/session/${session}/element`, { using: 'css selector', value: css })
  return el && el[W3C_ELEMENT]
}

async function waitFor (label, fn, { timeout = 60000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) {
      throw new Error(`等待「${label}」超时${lastError ? `（最后一次错误：${lastError.message}）` : ''}`)
    }
    await sleep(interval)
  }
}

/* ------------------------------------------------------------------ *
 * 待测的扩展包
 * ------------------------------------------------------------------ */

/** 目录先打成 xpi；Marionette 的临时安装吃文件（zip/xpi），不吃目录 */
async function prepareAddon () {
  if (!existsSync(TARGET)) {
    throw new Error(`找不到待测扩展：${path.relative(ROOT, TARGET)}\n` +
      '先运行 node scripts/build-firefox.mjs')
  }
  const info = await stat(TARGET)
  if (info.isDirectory()) {
    const entries = []
    const walk = async (dir, rel) => {
      for (const name of (await readdir(dir)).sort()) {
        const abs = path.join(dir, name)
        const child = `${rel}/${name}`
        const childInfo = await stat(abs)
        if (childInfo.isDirectory()) await walk(abs, child)
        else entries.push({ name: child.replace(/^\//, ''), data: await readFile(abs) })
      }
    }
    await walk(TARGET, '')
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    const out = path.join(TMP, 'firefox-e2e.xpi')
    await mkdir(TMP, { recursive: true })
    await writeFile(out, zip(entries))
    console.log(`把目录打成 xpi: ${path.relative(ROOT, out)}（${entries.length} 个文件）`)
    return out
  }
  // .zip 直接当 xpi 用，但换个后缀，免得 Firefox 按文件类型挑刺
  if (TARGET.endsWith('.zip')) {
    const out = path.join(TMP, 'firefox-e2e.xpi')
    await mkdir(TMP, { recursive: true })
    await copyFile(TARGET, out)
    return out
  }
  return TARGET
}

/**
 * 给 Firefox 的 user.js。刻意保持精简：越接近真实用户的配置，测出来的东西越可信。
 * 只放「不这么设就会弹窗/联网/装不上」的那几条。
 */
function firefoxUserPrefs (marionettePort) {
  return [
    // Marionette 监听端口（geckodriver --connect-existing 连的就是它）
    `user_pref("marionette.port", ${marionettePort});`,
    // 首次运行别弹「设为默认浏览器」、别打断点开首页
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.startup.page", 0);',
    // 不联网做遥测/更新
    'user_pref("app.update.auto", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    // 临时安装本来就不查签名；这里再放开一次，方便装未签名的 zip
    'user_pref("xpinstall.signatures.required", false);',
    // 侧载的扩展默认会被「自动禁用」，这条让它装完就是启用状态
    'user_pref("extensions.autoDisableScopes", 0);',
    // 让页面/背景页的 console 进日志，排查时全靠它
    'user_pref("devtools.console.stdout.content", true);'
  ].join('\n') + '\n'
}

/** 端口是否已经有人在听（用来等 Marionette 起来） */
function portOpen (port) {
  return new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = value => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(false))
  })
}

/**
 * 取扩展的 moz-extension UUID。
 *
 * 扩展页面的 URL 是 `moz-extension://<uuid>/...`，而这个 uuid 是 Firefox 装的时候
 * 随机分配的，事先不可能知道。两条来源，都在 profile 里：
 *   1. `prefs.js` 的 `extensions.webextensions.uuids`（id → uuid 的 JSON 串）——实测最可靠
 *   2. `<profile>/extensions.json` 里那条 addon 记录（顺带能确认它真的被载入了）
 *
 * 注意：**Marionette 的临时安装不会留下任何 UUID**——那是纯内存的会话级安装，
 * 所以这里走侧载（把 xpi 放进 profile/extensions/），和真实安装更接近。
 */
async function resolveExtensionUuid (profile) {
  return waitFor('扩展的 uuid（prefs.js 或 extensions.json）', async () => {
    const prefsFile = path.join(profile, 'prefs.js')
    if (existsSync(prefsFile)) {
      const prefs = await readFile(prefsFile, 'utf8')
      const match = /"extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"/.exec(prefs)
      if (match) {
        // prefs.js 里的值是一层转义过的 JSON 字符串
        const map = JSON.parse(match[1].replace(/\\"/g, '"'))
        if (map[GECKO_ID]) return map[GECKO_ID]
      }
    }
    const file = path.join(profile, 'extensions.json')
    if (existsSync(file)) {
      try {
        const data = JSON.parse(await readFile(file, 'utf8'))
        const entry = (data.addons || []).find(a => a.id === GECKO_ID)
        if (entry && entry.uuid) return entry.uuid
      } catch { /* 文件可能正在写，下一轮再试 */ }
    }
    return null
  }, { timeout: 30000 })
}

/** 从 extensions.json 里读扩展记录（用来确认它不只是被装上，而且是启用状态） */
async function readExtensionRecord (profile) {
  try {
    const data = JSON.parse(await readFile(path.join(profile, 'extensions.json'), 'utf8'))
    return (data.addons || []).find(a => a.id === GECKO_ID) || null
  } catch {
    return null
  }
}

/**
 * 打开扩展自己的页面（设置页）。
 *
 * WebDriver 的 Navigate 会**拒绝 `moz-extension://`**：
 *   `Navigation to "moz-extension://…" is not allowed in this context`
 * （受保护协议，不许被测脚本随便跳）。所以这里切到 chrome 上下文，用系统权限
 * 让当前标签页去加载它，再切回来照常驱动 DOM。
 * chrome 上下文需要 geckodriver 的 `--allow-system-access`（已经在参数里了）。
 */
async function openExtensionPage (session, url) {
  await wd('POST', `/session/${session}/moz/context`, { context: 'chrome' })
  try {
    await wd('POST', `/session/${session}/execute/sync`, {
      script: 'const uri = Services.io.newURI(arguments[0], null, null);' +
        'gBrowser.selectedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });' +
        'return true;',
      args: [url]
    })
  } finally {
    await wd('POST', `/session/${session}/moz/context`, { context: 'content' })
  }
}

/** 目录/文件里最新的 mtime，用来判断「包是不是比源码旧」 */
async function newestMtime (abs) {
  const info = await stat(abs)
  if (!info.isDirectory()) return info.mtimeMs
  let newest = 0
  for (const entry of await readdir(abs)) {
    newest = Math.max(newest, await newestMtime(path.join(abs, entry)))
  }
  return newest
}

/**
 * 待测包必须比源码新。
 *
 * 没有这道闸，很容易拿旧产物跑出一堆「Firefox 的问题」，其实只是忘了重新构建——
 * 第一次跑就踩了：改了 options.js 没重建，自检里的报错看起来像是 Firefox 的兼容性问题。
 */
async function assertAddonIsFresh () {
  if (!existsSync(TARGET)) return
  const targetInfo = await stat(TARGET)
  if (targetInfo.isDirectory()) return // 目录形态的 mtime 反映不了内容，跳过

  const sourceMtime = Math.max(
    await newestMtime(path.join(ROOT, 'src')),
    (await stat(path.join(ROOT, 'manifest.json'))).mtimeMs
  )
  if (sourceMtime > targetInfo.mtimeMs) {
    throw new Error('待测扩展比源码旧，先重新构建再跑 e2e：node scripts/build-firefox.mjs\n' +
      `  源码最新  ${new Date(sourceMtime).toISOString()}\n` +
      `  待测扩展  ${new Date(targetInfo.mtimeMs).toISOString()}  ${path.relative(ROOT, TARGET)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

let driverLog = null
let firefoxLog = null
let testServer = null
let driver = null
let firefox = null
let session = null

async function main () {
  console.log('\n== 环境 ==')
  if (!FIREFOX) throw new Error('找不到 firefox.exe，先运行 node .tools/fetch-firefox.mjs')
  if (!GECKODRIVER) throw new Error('找不到 geckodriver.exe，先运行 node .tools/fetch-firefox.mjs')
  await assertAddonIsFresh()
  const addon = await prepareAddon()
  const firefoxBinary = await asciiFirefoxBinary(FIREFOX)
  console.log(`  firefox     = ${firefoxBinary}`)
  console.log(`  geckodriver = ${GECKODRIVER}`)
  console.log(`  待测扩展    = ${path.relative(ROOT, addon)}`)

  if (!PORT) PORT = await freePort()
  BASE = `http://127.0.0.1:${PORT}`
  SITE_PORT = await freePort()
  const MARIONETTE_PORT = await freePort()

  // temp 必须落在**工作区内**：沙箱不允许子进程写工作区以外的路径
  // （实测：TMP/TEMP 指向 %TEMP% 时 geckodriver 直接报
  // `Unable to write to temporary directory` 并以 code 64 退出）。
  // 而 profile 路径含中文是没问题的（ASCII 程序 + 中文 profile = 正常，实机验证过）。
  const tempDir = path.join(TMP, 'firefox-tmp')
  await mkdir(tempDir, { recursive: true })
  const childEnv = { ...process.env, TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir }

  console.log('\n== 启动 Firefox（自己拉起，geckodriver 只负责连接）==')
  /**
   * 为什么不让 geckodriver 自己启动 Firefox：在这套沙箱里它那条启动路径会崩
   * （实测先是 crashpad 管道失败 → exit 1，关掉 crashpad 后变成 Access Violation
   * 0xC0000005），而**同样的参数我们自己启动就没问题**（`-marionette -headless`
   * 能稳定存活）。所以浏览器由我们按已知可用的方式拉起，geckodriver 用
   * `--connect-existing` 只当 WebDriver 前端。
   */
  const profile = path.join(TMP, `firefox-profile-${Date.now()}`)
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'user.js'), firefoxUserPrefs(MARIONETTE_PORT), 'utf8')

  // 侧载安装：Firefox 启动时会扫描 <profile>/extensions/ 下的 xpi。
  // 用它而不是 Marionette 的临时安装，是因为临时安装是纯内存的——profile 里
  // 查不到扩展的 uuid，而扩展页面的 URL 需要它（见 resolveExtensionUuid）。
  const extensionsDir = path.join(profile, 'extensions')
  await mkdir(extensionsDir, { recursive: true })
  await copyFile(addon, path.join(extensionsDir, `${GECKO_ID}.xpi`))

  firefoxLog = path.join(TMP, `firefox-${Date.now()}.log`)
  const ffFd = openSync(firefoxLog, 'w')
  firefox = spawn(firefoxBinary, [
    '-marionette', '-headless', '-no-remote', '-profile', profile, 'about:blank'
  ], {
    stdio: ['ignore', 'ignore', ffFd],
    env: {
      ...childEnv,
      // 关掉 crashpad：受限沙箱里 Firefox 连不上崩溃报告的命名管道
      // （stderr 里刷 `ConnectToPipe() failure: GetLastError()=00000002`），
      // 然后它会**直接自杀**（exit 1、profile 一个文件都不写）。
      // 这和 Chrome 需要 --no-sandbox 是同一类问题：都是命名管道被禁。
      MOZ_CRASHREPORTER_DISABLE: '1',
      // 允许 WebDriver 切到 chrome 上下文（打开 moz-extension:// 页面要用，
      // 见 openExtensionPage）。浏览器是我们自己拉起的，所以这个开关必须在这里设；
      // geckodriver 的 --allow-system-access 只对它自己启动的 Firefox 有效。
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1'
    }
  })
  firefox.on('exit', code => console.log(`  （Firefox 退出，code=${code}）`))

  await waitFor('Marionette 端口', () => portOpen(MARIONETTE_PORT), { timeout: 60000 })
  console.log(`  profile      = ${path.relative(ROOT, profile)}`)
  console.log(`  Marionette   = 127.0.0.1:${MARIONETTE_PORT}`)

  console.log('\n== 启动 geckodriver（--connect-existing）==')
  driverLog = path.join(TMP, `geckodriver-${Date.now()}.log`)
  const logFd = openSync(driverLog, 'w')
  driver = spawn(GECKODRIVER, [
    '--port', String(PORT),
    '--connect-existing',
    '--marionette-port', String(MARIONETTE_PORT),
    // 打开扩展自己的页面要用 chrome 上下文（见 openExtensionPage）
    '--allow-system-access',
    '--log', 'debug'
  ], { stdio: ['ignore', 'ignore', logFd], env: childEnv })
  driver.on('exit', code => console.log(`  （geckodriver 退出，code=${code}）`))

  await waitFor('geckodriver 端口', async () => {
    const res = await fetch(`${BASE}/status`)
    return res.ok
  }, { timeout: 30000 })

  const caps = { capabilities: { alwaysMatch: { browserName: 'firefox', acceptInsecureCerts: true } } }
  const created = await wd('POST', '/session', caps)
  session = created.sessionId
  const browserVersion = created.capabilities?.browserVersion
  check(`Firefox 起来了（${browserVersion}）`, Boolean(session), session)

  console.log('\n== 扩展是否被载入 ==')
  const uuid = await resolveExtensionUuid(profile)
  const record = await readExtensionRecord(profile)
  check(`扩展已载入（id = ${GECKO_ID}）`, Boolean(uuid))
  check('扩展处于启用状态（不是被 Firefox 自动禁用）', !record || record.active !== false,
    record && record.active)
  console.log(`  moz-extension uuid = ${uuid}`)

  console.log('\n== 设置页（扩展页面能不能打开）==')
  const optionsUrl = `moz-extension://${uuid}/src/options/options.html`
  await openExtensionPage(session, optionsUrl)
  const toggle = await waitFor('设置页的开关按钮', () => findElement(session, '#toggle'))
  // 按钮文字由 options.js 的 renderSettings() 在 refresh() 之后改写
  // （HTML 里是静态的「切换」，跑起来才变「已关闭，点击开启」），所以这里等它改写完
  const engineText = await waitFor('设置页渲染出真实状态', async () => {
    const text = await wd('GET', `/session/${session}/element/${toggle}/text`)
    return /开启|关闭/.test(text || '') ? text : null
  }, { timeout: 15000 })
  check('设置页打开了（扩展页面可用）', /开启|关闭/.test(engineText || ''), engineText)

  console.log('\n== 打开开关 ==')
  await wd('POST', `/session/${session}/element/${toggle}/click`, {})
  const selfTestButton = await findElement(session, '#self-test')

  console.log('\n== 跑扩展自带的自检（这一条覆盖整条引擎链路）==')
  await wd('POST', `/session/${session}/element/${selfTestButton}/click`, {})
  const report = await waitFor('自检结果', async () => {
    const el = await findElement(session, '#self-test-result')
    if (!el) return null
    const text = await wd('GET', `/session/${session}/element/${el}/text`)
    return text && text.includes('结论') ? text : null
  }, { timeout: 120000 })
  console.log(report.split('\n').map(line => '    ' + line).join('\n'))
  check('自检没有失败项', !/✗/.test(report), report.replace(/\s+/g, ' ').slice(0, 200))
  check('自检结论：输入链路正常', /输入链路完全正常/.test(report))

  console.log('\n== 工具栏面板（点了图标弹出的那个小设置页）==')
  // 这一段的价值不只是「面板能打开」：它同时证明了面板里那两套 API 的**Promise 形式**
  // 在 Gecko 的 chrome.* 命名空间下也能用（`chrome.runtime.sendMessage` 与
  // `chrome.storage.local.get`）——这两条只要有一条不成立，面板就会停在静态文案上。
  await openExtensionPage(session, `moz-extension://${uuid}/src/popup/popup.html`)
  const popupToggle = await waitFor('面板的开关按钮', () => findElement(session, '#toggle'))
  const popupText = await waitFor('面板渲染出真实状态', async () => {
    const text = await wd('GET', `/session/${session}/element/${popupToggle}/text`)
    return /开启|停用/.test(text || '') ? text : null
  }, { timeout: 15000 })
  check('面板渲染出了真实开关状态（不是 HTML 里的静态文案）', popupText === '停用输入法', popupText)

  const popupCounts = await wd('POST', `/session/${session}/execute/sync`, {
    script: 'return {' +
      ' schemas: document.querySelectorAll("#schema option").length,' +
      ' groups: document.querySelectorAll("#schema optgroup").length,' +
      ' tradSimp: document.getElementById("trad-simp-field").hidden' +
      '   ? 0 : document.getElementById("trad-simp").options.length };',
    args: []
  })
  check(`面板列全了 ${popupCounts.schemas} 个方案 / ${popupCounts.groups} 个分组`,
    popupCounts.schemas === 15 && popupCounts.groups === 4, popupCounts)
  check('面板上的简繁下拉框是「跟随 + 简 + 繁」三项（chrome.storage 的 Promise 形式可用）',
    popupCounts.tradSimp === 3, popupCounts)

  // 点一下关、再点一下开：走的是面板 -> background -> storage -> 广播那条回路
  await wd('POST', `/session/${session}/element/${popupToggle}/click`, {})
  const afterOff = await waitFor('面板把输入法关掉', async () => {
    const text = await wd('GET', `/session/${session}/element/${popupToggle}/text`)
    return text === '开启输入法' ? text : null
  }, { timeout: 15000 })
  check('面板上点一下能关（开关状态回读到了 background）', afterOff === '开启输入法', afterOff)
  await wd('POST', `/session/${session}/element/${popupToggle}/click`, {})
  const afterOn = await waitFor('面板把输入法开回来', async () => {
    const text = await wd('GET', `/session/${session}/element/${popupToggle}/text`)
    return text === '停用输入法' ? text : null
  }, { timeout: 15000 })
  check('再点一下又开回来（后面还要在普通网页上打字）', afterOn === '停用输入法', afterOn)

  console.log('\n== 普通网页上真的打字 ==')
  testServer = createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>e2e</title></head>
<body><textarea id="ta" rows="4" cols="40"></textarea></body></html>`)
  })
  await new Promise(resolve => testServer.listen(SITE_PORT, '127.0.0.1', resolve))
  const siteUrl = `http://127.0.0.1:${SITE_PORT}/`

  await wd('POST', `/session/${session}/url`, { url: siteUrl })
  const ta = await waitFor('测试页的 textarea', () => findElement(session, '#ta'))
  await wd('POST', `/session/${session}/element/${ta}/click`, {})

  // 真按键（WebDriver Actions 走的是浏览器的事件注入，和用户敲键盘同一条路）
  const keys = [...'nihao ']
  const t0 = Date.now()
  await wd('POST', `/session/${session}/actions`, {
    actions: [{
      type: 'key',
      id: 'keyboard',
      actions: keys.flatMap(ch => [{ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }])
    }]
  })

  const value = await waitFor('textarea 上屏「你好」', async () => {
    const el = await findElement(session, '#ta')
    const text = await wd('GET', `/session/${session}/element/${el}/property/value`)
    return text === '你好' ? text : null
  }, { timeout: 60000 }).catch(async () => {
    const el = await findElement(session, '#ta')
    return await wd('GET', `/session/${session}/element/${el}/property/value`)
  })
  check(`普通网页上 nihao + 空格 -> 上屏「你好」（${Date.now() - t0} ms）`, value === '你好', value)
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? '✅ Firefox 端到端通过' : `❌ ${failures} 项失败`}\n`)
  })
  .catch(error => {
    console.error('\n❌ Firefox 端到端崩溃:', error.message)
    console.error(error.stack)
    failures++
  })
  .finally(async () => {
    // 收尾：删会话、关掉我们自己拉起的 Firefox 与 geckodriver、失败时把日志尾部打出来
    try { if (session) await wd('DELETE', `/session/${session}`) } catch { /* 已经没了 */ }
    if (driver && !driver.killed) driver.kill()
    if (firefox && !firefox.killed) firefox.kill()
    if (testServer) testServer.close()
    if (failures) {
      const tail = async (file, label) => {
        if (!file || !existsSync(file)) return
        const lines = (await readFile(file, 'utf8')).trim().split('\n')
        console.error(`\n--- ${label}（${path.relative(ROOT, file)}）尾部 ---\n` +
          lines.slice(-40).join('\n'))
      }
      await tail(driverLog, 'geckodriver 日志')
      await tail(firefoxLog, 'Firefox 日志')
      console.error('\n提示：页面/背景页的 console 已经进了日志（devtools.console.stdout.content）')
    }
    await rm(path.join(TMP, 'firefox-e2e.xpi'), { force: true })
    process.exit(failures === 0 ? 0 : 1)
  })
