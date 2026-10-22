/**
 * tools/_check-dm-session.mjs —— 「私信回复续在同一条会话上」的本地回归（**不花 token、不碰真 B站、不用真 dsh**）
 *
 * 怎么做到不用真东西：
 *   · `dshBin` 指到一个**假 dsh**（findDshCli ① 认它）—— 它只做一件事：在会话桶里建一条 `session-fake-*`
 *     （或者，带 `--session-id` 时检查那条**已经在盘上**），然后把 argv 记到日志里；
 *   · `fetch` 被换掉：只认「会话列表 / 读消息」两个 URL，回一份假数据；
 *   · 私信那一跳的间隔用 `BILI_DUTY_DM_TICK_SEC=1` 压成 1 秒（那个环境变量只为这种预检存在）。
 *
 * 验的六件事：
 *   ① 值班轮**不带** `--session-id`、也不碰 dm-session.json（上一版的 sessionMode 确实撤掉了）
 *   ② 第一条私信：新开一条，跑完把 id + 「回给谁」记进 dm-session.json
 *   ③ 第二条私信（还是同一个人）：**续在同一条**上，且桶里**不多**一条会话
 *   ④ 换了回给谁：另开一条，不把上一个人的聊天记录带进新对话
 *   ⑤ 记的那条被删掉：下一跳重新开一条并改记新 id（自愈）
 *   ⑥ 私信回复还在跑：值班轮被挡住（`started:false`）—— 两条同时写一个会话会撞 `session.lock`
 *
 * 用法：`node tools/_check-dm-session.mjs`（约 15 秒；退出码 0 = 全过）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const HOME = join(tmpdir(), 'dsh-bili-scroll-check-dm')
const STATE = join(HOME, 'bili-duty')
const BUCKET_DIR = join(HOME, 'sessions', '--' + STATE.replace(/^\//, '').replace(/\//g, '-') + '--')
const FAKE = join(HOME, 'fake-dsh.mjs')
const FAKE_LOG = join(HOME, 'fake-dsh.log')
const SLOW_FLAG = join(HOME, 'slow')

rmSync(HOME, { recursive: true, force: true })
mkdirSync(STATE, { recursive: true })
mkdirSync(BUCKET_DIR, { recursive: true })

// ── 假 dsh：只记账 + 建/认会话目录（带 --session-id 时那条必须已经在盘上，否则像 DSH 一样 exit 1）──
writeFileSync(FAKE, `
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const LOG = ${JSON.stringify(FAKE_LOG)}
const BUCKET = ${JSON.stringify(BUCKET_DIR)}
const SLOW = ${JSON.stringify(SLOW_FLAG)}
const argv = process.argv.slice(2)
const say = (o) => appendFileSync(LOG, JSON.stringify({
  ...o,
  isDm: argv.some((a) => a.includes('私信里发来')),
  short: argv.map((a) => (a.length > 40 ? a.slice(0, 40) + '…' : a)),
}) + '\\n')
say({ begin: true })
if (existsSync(SLOW)) await new Promise((r) => setTimeout(r, Number(readFileSync(SLOW, 'utf8')) || 3000))
const i = argv.indexOf('--session-id')
if (i >= 0) {
  const want = argv[i + 1]
  if (!existsSync(join(BUCKET, want))) { say({ adoptMissing: want }); process.exit(1) }
  say({ adopted: want }); process.exit(0)
}
const id = 'session-fake-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 6)
mkdirSync(join(BUCKET, id), { recursive: true })
say({ created: id }); process.exit(0)
`)

const cfg = {
  dshBin: FAKE, dmWatch: true, dmWatchMinutes: 1, dmReplyPerDay: 5, dmOwnerUid: 42,
  peakValley: false, perDay: 5,
  _set: ['dshBin', 'dmWatch', 'dmWatchMinutes', 'dmReplyPerDay', 'dmOwnerUid', 'peakValley', 'perDay'],
}
writeFileSync(join(STATE, 'config.json'), JSON.stringify(cfg, null, 2))
writeFileSync(join(STATE, 'bili_credential.json'), JSON.stringify({ sessdata: 'fake', bili_jct: 'fake', buvid3: 'fake', dedeuserid: '999' }))
// 先记成"这条已经回过了"⇒ 私信那一跳不会自己开跑，全由下面 nextKey 控制
writeFileSync(join(STATE, 'dm-seen.json'), JSON.stringify({ 42: 'seen-k' }))

// ── 假 B站：只拦两个 URL ──
const realFetch = globalThis.fetch
let talkerUid = 42            // 「你本人」那个号（换人那一验会改它）
let nextKey = null            // 设成非空 = "现在有一条新消息"，跳一次就回一条
globalThis.fetch = async (url) => {
  const u = String(url)
  const json = (obj) => ({ status: 200, json: async () => obj })
  if (u.includes('get_sessions')) {
    return json({ code: 0, data: { session_list: [{ talker_id: talkerUid, unread_count: 1, last_msg: { content: JSON.stringify({ content: '在吗' }), timestamp: 1 } }] } })
  }
  if (u.includes('fetch_session_msgs')) {
    return json({ code: 0, data: { messages: [{ msg_type: 1, content: JSON.stringify({ content: '问一句' }), msg_key: nextKey || 'seen-k', timestamp: 1, sender_uid: talkerUid }] } })
  }
  throw new Error('预检里不该访问：' + u.slice(0, 80))
}

// ── 起插件（假 ctx：真给 HTTP 路由和工具）──
process.env.DSH_HOME = HOME
process.env.BILI_DUTY_DM_TICK_SEC = '1'          // 私信那一跳：1 秒（只为预检）
let handler = null
const mod = await import(join(import.meta.dirname, '..', 'index.js'))
mod.apply({
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(HOME, ...seg) : undefined),
  logger: { info() {}, warn() {} },
  tools: { register: (t) => t },
  webServer: { register: (o) => { handler = (typeof o === 'function' ? o : o?.handler); return { dispose() {} } } },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject() {}, register: () => ({}) },
}, {})

const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://x')))
await new Promise((r) => server.listen(0, r))
const base = 'http://127.0.0.1:' + server.address().port
const POST = async (p, body) => (await realFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json()

const logLines = () => (existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const dmRuns = () => logLines().filter((l) => l.isDm && !l.begin)          // 私信那一条的收尾行
const dmBegins = () => logLines().filter((l) => l.isDm && l.begin)
const dmRec = () => { try { return JSON.parse(readFileSync(join(STATE, 'dm-session.json'), 'utf8')) } catch { return null } }
const dirs = () => { try { return readdirSync(BUCKET_DIR).filter((n) => n.startsWith('session-')).sort() } catch { return [] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let bad = 0
const check = (ok, label, extra) => { console.log((ok ? '✓ ' : '✗ ') + label + (extra ? '  ' + extra : '')); if (!ok) bad += 1 }
const until = async (fn, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200) } console.log('… 等超时：' + label); return false }

try {
  /* ① 值班轮 */
  const r1 = await POST('/api/bili-duty/run', { mode: 'A' })
  await until(() => logLines().length >= 1, 5000, '值班轮 spawn')
  const duty = logLines()[0] || { short: [] }
  check(r1.started === true, '值班轮起来了', JSON.stringify(r1.started))
  check(!duty.short.includes('--session-id'), '值班轮**不带** --session-id（sessionMode 已撤掉）')
  check(dmRec() === null, '值班轮不碰 dm-session.json')

  /* ② 第一条私信：新开 + 记账 */
  nextKey = 'k1'
  await until(() => dmRuns().length >= 1, 8000, '第一跳私信')
  const d1 = dmRuns()[0] || { short: [] }
  check(!d1.short.includes('--session-id'), '第一条私信：新开一条')
  await until(() => dmRec() && dmRec().sessionId, 5000, '记账')
  const first = dmRec() || {}
  check(first.ownerUid === 42 && dirs().includes(first.sessionId), '记下 id + 回给谁（uid=42），且那条真在盘上', String(first.sessionId || ''))

  /* ③ 第二条私信（还是他）：续上一条、不新开 */
  const before = dirs().length
  nextKey = 'k2'
  await until(() => dmRuns().length >= 2, 8000, '第二跳私信')
  const d2 = dmRuns()[1] || { short: [] }
  const i2 = d2.short.indexOf('--session-id')
  check(i2 >= 0 && d2.short[i2 + 1] === first.sessionId, '第二条私信：续在同一条会话上')
  check(dirs().length === before, '续会话没有多开一条', '桶里 ' + dirs().length + ' 条')

  /* ④ 换个人：另开一条，不带上一个人的记录 */
  await POST('/api/bili-duty/config', { dmOwnerUid: 77 })
  talkerUid = 77
  nextKey = 'k3'
  await until(() => dmRuns().length >= 3, 8000, '换人后的那一条')
  const d3 = dmRuns()[2] || { short: [] }
  check(!d3.short.includes('--session-id'), '换了回给谁 ⇒ 另开一条（不把上一个人的聊天带过来）')
  await until(() => (dmRec() || {}).ownerUid === 77, 5000, '改记 ownerUid=77')
  check((dmRec() || {}).ownerUid === 77, '记的「回给谁」跟着换成 77')
  check(/另开一条/.test(readFileSync(join(STATE, 'duty.log'), 'utf8')), '日志里明说为什么另开')

  /* ⑤ 记的那条被删：重新开 + 改记 */
  const second = (dmRec() || {}).sessionId
  rmSync(join(BUCKET_DIR, second), { recursive: true, force: true })
  nextKey = 'k4'
  await until(() => dmRuns().length >= 4, 8000, '被删之后的那一条')
  const d4 = dmRuns()[3] || { short: [] }
  check(!d4.short.includes('--session-id'), '记的会话不在了 ⇒ 重新开一条')
  await until(() => (dmRec() || {}).sessionId && dmRec().sessionId !== second, 5000, '改记新 id')
  check((dmRec() || {}).sessionId !== second, '改记了新会话 id')
  check(/已经不在盘上了/.test(readFileSync(join(STATE, 'duty.log'), 'utf8')), '日志里明说"那条不在盘上了"')

  /* ⑥ 私信回复还在跑 ⇒ 值班轮先让路 */
  writeFileSync(SLOW_FLAG, '3000')                          // 让假 dsh 慢 3 秒
  const began = dmBegins().length
  const done = dmRuns().length
  nextKey = 'k5'
  await until(() => dmBegins().length > began && dmRuns().length === done, 8000, '慢的那条私信开跑')
  const r6 = await POST('/api/bili-duty/run', { mode: 'A' })
  check(r6.started === false && /私信回复正在跑/.test(String(r6.error || '')), '私信在跑时值班轮被挡住', JSON.stringify(r6.error || ''))
  rmSync(SLOW_FLAG, { force: true })
  await until(() => dmRuns().length > done, 8000, '慢的那条私信结束')
  const r6b = await POST('/api/bili-duty/run', { mode: 'A' })
  check(r6b.started === true, '私信跑完之后值班轮又能起了', JSON.stringify(r6b.started))
} catch (e) {
  console.error('✗ 预检自己出错：' + (e?.stack || e))
  bad += 1
}

server.close()
console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全过（私信续会话这一套）')
process.exit(bad ? 1 : 0)
