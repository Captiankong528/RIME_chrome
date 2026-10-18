/**
 * 包结构检查：不启动浏览器，只确认「装得上、认得出来」的静态条件。
 *
 *   node scripts/bundle-check.mjs
 *
 * 检查项：Host 半边能 import 并导出 apply；manifest / locale / 方案清单是合法 JSON；
 * Client 半边的关键标记（模块加载器入口、两个槽位、inputActions.insertText）都在。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..')

const host = await import('../index.js')
if (typeof host.apply !== 'function') throw new Error('index.js 没有导出 apply')

for (const file of ['package.json', 'locale/zh.json', 'locale/en.json', 'assets/schemas/manifest.json']) {
  JSON.parse(await readFile(join(plugin, file), 'utf8'))
  console.log(`json ok: ${file}`)
}

const manifest = JSON.parse(await readFile(join(plugin, 'assets/schemas/manifest.json'), 'utf8'))
console.log('manifest targets:', manifest.map(entry => entry.target).join(', '))

const client = await readFile(join(plugin, 'client.js'), 'utf8')
for (const marker of ['__ModuleLoader__', 'conversation.input.overlay', 'conversation.input.right', 'insertText', 'captureInsertion']) {
  if (!client.includes(marker)) throw new Error(`client.js 缺少 ${marker}`)
}
console.log('client.js markers ok, bytes:', client.length)
console.log('host apply ok')
