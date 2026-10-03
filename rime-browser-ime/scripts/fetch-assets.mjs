/**
 * 拉取 RIME 引擎（预编译 wasm）与输入方案（预编译 schema 二进制）到本地。
 *
 * 这些资产来自 LibreService/my_rime 发布在 npm 上的产物：
 *   @libreservice/my-rime  -> dist/rime.js | rime.wasm | rime.data  (librime + api.cpp 的 emscripten 产物)
 *   @rime-contrib/<target> -> 预先由 rime_api_console 部署好的 *.table.bin / *.prism.bin / *.schema.yaml
 *
 * 因此我们不需要 emsdk / CMake / LLVM，也不需要重新部署方案，直接消费上游产物。
 *
 * 用法:
 *   node scripts/fetch-assets.mjs            # 拉取默认方案集
 *   node scripts/fetch-assets.mjs --all      # 拉取 schemas.json 中全部方案
 */
import { mkdir, writeFile, rm, readdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const NPM = 'https://registry.npmjs.org'

const ENGINE_PKG = { name: '@libreservice/my-rime', version: '0.10.9' }
const ENGINE_FILES = ['dist/rime.js', 'dist/rime.wasm', 'dist/rime.data', 'LICENSE']

// 方案 -> npm 包。target 由上游 schemas.json 决定。
const SCHEMA_PKGS = [
  { target: 'luna-pinyin', deps: [] },
  { target: 'stroke', deps: [] },
  { target: 'double-pinyin', deps: [] },
  { target: 'pinyin-simp', deps: [] },
  { target: 'wubi', deps: [] },
  { target: 'cangjie', deps: [] },
  { target: 'quick', deps: [] },
  { target: 'cantonese', deps: [] },
  { target: 'terra-pinyin', deps: [] },
  { target: 'bopomofo', deps: [] },
  { target: 'array', deps: [] },
]

/**
 * 默认内置的方案集。
 * 体积大头是各方案的词典二进制（table.bin），所以取舍看的是「覆盖多少种输入方式」：
 * 全拼 / 双拼族 / 简拼 / 形码 / 注音。想全都要就 `--all`。
 */
const DEFAULT_TARGETS = ['luna-pinyin', 'stroke', 'double-pinyin', 'pinyin-simp', 'wubi', 'terra-pinyin', 'bopomofo']

function tarballUrl (name, version) {
  const flat = name.startsWith('@') ? name.slice(1).replace('/', '/') : name
  const base = name.startsWith('@') ? name.split('/')[1] : name
  return `${NPM}/${name}/-/${base}-${version}.tgz`
}

async function latestVersion (name) {
  const res = await fetch(`${NPM}/${name.replace('/', '%2F')}`)
  if (!res.ok) throw new Error(`registry ${name}: HTTP ${res.status}`)
  const meta = await res.json()
  return meta['dist-tags'].latest
}

async function download (name, version) {
  const slug = (name.replace('@', '').replace('/', '__')) + '@' + version
  const dir = path.join(CACHE, slug)
  if (existsSync(path.join(dir, '.ok'))) return dir

  await mkdir(dir, { recursive: true })
  const url = tarballUrl(name, version)
  process.stdout.write(`  下载 ${url}\n`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`tarball ${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tgz = path.join(CACHE, slug + '.tgz')
  await writeFile(tgz, buf)
  // Windows 自带 bsdtar
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' })
  await writeFile(path.join(dir, '.ok'), '')
  return dir
}

async function copyEngine () {
  const { name, version } = ENGINE_PKG
  const dir = await download(name, version)
  const dest = path.join(ROOT, 'src', 'engine')
  await mkdir(dest, { recursive: true })
  for (const rel of ENGINE_FILES) {
    const from = path.join(dir, 'package', ...rel.split('/'))
    if (!existsSync(from)) throw new Error('缺少文件: ' + rel + ' in ' + name)
    const to = path.join(dest, path.basename(rel))
    await cp(from, to)
    process.stdout.write(`  -> src/engine/${path.basename(rel)}\n`)
  }
  // 上游 LICENSE 单独留档，满足 AGPL 的署名要求
  await cp(path.join(dir, 'package', 'LICENSE'), path.join(ROOT, 'licenses', 'my-rime-LICENSE.txt'))
}

async function copySchema (target) {
  const name = `@rime-contrib/${target}`
  const version = await latestVersion(name)
  const dir = await download(name, version)
  const srcDir = path.join(dir, 'package')
  const dest = path.join(ROOT, 'schemas', target)
  await mkdir(dest, { recursive: true })
  const files = []
  for (const entry of await readdir(srcDir)) {
    if (entry === 'package.json' || entry === '.ok') continue
    await cp(path.join(srcDir, entry), path.join(dest, entry))
    files.push(entry)
  }
  files.sort()
  process.stdout.write(`  -> schemas/${target}/ (${files.length} 个文件, ${name}@${version})\n`)
  return { target, package: name, version, files }
}

async function main () {
  const all = process.argv.includes('--all')
  const targets = all ? SCHEMA_PKGS.map(p => p.target) : DEFAULT_TARGETS

  await mkdir(CACHE, { recursive: true })
  await mkdir(path.join(ROOT, 'licenses'), { recursive: true })

  console.log('== 引擎 (librime wasm) ==')
  await copyEngine()

  console.log('== 输入方案 ==')
  const manifest = []
  for (const target of targets) {
    manifest.push(await copySchema(target))
  }
  await writeFile(
    path.join(ROOT, 'schemas', 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  )
  console.log('\n完成。若不再需要缓存可删除 .cache/')
}

main().catch(err => {
  console.error('失败:', err.message)
  process.exit(1)
})
