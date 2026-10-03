/**
 * 打包共用的「收集运行时文件」。
 *
 * 现在有三个打包脚本收的是同一批文件：
 *   - scripts/package.mjs         → 可分发的 zip
 *   - scripts/pack-crx.mjs        → 可安装的 crx（载荷也是个 zip）
 *   - scripts/build-firefox.mjs   → Firefox 的 zip + 免解压目录
 * 它们唯一的差别是「哪些文件的字节要被替换」：
 *   - crx 要往 manifest 里注入 key（固定扩展 id）
 *   - Firefox 要把 manifest 换成 Gecko 那版
 * 所以这里只留一个带 overrides 的收集函数，别再各抄一份。
 */
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 扩展运行时真正会用到的顶层条目 */
export const INCLUDE = ['manifest.json', 'icons', 'licenses', 'schemas', 'src']
/** 即使在 INCLUDE 里也排除的东西 */
export const EXCLUDED_DIRS = new Set(['.cache', '.tmp', 'node_modules', 'dist'])

/**
 * @param {string} root 扩展根目录
 * @param {Record<string, Buffer>} [overrides] 相对路径 → 替换后的字节
 * @returns {Promise<{name: string, data: Buffer}[]>} 已按路径排序的条目
 */
export async function collectRuntimeFiles (root, overrides = {}) {
  const entries = []
  for (const item of INCLUDE) {
    const abs = path.join(root, item)
    if (!existsSync(abs)) {
      throw new Error(`缺少 ${item}，先运行 node scripts/fetch-assets.mjs`)
    }
    await collect(abs, item, entries, overrides)
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1))
}

async function collect (absPath, relPath, out, overrides) {
  const info = await stat(absPath)
  if (info.isDirectory()) {
    if (EXCLUDED_DIRS.has(path.basename(absPath))) return
    for (const entry of (await readdir(absPath)).sort()) {
      await collect(path.join(absPath, entry), `${relPath}/${entry}`, out, overrides)
    }
    return
  }
  const override = overrides[relPath]
  out.push({ name: relPath, data: override || await readFile(absPath) })
}

/** 把条目原样铺成一个免解压目录（浏览器里「加载已解压的扩展程序」直接选它） */
export async function writeUnpacked (dir, entries) {
  await mkdir(dir, { recursive: true })
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }
}

/** 体积格式化，几个打包脚本统一口径 */
export const mb = n => `${(n / 1048576).toFixed(2)} MB`
