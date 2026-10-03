/**
 * 静态自检：不启动浏览器，把「能不能被 Chrome 正常加载」这件事能离线查的部分全查一遍。
 *
 *   - manifest.json 是否合法、被引用的文件是否都存在
 *   - 所有 JS / JSON 的语法
 *   - 引擎产物是否在位（含 wasm 魔数）
 *   - schemas/manifest.json 与 src/common/const.js 里的方案注册表是否对得上
 *
 * 用法: node scripts/check.mjs
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

let failures = 0
let checks = 0

function ok (message) {
  checks++
  console.log(`  \u2713 ${message}`)
}

function bad (message) {
  checks++
  failures++
  console.log(`  \u2717 ${message}`)
}

function expect (condition, message, detail) {
  if (condition) ok(message)
  else bad(message + (detail ? ` — ${detail}` : ''))
}

async function readJson (rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'))
}

async function walk (dir, out = []) {
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === '.cache' || entry.name === '.tmp' || entry.name === 'node_modules') continue
      await walk(rel, out)
    } else {
      out.push(rel)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */

console.log('\n== manifest.json ==')
const manifest = await readJson('manifest.json')

expect(manifest.manifest_version === 3, 'manifest_version 是 3')
expect(typeof manifest.name === 'string' && manifest.name.length > 0, '有 name')
expect(/^\d+\.\d+\.\d+$/.test(manifest.version), `version 形如 x.y.z（${manifest.version}）`)
expect(Array.isArray(manifest.permissions) && manifest.permissions.includes('offscreen'), 'permissions 含 offscreen')
expect(Boolean(manifest.background?.service_worker), '声明了 background.service_worker')
expect(Boolean(manifest.action), '声明了 action（点击图标弹出设置面板）')
expect(/^src\/[a-z-]+\/[a-z-]+\.html$/.test(manifest.action?.default_popup || ''),
  `action.default_popup 指向面板页面（${manifest.action?.default_popup}）`)
expect(
  manifest.content_security_policy?.extension_pages?.includes('wasm-unsafe-eval'),
  "CSP 允许 wasm（'wasm-unsafe-eval'）"
)

console.log('\n== Firefox 清单（构建期由 lib/manifest.mjs 生成）==')
{
  const { buildFirefoxManifest, GECKO_ID, GECKO_MIN_VERSION } = await import('./lib/manifest.mjs')
  const firefox = buildFirefoxManifest(manifest)

  expect(firefox.manifest_version === 3, 'Firefox 版同样是 MV3')
  expect(firefox.background?.type === 'module', 'background 声明了 type: module（入口用了 import）')
  expect(firefox.background?.scripts?.[0] === manifest.background.service_worker,
    'background 换成 scripts，且与 Chrome 共用同一个入口文件')
  expect(firefox.background?.service_worker === undefined,
    'Firefox 清单里没有 service_worker（Gecko 不支持，见 bug 1573659）')
  expect(!(firefox.permissions || []).includes('offscreen'),
    'Firefox 清单去掉了 offscreen 权限（那边没有这个 API）')
  expect(firefox.minimum_chrome_version === undefined, 'Firefox 清单去掉了 minimum_chrome_version')
  expect(firefox.browser_specific_settings?.gecko?.id === GECKO_ID, `声明了 gecko id（${GECKO_ID}）`)
  expect(firefox.browser_specific_settings?.gecko?.strict_min_version === GECKO_MIN_VERSION,
    `声明了 strict_min_version = ${GECKO_MIN_VERSION}（MV3 从 109 开始）`)
  // Gecko 在 MV3 下默认**不**允许编译 wasm：不给这个关键字，引擎在背景页里根本起不来
  expect(firefox.content_security_policy?.extension_pages?.includes("'wasm-unsafe-eval'"),
    "Firefox 清单保留了 'wasm-unsafe-eval'（MV3 不给它 wasm 编译不了）")
  expect(!JSON.stringify(firefox).includes('offscreen'), 'Firefox 清单里不再出现任何 offscreen 字样')

  // 这些部分两个浏览器完全一样，转换时不许悄悄丢
  for (const key of ['content_scripts', 'host_permissions', 'options_ui', 'commands', 'icons', 'action']) {
    expect(JSON.stringify(firefox[key]) === JSON.stringify(manifest[key]), `${key} 原样保留`)
  }
}

console.log('\n== 清单引用的文件 ==')
const referenced = new Set()
for (const value of Object.values(manifest.icons || {})) referenced.add(value)
for (const value of Object.values(manifest.action?.default_icon || {})) referenced.add(value)
referenced.add(manifest.background?.service_worker)
referenced.add(manifest.options_ui?.page)
referenced.add(manifest.action?.default_popup)
for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) referenced.add(file)
  for (const file of script.css || []) referenced.add(file)
}
for (const file of [...referenced].filter(Boolean)) {
  if (existsSync(path.join(ROOT, file))) ok(file)
  else bad(`缺少文件: ${file}`)
}

console.log('\n== HTML 里的本地引用 ==')
{
  // manifest 只指向 options.html / offscreen.html 本身，
  // 页面里的 <script src> / <link href> 有没有写错，得单独查
  const htmlFiles = (await walk('src')).filter(f => f.endsWith('.html'))
  let refs = 0
  for (const rel of htmlFiles) {
    const html = await readFile(path.join(ROOT, rel), 'utf8')
    // 扩展页面的 CSP 是 script-src 'self'，内联 <script> 会被直接拦掉，
    // 而且只在运行时于控制台报错，很容易漏
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)]
    if (inline.length) {
      bad(`${rel} 有 ${inline.length} 段内联 <script>，会被扩展 CSP 拦掉`)
    }
    for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const value = match[1]
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) continue // 外部链接 / 锚点
      refs++
      const target = path.normalize(path.join(path.dirname(rel), value)).replace(/\\/g, '/')
      if (!existsSync(path.join(ROOT, target))) bad(`${rel} 引用了不存在的 ${value}`)
    }
  }
  ok(`${htmlFiles.length} 个 HTML 页面共 ${refs} 个本地引用都指向真实文件`)
}

console.log('\n== 语法 ==')
const files = (await walk('src')).concat(['manifest.json', 'package.json'])
for (const rel of files) {
  const ext = path.extname(rel)
  if (ext === '.json') {
    try {
      JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'))
      ok(`${rel} (json)`)
    } catch (error) {
      bad(`${rel} (json) — ${error.message}`)
    }
    continue
  }
  if (ext !== '.js') continue
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'ignore' })
  if (result.status === 0) ok(`${rel} (js)`)
  else bad(`${rel} (js) 语法错误`)
}

console.log('\n== 引擎产物 ==')
for (const [file, minBytes] of [['rime.js', 10000], ['rime.wasm', 100000], ['rime.data', 100000]]) {
  const rel = `src/engine/${file}`
  const full = path.join(ROOT, rel)
  if (!existsSync(full)) {
    bad(`缺少 ${rel}`)
    continue
  }
  const info = await stat(full)
  expect(info.size >= minBytes, `${rel} (${(info.size / 1024).toFixed(0)} KB)`)
}
const wasm = await readFile(path.join(ROOT, 'src/engine/rime.wasm'))
expect(
  wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d,
  'rime.wasm 魔数正确 (\\0asm)'
)
expect(
  existsSync(path.join(ROOT, 'licenses/my-rime-LICENSE.txt')),
  '保留了上游 AGPL 许可原文'
)

console.log('\n== 输入方案 ==')
const schemaManifest = await readJson('schemas/manifest.json')
const targets = new Set()
let schemaFiles = 0
for (const entry of schemaManifest) {
  targets.add(entry.target)
  for (const name of entry.files) {
    schemaFiles++
    const rel = `schemas/${entry.target}/${name}`
    if (!existsSync(path.join(ROOT, rel))) bad(`缺少 ${rel}`)
  }
}
ok(`schemas/manifest.json 声明了 ${schemaManifest.length} 个包 / ${schemaFiles} 个文件`)

// 通过动态 import 读出方案注册表（const.js 只往 globalThis 上挂东西）
await import('../src/common/const.js')
const { SCHEMAS, DEFAULTS, OP, RIME_STATE, MSG } = globalThis.RIME_CONST
expect(Array.isArray(SCHEMAS) && SCHEMAS.length > 0, `注册了 ${SCHEMAS.length} 个方案`)

for (const schema of SCHEMAS) {
  const missing = schema.targets.filter(t => !targets.has(t))
  if (missing.length) bad(`方案 ${schema.id} 依赖的包没下载: ${missing.join(', ')}`)
  else ok(`方案 ${schema.id}（${schema.name}）依赖齐全: ${schema.targets.join(', ')}`)

  const prefix = schema.targets[0]
  const dir = path.join(ROOT, 'schemas', prefix)
  if (existsSync(path.join(dir, `${schema.id}.schema.yaml`))) {
    ok(`  ${schema.id}.schema.yaml 在位`)
  } else {
    bad(`  schemas/${prefix}/${schema.id}.schema.yaml 不在，select_schema 会找不到方案`)
  }
}

expect(
  SCHEMAS.some(s => s.id === DEFAULTS.schemaId),
  `默认方案 ${DEFAULTS.schemaId} 在注册表里`
)

console.log('\n== 简繁默认值（跟随浏览器语言）==')
{
  const { TRAD_SIMP, prefersTraditional, tradSimpDefault } = globalThis.RIME_CONST

  for (const [locale, expected] of [
    ['zh-TW', true], ['zh-Hant-TW', true], ['zh-HK', true], ['zh-MO', true], ['zh-Hant', true],
    ['zh-CN', false], ['zh-Hans-CN', false], ['en-US', false], ['', false], [undefined, false]
  ]) {
    expect(prefersTraditional(locale) === expected,
      `prefersTraditional(${JSON.stringify(locale)}) === ${expected}`)
  }

  // 有简繁开关的方案 = 这张表的全部，不多不少（少一个就会有人打出繁体，多一个会误伤）
  const withSwitch = new Set([
    'luna_pinyin', 'luna_pinyin_fluency', 'terra_pinyin',
    'double_pinyin', 'double_pinyin_abc', 'double_pinyin_flypy', 'double_pinyin_mspy', 'double_pinyin_pyjj',
    'bopomofo', 'bopomofo_express'
  ])
  const tableIds = new Set(Object.keys(TRAD_SIMP))
  const missing = [...withSwitch].filter(id => !tableIds.has(id))
  const extra = [...tableIds].filter(id => !withSwitch.has(id))
  expect(missing.length === 0 && extra.length === 0,
    `简繁表覆盖 ${tableIds.size} 个带开关的方案，与预期一致`,
    `缺 ${missing.join(', ')} 多 ${extra.join(', ')}`)
  expect([...tableIds].every(id => SCHEMAS.some(s => s.id === id)), '简繁表里没有未注册的方案')

  for (const [id, variants] of Object.entries(TRAD_SIMP)) {
    const schema = SCHEMAS.find(s => s.id === id)
    const yamlPath = path.join(ROOT, 'schemas', schema.targets[0], `${id}.schema.yaml`)
    const yaml = existsSync(yamlPath) ? await readFile(yamlPath, 'utf8') : ''
    const names = [...new Set(variants.flatMap(v => Object.keys(v.options)))].sort()

    // 开关名必须真的写在这个方案的 yaml 里：写错一个字母 librime 不报错，只是静默不生效
    const unknown = names.filter(name => !new RegExp(`\\b${name}\\b`).test(yaml))
    expect(unknown.length === 0, `${id}: 开关 ${names.join(' / ')} 在方案 yaml 里都存在`,
      unknown.length ? `yaml 里找不到 ${unknown.join(', ')}` : '')

    // 每个 variant 都要写全同一组开关：注音的 zh_hant/zh_hans/zh_hant_tw 是三个独立
    // option，漏一个就会残留上一个 variant 的取值
    const shape = names.join(',')
    const sameShape = variants.every(v => Object.keys(v.options).sort().join(',') === shape)
    expect(sameShape, `${id}: ${variants.length} 个 variant 的开关集合一致`)

    expect(Boolean(tradSimpDefault(id, 'zh-CN')), `${id}: zh-CN 能选出默认 variant`)
    expect(Boolean(tradSimpDefault(id, 'zh-Hant-TW')), `${id}: zh-Hant-TW 能选出默认 variant`)
  }

  expect(tradSimpDefault('luna_pinyin', 'zh-CN').options.simplification === true,
    'zh-CN 下朙月拼音默认简体')
  expect(tradSimpDefault('luna_pinyin', 'zh-TW').options.simplification === false,
    'zh-TW 下朙月拼音默认繁体')
  expect(tradSimpDefault('luna_pinyin', 'en-US').options.simplification === true,
    'en-US 下朙月拼音默认简体')
  expect(tradSimpDefault('bopomofo', 'zh-CN').options.zh_hans === true, 'zh-CN 下注音默认简体字形')
  expect(tradSimpDefault('bopomofo', 'zh-TW').options.zh_hant_tw === true, 'zh-TW 下注音默认臺灣字形')
  expect(tradSimpDefault('bopomofo', 'zh-HK').options.zh_hant === true, 'zh-HK 下注音默认繁体字形')
  expect(tradSimpDefault('pinyin_simp', 'zh-CN') === null, '袖珍简拼没有简繁开关（词库本身就是简体）')
  expect(tradSimpDefault('wubi_trad', 'zh-CN') === null, '86五笔·繁体 保持方案自己的默认（繁）')

  // 用户手动选过之后，偏好是「某个 variant 名」，它压过语言默认；名字不存在就退回语言默认
  expect(tradSimpDefault('luna_pinyin', 'zh-CN', '繁').options.simplification === false,
    '偏好「繁」时朙月拼音出繁体')
  expect(tradSimpDefault('luna_pinyin', 'zh-TW', '简').options.simplification === true,
    '偏好「简」压过 zh-TW 的语言默认')
  expect(tradSimpDefault('bopomofo', 'zh-CN', '臺').options.zh_hant_tw === true,
    '偏好「臺」在注音里选到臺灣字形')
  expect(tradSimpDefault('luna_pinyin', 'zh-CN', '臺').options.simplification === true,
    '偏好名在当前方案里不存在时退回语言默认（注音选了「臺」再切到朙月拼音）')
}

console.log('\n== 状态栏 ==')
{
  const { STORAGE_KEYS } = globalThis.RIME_CONST
  expect(Boolean(STORAGE_KEYS && STORAGE_KEYS.tradSimp && STORAGE_KEYS.collapsed),
    'STORAGE_KEYS 声明了简繁与收起两个键')

  // 顺序有意义：状态栏类要先于 ime.js（控制器构造时 new 它），
  // 而 bootstrap.js 在最后（它一跑就会建控制器）
  const scripts = manifest.content_scripts[0].js
  const at = name => scripts.findIndex(p => p.endsWith(name))
  const order = [at('status-bar.js'), at('ime.js'), at('bootstrap.js')]
  expect(order[0] > -1 && order[0] < order[1] && order[1] < order[2],
    'content_scripts 顺序是 status-bar.js → ime.js → bootstrap.js', scripts.join(' → '))

  const bar = await readFile(path.join(ROOT, 'src/content/status-bar.js'), 'utf8')
  expect(/attachShadow/.test(bar), 'status-bar.js 用 Shadow DOM 承载（页面样式进不来）')
  expect(/isTopFrame/.test(bar), 'status-bar.js 只在顶层 frame 显示')

  // 演练场用 <script src> 复用同一批 content script：漏一个或顺序错都会当场炸
  // （漏 status-bar.js 就是「NS.StatusBar is not a constructor」），而 HTML 引用检查
  // 只看文件在不在，看不出这种错配
  const playground = await readFile(path.join(ROOT, 'src/playground/playground.html'), 'utf8')
  const expected = scripts.map(p => '../' + p.replace(/^src\//, ''))
  const positions = expected.map(rel => playground.indexOf(`"${rel}"`))
  expect(positions.every(p => p > -1), '演练场引用了全部 content script',
    expected.filter((rel, i) => positions[i] === -1).join(', '))
  expect(positions.every((p, i) => i === 0 || p > positions[i - 1]),
    '演练场的引用顺序和 manifest 一致')
}

console.log('\n== 消息协议 ==')
const ops = new Set(Object.values(OP))
const usedOps = new Set()
const protocolFiles = (await walk('src')).filter(f => f.endsWith('.js') && !f.includes('/engine/rime.js'))
for (const rel of protocolFiles) {
  const source = await readFile(path.join(ROOT, rel), 'utf8')
  for (const match of source.matchAll(/OP\.([A-Z_]+)/g)) usedOps.add(match[1])
}
for (const name of usedOps) {
  if (!(name in OP)) bad(`代码里用了未定义的 OP.${name}`)
}
ok(`OP 定义了 ${ops.size} 个操作，代码引用了 ${usedOps.size} 个，均在定义内`)
for (const name of ['PROCESS', 'LOAD_SCHEMA', 'SELECT_CANDIDATE', 'CHANGE_PAGE', 'INIT', 'STATUS']) {
  if (!(name in OP)) bad(`OP 缺少 ${name}`)
}

// engine/worker.js 用字符串字面量做 op 名（它在 Worker 全局里，不便依赖 const.js），
// 这里保证两边的字面量不会悄悄漂移
const engineWorker = await readFile(path.join(ROOT, 'src/engine/worker.js'), 'utf8')
const missingInWorker = Object.values(OP).filter(op => !new RegExp(`\\b${op}\\b`).test(engineWorker))
expect(
  missingInWorker.length === 0,
  `engine/worker.js 覆盖了全部 ${ops.size} 个 op`,
  missingInWorker.length ? `缺 ${missingInWorker.join(', ')}` : ''
)

expect(Object.keys(RIME_STATE).length === 4, 'RIME_STATE 四个状态齐全')
expect(Boolean(MSG.ENGINE_REQUEST && MSG.SETTINGS_CHANGED), 'MSG 关键消息类型齐全')

console.log('\n== 设置页 DOM 绑定 ==')
{
  // $('xxx') 引用的 id 必须真的在 options.html 里，否则自检按钮一按就是 TypeError
  const html = await readFile(path.join(ROOT, 'src/options/options.html'), 'utf8')
  const js = await readFile(path.join(ROOT, 'src/options/options.js'), 'utf8')
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
  const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))
  const missing = [...referenced].filter(id => !ids.has(id))
  expect(missing.length === 0, `options.js 引用的 ${referenced.size} 个 id 都存在于 options.html`,
    missing.length ? `缺 ${missing.join(', ')}` : '')
}

console.log('\n== 工具栏面板（action.default_popup）==')
{
  // 点工具栏图标弹出的小面板。它和设置页一样是「html + js 靠 id 对上」的结构，
  // 而且改文案/挪控件时最容易漏掉其中一边，所以这里按同一套规则查一遍。
  const popupHtml = manifest.action?.default_popup || ''
  const htmlPath = path.join(ROOT, popupHtml)
  expect(popupHtml.startsWith('src/') && existsSync(htmlPath),
    `面板页面存在（${popupHtml}）`)

  const html = existsSync(htmlPath) ? await readFile(htmlPath, 'utf8') : ''
  const jsPath = path.join(path.dirname(htmlPath), path.basename(popupHtml, '.html') + '.js')
  expect(existsSync(jsPath), `面板有配套脚本（${path.basename(jsPath)}）`)
  const js = existsSync(jsPath) ? await readFile(jsPath, 'utf8') : ''

  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))
  const missing = [...used].filter(id => !ids.has(id))
  expect(missing.length === 0, `面板脚本引用的 ${used.size} 个 id 都存在于 ${path.basename(htmlPath)}`,
    missing.length ? `缺 ${missing.join(', ')}` : '')

  // 面板要能跳去完整设置页：openOptionsPage 得有 options_ui 才有落点
  expect(/openOptionsPage/.test(js) && Boolean(manifest.options_ui?.page),
    '面板里的「打开完整设置页」有 options_ui 兜着')

  // 配了 default_popup 之后 action 的点击事件永远不会触发——注册它只是死代码
  const sw = await readFile(path.join(ROOT, 'src/background/service-worker.js'), 'utf8')
  expect(!/onClicked/.test(sw),
    'service worker 里没有工具栏点击回调（配了 default_popup 就不会触发）')
}

console.log('\n== 平台层不变量 ==')
{
  // 注释里提到 chrome.offscreen 是允许的（那是在解释取舍），这里只查真代码
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const srcFiles = (await walk('src')).filter(f => f.endsWith('.js') && !f.includes('/engine/rime.js'))
  const offscreenCallers = []
  const sources = new Map()
  for (const rel of srcFiles) {
    const source = await readFile(path.join(ROOT, rel), 'utf8')
    sources.set(rel, source)
    if (/chrome\.offscreen/.test(stripComments(source))) offscreenCallers.push(rel)
  }
  expect(offscreenCallers.length === 1 && offscreenCallers[0] === 'src/background/engine-bridge.js',
    'chrome.offscreen 只出现在 engine-bridge.js（唯一的平台分叉点）',
    offscreenCallers.join(', '))

  const bridge = sources.get('src/background/engine-bridge.js') || ''
  expect(/requestOffscreen/.test(bridge) && /requestLocal/.test(bridge), '两条宿主路径都实现了')
  expect(!/navigator\.userAgent|navigator\.vendor/.test(bridge), 'engine-bridge 靠能力探测而不是 UA 嗅探')

  // 宿主本体必须平台无关：它自己不许碰 Chrome 专属 API，也不许读 storage
  // （两种宿主的设置一律由调用方随请求下发，行为才一致）
  const hostCode = stripComments(sources.get('src/engine/host.js') || '')
  expect(/export function createEngineHost/.test(hostCode), 'engine/host.js 导出 createEngineHost 工厂')
  expect(!/chrome\.offscreen/.test(hostCode), 'engine/host.js 里没有 Chrome 专属 API')
  expect(!/chrome\.storage/.test(hostCode), 'engine/host.js 不读 chrome.storage')

  // 两个浏览器共用同一份宿主与同一份引擎产物
  for (const rel of ['src/engine/host.js', 'src/background/engine-bridge.js', 'src/engine/worker.js',
    'src/engine/rime.wasm', 'src/engine/rime.data']) {
    expect(existsSync(path.join(ROOT, rel)), `${rel} 在位（两个浏览器共用）`)
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${checks} 项检查）\n`)
process.exit(failures === 0 ? 0 : 1)
