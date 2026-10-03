/**
 * 引擎冒烟测试：在 Node 里把 librime 的加载与输入链路完整跑一遍。
 *
 * rime.js 是 emscripten 产物，保留了 Node 环境分支，所以可以：
 *   1. 用 vm.runInThisContext 提供 self / importScripts / postMessage 三个全局，
 *      让 src/engine/worker.js **原样**跑起来（和浏览器里同一条代码路径）
 *   2. 把 IDBFS 换成内存版（Node 没有 indexedDB，但 IDBFS.mount 本身就是 MEMFS.mount）
 *   3. 走一遍 init -> loadSchema -> process，断言 nihao + 空格 -> 你好
 *
 * 这样不用启动浏览器就能验证最高风险的那一段：
 * 「预编译方案写进 /usr/share/rime-data/build -> set_ime -> process」到底通不通。
 *
 * 用法: node scripts/engine-smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(import.meta.dirname, '..')
const ENGINE = path.join(ROOT, 'src', 'engine')

/* ------------------------------------------------------------------ *
 * 1. 搭一个「像 Worker」的全局环境
 * ------------------------------------------------------------------ */

process.chdir(ENGINE) // rime.data 在 Node 分支里是按 cwd 相对路径读的

globalThis.self = globalThis
globalThis.require = createRequire(import.meta.url)
globalThis.__dirname = ENGINE // rime.js 在 Node 分支用 __dirname 拼 wasm 路径

const pending = new Map()
let seq = 0
const events = []

globalThis.postMessage = msg => {
  if (!msg || msg.channel !== 'rime-engine') return
  if (msg.event) {
    events.push(msg)
    return
  }
  const waiter = pending.get(msg.id)
  if (!waiter) return
  pending.delete(msg.id)
  if (msg.ok) waiter.resolve(msg.result)
  else waiter.reject(new Error(msg.error))
}

globalThis.importScripts = rel => {
  const file = path.join(ENGINE, rel)
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
}

/* ------------------------------------------------------------------ *
 * 2. 加载我们的 worker（与浏览器里同一份代码）
 * ------------------------------------------------------------------ */

const workerFile = path.join(ENGINE, 'worker.js')
vm.runInThisContext(readFileSync(workerFile, 'utf8'), { filename: workerFile })

if (typeof globalThis.MEMFS !== 'object') {
  console.error('✗ rime.js 没有注入 MEMFS，产物可能不是预期的构建')
  process.exit(1)
}

// Node 没有 indexedDB；IDBFS.mount 在没有 autoPersist 时就是 MEMFS.mount，
// syncfs 换成直接回调，等于「内存版用户目录」——只少了跨会话持久化
globalThis.IDBFS = {
  ...globalThis.MEMFS,
  mount: mount => globalThis.MEMFS.mount(mount),
  syncfs: (mount, populate, callback) => callback(null)
}

// 简繁默认值表在 const.js 里（offscreen / 设置页用的是同一份），这里也读它，
// 免得测试自己另写一套「zh-TW 该出繁体」的判断
await import(new URL('../src/common/const.js', import.meta.url).href)

function rpc (op, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    globalThis.onmessage({ data: { channel: 'rime-engine', id, op, payload } })
  })
}

/* ------------------------------------------------------------------ *
 * 3. 跑流程
 * ------------------------------------------------------------------ */

let failures = 0
function check (label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

const waitFor = (label, fn, timeout = 120000) => {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn()
        if (value) return resolve(value)
      } catch (e) { /* 继续等 */ }
      if (Date.now() > deadline) return reject(new Error(`等待「${label}」超时`))
      setTimeout(tick, 200)
    }
    tick()
  })
}

async function main () {
  console.log('\n== 启动 ==')
  const t0 = Date.now()
  const status = await rpc('init', {
    schemaNames: { luna_pinyin: '朙月拼音' },
    pageSize: 5
  })
  const bootMs = Date.now() - t0
  check(`引擎初始化完成（wasm 编译 + rime.data 装载，${bootMs} ms）`, status.state === 'ready')

  console.log('\n== 装载方案 ==')
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'schemas', 'manifest.json'), 'utf8'))
  const files = []
  for (const target of ['luna-pinyin', 'stroke']) {
    const entry = manifest.find(m => m.target === target)
    if (!entry) throw new Error(`manifest 里没有 ${target}`)
    for (const name of entry.files) {
      const buf = readFileSync(path.join(ROOT, 'schemas', target, name))
      files.push({ name, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
    }
  }
  const loaded = await rpc('loadSchema', { id: 'luna_pinyin', files })
  check(`写入 ${loaded.written.length} 个预编译文件并 set_ime('luna_pinyin')`, loaded.schemaId === 'luna_pinyin',
    JSON.stringify(loaded.written))

  console.log('\n== 输入 nihao ==')
  let last = null
  for (const ch of 'nihao') {
    last = await rpc('process', { input: ch })
    const cands = (last.candidates || []).map(c => c.text).join(' ')
    console.log(`  "${ch}" -> state=${last.state} 编码=${last.head || ''}[${last.body || ''}]${last.tail || ''} 候选: ${cands}`)
  }
  check('组字状态为 ACCEPTED(1)', last.state === 1, `实际 ${last.state}`)
  // 朙月拼音的 preedit 会按音节插空格，所以是 "ni hao" 而不是 "nihao"
  const preedit = (last.head || '') + (last.body || '') + (last.tail || '')
  check('编码串为 ni hao（音节间带空格）', preedit === 'ni hao', JSON.stringify(preedit))
  check('首个候选是「你好」', (last.candidates || [])[0]?.text === '你好',
    (last.candidates || []).map(c => c.text).join(' / '))

  console.log('\n== 空格上屏 ==')
  const committed = await rpc('process', { input: ' ' })
  console.log(`  state=${committed.state} committed=${JSON.stringify(committed.committed)}`)
  check('state 为 COMMITTED(0)', committed.state === 0, `实际 ${committed.state}`)
  check('上屏内容为「你好」', committed.committed === '你好', JSON.stringify(committed.committed))

  console.log('\n== 数字选词 ==')
  for (const ch of 'nihao') await rpc('process', { input: ch })
  // 选中整个句子的候选（index 0 = 你好），应当直接上屏
  const picked = await rpc('selectCandidate', { index: 0 })
  console.log(`  selectCandidate(0) -> state=${picked.state} committed=${JSON.stringify(picked.committed)}`)
  check('selectCandidate(0) 上屏「你好」', picked.committed === '你好', JSON.stringify(picked))

  // 选非首个候选，确认索引确实按候选顺序走
  for (const ch of 'nihao') await rpc('process', { input: ch })
  const third = await rpc('selectCandidate', { index: 2 })
  console.log(`  selectCandidate(2) -> state=${third.state} committed=${JSON.stringify(third.committed)}`)
  check('selectCandidate(2) 上屏「妳好」', third.committed === '妳好', JSON.stringify(third.committed))

  console.log('\n== 翻页 ==')
  // 必须在组字状态里翻页；组字结束后 changePage 返回 UNHANDLED 是正常的
  const first = await rpc('process', { input: 'a' })
  const paged = await rpc('changePage', { backward: false })
  console.log(`  第 ${first.page} 页 -> 第 ${paged.page} 页（state=${paged.state}）`)
  check('changePage(false) 翻到第 2 页', paged.page === 1 && paged.state === 1, JSON.stringify(paged))
  const back = await rpc('changePage', { backward: true })
  check('changePage(true) 翻回第 1 页', back.page === 0 && back.state === 1, JSON.stringify(back))

  // 收尾：清掉组字，免得影响后面的断言
  await rpc('process', { input: '{Escape}' })

  console.log('\n== 运行中的简繁开关 ==')
  const option = await rpc('setOption', { option: 'simplification', value: true })
  check('setOption 返回被设置的选项', option.option === 'simplification' && option.value === true, option)
  const afterOption = await rpc('process', { input: 'n' })
  check('切到简体后引擎仍可用', afterOption.state === 1 && (afterOption.candidates || []).length > 0,
    JSON.stringify({ state: afterOption.state }))
  await rpc('process', { input: '{Escape}' })

  // 用户按 Ctrl+Shift+4：方案 yaml 的 key_binder 把这一组合绑到 toggle simplification
  await rpc('setOption', { option: 'simplification', value: false })
  const toggled = await rpc('process', { input: '{Control+Shift+4}' })
  check('Ctrl+Shift+4 触发 simplification 开关',
    Array.isArray(toggled.updatedOptions) && toggled.updatedOptions.includes('simplification'),
    JSON.stringify(toggled.updatedOptions))
  let hanzi = null
  for (const ch of 'hanzi') hanzi = await rpc('process', { input: ch })
  check('Ctrl+Shift+4 之后 hanzi 首候选是「汉字」', (hanzi.candidates || [])[0]?.text === '汉字',
    (hanzi.candidates || []).map(c => c.text).slice(0, 3).join(' / '))
  await rpc('process', { input: '{Escape}' })

  console.log('\n== 简繁默认值（跟随浏览器语言）==')
  const { prefersTraditional, tradSimpDefault } = globalThis.RIME_CONST
  const variantCN = tradSimpDefault('luna_pinyin', 'zh-CN')
  const variantTW = tradSimpDefault('luna_pinyin', 'zh-TW')
  check('zh-CN / zh-TW 选出相反的 variant',
    variantCN.options.simplification === true && variantTW.options.simplification === false,
    JSON.stringify({ zhCN: variantCN.options, zhTW: variantTW.options }))
  check('袖珍简拼没有简繁开关（词库本身就是简体）', tradSimpDefault('pinyin_simp', 'zh-CN') === null)
  check('简体地区判定', !prefersTraditional('en-US') && !prefersTraditional('zh-CN') && prefersTraditional('zh-TW'))

  // 照 offscreen 的做法把默认值随方案一起下发：zh-CN 应当得到简体
  const loadedCN = await rpc('loadSchema', { id: 'luna_pinyin', files, options: variantCN.options })
  check('loadSchema 回报实际下发的开关', loadedCN.options && loadedCN.options.simplification === true,
    JSON.stringify(loadedCN.options))
  hanzi = null
  for (const ch of 'hanzi') hanzi = await rpc('process', { input: ch })
  check('zh-CN：hanzi 首候选是「汉字」', (hanzi.candidates || [])[0]?.text === '汉字',
    (hanzi.candidates || []).map(c => c.text).slice(0, 3).join(' / '))
  await rpc('process', { input: '{Escape}' })

  await rpc('loadSchema', { id: 'luna_pinyin', files: [], options: variantTW.options })
  hanzi = null
  for (const ch of 'hanzi') hanzi = await rpc('process', { input: ch })
  check('zh-TW：hanzi 首候选是「漢字」', (hanzi.candidates || [])[0]?.text === '漢字',
    (hanzi.candidates || []).map(c => c.text).slice(0, 3).join(' / '))
  await rpc('process', { input: '{Escape}' })

  // 不下发开关时回到方案 yaml 的原生默认（繁体）：证明「简体是我们下发的」，不是引擎自己变了
  await rpc('loadSchema', { id: 'luna_pinyin', files: [] })
  hanzi = null
  for (const ch of 'hanzi') hanzi = await rpc('process', { input: ch })
  check('不下发开关时回到方案原生默认（繁体）', (hanzi.candidates || [])[0]?.text === '漢字',
    (hanzi.candidates || []).map(c => c.text).slice(0, 3).join(' / '))
  await rpc('process', { input: '{Escape}' })

  console.log('\n== 清空用户词频 ==')
  // reset 里有一段手写的递归 FS 遍历，很容易写错，单独测一遍恢复路径
  const resetResult = await rpc('reset', {})
  check('reset 返回成功', resetResult.reset === true, resetResult)
  // worker 的 reset 只负责清用户目录 + 重新 init；重新选方案是 offscreen 层的职责
  const reloaded = await rpc('loadSchema', { id: 'luna_pinyin', files })
  check('reset 之后重新装载方案', reloaded.schemaId === 'luna_pinyin', reloaded)
  const afterReset = await rpc('process', { input: 'n' })
  check('reset 之后引擎仍然可用', afterReset.state === 1 && (afterReset.candidates || []).length > 0,
    JSON.stringify({ state: afterReset.state, candidates: (afterReset.candidates || []).length }))
  await rpc('process', { input: '{Escape}' })

  console.log('\n== 状态 ==')
  const final = await rpc('status', {})
  check(`status 报告已选中 ${final.schemaId}`, final.schemaId === 'luna_pinyin')
  check('引擎发出过 ready 事件', events.some(e => e.state === 'ready'),
    JSON.stringify(events))
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? '✅ 引擎链路全部通过' : `❌ ${failures} 项失败`}\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(error => {
    console.error('\n❌ 冒烟测试崩溃:', error.message)
    console.error(error.stack)
    process.exit(1)
  })
