/**
 * 打包：把扩展真正需要的文件收成一个 zip，产出 dist/rime-browser-ime-<version>.zip。
 *
 * 这个项目没有编译步骤，所以「构建」= 挑选运行时需要的文件 + 打成一个可分发的包。
 * ZIP 容器用 scripts/lib/zip.mjs、文件收集用 scripts/lib/files.mjs（两者都与
 * pack-crx.mjs / build-firefox.mjs 共用），所以 Windows / macOS / Linux 产出一致，
 * 不依赖系统的 Compress-Archive。
 *
 * 需要**可安装**的产物（签名 crx）请用 node scripts/pack-crx.mjs；
 * 需要 Firefox 版请用 node scripts/build-firefox.mjs。
 *
 * 用法: node scripts/package.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { zip } from './lib/zip.mjs'
import { collectRuntimeFiles, mb } from './lib/files.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')

const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'))
const entries = await collectRuntimeFiles(ROOT)

const rawTotal = entries.reduce((sum, e) => sum + e.data.length, 0)
const archive = zip(entries)
const outFile = path.join(DIST, `rime-browser-ime-${manifest.version}.zip`)

// 只写自己的产物，别把 dist 里 Chrome crx / Firefox 包一起清掉
await mkdir(DIST, { recursive: true })
await writeFile(outFile, archive)

console.log(`打包完成: dist/${path.basename(outFile)}`)
console.log(`  ${entries.length} 个文件`)
console.log(`  原始 ${mb(rawTotal)} -> 压缩后 ${mb(archive.length)}`)
console.log('\n加载方式：解压后在 chrome://extensions 里「加载已解压的扩展程序」选择解压目录。')
