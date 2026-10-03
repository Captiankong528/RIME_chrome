/**
 * 构建 Firefox 版扩展（与 Chrome 版同一套源码）。
 *
 * 两个浏览器的差别只有「清单」和「引擎宿主住哪」，源码一个字都不用改：
 *   - 清单：background.service_worker → background.scripts、去掉 offscreen 权限、
 *     补上 browser_specific_settings.gecko（见 scripts/lib/manifest.mjs）
 *   - 宿主：src/background/engine-bridge.js 探测到没有 chrome.offscreen 时，
 *     直接让引擎就地跑在背景页里，所以 offscreen 那一整套在 Firefox 下不会被调用
 *
 * 用法: node scripts/build-firefox.mjs
 * 产物:
 *   dist/firefox/                           免解压目录（about:debugging 选这里的 manifest.json）
 *   dist/rime-browser-ime-<版本>-firefox.zip 可直接给 web-ext sign / AMO 的文件
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { zip } from './lib/zip.mjs'
import { collectRuntimeFiles, writeUnpacked, mb } from './lib/files.mjs'
import { buildFirefoxManifest, serializeManifest, GECKO_ID, GECKO_MIN_VERSION } from './lib/manifest.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')

const chromeManifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'))
const firefoxManifest = buildFirefoxManifest(chromeManifest)

const entries = await collectRuntimeFiles(ROOT, {
  'manifest.json': Buffer.from(serializeManifest(firefoxManifest), 'utf8')
})
const payload = zip(entries)
const rawTotal = entries.reduce((sum, e) => sum + e.data.length, 0)

const base = `rime-browser-ime-${chromeManifest.version}-firefox`
const unpackedDir = path.join(DIST, base)
const zipFile = path.join(DIST, `${base}.zip`)

// 只清理自己的产物：Chrome 的 crx/zip 也在 dist 里，别顺手删掉
await rm(unpackedDir, { recursive: true, force: true })
await rm(zipFile, { force: true })
await mkdir(DIST, { recursive: true })

await writeUnpacked(unpackedDir, entries)
await writeFile(zipFile, payload)

console.log('\nFirefox 包构建完成：')
console.log(`  dist/${base}/        ${mb(rawTotal)}   ← 免解压，about:debugging 直接选它`)
console.log(`  dist/${base}.zip     ${mb(payload.length)}   ← 给 web-ext sign / AMO 上传`)
console.log(`\n  扩展 id        = ${GECKO_ID}`)
console.log(`  最低 Firefox   = ${GECKO_MIN_VERSION}`)
console.log(`  文件数         = ${entries.length}`)
console.log(`  清单差异       = service_worker→scripts、去掉 offscreen 权限、+browser_specific_settings`)
console.log('\n加载方式（三种，详见 rime-browser-ime/README.md 的「Firefox」一节）：')
console.log('  A 临时加载（开发用，重启浏览器失效）:')
console.log('     about:debugging#/runtime/this-firefox → 「临时载入附加组件」→ 选上面的 manifest.json')
console.log('  B 装未签名的 zip（需要 Nightly / Developer Edition / ESR）:')
console.log('     about:config 把 xpinstall.signatures.required 设为 false，再拖入 zip')
console.log('  C 正式安装（Release 版必须签名）:')
console.log('     npx web-ext sign --api-key <AMO key> --api-secret <AMO secret> --source-dir dist/' + base)
