/**
 * 生成扩展图标（32/48/128 的 PNG）。
 * 不依赖任何图形库：手写最小 PNG 编码器（zlib deflate + CRC32）。
 * 用法: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng (width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 画一个圆角方块 + 中间一个「中」字形色块（示意，不追求字形精确） */
function render (size) {
  const buf = Buffer.alloc(size * size * 4)
  const r = size * 0.22
  const put = (x, y, [cr, cg, cb, ca]) => {
    const i = (y * size + x) * 4
    const a = ca / 255
    buf[i] = Math.round(buf[i] * (1 - a) + cr * a)
    buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + cg * a)
    buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + cb * a)
    buf[i + 3] = Math.max(buf[i + 3], ca)
  }
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r)
    const cy = Math.min(Math.max(y, r), size - r)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= r * r
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue
      const t = (x + y) / (2 * size)
      put(x, y, [
        Math.round(28 + 40 * t),
        Math.round(60 + 60 * t),
        Math.round(120 + 80 * t),
        255
      ])
    }
  }
  // 「中」：一个方框 + 一竖
  const s = size / 16
  const stroke = Math.max(1, Math.round(size / 12))
  const box = { x0: Math.round(4 * s), x1: Math.round(12 * s), y0: Math.round(4.5 * s), y1: Math.round(11.5 * s) }
  const ink = [255, 255, 255, 255]
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const edgeX = x < box.x0 + stroke || x >= box.x1 - stroke
      const edgeY = y < box.y0 + stroke || y >= box.y1 - stroke
      const mid = Math.abs(x - (box.x0 + box.x1) / 2) < stroke / 2
      if (edgeX || edgeY || mid) put(x, y, ink)
    }
  }
  return encodePng(size, size, buf)
}

await mkdir(path.join(ROOT, 'icons'), { recursive: true })
for (const size of [16, 32, 48, 128]) {
  await writeFile(path.join(ROOT, 'icons', `icon${size}.png`), render(size))
  console.log(`icons/icon${size}.png`)
}
