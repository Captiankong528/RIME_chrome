/**
 * 打包成**可安装**的 Chrome 扩展：产出 CRX3（签名）与可直接加载的解压目录。
 *
 * 为什么需要这个：`package.mjs` 产出的 zip 解开后还要手动开开发者模式才能装。
 * CRX3 是 Chrome 的原生扩展包格式，签名过、带固定的扩展 id，能直接被浏览器安装。
 *
 * 这里没有用 Chrome 自带的 `--pack-extension`：那个开关在受限沙箱里起不来
 * （crashpad `OpenProcess: 拒绝访问`），而且这个项目本来就没有任何外部依赖，
 * 所以 CRX3 的封装与签名都在 Node 里手写（格式见 Chromium 的 crx3.proto）。
 *
 * CRX3 结构：
 *   "Cr24" | u32 版本(=3) | u32 头长度 | CrxFileHeader(protobuf) | ZIP 载荷
 * 其中 CrxFileHeader 含：
 *   field 2     asn1_public_key      —— DER 编码的 SubjectPublicKeyInfo
 *   field 10000 signed_header_data   —— protobuf{ crx_id(1), sha256_with_rsa(2) }
 *   field 10001 sha256_with_rsa      —— RSA-SHA256 签名
 * 签名覆盖： "CRX3 SignedData\0" + signed_header_data + 整段 ZIP 载荷
 *
 * **扩展 id 由签名公钥决定**（= SHA256(SPKI) 前 16 字节，逐半字节映射到 a–p），
 * 所以私钥必须留下来复用，否则每次打包都会变成另一个扩展、覆盖安装时更新不上。
 * 私钥默认放在扩展根目录的 rime-browser-ime.pem，已被 .gitignore 覆盖，不要提交。
 *
 * 用法:
 *   node scripts/pack-crx.mjs
 *   node scripts/pack-crx.mjs --key path/to/key.pem
 */
import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { zip } from './lib/zip.mjs'
import { collectRuntimeFiles, writeUnpacked, mb } from './lib/files.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')

/** kSignatureContext（components/crx_file/crx_file.h）：注意结尾有一个 0 字节 */
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1')

/* ------------------------------------------------------------------ *
 * protobuf 最小编码器
 * ------------------------------------------------------------------ */

const varint = n => {
  const out = []
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
  out.push(n)
  return Buffer.from(out)
}
const tag = (field, wire) => varint((field << 3) | wire)
/** length-delimited（bytes） */
const bytesField = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf])

/* ------------------------------------------------------------------ *
 * 扩展 id：SHA256(SPKI) 取前 16 字节，每个半字节映射到 a–p
 * ------------------------------------------------------------------ */

function extensionIdFromHash (hash) {
  let id = ''
  for (const byte of hash.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

/* ------------------------------------------------------------------ *
 * CRX3 组装
 * ------------------------------------------------------------------ */

function buildCrx3 (payload, privateKey, spkiDer, crxId) {
  // SignedData { crx_id = 1 } —— 恰好 16 字节，**没有算法字段**
  const signedHeaderData = bytesField(1, crxId)

  // 签名覆盖 [context][signed-header-size][signed-header][archive]。
  // 那个 4 字节小端长度前缀极易漏掉——漏了 Chrome 就报 CRX_HEADER_INVALID。
  const sizeOctets = Buffer.alloc(4)
  sizeOctets.writeUInt32LE(signedHeaderData.length, 0)

  const signer = crypto.createSign('sha256') // RSA_PKCS1_SHA256
  signer.update(SIGNATURE_CONTEXT)
  signer.update(sizeOctets)
  signer.update(signedHeaderData)
  signer.update(payload)
  const signature = signer.sign(privateKey)

  // AsymmetricKeyProof { public_key = 1, signature = 2 } —— 公钥和签名在这个子消息里，
  // 不是 CrxFileHeader 的顶层字段
  const proof = Buffer.concat([
    bytesField(1, spkiDer),
    bytesField(2, signature)
  ])

  const header = Buffer.concat([
    bytesField(2, proof), // sha256_with_rsa
    bytesField(10000, signedHeaderData) // signed_header_data
  ])

  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'ascii')
  prefix.writeUInt32LE(3, 4) // 版本
  prefix.writeUInt32LE(header.length, 8) // 头长度

  return Buffer.concat([prefix, header, payload])
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const keyArgIndex = process.argv.indexOf('--key')
const keyPath = keyArgIndex !== -1 && process.argv[keyArgIndex + 1]
  ? path.resolve(process.argv[keyArgIndex + 1])
  : path.join(ROOT, 'rime-browser-ime.pem')

const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'))

/* 1) 私钥：有就复用，没有就生成（复用它扩展 id 才稳定） */
let privateKey
let keyCreated = false
if (existsSync(keyPath)) {
  privateKey = crypto.createPrivateKey(await readFile(keyPath))
  console.log(`复用签名私钥: ${path.relative(ROOT, keyPath)}`)
} else {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKey = pair.privateKey
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  try { await chmod(keyPath, 0o600) } catch { /* Windows 上无意义，忽略 */ }
  keyCreated = true
  console.log(`新建签名私钥: ${path.relative(ROOT, keyPath)}（已 gitignore，别提交/外传）`)
}

/* 2) 从私钥导出公钥 —— 保证「签名的钥」和「算 id 的钥」是同一把 */
const publicKey = crypto.createPublicKey(privateKey)
const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
const keyHash = crypto.createHash('sha256').update(spkiDer).digest()
const crxId = keyHash.subarray(0, 16)
const extensionId = extensionIdFromHash(keyHash)

/* 3) 收集文件并打成 ZIP 载荷
 *
 * 打包时往 manifest 里注入 "key"（DER SPKI 的 base64）：
 * 这样「加载已解压的扩展程序」也会得到**和 crx 完全相同**的扩展 id。
 * 不注入的话，Chrome 对未打包扩展是按目录路径算 id 的，两者会对不上。
 * 源目录的 manifest.json 保持干净，只改打包产物里的那一份。 */
const manifestWithKey = Buffer.from(JSON.stringify({
  ...manifest,
  key: spkiDer.toString('base64')
}, null, 2) + '\n', 'utf8')

const entries = await collectRuntimeFiles(ROOT, { 'manifest.json': manifestWithKey })

const rawTotal = entries.reduce((sum, e) => sum + e.data.length, 0)
const payload = zip(entries)

/* 4) 组装，并在落盘前按 Chromium 的算法独立复算一遍 */
const crx = buildCrx3(payload, privateKey, spkiDer, crxId)

{
  const headerLen = crx.readUInt32LE(8)
  const header = crx.subarray(12, 12 + headerLen)
  const proof = readBytesField(header, 2) // AsymmetricKeyProof
  const signedHeaderData = readBytesField(header, 10000)
  const embeddedKey = readBytesField(proof, 1)
  const signature = readBytesField(proof, 2)

  if (!embeddedKey.equals(spkiDer)) {
    console.error('自校验失败：头里的公钥与私钥导出的公钥不一致')
    process.exit(1)
  }
  if (!readBytesField(signedHeaderData, 1).equals(crxId)) {
    console.error('自校验失败：signed_header_data 里的 crx_id 不正确')
    process.exit(1)
  }

  const sizeOctets = Buffer.alloc(4)
  sizeOctets.writeUInt32LE(signedHeaderData.length, 0)
  const verify = crypto.createVerify('sha256')
  verify.update(SIGNATURE_CONTEXT)
  verify.update(sizeOctets)
  verify.update(signedHeaderData)
  verify.update(payload)
  if (!verify.verify(publicKey, signature)) {
    console.error('自校验失败：CRX 签名无法验证，已放弃写盘')
    process.exit(1)
  }
}

/* 5) 落盘：crx + zip + 解压目录（解压目录给「加载已解压的扩展程序」用）
 *
 * 只清自己的解压目录，不再整个删掉 dist：Firefox 包也住在 dist 里，
 * 打一次 Chrome 包就把人家删了很讨嫌。crx/zip 用 writeFile 覆盖即可。 */
await mkdir(DIST, { recursive: true })

const base = `rime-browser-ime-${manifest.version}`
const crxFile = path.join(DIST, `${base}.crx`)
const zipFile = path.join(DIST, `${base}.zip`)
const unpackedDir = path.join(DIST, `${base}-unpacked`)

await rm(unpackedDir, { recursive: true, force: true })
await writeFile(crxFile, crx)
await writeFile(zipFile, payload)
await writeUnpacked(unpackedDir, entries)

console.log('\n打包完成：')
console.log(`  dist/${base}.crx            ${mb(crx.length)}   ← 可安装`)
console.log(`  dist/${base}.zip            ${mb(payload.length)}   ← 解压后可「加载已解压的扩展程序」`)
console.log(`  dist/${base}-unpacked/      ${mb(rawTotal)}   ← 免解压，直接选这个目录`)
console.log(`\n  扩展 id     = ${extensionId}`)
console.log(`  文件数      = ${entries.length}`)
console.log(`  原始 ${mb(rawTotal)} -> 压缩后 ${mb(payload.length)}`)
if (keyCreated) console.log('\n⚠ 首次生成了签名私钥，请备份 rime-browser-ime.pem：换掉它 = 换一个扩展 id。')
console.log('\n装之前可以跑 node scripts/verify-crx.mjs 独立核对结构与签名。')
console.log('安装方式见 rime-browser-ime/README.md 的「安装」一节。')

/** 从 protobuf 里取一个 length-delimited 字段（只够本脚本用） */
function readBytesField (buf, wanted) {
  let i = 0
  const readVarint = () => {
    let r = 0
    let shift = 0
    for (;;) {
      const b = buf[i++]
      r |= (b & 0x7f) << shift
      if (!(b & 0x80)) break
      shift += 7
    }
    return r >>> 0
  }
  while (i < buf.length) {
    const key = readVarint()
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const len = readVarint()
      const value = buf.subarray(i, i + len)
      i += len
      if (field === wanted) return Buffer.from(value)
    } else if (wire === 0) {
      readVarint()
    } else {
      throw new Error('CRX 头里有不认识的 protobuf wire type: ' + wire)
    }
  }
  throw new Error(`CRX 头里找不到字段 ${wanted}`)
}
