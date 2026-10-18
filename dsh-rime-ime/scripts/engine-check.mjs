/**
 * 引擎链路自检（Node，不需要浏览器）：
 *
 *   node scripts/engine-check.mjs
 *
 * 它在 Node 里搭一个「像 Worker」的全局环境，把 src 里的 worker.js **原样**跑起来，
 * 并且走的是插件版新增的 boot 路径：wasm 与 rime.data 都由调用方以字节喂进来
 * （wasmBinary / getPreloadedPackage），worker 自己不发任何网络请求。
 *
 * 验证三件事：
 *   1. boot + init 能在「无网络、无 indexedDB」的环境里把 librime 跑起来；
 *   2. 用 assets/ 里分发的方案文件装载朙月拼音，nihao + 空格 上屏「你好」；
 *   3. 第二个方案（86五笔）也能装载并出候选。
 *
 * 浏览器里真正的 Host 路由与按键链路不在这个脚本的覆盖范围里——那部分靠
 * /rime-ime/diagnostics 里的页面自检结果确认。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const HERE = path.resolve(import.meta.dirname, '..')
const ENGINE = path.join(HERE, 'assets', 'engine')
const SCHEMAS = path.join(HERE, 'assets', 'schemas')

let failures = 0
function check (label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`)
  }
}

/* ---------------- 1. 「像 Worker」的全局环境 ---------------- */

process.chdir(ENGINE)
globalThis.self = globalThis
globalThis.require = createRequire(import.meta.url)
globalThis.__dirname = ENGINE

const pending = new Map()
const events = []
let seq = 0

globalThis.postMessage = message => {
  if (!message || message.channel !== 'rime-engine') return
  if (message.event) {
    events.push(message)
    return
  }
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.ok) waiter.resolve(message.result)
  else waiter.reject(new Error(message.error))
}

/** 模拟 importScripts：boot 传进来的 URL 在 Node 里就是 assets/engine/rime.js */
globalThis.importScripts = () => {
  const file = path.join(ENGINE, 'rime.js')
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
}

function send (message) {
  globalThis.onmessage({ data: message })
}

function rpc (op, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    send({ channel: 'rime-engine', id, op, payload })
  })
}

function arrayBufferOf (file) {
  const buffer = readFileSync(file)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

/* ---------------- 2. 跑 worker + boot ---------------- */

async function main () {
  const workerFile = path.join(ENGINE, 'worker.js')
  vm.runInThisContext(readFileSync(workerFile, 'utf8'), { filename: workerFile })

  console.log('\n== boot（wasm 与 rime.data 由调用方喂入）==')
  const t0 = Date.now()
  send({
    channel: 'rime-engine',
    op: 'boot',
    payload: {
      rimeJsUrl: 'rime.js',
      wasm: arrayBufferOf(path.join(ENGINE, 'rime.wasm')),
      data: arrayBufferOf(path.join(ENGINE, 'rime.data')),
      baseUrl: `file:///${ENGINE.replaceAll('\\', '/')}/`
    }
  })
  check('boot 之后注入了 MEMFS（rime.js 已求值）', typeof globalThis.MEMFS === 'object')

  // Node 没有 indexedDB：IDBFS 退化成内存文件系统，syncfs 直接回调
  globalThis.IDBFS = {
    ...globalThis.MEMFS,
    mount: (mount) => globalThis.MEMFS.mount(mount),
    syncfs: (mount, populate, callback) => callback(null)
  }

  const status = await rpc('init', { schemaNames: { luna_pinyin: '朙月拼音' }, pageSize: 5 })
  check(`init 完成（${Date.now() - t0} ms）`, status.state === 'ready', status)

  /* ---------------- 3. 装载朙月拼音并打 nihao ---------------- */

  const manifest = JSON.parse(readFileSync(path.join(SCHEMAS, 'manifest.json'), 'utf8'))
  const filesFor = (targets) => {
    const files = []
    for (const target of targets) {
      const entry = manifest.find(item => item.target === target)
      if (!entry) throw new Error(`manifest 里没有 ${target}`)
      for (const name of entry.files) {
        files.push({ name, data: arrayBufferOf(path.join(SCHEMAS, target, name)) })
      }
    }
    return files
  }

  console.log('\n== 朙月拼音 ==')
  const loaded = await rpc('loadSchema', {
    id: 'luna_pinyin',
    files: filesFor(['luna-pinyin', 'stroke']),
    options: { simplification: true }
  })
  check(`写入 ${loaded.written.length} 个预编译文件`, loaded.schemaId === 'luna_pinyin', loaded)

  let last = null
  for (const ch of 'nihao') last = await rpc('process', { input: ch })
  const preedit = (last.head || '') + (last.body || '') + (last.tail || '')
  check('nihao 进入组字（ACCEPTED）', last.state === 1, last.state)
  check('编码串为 ni hao', preedit === 'ni hao', preedit)
  check('首候选是「你好」', (last.candidates || [])[0]?.text === '你好', (last.candidates || []).map(c => c.text))

  const committed = await rpc('process', { input: '{space}' })
  check('空格上屏「你好」', committed.state === 0 && committed.committed === '你好', committed)
  await rpc('process', { input: '{Escape}' })

  /* ---------------- 4. 第二个方案 ---------------- */

  console.log('\n== 86五笔 ==')
  const wubi = await rpc('loadSchema', {
    id: 'wubi86',
    files: filesFor(['wubi', 'pinyin-simp', 'stroke']),
    options: null
  })
  check('装载 86五笔', wubi.schemaId === 'wubi86', wubi)
  let wubiLast = null
  for (const ch of 'aaaa') wubiLast = await rpc('process', { input: ch })
  check('aaaa 有候选', wubiLast.state === 1 && (wubiLast.candidates || []).length > 0, wubiLast.candidates)
  await rpc('process', { input: '{Escape}' })

  /* ---------------- 5. 状态 ---------------- */

  const final = await rpc('status', {})
  check('status 报告当前方案', final.schemaId === 'wubi86', final)
  check('引擎发出过 ready 事件', events.some(event => event.state === 'ready'), events)
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? '✅ 引擎链路全部通过' : `❌ ${failures} 项失败`}\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error('\n❌ 自检崩溃:', error.message)
    console.error(error.stack)
    process.exit(1)
  })
