/**
 * 独立校验打包出来的 CRX3：从零解析容器头、验证签名、核对扩展 id 与文件数。
 *
 * 刻意**不复用** pack-crx.mjs 里的任何函数——两边共用同一段代码的话，
 * 同一个格式误解会在「生成」和「校验」里同时成立，校验就变成自我确认了。
 * （第一版就是这么翻车的：生成和校验都漏了 signed-header-size，双双"通过"，
 *   结果 Chrome 报 CRX_HEADER_INVALID。）
 *
 * 这里的字段结构照 Chromium 的 components/crx_file/crx3.proto 与 crx_verifier.cc 写。
 *
 * 用法:
 *   node scripts/verify-crx.mjs
 *   node scripts/verify-crx.mjs dist/my-extension.crx
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const arg = process.argv[2]
const crxPath = arg
  ? path.resolve(process.cwd(), arg)
  : path.join(ROOT, 'dist', `rime-browser-ime-${JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version}.crx`)

/** kSignatureContext：注意结尾有一个 0 字节（crx_file.h） */
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1')

const buf = readFileSync(crxPath)
console.log(`校验 ${path.relative(ROOT, crxPath) || crxPath}\n`)

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

console.log('== CRX3 容器 ==')
check('magic = "Cr24"', buf.subarray(0, 4).toString('latin1') === 'Cr24', buf.subarray(0, 4).toString('latin1'))
const version = buf.readUInt32LE(4)
check('版本 = 3', version === 3, String(version))
const headerLen = buf.readUInt32LE(8)
const header = buf.subarray(12, 12 + headerLen)
const payload = buf.subarray(12 + headerLen)
check('头长度合理', headerLen > 0 && 12 + headerLen < buf.length, `${headerLen} 字节`)
check('载荷是 ZIP (PK\\x03\\x04)', payload.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  payload.subarray(0, 4).toString('hex'))

// Chromium 会拒绝「头里出现 ZIP 中央目录记录」的 crx：解压时会被误当成 zip 结构。
// 公钥/签名是随机字节，极小概率会撞上，所以每次打包都要检查。
const find = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
for (const [name, token] of [
  ['EOCD (PK\\x05\\x06)', Buffer.from([0x50, 0x4b, 0x05, 0x06])],
  ['EOCD64 (PK\\x06\\x06)', Buffer.from([0x50, 0x4b, 0x06, 0x06])],
  ['EOCD64 record (PK\\x06\\x07)', Buffer.from([0x50, 0x4b, 0x06, 0x07])]
]) {
  check(`头里不含 ${name}`, find(header, token) === -1)
}

/** 极简 protobuf 读取：field -> Buffer（wire 2）或 number（wire 0） */
function readFields (b, consumedOut) {
  const out = new Map()
  let i = 0
  const rv = () => {
    let r = 0
    let s = 0
    for (;;) {
      const x = b[i++]
      r |= (x & 0x7f) << s
      if (!(x & 0x80)) break
      s += 7
    }
    return r >>> 0
  }
  while (i < b.length) {
    const key = rv()
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const len = rv()
      out.set(field, Buffer.from(b.subarray(i, i + len)))
      i += len
    } else if (wire === 0) {
      out.set(field, rv())
    } else {
      throw new Error('CRX 头里有不认识的 protobuf wire type: ' + wire)
    }
  }
  if (consumedOut) consumedOut[0] = i
  return out
}

const consumed = [0]
const hf = readFields(header, consumed)
// 关键：sha256_with_rsa 是 repeated AsymmetricKeyProof（field 2），公钥不在顶层
const proof = hf.get(2)
const signedHeaderData = hf.get(10000)
check('field 2     = AsymmetricKeyProof', Buffer.isBuffer(proof), `${proof && proof.length} 字节`)
check('field 10000 = signed_header_data', Buffer.isBuffer(signedHeaderData), `${signedHeaderData && signedHeaderData.length} 字节`)
check('没有凭空多出来的 field 10001', !hf.has(10001), hf.has(10001) ? '存在（不合法）' : '不存在')

if (!Buffer.isBuffer(proof) || !Buffer.isBuffer(signedHeaderData)) {
  console.log(`\n❌ 头结构不对，无法继续（共 ${failures} 项失败）`)
  process.exit(1)
}

const pf = readFields(proof)
const spki = pf.get(1)
const signature = pf.get(2)
check('proof.public_key = 1', Buffer.isBuffer(spki), `${spki && spki.length} 字节`)
check('proof.signature  = 2', Buffer.isBuffer(signature), `${signature && signature.length} 字节`)

const sf = readFields(signedHeaderData)
const embeddedId = sf.get(1)
check('SignedData 只有 crx_id，没有算法字段', Buffer.isBuffer(embeddedId) && sf.size === 1,
  `字段数 ${sf.size}`)
check('crx_id 恰好 16 字节', Boolean(embeddedId) && embeddedId.length === 16, `${embeddedId && embeddedId.length} 字节`)

// header_size 描述的是**整个 CrxFileHeader**（proof + signed_header_data 两个字段），
// 不是内层 SignedData 的长度。所以这里必须能把它完整解析完，不能多也不能少。
check('外层 header_size 覆盖全部头字段且无多余字节',
  consumed[0] === headerLen, `解析了 ${consumed[0]} 字节 / 声明 ${headerLen}`)

if (!Buffer.isBuffer(spki) || !Buffer.isBuffer(signature) || !Buffer.isBuffer(embeddedId)) {
  console.log(`\n❌ 头结构不完整，无法验签（共 ${failures} 项失败）`)
  process.exit(1)
}

console.log('\n== 签名与扩展 id ==')
const publicKey = crypto.createPublicKey({ key: spki, type: 'spki', format: 'der' })

// 签名覆盖 [context][signed-header-size][signed-header][archive]
const sizeOctets = Buffer.alloc(4)
sizeOctets.writeUInt32LE(signedHeaderData.length, 0)
const v = crypto.createVerify('sha256')
v.update(SIGNATURE_CONTEXT)
v.update(sizeOctets)
v.update(signedHeaderData)
v.update(payload)
check('RSA_PKCS1_SHA256 签名验证', v.verify(publicKey, signature))

// 反证：不带长度前缀时必须验不过，否则说明那个前缀根本没进签名
const bad = crypto.createVerify('sha256')
bad.update(SIGNATURE_CONTEXT)
bad.update(signedHeaderData)
bad.update(payload)
check('去掉长度前缀后签名应当失败（反证）', !bad.verify(publicKey, signature),
  '若这里"通过"，说明 signed-header-size 没被签进去')

const digest = crypto.createHash('sha256').update(spki).digest()
check('嵌入的 crx_id = SHA256(SPKI) 前 16 字节', digest.subarray(0, 16).equals(embeddedId))

let id = ''
for (const byte of digest.subarray(0, 16)) {
  id += String.fromCharCode(97 + (byte >> 4))
  id += String.fromCharCode(97 + (byte & 0x0f))
}
check('扩展 id 格式合法 (a–p × 32)', /^[a-p]{32}$/.test(id), id)
console.log(`     => 安装后的扩展 id 应为 ${id}`)

console.log('\n== 载荷 ZIP ==')
let eocd = -1
for (let i = payload.length - 22; i >= 0 && i > payload.length - 22 - 65536; i--) {
  if (payload.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
}
check('找到 ZIP 中央目录 (EOCD)', eocd !== -1)
if (eocd !== -1) {
  const count = payload.readUInt16LE(eocd + 10)
  console.log(`     => 载荷内含 ${count} 个文件`)
  check('载荷含 manifest.json', payload.includes(Buffer.from('manifest.json')))
}

// 载荷里的 manifest 必须带 key，且该 key 要能推出同一个扩展 id——
// 否则「加载已解压」会拿到另一个 id，和 crx 装出来的对不上。
try {
  const unpackedManifestPath = path.join(path.dirname(crxPath),
    path.basename(crxPath, '.crx') + '-unpacked', 'manifest.json')
  const m = JSON.parse(readFileSync(unpackedManifestPath, 'utf8'))
  check('打包产物的 manifest 带 key（钉住扩展 id）', typeof m.key === 'string' && m.key.length > 0)
  if (typeof m.key === 'string') {
    const keyDer = Buffer.from(m.key, 'base64')
    const idFromManifest = (() => {
      const d = crypto.createHash('sha256').update(keyDer).digest()
      let s = ''
      for (const by of d.subarray(0, 16)) { s += String.fromCharCode(97 + (by >> 4)); s += String.fromCharCode(97 + (by & 0x0f)) }
      return s
    })()
    check('manifest.key 与 crx 公钥推出同一个扩展 id', idFromManifest === id, `${idFromManifest} vs ${id}`)
  }
} catch (e) {
  console.log('  · 跳过：读不到对应的 -unpacked/manifest.json —', e.message)
}

console.log(`\n${failures === 0 ? '✅ CRX3 结构与签名全部校验通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
