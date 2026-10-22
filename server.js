#!/usr/bin/env node
/* =============================================================================
 * 校园跑跑 · 后端服务器（零依赖单文件版）
 *
 * 作用：让「校园跑跑」从单机版升级为真正联网的多设备版本：
 *   - 账号注册 / 登录（多台手机共享同一份数据）
 *   - 任务、二手商品的发布与同步
 *   - 站内聊天实时推送（WebSocket，秒级送达）
 *   - 管理后台数据与客服工作台
 *
 * 运行方式（只需 Node.js，无需 npm install）：
 *   node server.js            # 默认端口 3000
 *   node server.js 8080       # 指定端口
 *   PORT=8080 node server.js  # 或用环境变量
 *
 * 数据保存在同目录 data.json（首次运行自动生成内置演示数据）。
 * 浏览器打开 http://本机IP:端口 可查看服务器运行状态。
 * ========================================================================== */
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const zlib = require('zlib')

const VERSION = '1.5.3'
/* 随机生成的管理员口令（仅未配置环境变量时使用，启动后打印一次） */
let ADMIN_PASSWORD_HINT = ''
/* 种子演示口令：新建数据文件时随机生成 */
const SEED_DEMO_PWD =
  String(process.env.CAMPUS_DEMO_PASSWORD || '').trim() || crypto.randomBytes(4).toString('hex')
const PORT = (() => {
  const arg = parseInt(process.argv[2], 10)
  if (arg > 0) return arg
  const env = parseInt(process.env.PORT, 10)
  return env > 0 ? env : 3000
})()
/* 数据文件：默认 server/data.json，可用环境变量 CAMPUS_DATA 指定其他位置 */
const DATA_FILE = process.env.CAMPUS_DATA
  ? path.resolve(process.env.CAMPUS_DATA)
  : path.join(__dirname, 'data.json')

/* =============================== 小工具 =============================== */

const now = () => Date.now()

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

function orderNo() {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const ymd = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `PP${ymd}${Math.floor(Math.random() * 900000 + 100000)}`
}

function money(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2)
}

function hashPwd(pwd, salt) {
  return crypto.createHash('sha256').update(salt + '::' + pwd).digest('hex')
}

function makeSalt() {
  return crypto.randomBytes(8).toString('hex')
}

/* 头像与商品图片：内联 SVG data-uri（与前端 mock.js 视觉一致） */
function svgImg(from, to, emoji) {
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
        `<rect width="300" height="300" fill="url(%23g)"/>` +
        `<circle cx="240" cy="60" r="90" fill="#ffffff" opacity="0.12"/>` +
        `<circle cx="50" cy="250" r="70" fill="#ffffff" opacity="0.10"/>` +
        `<text x="150" y="150" font-size="120" text-anchor="middle" dominant-baseline="central">${emoji}</text>` +
        `</svg>`
    ).replace(/%2523/g, '%23')
  )
}

function svgAvatar(color, text) {
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
        `<rect width="120" height="120" rx="60" fill="${color}"/>` +
        `<text x="60" y="60" font-size="52" fill="#ffffff" text-anchor="middle" dominant-baseline="central" font-family="sans-serif">${text}</text>` +
        `</svg>`
    ).replace(/%2523/g, '%23')
  )
}

const AVATAR_COLORS = ['#ff6a3d', '#4c6ef5', '#12b886', '#f59f00', '#ae3ec9', '#15aabf', '#f06595', '#40c057']
function avatarFor(name) {
  const s = String(name || '同学').trim()
  const ch = s.charAt(0) || '同'
  let sum = 0
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i)
  return svgAvatar(AVATAR_COLORS[sum % AVATAR_COLORS.length], ch)
}

const IMG = {
  book: svgImg('#ffb199', '#ff6a3d', '📚'),
  laptop: svgImg('#a5b4fc', '#4c6ef5', '💻'),
  bike: svgImg('#7ee8c2', '#12b886', '🚲'),
  lamp: svgImg('#ffd8a8', '#f59f00', '💡'),
  shoes: svgImg('#c5b3f7', '#ae3ec9', '👟'),
  racket: svgImg('#99e9f2', '#15aabf', '🏸'),
  cup: svgImg('#ffc9de', '#f06595', '☕'),
  guitar: svgImg('#ffe066', '#fab005', '🎸'),
  fan: svgImg('#b2f2bb', '#40c057', '🌀'),
  camera: svgImg('#adc2ff', '#3b5bdb', '📷'),
  tent: svgImg('#8ce99a', '#2f9e44', '⛺'),
  glasses: svgImg('#dee2e6', '#868e96', '👓')
}

/* =============================== 数据层 =============================== */

let DB = null
let dirty = false
let saveTimer = null

function loadDB() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8')
      const data = JSON.parse(raw)
      if (data && Array.isArray(data.users) && Array.isArray(data.tasks)) {
        DB = data
        DB.tokens = DB.tokens || {}
        DB.smsCodes = DB.smsCodes || {}
        DB.payOrders = DB.payOrders || []
        console.log(`[数据] 已载入 ${DATA_FILE}（用户 ${DB.users.length} · 任务 ${DB.tasks.length} · 商品 ${DB.goods.length}）`)
        return
      }
    } catch (e) {
      console.warn('[数据] data.json 解析失败，将备份并使用内置演示数据：', e.message)
      try {
        fs.copyFileSync(DATA_FILE, DATA_FILE + '.broken-' + Date.now())
      } catch (_) {}
    }
  }
  DB = buildSeedData()
  dirty = true
  console.log('[数据] 已生成内置演示数据')
}

function saveSoon() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 400)
}

function saveNow() {
  if (!dirty || !DB) return
  dirty = false
  try {
    const tmp = DATA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(DB))
    fs.renameSync(tmp, DATA_FILE)
  } catch (e) {
    console.error('[数据] 保存失败：', e.message)
  }
}

setInterval(() => saveNow(), 30 * 1000).unref?.()

process.on('SIGINT', () => {
  console.log('\n[退出] 正在保存数据…')
  saveNow()
  process.exit(0)
})
process.on('SIGTERM', () => {
  saveNow()
  process.exit(0)
})

/* ---------------- 用户字段裁剪 ---------------- */
function pubUser(u, opts) {
  if (!u) return null
  const copy = {
    id: u.id,
    name: u.name,
    account: u.account,
    phone: u.phone,
    role: u.role,
    status: u.status,
    avatar: u.avatar,
    school: u.school,
    campus: u.campus,
    studentNo: u.studentNo || '',
    college: u.college || '',
    realName: u.realName || '',
    verified: !!u.verified,
    verifiedAt: u.verifiedAt || '',
    credit: u.credit,
    rating: u.rating,
    finishedOrders: u.finishedOrders,
    publishCount: u.publishCount,
    totalEarn: u.totalEarn,
    balance: u.balance,
    joinedAt: u.joinedAt,
    bio: u.bio || '',
    gender: u.gender || '保密',
    places: Array.isArray(u.places) ? u.places : [],
    vouchers: (u.vouchers || []).filter((v) => !v.used)
  }
  if (opts && opts.self) copy.walletLogs = u.walletLogs || []
  return copy
}

function findUserById(uid) {
  return DB.users.find((u) => u.id === uid) || null
}

function findByAccount(account) {
  const q = String(account || '').trim()
  if (!q) return null
  return DB.users.find((u) => u.phone === q || u.account === q) || null
}

function findTask(tid) {
  return DB.tasks.find((t) => t.id === tid) || null
}

function findGoods(gid) {
  return DB.goods.find((g) => g.id === gid) || null
}

function findConv(cid) {
  return DB.convs.find((c) => c.id === cid) || null
}

/* =============================== 图形验证码 ===============================
 * 不依赖任何第三方短信服务：服务端生成一张带噪点/干扰线的 PNG，
 * 把答案存在内存里（key -> {code, at, tries}），客户端凭 key + code 校验。
 *
 * 安全要点：
 *  - 答案只存在服务端内存，绝不下发给客户端；
 *  - 一次性使用，校验无论成败都作废，避免爆破；
 *  - 5 分钟过期；
 *  - 生成与校验都做 IP 限流。
 * ========================================================================== */

/* 去掉易混淆字符：0/O、1/I/l、2/Z、5/S、8/B */
const CAPTCHA_CHARS = 'ACDEFGHJKLMNPQRTUVWXY3467'
const CAPTCHA_TTL = 5 * 60 * 1000
const CAPTCHA_MAX = 20000
const CAPTCHAS = new Map()

function rndInt(n) {
  return crypto.randomInt(0, n)
}

/* ---- 极简 PNG 编码（零依赖）----
 * 生成 8bit RGB 真彩色 PNG，使用 zlib 的 "stored" 块（不压缩），
 * 体积约 20~30KB，对验证码这种小图完全够用。 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* 3x5 点阵字模，用二进制位表示，够清晰也不易被 OCR 认出 */
const GLYPHS = {
  A: ['010', '101', '111', '101', '101'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  H: ['101', '101', '111', '101', '101'],
  J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['101', '111', '111', '111', '101'],
  P: ['111', '101', '111', '100', '100'],
  Q: ['010', '101', '101', '111', '011'],
  R: ['111', '101', '111', '110', '101'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '011'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '6': ['011', '100', '111', '101', '011'],
  '7': ['111', '001', '010', '010', '010']
}

function drawGlyph(buf, W, H, ch, ox, oy, scale, color) {
  const g = GLYPHS[ch]
  if (!g) return
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (g[r][c] !== '1') continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = ox + c * scale + dx
          const y = oy + r * scale + dy
          if (x < 0 || y < 0 || x >= W || y >= H) continue
          const i = (y * W + x) * 3
          buf[i] = color[0]
          buf[i + 1] = color[1]
          buf[i + 2] = color[2]
        }
      }
    }
  }
}

const CAPTCHA_TEXT_COLORS = [
  [40, 52, 90], [140, 40, 60], [30, 90, 70], [110, 60, 20], [70, 40, 110], [20, 60, 100]
]
const CAPTCHA_BG_COLORS = [
  [255, 244, 238], [238, 246, 255], [238, 252, 246], [255, 248, 232], [248, 240, 255]
]

function makeCaptchaImage(code) {
  const W = 200
  const H = 74
  const buf = Buffer.alloc(W * H * 3)
  const bg = CAPTCHA_BG_COLORS[rndInt(CAPTCHA_BG_COLORS.length)]
  for (let i = 0; i < W * H; i++) {
    /* 轻微噪点，让背景不是纯色 */
    const n = rndInt(18)
    buf[i * 3] = Math.min(255, bg[0] + n)
    buf[i * 3 + 1] = Math.min(255, bg[1] + n)
    buf[i * 3 + 2] = Math.min(255, bg[2] + n)
  }

  /* 干扰线：随机折线 */
  for (let k = 0; k < 3; k++) {
    const col = [rndInt(120) + 120, rndInt(120) + 120, rndInt(120) + 120]
    let x = rndInt(20)
    let y = rndInt(H)
    for (let s = 0; s < 60; s++) {
      x += rndInt(4)
      y += rndInt(5) - 2
      if (x >= W || y < 0 || y >= H) break
      const i = (y * W + x) * 3
      buf[i] = col[0]
      buf[i + 1] = col[1]
      buf[i + 2] = col[2]
    }
  }

  /* 字符：4 位，每位随机缩放与上下偏移 */
  const color = CAPTCHA_TEXT_COLORS[rndInt(CAPTCHA_TEXT_COLORS.length)]
  const cellW = Math.floor((W - 24) / code.length)
  for (let i = 0; i < code.length; i++) {
    const scale = 5 + rndInt(3) // 5~7
    const gw = 3 * scale
    const gh = 5 * scale
    const ox = 16 + i * cellW + Math.floor((cellW - gw) / 2) + rndInt(5) - 2
    const oy = Math.floor((H - gh) / 2) + rndInt(9) - 4
    drawGlyph(buf, W, H, code[i], ox, oy, scale, color)
  }
  return encodePng(W, H, buf)
}

function newCaptcha(req) {
  const ip = clientIp(req)
  if (!checkIpRate(ip, 'captcha', 60, 10 * 60 * 1000)) {
    E('ratelimit', '验证码请求过于频繁，请稍后再试', 429)
  }
  /* 清理过期项，避免内存无限增长 */
  const cut = now() - CAPTCHA_TTL
  if (CAPTCHAS.size > 2000) {
    for (const [k, v] of CAPTCHAS) if (v.at < cut) CAPTCHAS.delete(k)
  }
  if (CAPTCHAS.size > CAPTCHA_MAX) E('busy', '服务器繁忙，请稍后再试', 503)

  let code = ''
  for (let i = 0; i < 4; i++) code += CAPTCHA_CHARS[rndInt(CAPTCHA_CHARS.length)]
  const key = crypto.randomBytes(12).toString('hex')
  CAPTCHAS.set(key, { code: hashPwd(code, key), at: now(), tries: 0, plain: code })
  const png = makeCaptchaImage(code)
  return { key, image: 'data:image/png;base64,' + png.toString('base64') }
}

/** 校验并作废验证码；失败抛出 ApiError */
function consumeCaptcha(req, key, input) {
  const ip = clientIp(req)
  if (!checkIpRate(ip, 'captcha-check', 40, 10 * 60 * 1000)) {
    E('ratelimit', '尝试过于频繁，请稍后再试', 429)
  }
  const k = str(key)
  const code = str(input)
  if (!k) E('needcaptcha', '请先获取图形验证码')
  if (!code) E('needcaptcha', '请输入图形验证码')
  const rec = CAPTCHAS.get(k)
  if (!rec) E('captchaexpired', '验证码已失效，请刷新重试')
  CAPTCHAS.delete(k) // 一次性：无论对错都作废
  if (now() - rec.at > CAPTCHA_TTL) E('captchaexpired', '验证码已过期，请刷新重试')
  if (hashPwd(code.toUpperCase(), k) !== rec.code) E('badcaptcha', '图形验证码不正确')
  return true
}

/* ---------------- DTO（附带关联用户对象，便于前端直接渲染） ---------------- */
function taskDto(t) {
  const copy = Object.assign({}, t)
  copy.publisher = pubUser(findUserById(t.publisherId))
  copy.acceptor = t.acceptorId ? pubUser(findUserById(t.acceptorId)) : null
  return copy
}

function goodsDto(g) {
  const copy = Object.assign({}, g)
  copy.seller = pubUser(findUserById(g.sellerId))
  return copy
}

function convDto(c) {
  return {
    id: c.id,
    type: c.type,
    memberIds: c.memberIds.slice(),
    contextKind: c.contextKind || '',
    contextId: c.contextId || '',
    lastText: c.lastText || '',
    lastAt: c.lastAt || c.createdAt,
    readAt: Object.assign({}, c.readAt || {}),
    createdAt: c.createdAt
  }
}

/* ---------------- 钱包 ---------------- */
function walletChange(u, delta, title, type) {
  const amt = Math.round(Number(delta) * 100) / 100
  u.balance = Math.round(((u.balance || 0) + amt) * 100) / 100
  if (!Array.isArray(u.walletLogs)) u.walletLogs = []
  u.walletLogs.unshift({
    id: id('log'),
    type,
    amount: amt,
    title,
    time: now(),
    balance: u.balance
  })
  if (u.walletLogs.length > 60) u.walletLogs.length = 60
  saveSoon()
}

/* ---------------- 令牌 ---------------- */
function issueToken(u) {
  const token = crypto.randomBytes(24).toString('hex')
  DB.tokens[token] = { userId: u.id, at: now() }
  saveSoon()
  return token
}

function userByToken(token) {
  if (!token) return null
  const rec = DB.tokens[token]
  if (!rec) return null
  return findUserById(rec.userId)
}

/* ---------------- 管理统计 ---------------- */
function adminStats() {
  const t = DB.tasks
  return {
    users: DB.users.length,
    banned: DB.users.filter((u) => u.status === 'banned').length,
    tasks: t.length,
    pending: t.filter((x) => x.status === 'pending').length,
    running: t.filter((x) => x.status === 'running').length,
    done: t.filter((x) => x.status === 'done').length,
    goods: DB.goods.length,
    onSale: DB.goods.filter((g) => g.status === 'on').length,
    csOpen: DB.convs.filter((c) => c.type === 'cs').length,
    messages: DB.messages.length
  }
}

/* =============================== WebSocket 引擎 ===============================
 * 手写的极简 RFC6455 服务端实现（只依赖 Node 内置模块）：
 * 支持 文本帧 / 分片重组 / ping-pong 心跳 / close。足以支撑本项目的 JSON 消息推送。
 * ============================================================================ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const clients = new Map() // socket -> { socket, userId, buffer, frags, fragOpcode, alive }

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x81 // FIN + text
  return Buffer.concat([header, payload])
}

function sendControl(c, opcode, payload) {
  const body = payload && payload.length ? payload : Buffer.alloc(0)
  const header = Buffer.alloc(2)
  header[0] = 0x80 | opcode
  header[1] = Math.min(body.length, 125)
  try {
    c.socket.write(Buffer.concat([header, body.slice(0, 125)]))
  } catch (_) {}
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch (e) {
    socket.destroy()
    return
  }
  const token = url.searchParams.get('token')
  const user = userByToken(token)

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      wsAccept(key) +
      '\r\n\r\n'
  )
  try {
    socket.setNoDelay(true)
  } catch (_) {}

  const c = { socket, userId: user ? user.id : null, buffer: Buffer.alloc(0), frags: [], fragOpcode: 0, alive: true }
  clients.set(socket, c)
  if (user) console.log(`[WS] 上线 ${user.name}（${user.phone || user.account}）· 当前在线 ${onlineCount()}`)

  socket.on('data', (chunk) => {
    c.buffer = c.buffer.length ? Buffer.concat([c.buffer, chunk]) : chunk
    try {
      parseFrames(c)
    } catch (e) {
      console.warn('[WS] 帧解析异常，关闭连接：', e.message)
      try {
        socket.destroy()
      } catch (_) {}
      clients.delete(socket)
    }
  })
  const bye = () => {
    const u = c.userId ? findUserById(c.userId) : null
    if (u) console.log(`[WS] 下线 ${u.name} · 当前在线 ${Math.max(0, onlineCount() - 1)}`)
    clients.delete(socket)
  }
  socket.on('close', bye)
  socket.on('error', () => {
    try {
      socket.destroy()
    } catch (_) {}
    if (clients.has(socket)) bye()
  })
}

function parseFrames(c) {
  for (;;) {
    const buf = c.buffer
    if (buf.length < 2) return
    const b0 = buf[0]
    const b1 = buf[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let pos = 2
    if (len === 126) {
      if (buf.length < 4) return
      len = buf.readUInt16BE(2)
      pos = 4
    } else if (len === 127) {
      if (buf.length < 10) return
      const big = buf.readBigUInt64BE(2)
      if (big > 8n * 1024n * 1024n) throw new Error('帧过大')
      len = Number(big)
      pos = 10
    }
    let maskKey = null
    if (masked) {
      if (buf.length < pos + 4) return
      maskKey = buf.slice(pos, pos + 4)
      pos += 4
    }
    if (buf.length < pos + len) return
    let payload = Buffer.from(buf.slice(pos, pos + len))
    c.buffer = buf.slice(pos + len)
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    }
    handleFrame(c, fin, opcode, payload)
  }
}

function handleFrame(c, fin, opcode, payload) {
  if (opcode === 0x8) {
    // close
    sendControl(c, 0x8)
    try {
      c.socket.end()
    } catch (_) {}
    return
  }
  if (opcode === 0x9) {
    sendControl(c, 0xa, payload)
    return
  }
  if (opcode === 0xa) {
    c.alive = true
    return
  }
  if (opcode === 0x1 || opcode === 0x2) {
    c.fragOpcode = opcode
    c.frags = [payload]
    if (fin) deliverWs(c)
    return
  }
  if (opcode === 0x0 && c.frags.length) {
    c.frags.push(payload)
    if (fin) deliverWs(c)
  }
}

function deliverWs(c) {
  const data = Buffer.concat(c.frags)
  const isText = c.fragOpcode === 0x1
  c.frags = []
  if (!isText) return
  let msg
  try {
    msg = JSON.parse(data.toString('utf8'))
  } catch (e) {
    return
  }
  /* 目前客户端仅发送 {type:'ping'} 保活信令 */
  if (msg && msg.type === 'ping') {
    try {
      c.socket.write(encodeFrame(JSON.stringify({ type: 'pong', t: now() })))
    } catch (_) {}
  }
}

/* 心跳：25 秒一次 ping，浏览器会自动回 pong；连丢两次则断开 */
setInterval(() => {
  clients.forEach((c) => {
    if (!c.alive) {
      try {
        c.socket.destroy()
      } catch (_) {}
      clients.delete(c.socket)
      return
    }
    c.alive = false
    sendControl(c, 0x9)
  })
}, 25000)

function onlineCount() {
  let n = 0
  clients.forEach((c) => {
    if (c.userId) n++
  })
  return n
}

function broadcast(obj, pred) {
  if (!clients.size) return
  const frame = encodeFrame(JSON.stringify(obj))
  clients.forEach((c) => {
    if (pred && !pred(c)) return
    try {
      c.socket.write(frame)
    } catch (_) {}
  })
}

function broadcastMembers(conv, obj) {
  const members = conv.memberIds
  broadcast(obj, (c) => c.userId && members.indexOf(c.userId) > -1)
}

function broadcastAll(obj) {
  broadcast(obj, null)
}

/* =============================== 种子数据 ===============================
 * 与 App 单机版内置的演示数据保持一致：
 *  - 管理员账号：202325817（口令由 CAMPUS_ADMIN_PASSWORD 环境变量指定，未配置则启动时随机生成）
 *  - 演示账号：13800138000（林小跑）等，口令为 'demo-' + 随机串，仅当启动时
 *    未设置 CAMPUS_DEMO_PASSWORD 才随机生成，且只在控制台显示一次
 * 首次运行后所有数据都保存在 data.json，多台设备共享。
 * ====================================================================== */

const M = 60 * 1000
const H = 60 * M
const D = 24 * H

function seedUser(def, t0) {
  const salt = makeSalt()
  const u = {
    id: def.id,
    name: def.name,
    account: def.account || '',
    phone: def.phone,
    salt,
    passwordHash: hashPwd(def.password, salt),
    role: def.role || 'user',
    status: 'active',
    avatar: def.avatar,
    school: '中犇大学',
    campus: def.campus || '中心校区',
    studentNo: def.studentNo || '',
    college: def.college || '',
    realName: def.realName || '',
    verified: !!def.verified,
    verifiedAt: def.verifiedAt || '',
    credit: def.credit,
    rating: def.rating,
    finishedOrders: def.finishedOrders || 0,
    publishCount: def.publishCount || 0,
    totalEarn: def.totalEarn || 0,
    balance: def.balance,
    walletLogs: def.walletLogs || [],
    joinedAt: def.joinedAt || t0,
    bio: def.bio || '这位同学很低调，什么都没写～'
  }
  return u
}

function buildSeedData() {
  const t0 = now()

  /* 管理员口令：优先取环境变量 CAMPUS_ADMIN_PASSWORD；
   * 未配置时忽略种子里的弱口令，随机生成一串强口令并只在启动日志里打印一次。 */
  const adminPassword =
    String(process.env.CAMPUS_ADMIN_PASSWORD || '').trim() || crypto.randomBytes(9).toString('base64url')
  ADMIN_PASSWORD_HINT = !process.env.CAMPUS_ADMIN_PASSWORD ? adminPassword : ''

  /* ---------------- 账号 ---------------- */
  const users = [
    seedUser(
      {
        id: 'u_admin',
        name: '平台管理员',
        account: '202325817',
        phone: '202325817',
        password: adminPassword,
        role: 'admin',
        avatar: svgAvatar('#16181d', '管'),
        verified: true,
        credit: 100,
        rating: 5,
        balance: 10000,
        joinedAt: t0 - 400 * D,
        bio: '校园跑跑官方管理员，有问题请在消息页联系客服'
      },
      t0
    ),
    seedUser(
      {
        id: 'u_self',
        name: '林小跑',
        phone: '13800138000',
        password: 'demo-' + SEED_DEMO_PWD,
        avatar: svgAvatar('#ff6a3d', '林'),
        credit: 92,
        balance: 128.5,
        totalEarn: 386.4,
        finishedOrders: 27,
        publishCount: 9,
        rating: 4.9,
        joinedAt: t0 - 96 * D,
        bio: '计算机学院大三 · 常在西门驿站出没，接单飞快 ⚡',
        walletLogs: [
          { id: id('log'), type: 'earn', amount: 8, title: '跑腿收入 · 西门驿站取件', time: t0 - 3 * H, balance: 128.5 },
          { id: id('log'), type: 'earn', amount: 22, title: '跑腿收入 · 文印店打印论文', time: t0 - 26 * H, balance: 120.5 },
          { id: id('log'), type: 'pay', amount: -5, title: '发布跑腿 · 外卖柜拿粥', time: t0 - 29 * H, balance: 98.5 },
          { id: id('log'), type: 'earn', amount: 15, title: '二手交易 · 宿舍小台灯', time: t0 - 60 * H, balance: 103.5 }
        ]
      },
      t0
    ),
    seedUser(
      {
        id: 'u_a',
        name: '陈一诺',
        phone: '13800000001',
        password: 'demo-' + SEED_DEMO_PWD,
        avatar: svgAvatar('#4c6ef5', '陈'),
        verified: true,
        credit: 98,
        rating: 4.95,
        finishedOrders: 63,
        publishCount: 12,
        totalEarn: 812.6,
        balance: 256,
        joinedAt: t0 - 300 * D,
        bio: '外语学院 · 5 分钟必回消息',
        studentNo: '202201****21',
        college: '外国语学院',
        realName: '陈一诺',
        verifiedAt: '2025-09-12',
        walletLogs: [
          { id: id('log'), type: 'earn', amount: 16, title: '跑腿收入 · 菜鸟驿站代取快递', time: t0 - 5 * H, balance: 256 }
        ]
      },
      t0
    ),
    seedUser(
      {
        id: 'u_b',
        name: '王梓涵',
        phone: '13800000002',
        password: 'demo-' + SEED_DEMO_PWD,
        avatar: svgAvatar('#12b886', '王'),
        verified: true,
        credit: 95,
        rating: 4.9,
        finishedOrders: 41,
        publishCount: 8,
        totalEarn: 498.2,
        balance: 89,
        campus: '东湖校区',
        joinedAt: t0 - 260 * D,
        bio: '数统学院 · 每天中午都去食堂',
        studentNo: '202203****08',
        college: '数学与统计学院',
        realName: '王梓涵',
        verifiedAt: '2025-09-20'
      },
      t0
    ),
    seedUser(
      {
        id: 'u_c',
        name: '刘思远',
        phone: '13800000003',
        password: 'demo-' + SEED_DEMO_PWD,
        avatar: svgAvatar('#f59f00', '刘'),
        verified: true,
        credit: 90,
        rating: 4.8,
        finishedOrders: 18,
        publishCount: 5,
        totalEarn: 176.8,
        balance: 45.2,
        campus: '南苑校区',
        joinedAt: t0 - 180 * D,
        bio: '机械学院 · 有电动车',
        studentNo: '202204****33',
        college: '机械工程学院',
        realName: '刘思远',
        verifiedAt: '2025-10-02'
      },
      t0
    ),
    seedUser(
      {
        id: 'u_d',
        name: '赵可欣',
        phone: '13800000004',
        password: 'demo-' + SEED_DEMO_PWD,
        avatar: svgAvatar('#ae3ec9', '赵'),
        verified: true,
        credit: 96,
        rating: 4.92,
        finishedOrders: 52,
        publishCount: 15,
        totalEarn: 645.3,
        balance: 310.5,
        campus: '北岭校区',
        joinedAt: t0 - 210 * D,
        bio: '设计学院 · 图书馆常驻',
        studentNo: '202205****47',
        college: '艺术学院',
        realName: '赵可欣',
        verifiedAt: '2025-09-28'
      },
      t0
    ),
    seedUser(
      {
        id: 'u_e',
        name: '孙浩宇',
        phone: '13800000005',
        password: 'demo-' + SEED_DEMO_PWD,
        avatar: svgAvatar('#15aabf', '孙'),
        credit: 82,
        rating: 4.7,
        finishedOrders: 6,
        publishCount: 3,
        totalEarn: 54,
        balance: 12,
        joinedAt: t0 - 40 * D,
        bio: '大一新生 · 正在熟悉校园'
      },
      t0
    )
  ]

  /* ---------------- 任务池 ---------------- */
  const baseTasks = [
    { type: 'express', title: '菜鸟驿站代取快递 2 件', desc: '取件码已发你，大件在货架最里面，麻烦轻拿轻放。送到 B 栋 512 宿舍。', from: '菜鸟驿站(西门)', to: '学生公寓 B 栋', campus: '中心校区', reward: 6, tip: 2, deadline: '1小时内', publisherId: 'u_a', minsAgo: 4, hot: 12 },
    { type: 'food', title: '外卖柜代拿：麻辣香锅 1 份', desc: '骑手马上到校门外卖柜，帮忙取一下送到图书馆三楼自习区。', from: '门口外卖柜', to: '图书馆', campus: '中心校区', reward: 5, tip: 0, deadline: '30分钟内', publisherId: 'u_d', minsAgo: 2, hot: 23 },
    { type: 'print', title: '文印店打印论文 35 页并装订', desc: '文件已发 QQ，双面打印 35 页，胶装一份，预算 20 以内。送到三教 302。', from: '文印中心', to: '二号教学楼', campus: '中心校区', reward: 15, tip: 3, deadline: '2小时内', publisherId: 'u_b', minsAgo: 26, hot: 8 },
    { type: 'buy', title: '第三食堂代买两份盖饭', desc: '一份黄焖鸡少辣、一份番茄鸡蛋面，多要两双筷子。送到实验楼 401。', from: '第三食堂', to: '实验楼', campus: '东湖校区', reward: 8, tip: 0, deadline: '30分钟内', publisherId: 'u_c', minsAgo: 9, hot: 17 },
    { type: 'other', title: '图书馆帮占个座（靠窗）', desc: '我 20 分钟后到，帮忙在 4 楼靠窗位置放本书占一个位子即可。', from: '图书馆', to: '图书馆', campus: '中心校区', reward: 3, tip: 0, deadline: '1小时内', publisherId: 'u_e', minsAgo: 15, hot: 5 },
    { type: 'express', title: '京东快递站取 3 个包裹', desc: '三个小件的手机取件码，一起取回来放宿舍楼下快递架。', from: '京东快递站', to: '学生公寓 C 栋', campus: '南苑校区', reward: 7, tip: 1, deadline: '今天内', publisherId: 'u_c', minsAgo: 38, hot: 6 },
    { type: 'buy', title: '超市代买牛奶和纸巾', desc: '纯牛奶 1 箱（1L*6）、抽纸 2 提，东西有点重，有车的同学优先。', from: '学生超市', to: '学生公寓 A 栋', campus: '中心校区', reward: 12, tip: 5, deadline: '2小时内', publisherId: 'u_a', minsAgo: 52, hot: 31 },
    { type: 'other', title: '帮送到学生处交纸质材料', desc: '一个文件袋，交到学生处 2 号窗口并拍个回执照片。', from: '一号教学楼', to: '学生处', campus: '北岭校区', reward: 10, tip: 0, deadline: '今晚前', publisherId: 'u_d', minsAgo: 64, hot: 4 },
    { type: 'food', title: '食堂代拿奶茶 3 杯（不加冰）', desc: '珍珠奶茶 3 杯不加冰，送到体育馆羽毛球场。', from: '第三食堂', to: '体育馆', campus: '中心校区', reward: 6, tip: 2, deadline: '30分钟内', publisherId: 'u_b', minsAgo: 7, hot: 19 },
    { type: 'print', title: '打印实验报告 + 彩色封面', desc: '报告 8 页，彩色封面 1 张，需要装订订书机即可。', from: '文印中心', to: '实验楼', campus: '东湖校区', reward: 9, tip: 0, deadline: '2小时内', publisherId: 'u_c', minsAgo: 71, hot: 3 }
  ]

  const tasks = []
  baseTasks.forEach((def, i) => {
    const created = t0 - def.minsAgo * M
    tasks.push({
      id: id('task'),
      orderNo: `PP2601${String(i + 1).padStart(4, '0')}${Math.floor(Math.random() * 90 + 10)}`,
      type: def.type,
      title: def.title,
      desc: def.desc,
      from: def.from,
      to: def.to,
      campus: def.campus,
      reward: def.reward,
      tip: def.tip,
      deadline: def.deadline,
      publisherId: def.publisherId,
      acceptorId: '',
      status: 'pending',
      hot: def.hot,
      createdAt: created,
      acceptedAt: null,
      arrivedAt: null,
      finishedAt: null,
      timeline: [{ status: 'pending', at: created, text: '已发布，等待同学接单' }],
      rating: null
    })
  })

  /* 我发布的：一条进行中、一条已完成（沿用旧口径，供演示） */
  const mine1 = {
    id: id('task'),
    orderNo: 'PP2601008821',
    type: 'express',
    title: '西门驿站取一个中号纸箱',
    desc: '箱子有点沉，麻烦送到 A 栋 302，到了敲门即可。',
    from: '菜鸟驿站(西门)',
    to: '学生公寓 A 栋',
    campus: '中心校区',
    reward: 8,
    tip: 2,
    deadline: '1小时内',
    publisherId: 'u_self',
    acceptorId: 'u_a',
    status: 'running',
    hot: 3,
    createdAt: t0 - 32 * M,
    acceptedAt: t0 - 20 * M,
    arrivedAt: null,
    finishedAt: null,
    timeline: [
      { status: 'pending', at: t0 - 32 * M, text: '已发布，等待同学接单' },
      { status: 'running', at: t0 - 20 * M, text: '陈一诺 已接单，正在前往驿站' }
    ],
    rating: null
  }
  const mine2 = {
    id: id('task'),
    orderNo: 'PP2601004417',
    type: 'food',
    title: '外卖柜拿一份粥',
    desc: '送到 C 栋楼下并打电话。',
    from: '门口外卖柜',
    to: '学生公寓 C 栋',
    campus: '中心校区',
    reward: 5,
    tip: 0,
    deadline: '30分钟内',
    publisherId: 'u_self',
    acceptorId: 'u_d',
    status: 'done',
    hot: 9,
    createdAt: t0 - 26 * H,
    acceptedAt: t0 - 26 * H + 3 * M,
    arrivedAt: t0 - 26 * H + 14 * M,
    finishedAt: t0 - 26 * H + 16 * M,
    timeline: [
      { status: 'pending', at: t0 - 26 * H, text: '已发布，等待同学接单' },
      { status: 'running', at: t0 - 26 * H + 3 * M, text: '赵可欣 已接单' },
      { status: 'arrived', at: t0 - 26 * H + 14 * M, text: '赵可欣 已送达，等待确认' },
      { status: 'done', at: t0 - 26 * H + 16 * M, text: '我 已确认完成，本次体验好评' }
    ],
    rating: { score: 5, text: '很快就送到了，还帮忙放在楼下～' }
  }
  const allTasks = [mine1, ...tasks, mine2]

  /* ---------------- 二手商品 ---------------- */
  const goodsSeed = [
    { title: '高等数学同济第七版 上下册', cat: 'book', price: 25, origin: 76, cond: 'good', img: 'book', campus: '中心校区', sellerId: 'u_a', views: 231, wants: 18, desc: '上学期用完，书页干净无笔记，上册有一点点折角。可在图书馆当面交易。' },
    { title: 'iPad 第9代 64G WiFi 深空灰', cat: 'digital', price: 1299, origin: 2499, cond: 'like', img: 'laptop', campus: '中心校区', sellerId: 'u_b', views: 892, wants: 47, desc: '21 年购入，一直贴膜带壳使用，屏幕无划痕，电池健康 89%。含原装充电器、包装盒。' },
    { title: '捷安特 ATX 660 山地车', cat: 'sport', price: 480, origin: 1580, cond: 'good', img: 'bike', campus: '东湖校区', sellerId: 'u_c', views: 640, wants: 35, desc: '骑了两年多，链条今年刚换新，刹车灵敏。毕业出，可小刀，自提带走。' },
    { title: '小米护眼台灯 Pro', cat: 'daily', price: 79, origin: 199, cond: 'like', img: 'lamp', campus: '南苑校区', sellerId: 'u_d', views: 156, wants: 11, desc: '宿舍换风格了，成色很好，无频闪，白光暖光都正常。' },
    { title: 'Nike Air Force 1 白色 41码', cat: 'cloth', price: 260, origin: 899, cond: 'like', img: 'shoes', campus: '中心校区', sellerId: 'u_e', views: 412, wants: 24, desc: '实穿 5 次不到，尺码偏大所以出。鞋盒在，鞋面几乎全新。' },
    { title: '尤尼克斯羽毛球拍 全碳素', cat: 'sport', price: 168, origin: 420, cond: 'good', img: 'racket', campus: '北岭校区', sellerId: 'u_a', views: 208, wants: 14, desc: '拉线 24 磅，还能打半年，附送一个球拍套。' },
    { title: '星巴克随行杯 473ml', cat: 'daily', price: 35, origin: 119, cond: 'like', img: 'cup', campus: '中心校区', sellerId: 'u_b', views: 97, wants: 6, desc: '全新未使用，抽奖中的，用不上所以转让。' },
    { title: '雅马哈 F310 民谣吉他', cat: 'other', price: 320, origin: 899, cond: 'good', img: 'guitar', campus: '东湖校区', sellerId: 'u_c', views: 355, wants: 29, desc: '大学四年陪伴，音色很稳，琴颈无变形，送琴包和变调夹。' },
    { title: '迷你静音小风扇 USB 充电', cat: 'daily', price: 19, origin: 59, cond: 'fair', img: 'fan', campus: '南苑校区', sellerId: 'u_d', views: 63, wants: 4, desc: '风力够用，有一点使用痕迹，功能完好。' },
    { title: '佳能 EOS M50 微单 套机', cat: 'digital', price: 2380, origin: 4299, cond: 'good', img: 'camera', campus: '中心校区', sellerId: 'u_a', views: 1203, wants: 58, desc: '快门约 1.2 万，成色好，含 15-45 镜头、两块电池、相机包。' },
    { title: '48 寸可折叠露营帐篷', cat: 'other', price: 89, origin: 259, cond: 'like', img: 'tent', campus: '北岭校区', sellerId: 'u_e', views: 134, wants: 9, desc: '只用过两次，防风防雨，收纳后很小，适合新生军训后出去玩。' },
    { title: 'Ray-Ban 金属框眼镜 防蓝光', cat: 'cloth', price: 120, origin: 699, cond: 'like', img: 'glasses', campus: '东湖校区', sellerId: 'u_d', views: 88, wants: 5, desc: '度数不高可以换片，镜框无变形，附原装硬盒。' }
  ]

  const goods = [
    {
      id: id('goods'),
      title: '数据结构教材 + 习题解答',
      cat: 'book',
      price: 18,
      origin: 68,
      cond: 'good',
      imgs: [IMG.book],
      cover: IMG.book,
      campus: '中心校区',
      sellerId: 'u_self',
      views: 47,
      wants: 3,
      desc: '上下两册一起出，笔记都是重点划线，超值。',
      status: 'on',
      createdAt: t0 - 5 * H
    },
    {
      id: id('goods'),
      title: '宿舍小台灯（可调三档）',
      cat: 'daily',
      price: 25,
      origin: 79,
      cond: 'like',
      imgs: [IMG.lamp],
      cover: IMG.lamp,
      campus: '中心校区',
      sellerId: 'u_self',
      views: 12,
      wants: 1,
      desc: '换了护眼灯，这个闲置了，功能完好。',
      status: 'sold',
      createdAt: t0 - 60 * H
    }
  ]
  goodsSeed.forEach((def, i) => {
    goods.push({
      id: id('goods'),
      title: def.title,
      cat: def.cat,
      price: def.price,
      origin: def.origin,
      cond: def.cond,
      imgs: [IMG[def.img]],
      cover: IMG[def.img],
      campus: def.campus,
      sellerId: def.sellerId,
      views: def.views,
      wants: def.wants,
      desc: def.desc,
      status: 'on',
      createdAt: t0 - (i * 7 + 3) * H
    })
  })

  /* ---------------- 会话与消息 ---------------- */
  const convs = []
  const messages = []
  const addMsg = (convId, fromId, kind, text, minsAgo) => {
    messages.push({ id: id('msg'), convId, fromId, kind, text, at: t0 - minsAgo * M, clientId: '' })
  }

  const c1 = {
    id: id('conv'),
    type: 'user',
    memberIds: ['u_self', 'u_a'],
    contextKind: 'task',
    contextId: mine1.id,
    lastText: '',
    lastAt: t0 - 3 * M,
    readAt: { u_self: t0 - 5 * M, u_a: t0 - 9 * M },
    createdAt: t0 - 22 * M
  }
  addMsg(c1.id, 'u_a', 'text', '同学你好，我到西门驿站啦，你这个是纸箱大件，我直接给你搬到 A 栋楼下吧～', 10)
  addMsg(c1.id, 'u_self', 'text', '好呀谢谢你！到楼下敲 302 就行', 8)
  addMsg(c1.id, 'u_a', 'text', '刚取到，正在路上 🛵', 3)
  c1.lastText = '刚取到，正在路上 🛵'
  convs.push(c1)

  const c2 = {
    id: id('conv'),
    type: 'user',
    memberIds: ['u_self', 'u_d'],
    contextKind: 'task',
    contextId: mine2.id,
    lastText: '',
    lastAt: t0 - 24 * H,
    readAt: { u_self: t0 - 24 * H - 30 * M, u_d: t0 - 24 * H - 30 * M },
    createdAt: t0 - 25 * H
  }
  addMsg(c2.id, 'u_self', 'text', '你好，外卖到了放 C 栋楼下就行，谢谢！', 25 * 60)
  addMsg(c2.id, 'u_d', 'text', '好的，已经放好啦，记得趁热喝～', 24 * 60)
  c2.lastText = '好的，已经放好啦，记得趁热喝～'
  convs.push(c2)

  const cs = {
    id: id('conv'),
    type: 'cs',
    memberIds: ['u_self', 'u_admin'],
    contextKind: '',
    contextId: '',
    lastText: '',
    lastAt: t0 - 60 * M,
    readAt: { u_self: t0 - 50 * M, u_admin: t0 - 75 * M },
    createdAt: t0 - 3 * H
  }
  addMsg(cs.id, 'u_admin', 'text', '你好呀 👋 我是校园跑跑客服，任何使用问题都可以在这里留言，人工服务时间 9:00 - 22:00。', 120)
  addMsg(cs.id, 'u_self', 'text', '请问提现一般多久能到账呀？', 70)
  addMsg(cs.id, 'u_admin', 'text', '你好～目前平台暂未开通提现功能，赏金会保留在账户余额中，可用于发布跑腿任务。等支付通道开通后会第一时间通知大家 🙌', 60)
  cs.lastText = '你好～目前平台暂未开通提现功能，赏金会保留在账户余额中，可用于发布跑腿任务。等支付通道开通后会第一时间通知大家 🙌'
  convs.push(cs)

  return { version: 1, users, tasks: allTasks, goods, convs, messages, tokens: {}, smsCodes: {}, payOrders: [] }
}

/* =============================== HTTP 框架 =============================== */

class ApiError extends Error {
  constructor(code, msg, status) {
    super(msg || code)
    this.code = code
    this.status = status || 400
  }
}

function E(code, msg, status) {
  throw new ApiError(code, msg, status)
}

const str = (v) => String(v === undefined || v === null ? '' : v).trim()

const ROUTES = []
function route(method, pattern, fn) {
  const keys = []
  const re = new RegExp(
    '^' +
      pattern.replace(/:[a-zA-Z_]+/g, (m) => {
        keys.push(m.slice(1))
        return '([^/]+)'
      }) +
      '$'
  )
  ROUTES.push({ method, re, keys, fn })
}

function requireAuth(ctx) {
  if (!ctx.me) E('noauth', '请先登录', 401)
  return ctx.me
}

function requireAdmin(ctx) {
  const me = requireAuth(ctx)
  if (me.role !== 'admin') E('forbidden', '需要管理员权限', 403)
  return me
}

/* =============================== API 处理器 =============================== */

const CS_GREETING =
  '你好呀 👋 这里是校园跑跑客服中心，请描述你遇到的问题，我们会尽快回复你～（人工服务时间 9:00 - 22:00）'

function pushConvMessage(conv, fromId, kind, text, clientId) {
  const m = {
    id: id('msg'),
    convId: conv.id,
    fromId,
    kind,
    text,
    at: now(),
    clientId: clientId || ''
  }
  DB.messages.push(m)
  conv.lastText = text
  conv.lastAt = m.at
  return m
}

/* ---------------- 健康检查 / 状态页 ---------------- */
route('GET', '/ping', () => ({
  ok: true,
  service: 'campus-runner',
  version: VERSION,
  time: now(),
  users: DB.users.length,
  online: onlineCount()
}))

/* ---------------- 账号 ---------------- */
route('POST', '/api/register', (ctx) => {
  const b = ctx.body || {}
  const phone = str(b.phone)
  const name = str(b.name)
  const password = String(b.password || '')
  const campus = str(b.campus) || '中心校区'
  const school = str(b.school) || '中犇大学'
  if (!/^1[3-9]\d{9}$/.test(phone)) E('badphone', '请输入正确的 11 位手机号')
  if (name.length < 2 || name.length > 12) E('badname', '昵称需为 2-12 个字')
  if (password.length < 6) E('badpwd', '密码至少 6 位')
  if (password.length > 64) E('badpwd', '密码不能超过 64 位')
  if (!checkIpRate(clientIp(ctx.req), 'register', 5, 60 * 60 * 1000)) {
    E('ratelimit', '注册过于频繁，请稍后再试', 429)
  }
  if (DB.users.some((u) => u.phone === phone)) E('exists', '该手机号已注册，请直接登录')
  /* 注册必须通过图形验证码，防止脚本批量注册 */
  consumeCaptcha(ctx.req, b.captchaKey, b.captcha)

  const salt = makeSalt()
  const u = {
    id: id('u'),
    name,
    account: '',
    phone,
    salt,
    passwordHash: hashPwd(password, salt),
    role: 'user',
    status: 'active',
    avatar: avatarFor(name),
    school,
    campus,
    studentNo: '',
    college: '',
    realName: '',
    verified: false,
    verifiedAt: '',
    credit: 90,
    rating: 5,
    finishedOrders: 0,
    publishCount: 0,
    totalEarn: 0,
    balance: 0,
    walletLogs: [],
    joinedAt: now(),
    bio: '这位同学很低调，什么都没写～'
  }
  DB.users.push(u)
  /* 新用户赠送改为平台代金券（不是现金余额，避免「注册送现金」的合规与套利风险）。
     代金券只抵扣跑腿赏金，且不可提现，在发布任务结算时核销。 */
  u.vouchers = [
    { id: id('vc'), amount: 30, title: '新人代金券', used: false, at: now(), expire: now() + 90 * 24 * 3600 * 1000 }
  ]
  const token = issueToken(u)
  saveSoon()
  broadcastAll({ type: 'user', user: pubUser(u) })
  console.log(`[账号] 新用户注册：${name}（${phone}）`)
  return { ok: true, token, user: pubUser(u, { self: true }) }
})

route('POST', '/api/login', (ctx) => {
  const b = ctx.body || {}
  const account = str(b.account)
  const password = String(b.password || '')
  const ipKey = clientIp(ctx.req)
  /* 暴力破解防护：同 IP 10 分钟内最多 20 次登录尝试 */
  if (!checkIpRate(ipKey, 'login', 20, 10 * 60 * 1000)) E('ratelimit', '尝试过于频繁，请 10 分钟后再试', 429)
  const u = findByAccount(account)
  if (!u) E('nouser', '账号不存在，请先注册')
  if (u.status === 'banned') E('banned', '该账号已被禁用，请联系客服')
  if (hashPwd(password, u.salt) !== u.passwordHash) {
    const n = (u.loginFail || 0) + 1
    u.loginFail = n
    if (n >= 5 && !u.lockedUntil) u.lockedUntil = now() + 15 * 60 * 1000
    if (u.lockedUntil && u.lockedUntil > now()) {
      E('locked', '密码错误次数过多，账号已临时锁定 15 分钟', 423)
    }
    saveSoon()
    E('badpwd', `密码不正确，还可尝试 ${Math.max(0, 5 - n)} 次`)
  }
  u.loginFail = 0
  u.lockedUntil = 0
  const token = issueToken(u)
  saveSoon()
  console.log(`[账号] 登录：${u.name}`)
  return { ok: true, token, user: pubUser(u, { self: true }) }
})

route('POST', '/api/captcha', (ctx) => {
  return Object.assign({ ok: true }, newCaptcha(ctx.req))
})

/* 短信接口保留为「未启用」占位：本项目不采购短信服务，
 * 账号验证统一走图形验证码。若将来接入短信网关，在此实现即可。
 * 保留该路由是为了让老版本客户端拿到明确提示，而不是 404 后无限重试。 */
route('POST', '/api/sms-code', () => {
  E('smsdisabled', '本平台暂未开通短信验证码，请使用图形验证码', 400)
})

route('POST', '/api/login-code', () => {
  E('smsdisabled', '本平台暂未开通验证码登录，请使用「账号 + 密码」登录', 400)
})

route('POST', '/api/logout', (ctx) => {
  const token = ctx.token
  if (token && DB.tokens[token]) {
    delete DB.tokens[token]
    saveSoon()
  }
  return { ok: true }
})

/* ---------------- 全量同步 ---------------- */
route('GET', '/api/bootstrap', (ctx) => {
  const me = ctx.me
  const data = {
    ok: true,
    version: VERSION,
    now: now(),
    users: DB.users.map((u) => pubUser(u)),
    tasks: DB.tasks.map(taskDto),
    goods: DB.goods.map(goodsDto)
  }
  if (me) {
    data.me = pubUser(me, { self: true })
    const convs = DB.convs.filter(
      (c) => c.memberIds.indexOf(me.id) > -1 || (me.role === 'admin' && c.type === 'cs')
    )
    data.convs = convs.map(convDto)
    const ids = {}
    convs.forEach((c) => {
      ids[c.id] = 1
    })
    data.messages = DB.messages.filter((m) => ids[m.convId])
    if (me.role === 'admin') data.stats = adminStats()
  } else {
    data.convs = []
    data.messages = []
    data.me = null
  }
  return data
})

route('GET', '/api/me', (ctx) => {
  const me = requireAuth(ctx)
  return { ok: true, user: pubUser(me, { self: true }) }
})

route('POST', '/api/me', (ctx) => {
  const me = requireAuth(ctx)
  const b = ctx.body || {}
  if (b.name !== undefined) {
    const name = str(b.name)
    if (name.length < 2 || name.length > 12) E('badname', '昵称需为 2-12 个字')
    me.name = name
  }
  if (b.campus !== undefined) me.campus = str(b.campus).slice(0, 30) || me.campus
  if (b.school !== undefined) me.school = str(b.school).slice(0, 30) || me.school
  if (b.bio !== undefined) me.bio = str(b.bio).slice(0, 60)
  if (b.gender !== undefined && ['男', '女', '保密'].includes(str(b.gender))) me.gender = str(b.gender)
  if (b.avatar !== undefined) {
    const av = String(b.avatar || '')
    /* 头像只接受 http(s) 地址、本地临时文件路径或 base64 图片，杜绝 javascript: 等注入 */
    if (!av) me.avatar = me.avatar
    else if (/^https?:\/\//i.test(av) || /^data:image\/(png|jpe?g|webp);base64,/i.test(av) || /^\/(static|tmp)\//.test(av)) {
      if (av.length <= 400000) me.avatar = av
    }
  }
  if (Array.isArray(b.places)) {
    me.places = b.places
      .map((x) => String(x || '').trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 6)
  }
  /* 注意：以下字段一律不接受客户端修改，防止越权提权
   *   role / status / credit / balance / verified / walletLogs / id */
  saveSoon()
  broadcastAll({ type: 'user', user: pubUser(me) })
  return { ok: true, user: pubUser(me, { self: true }) }
})

route('POST', '/api/me/verify', (ctx) => {
  const me = requireAuth(ctx)
  const b = ctx.body || {}
  const realName = str(b.name)
  const studentNo = str(b.studentNo)
  if (realName.length < 2 || realName.length > 6 || !/^[\u4e00-\u9fa5]{2,6}$/.test(realName)) {
    E('badname', '请输入 2-6 个汉字的真实姓名')
  }
  if (!/^\d{8,14}$/.test(studentNo)) E('badstudentno', '学号需为 8-14 位数字')
  /* 已被他人认证的学号不允许重复绑定 */
  if (DB.users.some((u) => u.id !== me.id && u.studentNo && u.studentNo === studentNo)) {
    E('duplicated', '该学号已被其他账号认证')
  }
  const firstVerify = !me.verified
  me.name = realName
  me.studentNo = studentNo
  me.college = str(b.college).slice(0, 20)
  me.realName = realName
  me.verified = true
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  me.verifiedAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  /* 信用分只在首次认证时加分 */
  if (firstVerify) me.credit = Math.min(100, (me.credit || 90) + 5)
  saveSoon()
  broadcastAll({ type: 'user', user: pubUser(me) })
  return { ok: true, user: pubUser(me, { self: true }) }
})

/* ---------------- 任务 ---------------- */
route('POST', '/api/tasks', (ctx) => {
  const me = requireAuth(ctx)
  if (me.status === 'banned') E('banned', '该账号已被禁用，请联系客服')
  const b = ctx.body || {}
  const title = str(b.title)
  if (title.length < 4) E('badtitle', '标题至少 4 个字')
  if (!str(b.from)) E('badfrom', '请选择取件地点')
  if (!str(b.to)) E('badto', '请选择送达地点')
  const reward = Number(b.reward) || 0
  const tip = Number(b.tip) || 0
  if (!(reward > 0)) E('badreward', '请填写跑腿赏金')
  const total = reward + tip
  if ((me.balance || 0) < total) E('nobalance', `余额不足，还差 ¥${money(total - (me.balance || 0))}`)

  const t = {
    id: id('task'),
    orderNo: orderNo(),
    type: str(b.type) || 'other',
    title,
    desc: str(b.desc),
    from: str(b.from),
    to: str(b.to),
    campus: str(b.campus) || me.campus,
    reward,
    tip,
    deadline: str(b.deadline),
    publisherId: me.id,
    acceptorId: '',
    status: 'pending',
    hot: 0,
    createdAt: now(),
    acceptedAt: null,
    arrivedAt: null,
    finishedAt: null,
    timeline: [{ status: 'pending', at: now(), text: '已发布，等待同学接单' }],
    rating: null
  }
  DB.tasks.unshift(t)
  me.publishCount = (me.publishCount || 0) + 1
  walletChange(me, -total, `发布跑腿 · ${title}`, 'pay')
  saveSoon()
  broadcastAll({ type: 'task', task: taskDto(t) })
  console.log(`[任务] ${me.name} 发布：${title}（¥${total}）`)
  return { ok: true, task: taskDto(t), users: [pubUser(me, { self: true })] }
})

function taskOp(ctx, op) {
  const me = requireAuth(ctx)
  const t = findTask(ctx.params.id) || E('notfound', '任务不存在')
  const cur = now()

  if (op === 'accept') {
    if (t.publisherId === me.id) E('self', '不能接自己发布的任务')
    if (me.status === 'banned') E('banned', '该账号已被禁用，请联系客服')
    if (t.status !== 'pending') E('taken', '手慢了，这单已被其他同学接走')
    t.acceptorId = me.id
    t.status = 'running'
    t.acceptedAt = cur
    t.hot = (t.hot || 0) + 1
    t.timeline.push({ status: 'running', at: cur, text: `${me.name} 已接单，正在前往` })
  } else if (op === 'arrive') {
    if (t.acceptorId !== me.id) E('forbidden', '只有接单同学可以操作')
    if (t.status !== 'running') E('state', '当前状态不能标记送达')
    t.status = 'arrived'
    t.arrivedAt = cur
    t.timeline.push({ status: 'arrived', at: cur, text: `${me.name} 已送达，等待发布方确认` })
  } else if (op === 'complete') {
    if (t.publisherId !== me.id) E('forbidden', '只有发布方可以确认完成')
    if (t.status !== 'arrived') E('state', '当前状态不能确认完成')
    t.status = 'done'
    t.finishedAt = cur
    t.timeline.push({ status: 'done', at: cur, text: '已完成，感谢你的信任' })
    const total = t.reward + t.tip
    const acc = findUserById(t.acceptorId)
    if (acc) {
      walletChange(acc, total, `跑腿收入 · ${t.title}`, 'earn')
      acc.totalEarn = Math.round(((acc.totalEarn || 0) + total) * 100) / 100
      acc.finishedOrders = (acc.finishedOrders || 0) + 1
      acc.credit = Math.min(100, (acc.credit || 90) + 1)
      saveSoon()
      broadcastAll({ type: 'user', user: pubUser(acc) })
    }
  } else if (op === 'cancel') {
    if (t.publisherId !== me.id && t.acceptorId !== me.id) E('forbidden', '无权操作该任务')
    if (t.status !== 'pending' && t.status !== 'running') E('state', '当前状态不能取消')
    t.status = 'canceled'
    t.finishedAt = cur
    t.timeline.push({ status: 'canceled', at: cur, text: str((ctx.body || {}).reason) || '发布方取消' })
    const pub = findUserById(t.publisherId)
    if (pub) {
      walletChange(pub, t.reward + t.tip, `退款 · ${t.title}`, 'refund')
      saveSoon()
      broadcastAll({ type: 'user', user: pubUser(pub) })
    }
  } else if (op === 'rate') {
    if (t.publisherId !== me.id) E('forbidden', '只有发布方可以评价')
    if (t.status !== 'done') E('state', '完成后才能评价')
    const score = Math.max(1, Math.min(5, Number((ctx.body || {}).score) || 5))
    const text = str((ctx.body || {}).text) || '好评'
    t.rating = { score, text }
    t.timeline.push({ status: 'rate', at: cur, text: `已评价 ${score} 星` })
  } else {
    E('badop', '未知操作')
  }

  saveSoon()
  broadcastAll({ type: 'task', task: taskDto(t) })
  const users = []
  const pub = findUserById(t.publisherId)
  const acc = t.acceptorId ? findUserById(t.acceptorId) : null
  if (pub) users.push(pubUser(pub))
  if (acc) users.push(pubUser(acc))
  return { ok: true, task: taskDto(t), users }
}

route('POST', '/api/tasks/:id/accept', (ctx) => taskOp(ctx, 'accept'))
route('POST', '/api/tasks/:id/arrive', (ctx) => taskOp(ctx, 'arrive'))
route('POST', '/api/tasks/:id/complete', (ctx) => taskOp(ctx, 'complete'))
route('POST', '/api/tasks/:id/cancel', (ctx) => taskOp(ctx, 'cancel'))
route('POST', '/api/tasks/:id/rate', (ctx) => taskOp(ctx, 'rate'))

route('POST', '/api/tasks/:id/remove', (ctx) => {
  requireAdmin(ctx)
  const i = DB.tasks.findIndex((t) => t.id === ctx.params.id)
  if (i < 0) E('notfound', '任务不存在')
  DB.tasks.splice(i, 1)
  saveSoon()
  broadcastAll({ type: 'taskDeleted', id: ctx.params.id })
  return { ok: true }
})

/* ---------------- 二手商品 ---------------- */
route('POST', '/api/goods', (ctx) => {
  const me = requireAuth(ctx)
  if (me.status === 'banned') E('banned', '该账号已被禁用，请联系客服')
  const b = ctx.body || {}
  const title = str(b.title)
  if (title.length < 4) E('badtitle', '标题至少 4 个字')
  const price = Number(b.price) || 0
  if (!(price > 0)) E('badprice', '请填写正确的价格')
  const g = {
    id: id('goods'),
    title,
    cat: str(b.cat) || 'other',
    price,
    origin: Number(b.origin) || price,
    cond: str(b.cond) || 'good',
    imgs: Array.isArray(b.imgs) ? b.imgs.slice(0, 9) : [],
    cover: Array.isArray(b.imgs) && b.imgs.length ? b.imgs[0] : '',
    campus: str(b.campus) || me.campus,
    sellerId: me.id,
    views: 0,
    wants: 0,
    desc: str(b.desc),
    status: 'on',
    createdAt: now()
  }
  DB.goods.unshift(g)
  me.publishCount = (me.publishCount || 0) + 1
  saveSoon()
  broadcastAll({ type: 'goods', goods: goodsDto(g) })
  console.log(`[市集] ${me.name} 发布：${title}（¥${price}）`)
  return { ok: true, goods: goodsDto(g) }
})

route('POST', '/api/goods/:id/toggle', (ctx) => {
  const me = requireAuth(ctx)
  const g = findGoods(ctx.params.id) || E('notfound', '商品不存在')
  if (g.sellerId !== me.id && me.role !== 'admin') E('forbidden', '无权操作')
  g.status = g.status === 'on' ? 'off' : 'on'
  saveSoon()
  broadcastAll({ type: 'goods', goods: goodsDto(g) })
  return { ok: true, goods: goodsDto(g) }
})

route('POST', '/api/goods/:id/want', (ctx) => {
  requireAuth(ctx)
  const g = findGoods(ctx.params.id) || E('notfound', '商品不存在')
  g.wants = (g.wants || 0) + 1
  saveSoon()
  broadcastAll({ type: 'goods', goods: goodsDto(g) })
  return { ok: true, goods: goodsDto(g) }
})

route('POST', '/api/goods/:id/remove', (ctx) => {
  const me = requireAuth(ctx)
  const g = findGoods(ctx.params.id) || E('notfound', '商品不存在')
  if (g.sellerId !== me.id && me.role !== 'admin') E('forbidden', '无权操作')
  const i = DB.goods.findIndex((x) => x.id === g.id)
  DB.goods.splice(i, 1)
  saveSoon()
  broadcastAll({ type: 'goodsDeleted', id: g.id })
  return { ok: true }
})

/* ---------------- 会话与消息 ---------------- */
route('POST', '/api/convs/open', (ctx) => {
  const me = requireAuth(ctx)
  const b = ctx.body || {}
  const targetId = str(b.targetId)
  const target = findUserById(targetId) || E('notarget', '对方用户不存在')
  if (target.id === me.id) E('self', '不能和自己发起会话')
  const kind = str(b.kind)
  const cid = str(b.id)

  let conv = DB.convs.find(
    (c) => c.memberIds.indexOf(me.id) > -1 && c.memberIds.indexOf(target.id) > -1
  )
  const freshSystemMsgs = []
  if (!conv) {
    conv = {
      id: id('conv'),
      type: target.role === 'admin' ? 'cs' : 'user',
      memberIds: [me.id, target.id],
      contextKind: kind,
      contextId: cid,
      lastText: '',
      lastAt: now(),
      readAt: {},
      createdAt: now()
    }
    DB.convs.push(conv)
    if (conv.type === 'cs') {
      freshSystemMsgs.push(pushConvMessage(conv, null, 'system', CS_GREETING))
    } else {
      freshSystemMsgs.push(
        pushConvMessage(conv, null, 'system', `你与 ${target.name} 的会话已创建，请注意保护个人隐私～`)
      )
    }
  } else if (cid && (conv.contextId !== cid || conv.contextKind !== kind)) {
    conv.contextKind = kind
    conv.contextId = cid
  }
  saveSoon()
  broadcastMembers(conv, { type: 'conv', conv: convDto(conv) })
  freshSystemMsgs.forEach((m) => {
    broadcastMembers(conv, { type: 'message', conv: convDto(conv), message: m })
  })
  return { ok: true, conv: convDto(conv) }
})

route('POST', '/api/convs/:id/read', (ctx) => {
  const me = requireAuth(ctx)
  const conv = findConv(ctx.params.id) || E('notfound', '会话不存在')
  if (conv.memberIds.indexOf(me.id) < 0) E('forbidden', '无权操作')
  conv.readAt = conv.readAt || {}
  conv.readAt[me.id] = now()
  saveSoon()
  return { ok: true }
})

route('GET', '/api/convs/:id/messages', (ctx) => {
  const me = requireAuth(ctx)
  const conv = findConv(ctx.params.id) || E('notfound', '会话不存在')
  if (conv.memberIds.indexOf(me.id) < 0 && me.role !== 'admin') E('forbidden', '无权查看')
  return { ok: true, messages: DB.messages.filter((m) => m.convId === conv.id) }
})

route('POST', '/api/convs/:id/messages', (ctx) => {
  const me = requireAuth(ctx)
  const conv = findConv(ctx.params.id) || E('notfound', '会话不存在')
  if (conv.memberIds.indexOf(me.id) < 0) E('forbidden', '无权发言')
  if (me.status === 'banned') E('banned', '该账号已被禁用，无法发送消息')
  let text = String((ctx.body || {}).text || '').trim()
  if (!text) E('empty', '消息不能为空')
  if (text.length > 1000) text = text.slice(0, 1000)
  const clientId = str((ctx.body || {}).clientId)
  const m = pushConvMessage(conv, me.id, 'text', text, clientId)
  conv.readAt = conv.readAt || {}
  conv.readAt[me.id] = m.at
  saveSoon()
  broadcastMembers(conv, { type: 'message', conv: convDto(conv), message: m })
  return { ok: true, message: m, conv: convDto(conv) }
})

/* ---------------- 钱包（余额托管） ----------------
 * 设计：客户端**永远不能直接改余额**，只能「提交申请」。钱的真正变动只发生在
 * 管理员审核通过的那一刻，由服务端调用 walletChange() 完成。
 *
 *   充值：用户转账给平台 → 提交申请（金额 + 转账单号 + 备注）
 *         → 管理员在后台核对银行/支付宝流水 → 确认到账 → 入账
 *   提现：用户提交申请（金额 + 收款方式）→ 管理员线下打款
 *         → 后台标记已完成 → 扣减余额
 *
 * 这样既堵死了「客户端伪造加钱」，也不需要支付商户号即可运营。 */
const PAY_MIN = 1
const PAY_MAX = 5000
const PAY_REMARK_MAX = 120
const RECHARGE_METHODS = ['wechat', 'alipay', 'bank']
const RECHARGE_METHOD_NAME = { wechat: '微信转账', alipay: '支付宝', bank: '银行卡' }

function payDto(o) {
  const u = findUserById(o.userId)
  const copy = Object.assign({}, o)
  copy.userName = u ? u.name : '（已注销）'
  copy.userPhone = u ? u.phone : ''
  copy.methodName = RECHARGE_METHOD_NAME[o.method] || o.method || ''
  return copy
}

function parseAmount(v) {
  const n = Number(v)
  if (!isFinite(n)) E('badamount', '请输入正确的金额')
  const amt = Math.round(n * 100) / 100
  if (amt < PAY_MIN) E('badamount', `单笔金额不能少于 ${PAY_MIN} 元`)
  if (amt > PAY_MAX) E('badamount', `单笔金额不能超过 ${PAY_MAX} 元`)
  return amt
}

/* 提交充值申请 */
route('POST', '/api/wallet/recharge', (ctx) => {
  const me = requireAuth(ctx)
  const b = ctx.body || {}
  const amount = parseAmount(b.amount)
  const method = str(b.method)
  if (RECHARGE_METHODS.indexOf(method) < 0) E('badmethod', '请选择转账方式')
  const tradeNo = str(b.tradeNo)
  if (tradeNo.length < 4) E('badtradeno', '请填写转账单号后 4 位以上，便于客服核对')
  if (tradeNo.length > 64) E('badtradeno', '转账单号过长')
  const remark = str(b.remark).slice(0, PAY_REMARK_MAX)

  if (!checkIpRate(clientIp(ctx.req), 'recharge', 10, 60 * 60 * 1000)) {
    E('ratelimit', '提交过于频繁，请稍后再试', 429)
  }
  const pending = DB.payOrders.filter(
    (o) => o.userId === me.id && o.kind === 'recharge' && o.status === 'pending'
  )
  if (pending.length >= 3) E('toomany', '你已有多笔充值待审核，请等待客服处理后再提交')

  const o = {
    id: id('pay'),
    kind: 'recharge',
    userId: me.id,
    amount,
    method,
    tradeNo,
    remark,
    status: 'pending',
    createdAt: now(),
    reviewedAt: 0,
    reviewedBy: '',
    reviewRemark: ''
  }
  DB.payOrders.unshift(o)
  saveSoon()
  console.log(`[充值] ${me.name} 申请充值 ${money(amount)} 元（${RECHARGE_METHOD_NAME[method]} ${tradeNo}）`)
  return { ok: true, order: payDto(o), msg: '申请已提交，客服核对到账后会自动入账' }
})

/* 提交提现申请 */
route('POST', '/api/wallet/withdraw', (ctx) => {
  const me = requireAuth(ctx)
  const b = ctx.body || {}
  const amount = parseAmount(b.amount)
  const target = str(b.target)
  if (target.length < 2) E('badtarget', '请填写收款方式（如「支付宝 138****0000」）')
  if (target.length > 64) E('badtarget', '收款方式过长')
  if (!me.verified) E('needverify', '提现前需先完成校园认证')
  const avail = Number(me.balance || 0)
  if (amount > avail) E('nobalance', `可提现余额不足（当前 ${money(avail)} 元）`)

  if (!checkIpRate(clientIp(ctx.req), 'withdraw', 10, 60 * 60 * 1000)) {
    E('ratelimit', '提交过于频繁，请稍后再试', 429)
  }
  const pending = DB.payOrders.filter(
    (o) => o.userId === me.id && o.kind === 'withdraw' && o.status === 'pending'
  )
  if (pending.length) E('toomany', '你已有一笔提现待处理，请等待客服打款')
  /* 冻结：提交即扣减，避免用户提交后又把钱花掉导致重复提现。
   * 审核拒绝时原路退回。 */
  const hold = pending.reduce((s, o) => s + Number(o.amount || 0), 0)
  if (amount + hold > avail) E('nobalance', '可提现余额不足')

  walletChange(me, -amount, '提现申请（待打款）', 'withdraw')
  const o = {
    id: id('pay'),
    kind: 'withdraw',
    userId: me.id,
    amount,
    method: 'offline',
    tradeNo: '',
    remark: '',
    target,
    status: 'pending',
    createdAt: now(),
    reviewedAt: 0,
    reviewedBy: '',
    reviewRemark: ''
  }
  DB.payOrders.unshift(o)
  saveSoon()
  broadcastAll({ type: 'user', user: pubUser(me, { self: true }) })
  console.log(`[提现] ${me.name} 申请提现 ${money(amount)} 元 → ${target}`)
  return { ok: true, order: payDto(o), msg: '提现申请已提交，客服将在 1-3 个工作日内打款' }
})

/* 我的资金申请列表 */
route('GET', '/api/wallet/orders', (ctx) => {
  const me = requireAuth(ctx)
  return {
    ok: true,
    orders: DB.payOrders.filter((o) => o.userId === me.id).slice(0, 50).map(payDto)
  }
})

/* 充值收款信息（展示给用户，让用户按此转账） */
route('GET', '/api/wallet/payinfo', () => ({
  ok: true,
  info: {
    min: PAY_MIN,
    max: PAY_MAX,
    methods: RECHARGE_METHODS.map((m) => ({ key: m, name: RECHARGE_METHOD_NAME[m] })),
    accounts: [
      { method: 'wechat', label: '微信转账', value: process.env.CAMPUS_PAY_WECHAT || '联系客服获取' },
      { method: 'alipay', label: '支付宝', value: process.env.CAMPUS_PAY_ALIPAY || '联系客服获取' },
      { method: 'bank', label: '银行卡', value: process.env.CAMPUS_PAY_BANK || '联系客服获取' }
    ],
    notice: '转账时请在备注里写上你的手机号，客服核对到账后 30 分钟内入账。'
  }
}))

/* 旧的 /api/wallet 保留为明确报错，避免老版本客户端静默失败 */
route('POST', '/api/wallet', (ctx) => {
  requireAuth(ctx)
  E('payclosed', '请使用「账户充值」「申请提现」页面提交申请', 400)
})


/* ---------------- 管理端 ---------------- */
route('GET', '/api/admin/stats', (ctx) => {
  requireAdmin(ctx)
  return { ok: true, stats: adminStats() }
})

route('POST', '/api/admin/users/:id/status', (ctx) => {
  requireAdmin(ctx)
  const u = findUserById(ctx.params.id) || E('notfound', '用户不存在')
  if (u.role === 'admin') E('forbidden', '不能操作管理员账号')
  u.status = u.status === 'banned' ? 'active' : 'banned'
  saveSoon()
  broadcastAll({ type: 'user', user: pubUser(u) })
  console.log(`[管理] ${u.name} 状态变更为 ${u.status === 'banned' ? '禁用' : '正常'}`)
  return { ok: true, user: pubUser(u) }
})

/* 资金申请列表（管理员） */
route('GET', '/api/admin/payorders', (ctx) => {
  requireAdmin(ctx)
  const q = str(ctx.query.get('status')) // pending | done | rejected | all
  let list = DB.payOrders
  if (q && q !== 'all') list = list.filter((o) => o.status === q)
  const counts = {
    recharge: DB.payOrders.filter((o) => o.kind === 'recharge' && o.status === 'pending').length,
    withdraw: DB.payOrders.filter((o) => o.kind === 'withdraw' && o.status === 'pending').length
  }
  return { ok: true, orders: list.slice(0, 200).map(payDto), counts }
})

/* 审核资金申请：通过 / 拒绝
 *  - 充值通过 → 给用户加余额
 *  - 提现通过 → 余额已在提交时扣减，这里只改状态
 *  - 任何拒绝 → 充值不动余额；提现把冻结的金额原路退回 */
route('POST', '/api/admin/payorders/:id/review', (ctx) => {
  const admin = requireAdmin(ctx)
  const b = ctx.body || {}
  const action = str(b.action) // approve | reject
  if (action !== 'approve' && action !== 'reject') E('badaction', '操作类型不正确')
  const o = DB.payOrders.find((x) => x.id === ctx.params.id) || E('notfound', '申请不存在')
  if (o.status !== 'pending') E('done', '该申请已处理过，不能重复操作')

  const u = findUserById(o.userId) || E('nouser', '申请人不存在')
  const note = str(b.note).slice(0, 100)

  if (action === 'approve') {
    if (o.kind === 'recharge') {
      walletChange(u, o.amount, `充值到账（${RECHARGE_METHOD_NAME[o.method] || o.method}）`, 'recharge')
    } else {
      /* 提现：钱在提交时就已扣，这里无需再动余额；补一条流水便于对账 */
      if (!Array.isArray(u.walletLogs)) u.walletLogs = []
      u.walletLogs.unshift({
        id: id('log'),
        type: 'withdraw',
        amount: 0,
        title: `提现已打款 ¥${money(o.amount)}`,
        time: now(),
        balance: u.balance
      })
    }
    o.status = 'done'
  } else {
    if (o.kind === 'withdraw') {
      walletChange(u, o.amount, '提现被驳回，已退回余额', 'refund')
    }
    o.status = 'rejected'
  }
  o.reviewedAt = now()
  o.reviewedBy = admin.name
  o.reviewRemark = note
  saveSoon()
  broadcastAll({ type: 'user', user: pubUser(u, { self: true }) })
  console.log(
    `[审核] ${admin.name} ${action === 'approve' ? '通过' : '驳回'} ${u.name} 的` +
      `${o.kind === 'recharge' ? '充值' : '提现'} ${money(o.amount)} 元`
  )
  return { ok: true, order: payDto(o), user: pubUser(u, { self: true }) }
})

/* =============================== 请求分发 =============================== */

/* 请求体读取：超过 1MB 时停止累积并返回 413。
 * 注意：不能在 reject 之后立刻 req.destroy()，否则响应还没写回连接就被断开，
 * 客户端只会看到 ECONNRESET。这里改为「不再累积 + 丢弃剩余数据 + 正常 reject」。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (fn, arg) => {
      if (done) return
      done = true
      fn(arg)
    }
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > 1024 * 1024) {
        chunks.length = 0
        req.resume() // 丢弃剩余请求体，保持连接可读
        finish(reject, new ApiError('toobig', '请求体过大', 413))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks)))
    req.on('error', (e) => finish(reject, e))
    req.on('aborted', () => finish(reject, new ApiError('aborted', '请求已中断', 400)))
  })
}

/* ---------------- 安全辅助：来源白名单与限流 ---------------- */
/* 来源白名单：默认只允许本机 H5 调试与 App 内置网页（file://、app://、localhost）。
 * 如需对外开放，用环境变量显式配置：
 *   CAMPUS_ORIGINS=https://app.example.com,https://h5.example.com node server.js */
const ALLOWED_ORIGINS = (() => {
  const raw = String(process.env.CAMPUS_ORIGINS || '').trim()
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'file://',
    'app://'
  ]
})()

/* 回环地址：App 内置的 H5 由 127.0.0.1 上的本地服务提供，端口是启动时随机挑选的，
 * 因此不能按固定端口白名单判断，必须放行任意端口的 loopback 源。
 * 安全性说明：本服务的鉴权走 Authorization: Bearer（不依赖 Cookie），
 * 不存在被任意网站借 Cookie 发起 CSRF 的空间，放行回环源不会扩大攻击面。 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

function isAllowedOrigin(origin) {
  if (!origin) return true // App / 小程序 / 服务端直连，无 Origin
  if (origin === 'null') return true // 部分 WebView 在本地页面下会发送 Origin: null
  if (LOOPBACK_ORIGIN_RE.test(origin)) return true
  if (ALLOWED_ORIGINS.indexOf('*') > -1) return true
  if (ALLOWED_ORIGINS.indexOf(origin) > -1) return true
  return ALLOWED_ORIGINS.some((a) => origin.indexOf(a) === 0)
}

function corsHeadersFor(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  }
  if (origin && isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

/* 简易滑动窗口限流：key -> 时间戳数组 */
const RATE_BUCKETS = new Map()
function checkIpRate(key, action, limit, windowMs) {
  const k = action + '|' + (key || 'unknown')
  const cur = now()
  let arr = RATE_BUCKETS.get(k)
  if (!arr) {
    arr = []
    RATE_BUCKETS.set(k, arr)
  }
  while (arr.length && cur - arr[0] > windowMs) arr.shift()
  if (arr.length >= limit) return false
  arr.push(cur)
  if (RATE_BUCKETS.size > 5000) {
    /* 防止内存膨胀：超过阈值时清掉空桶 */
    for (const [kk, vv] of RATE_BUCKETS) if (!vv.length) RATE_BUCKETS.delete(kk)
  }
  return true
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown'
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
}

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj)
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    },
    corsHeadersFor(origin)
  )
  try {
    res.writeHead(status, headers)
    res.end(body)
  } catch (_) {}
}

function stamp() {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function handleHttp(req, res) {
  const t0 = Date.now()
  const reqPath = (req.url || '').split('?')[0]
  const origin = String(req.headers.origin || '')

  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('origin not allowed')
      return
    }
    res.writeHead(204, corsHeadersFor(origin))
    res.end()
    return
  }

  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch (e) {
    sendJson(res, 400, { ok: false, code: 'badurl', msg: '请求地址错误' }, origin)
    return
  }
  let pathname = url.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch (_) {}

  /* 状态页：浏览器直接打开服务器地址时展示 */
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = statusPage()
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(html)
    return
  }

  /* 路由匹配 */
  let def = null
  let mm = null
  for (let i = 0; i < ROUTES.length; i++) {
    const r = ROUTES[i]
    if (r.method !== req.method) continue
    const m = r.re.exec(pathname)
    if (m) {
      def = r
      mm = m
      break
    }
  }
  if (!def) {
    sendJson(res, 404, { ok: false, code: 'notfound', msg: '接口不存在' }, origin)
    return
  }

  /* 全局接口限流：单 IP 每分钟最多 240 次请求 */
  if (!checkIpRate(clientIp(req), 'api', 240, 60 * 1000)) {
    sendJson(res, 429, { ok: false, code: 'ratelimit', msg: '请求过于频繁，请稍后再试' }, origin)
    return
  }

  const params = {}
  def.keys.forEach((k, i) => {
    params[k] = mm[i + 1]
  })

  /* 请求体 */
  let body = {}
  if (req.method === 'POST') {
    try {
      const raw = await readBody(req)
      if (raw.length) body = JSON.parse(raw.toString('utf8'))
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}
    } catch (e) {
      if (e instanceof ApiError) {
        sendJson(res, e.status, { ok: false, code: e.code, msg: e.message }, origin)
      } else {
        sendJson(res, 400, { ok: false, code: 'badjson', msg: '请求格式错误' }, origin)
      }
      return
    }
  }

  const token =
    String(req.headers['authorization'] || '')
      .replace(/^Bearer\s+/i, '')
      .trim() ||
    url.searchParams.get('token') ||
    ''
  const me = userByToken(token)
  const ctx = { req, res, params, body, query: url.searchParams, me, token, origin }

  let status = 200
  try {
    const out = def.fn(ctx)
    const result = out && typeof out.then === 'function' ? await out : out
    sendJson(res, 200, result, origin)
  } catch (e) {
    if (e instanceof ApiError) {
      status = e.status
      sendJson(res, e.status, { ok: false, code: e.code, msg: e.message }, origin)
    } else {
      status = 500
      console.error(`[错误] ${req.method} ${reqPath}`, e)
      sendJson(res, 500, { ok: false, code: 'servererror', msg: '服务器内部错误' }, origin)
    }
  }

  if (pathname.startsWith('/api/') && pathname !== '/api/bootstrap') {
    console.log(`[${stamp()}] ${req.method} ${reqPath} → ${status} (${Date.now() - t0}ms)`)
  }
}

/* =============================== 状态页 =============================== */

function lanIPs() {
  const list = []
  const ifs = os.networkInterfaces()
  Object.keys(ifs).forEach((name) => {
    ;(ifs[name] || []).forEach((it) => {
      if (it.family === 'IPv4' && !it.internal) list.push(it.address)
    })
  })
  return list
}

function statusPage() {
  const ips = lanIPs()
  const up = Math.floor(process.uptime())
  const upText = up < 60 ? `${up} 秒` : up < 3600 ? `${Math.floor(up / 60)} 分钟` : `${(up / 3600).toFixed(1)} 小时`
  const s = adminStats()
  const addrItems = ips.length
    ? ips.map((ip) => `<li><code>http://${ip}:${PORT}</code></li>`).join('')
    : '<li>（未检测到局域网地址，请确认电脑已连接 WiFi / 网线）</li>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>校园跑跑 · 服务器</title>
<style>
  body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f6f9;color:#16181d;margin:0;padding:40px 20px}
  .card{max-width:640px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 10px 40px rgba(22,24,29,.08)}
  h1{font-size:24px;margin:0 0 6px} .sub{color:#8b93a7;font-size:14px;margin-bottom:20px}
  .badge{display:inline-block;background:#e6f9f2;color:#0ca678;font-weight:700;font-size:13px;border-radius:999px;padding:4px 12px;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}
  .cell{background:#f5f6f9;border-radius:12px;padding:12px;text-align:center}
  .num{font-size:20px;font-weight:800;color:#ff5b2e} .lab{font-size:12px;color:#8b93a7;margin-top:4px}
  h2{font-size:16px;margin:22px 0 8px}
  ul{padding-left:20px;line-height:2} code{background:#f1f3f7;border-radius:6px;padding:2px 8px;font-size:14px}
  .tip{background:#fff7e6;border-radius:12px;padding:14px 16px;font-size:13px;color:#7a5b1e;line-height:1.8}
  .foot{margin-top:22px;color:#b9bfcc;font-size:12px;text-align:center}
</style></head><body><div class="card">
  <div class="badge">● 服务运行中</div>
  <h1>🛵 校园跑跑 · 后端服务器</h1>
  <div class="sub">v${VERSION} · 端口 ${PORT} · 已运行 ${upText}</div>
  <div class="grid">
    <div class="cell"><div class="num">${s.users}</div><div class="lab">注册用户</div></div>
    <div class="cell"><div class="num">${onlineCount()}</div><div class="lab">在线设备</div></div>
    <div class="cell"><div class="num">${s.tasks}</div><div class="lab">任务</div></div>
    <div class="cell"><div class="num">${s.messages}</div><div class="lab">消息</div></div>
  </div>
  <h2>📱 在 App 中填写以下地址</h2>
  <ul>${addrItems}</ul>
  <div class="tip">
    ① 手机与电脑需连接<strong>同一个 WiFi / 热点</strong>；<br>
    ② App 登录页底部点「⚙ 服务器设置」，填入上方地址并保存；<br>
    ③ 两台手机填写同一个地址，即可实时聊天、共享任务与市集。
  </div>
  <div class="foot">校园跑跑 · 让校园里的每一件小事都有人顺路帮你</div>
</div></body></html>`
}

/* =============================== 启动 =============================== */

loadDB()

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    console.error('[错误] 未捕获异常：', e)
    try {
      sendJson(res, 500, { ok: false, code: 'servererror', msg: '服务器内部错误' })
    } catch (_) {}
  })
})

server.on('upgrade', (req, socket) => handleUpgrade(req, socket))

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n!! 端口 ${PORT} 已被占用，请换一个端口运行，例如：node server.js 3001\n`)
    process.exit(1)
  }
  console.error('[错误]', e)
})

server.listen(PORT, () => {
  const ips = lanIPs()
  console.log('')
  console.log('  🛵 校园跑跑 · 后端服务器已启动')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  本机地址   http://127.0.0.1:${PORT}`)
  ips.forEach((ip) => console.log(`  局域网地址 http://${ip}:${PORT}   ← 手机 App 里填这个`))
  console.log(`  数据文件   ${DATA_FILE}`)
  console.log('  ─────────────────────────────────────────────')
  console.log('  管理员账号 202325817')
  if (ADMIN_PASSWORD_HINT) {
    console.log(`  初始口令   ${ADMIN_PASSWORD_HINT}`)
    console.log('             （本次随机生成，仅显示一次；请立即登录后修改，')
    console.log('               或设置环境变量 CAMPUS_ADMIN_PASSWORD 固定口令）')
  } else {
    console.log('  初始口令   已由环境变量 CAMPUS_ADMIN_PASSWORD 指定')
  }
  console.log('  ─────────────────────────────────────────────')
  console.log('  手机与电脑连同一个 WiFi（或热点），在 App「服务器设置」')
  console.log(`  中填入上方局域网地址（含 http:// 和端口），两台手机相同即可。`)
  if (process.env.CAMPUS_DEV === '1') {
    console.log('')
    console.log('  ⚠ 当前为开发模式（CAMPUS_DEV=1）：接口会回传短信校验码，请勿用于生产环境！')
  }
  console.log('')
})

/* 供测试脚本复用：导出 server 与内部工具，正常 `node server.js` 运行时不受影响 */
module.exports = { server, PORT, DB: () => DB, newCaptcha, consumeCaptcha, CAPTCHAS }
