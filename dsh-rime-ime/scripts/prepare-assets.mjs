/**
 * 把 rime-browser-ime 里已经验证过的引擎产物搬进本插件（assets/）。
 *
 *   node scripts/prepare-assets.mjs
 *
 * 搬四类东西：
 *   1. librime 的 emscripten 产物：rime.js / rime.wasm / rime.data；
 *   2. 本插件的引擎 Worker（../worker.js）——Host 用同一条路由供给页面；
 *   3. 输入方案的预编译产物（.prism.bin / .table.bin / .reverse.bin / .yaml），只搬
 *      client.js 里 SCHEMAS 用得到的那几个 target；
 *   4. 过滤后的 schemas/manifest.json。
 *
 * 为什么只搬一部分方案：全量 15 个方案约 40 MB，其中 terra-pinyin / bopomofo 两套
 * 中文拉丁化方案体积最大、用的人最少。这里只留音码（朙月拼音、袖珍简拼）、双拼、
 * 形码（五笔、五笔画）共 12 个方案，约 27 MB。要加方案就改 TARGETS + client.js 的
 * SCHEMAS，两边必须一致。
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const sourceDir = join(pluginDir, '..', 'rime-browser-ime')
const outDir = join(pluginDir, 'assets')

/** 与 client.js 的 SCHEMAS[].targets 必须一致。 */
const TARGETS = ['luna-pinyin', 'double-pinyin', 'wubi', 'pinyin-simp', 'stroke']

async function main () {
  await assertSource()
  await rm(outDir, { recursive: true, force: true })
  await mkdir(join(outDir, 'engine'), { recursive: true })
  await mkdir(join(outDir, 'schemas'), { recursive: true })

  for (const name of ['rime.js', 'rime.wasm', 'rime.data']) {
    await cp(join(sourceDir, 'src', 'engine', name), join(outDir, 'engine', name))
  }
  await cp(join(pluginDir, 'worker.js'), join(outDir, 'engine', 'worker.js'))

  const manifest = JSON.parse(await readFile(join(sourceDir, 'schemas', 'manifest.json'), 'utf8'))
  const kept = []
  for (const target of TARGETS) {
    const entry = manifest.find(item => item.target === target)
    if (!entry) throw new Error(`上游 manifest 里没有 ${target}`)
    await cp(join(sourceDir, 'schemas', target), join(outDir, 'schemas', target), { recursive: true })
    kept.push(entry)
  }
  await writeFile(join(outDir, 'schemas', 'manifest.json'), JSON.stringify(kept, null, 2) + '\n', 'utf8')

  const total = await sizeOf(outDir)
  const engine = await sizeOf(join(outDir, 'engine'))
  console.log(`assets/ 就绪：${(total / 1024 / 1024).toFixed(1)} MB（引擎 ${(engine / 1024 / 1024).toFixed(1)} MB）`)
  console.log(`方案：${kept.map(entry => entry.target).join(', ')}`)
}

async function assertSource () {
  try {
    await stat(join(sourceDir, 'src', 'engine', 'rime.wasm'))
  } catch (error) {
    throw new Error(`找不到上游产物：${join(sourceDir, 'src', 'engine', 'rime.wasm')}（先跑 rime-browser-ime/scripts/fetch-assets.mjs）`)
  }
}

async function sizeOf (dir) {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(dir, { withFileTypes: true }))
  let total = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await sizeOf(full)
    else total += (await stat(full)).size
  }
  return total
}

main().catch((error) => {
  console.error(error.message || error)
  process.exitCode = 1
})
