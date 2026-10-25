/**
 * tools/_check-dm-session.mjs —— 「私信回复续在同一条会话上」的本地回归（**不花 token、不碰真 B站、不用真 dsh**）
 *
 * 怎么做到不用真东西：
 *   · `dshBin` 指到一个**假 dsh**（findDshCli ① 认它）—— 它只做一件事：在会话桶里建一条 `session-fake-*`
 *     （或者，带 `--session-id` 时检查那条**已经在盘上**），然后把 argv 记到日志里；
 *   · `fetch` 被换掉：只认「会话列表 / 读消息」两个 URL，回一份假数据；
 *   · 私信那一跳的间隔用 `BILI_DUTY_DM_TICK_SEC=1` 压成 1 秒（那个环境变量只为这种预检存在）。
 *
 * 验的八件事：
 *   ① 值班轮**不带** `--session-id`、也不碰 dm-session.json（上一版的 sessionMode 确实撤掉了）
 *   ② 第一条私信：新开一条，跑完把 id + 「回给谁」记进 dm-session.json
 *   ③ 第二条私信（还是同一个人）：**续在同一条**上，且桶里**不多**一条会话
 *   ④ 换了回给谁：另开一条，不把上一个人的聊天记录带进新对话
 *   ⑤ 记的那条被删掉：下一跳重新开一条并改记新 id（自愈）
 *   ⑥ 私信回复还在跑：值班轮被挡住（`started:false`）—— 两条同时写一个会话会撞 `session.lock`
 *   ⑦ 那条会话**正被别的进程写着**（= 你在 GUI 里打开/改过它）：改用**新会话**立刻重来一次，不漏回
 *   ⑧ 怎么都回不成：**不记 seen**（下一跳还会试），试满 3 次才记成"已回"并放弃
 *   ⑨ 路径"难认"（**空格 / 中文**）时桶名照样对得上 —— 家目录特意起成 `dsh-bili-scroll-check dm/中文`，
 *      桶名用**从 DSH 源码抄下来的** `projectKey` 参考实现算（见下面 projectKeyRef）
 *   ⑩ 人设（AGENTS.md）**只在新会话 / 设定变过时贴**：新会话带全文、续会话不重复贴、设定改过再贴一次
 *   ⑪ 投递方式「**评论（不 @）+ 私信**」那一档：提示词明说"不许 @ 任何人"、也不再要「要 @ 谁」
 *   ⑫ 「评论里 @ 我们的」（B站 的「@我的」）：主人 @ 的会列进提示词；陌生人 @ 的、判重表里记过的都不列
 *
 * 用法：`node tools/_check-dm-session.mjs`（约 30 秒；退出码 0 = 全过）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

/**
 * ⭐ 参考实现：**照抄 DSH 自己的** `projectKey(cwd)`
 *   （`@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`，0.2.1-rc.2）。
 *   用它算出"会话桶目录" ⇒ 插件要是又自己猜桶名（比如只把 `/` 换成 `-`），
 *   这个预检里的家目录（带空格 + 中文）就会让它**对不上**、当场红 ✗
 */
const projectKeyRef = (cwd) => {
  const s = String(cwd || '')
  if (!s) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const HOME = join(tmpdir(), 'dsh-bili-scroll-check dm', '中文')   // ⭐ 故意带空格 + 中文
const STATE = join(HOME, 'bili-duty')
const BUCKET_DIR = join(HOME, 'sessions', projectKeyRef(STATE))
const FAKE = join(HOME, 'fake-dsh.mjs')
const FAKE_LOG = join(HOME, 'fake-dsh.log')
const SLOW_FLAG = join(HOME, 'slow')        // 内容 = 毫秒：让这一轮慢下来（验"值班轮让路"）
const LOCKED_FLAG = join(HOME, 'locked')    // 存在 = 那条会话正被别的进程写着（模拟 GUI 打开/改过它）
const FAIL_FLAG = join(HOME, 'fail')        // 存在 = 这一轮怎么都失败（验"失败不记 seen + 试满 3 次才放弃"）

rmSync(HOME, { recursive: true, force: true })
mkdirSync(STATE, { recursive: true })
mkdirSync(BUCKET_DIR, { recursive: true })

// ── 假 dsh：只记账 + 建/认会话目录（带 --session-id 时那条必须已经在盘上、而且没被别人锁着，否则像 DSH 一样 exit 1）──
writeFileSync(FAKE, `
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const LOG = ${JSON.stringify(FAKE_LOG)}
const BUCKET = ${JSON.stringify(BUCKET_DIR)}
const SLOW = ${JSON.stringify(SLOW_FLAG)}
const LOCKED = ${JSON.stringify(LOCKED_FLAG)}
const FAIL = ${JSON.stringify(FAIL_FLAG)}
const argv = process.argv.slice(2)
const say = (o) => appendFileSync(LOG, JSON.stringify({
  ...o,
  isDm: argv.some((a) => a.includes('私信里发来')),
  hasDoc: argv.some((a) => a.includes('测试人设')),
  hasHist: argv.some((a) => a.includes('最近的几句私信')),
  hasNoAt: argv.some((a) => a.includes('不许 @ 任何人')),
  hasAt: argv.some((a) => a.includes('每条在正文里纯文本 @')),
  has300: argv.some((a) => a.includes('300 字')),
  hasAtList: argv.some((a) => a.includes('评论里 @ 我们的')),
  hasAt111: argv.some((a) => a.includes('rpid 111')),
  hasAt222: argv.some((a) => a.includes('rpid 222')),
  hasAt333: argv.some((a) => a.includes('rpid 333')),
  short: argv.map((a) => (a.length > 40 ? a.slice(0, 40) + '…' : a)),
}) + '\\n')
say({ begin: true })
if (existsSync(SLOW)) await new Promise((r) => setTimeout(r, Number(readFileSync(SLOW, 'utf8')) || 3000))
if (existsSync(FAIL)) { say({ failed: true }); console.error('dsh: boom'); process.exit(1) }
const i = argv.indexOf('--session-id')
if (i >= 0) {
  const want = argv[i + 1]
  if (!existsSync(join(BUCKET, want))) { say({ adoptMissing: want }); process.exit(1) }
  if (existsSync(LOCKED)) { say({ locked: want }); console.error('dsh: session "' + want + '" is already owned by an active write handle'); process.exit(1) }
  say({ adopted: want }); process.exit(0)
}
const id = 'session-fake-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 6)
mkdirSync(join(BUCKET, id), { recursive: true })
say({ created: id }); process.exit(0)
`)

const WS = join(HOME, 'ws')                 // 假的"使用者的工作区"：里面放一份人设 AGENTS.md
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'AGENTS.md'), '# 测试人设：本鲸是测试用的\n标记-A')

const cfg = {
  dshBin: FAKE, dmWatch: true, dmWatchMinutes: 1, dmReplyPerDay: 5, dmOwnerUid: 42,
  peakValley: false, perDay: 5, workspace: WS,
  // ⭐ 投递方式特意选「评论（不 @）+ 私信」，并且**不填「要 @ 谁」** —— 验那一档的提示词
  dmMode: 'both-noat', autoComment: true, mentionName: '', dmUid: 424242,
  replyToComments: true,   // ⭐ 顺带验「评论里 @ 我们的」那条链路（走 B站 的 @我的 接口）
  _set: ['dshBin', 'dmWatch', 'dmWatchMinutes', 'dmReplyPerDay', 'dmOwnerUid', 'peakValley', 'perDay', 'workspace',
    'dmMode', 'autoComment', 'mentionName', 'dmUid', 'replyToComments'],
}
writeFileSync(join(STATE, 'config.json'), JSON.stringify(cfg, null, 2))
writeFileSync(join(STATE, 'bili_credential.json'), JSON.stringify({ sessdata: 'fake', bili_jct: 'fake', buvid3: 'fake', dedeuserid: '999' }))
// 先记成"这条已经回过了"⇒ 私信那一跳不会自己开跑，全由下面 nextKey 控制
writeFileSync(join(STATE, 'dm-seen.json'), JSON.stringify({ 42: 'seen-k' }))
// ⭐ 判重表里已经记过 rpid 333（那条 @ 不该再列给这一轮）；101 是另一条无关记录
writeFileSync(join(STATE, 'seen.md'), '- 2026-10-20 · BV1ccccccccc rpid 333 · 已经回过了\n- 2026-10-20 · BV1zzzzzzzzz rpid 101 · 无关记录\n')

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
  if (u.includes('msgfeed/at')) {                      // ⭐「评论里 @ 我们的」（@我的）
    return json({ code: 0, data: { items: [
      { user: { mid: 42, nickname: '主人' }, at_time: Math.floor(Date.now() / 1000) - 60,
        item: { type: 'reply', uri: 'https://www.bilibili.com/video/BV1aaaaaaaaa', source_id: 111, target_id: 0, source_content: '@本鲸 记一下这条' } },
      { user: { mid: 999, nickname: '陌生人' }, at_time: Math.floor(Date.now() / 1000) - 60,
        item: { type: 'reply', uri: 'https://www.bilibili.com/video/BV1bbbbbbbbb', source_id: 222, target_id: 0, source_content: '@本鲸 帮我看个视频' } },
      { user: { mid: 42, nickname: '主人' }, at_time: Math.floor(Date.now() / 1000) - 60,
        item: { type: 'reply', uri: 'https://www.bilibili.com/video/BV1ccccccccc', source_id: 333, target_id: 0, source_content: '@本鲸 这条已经回过了' } },
    ] } })
  }
  if (u.includes('fetch_session_msgs')) {
    // ⚠️ B站 这个接口是**倒序**的（新的在前）—— lib/dm.mjs 会 reverse 一遍
    // 当前这一句 + 两句旧的（当前这句在提示词正文里，会被去重掉）
    return json({ code: 0, data: { messages: [
      { msg_type: 1, content: JSON.stringify({ content: '问一句' }), msg_key: nextKey || 'seen-k', timestamp: 3, sender_uid: talkerUid },
      { msg_type: 1, content: JSON.stringify({ content: '上一句的回复' }), msg_key: 'h-old-2', timestamp: 2, sender_uid: 999 },
      { msg_type: 1, content: JSON.stringify({ content: '上一句：鲸鲸在吗' }), msg_key: 'h-old-1', timestamp: 1, sender_uid: talkerUid },
    ] } })
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
const seenOf = (uid) => { try { return (JSON.parse(readFileSync(join(STATE, 'dm-seen.json'), 'utf8')) || {})[String(uid)] } catch { return undefined } }
const quotaN = () => { try { return Number((JSON.parse(readFileSync(join(STATE, 'dm-quota.json'), 'utf8')) || {}).n) || 0 } catch { return 0 } }
const dirs = () => { try { return readdirSync(BUCKET_DIR).filter((n) => n.startsWith('session-')).sort() } catch { return [] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等"没有刚跑完还没记完账的轮次"：静 1.5 秒（> 1 秒那一跳）再往下走 */
const settle = async () => { const n = dmRuns().length; await sleep(1500); return dmRuns().length === n }
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
  check(duty.hasNoAt === true, '「评论（不 @）+ 私信」那一档：提示词明说**不许 @ 任何人**')
  check(duty.hasAt === false, '那一档里没有"纯文本 @ 要 @ 谁"那套（**不用填「要 @ 谁」**）')
  check(duty.has300 === true, '评论字数上限是 **300 字**（2026-10-25 从 150 放宽）')
  check(duty.hasAtList === true && duty.hasAt111 === true, '「评论里 @ 我们的」列进了提示词（主人 @ 的那条）')
  check(duty.hasAt222 === false, '陌生人 @ 的**不列**（只回主人本人的）')
  check(duty.hasAt333 === false, '判重表里记过 rpid 的**不重复列**（已经回过了）')
  check(dmRec() === null, '值班轮不碰 dm-session.json')

  /* ② 第一条私信：新开 + 记账 */
  nextKey = 'k1'
  await until(() => dmRuns().length >= 1, 8000, '第一跳私信')
  const d1 = dmRuns()[0] || { short: [] }
  check(!d1.short.includes('--session-id'), '第一条私信：新开一条')
  check(d1.hasDoc === true, '第一条私信（新会话）：**带**人设全文')
  check(d1.hasHist === true, '第一条私信（新会话）：**带**最近几句私信（接得上话）')
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
  check(d2.hasDoc === false, '第二条私信（续会话）：**不再重复贴**人设（省篇幅）')
  check(d2.hasHist === false, '第二条私信（续会话）：也不必再贴最近几句（历史里连着）')
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

  /* ⑦ 那条会话正被别的进程写着（= 你在 GUI 里打开/改过它）⇒ 改用新会话重来一次，不能漏回 */
  await settle()
  await POST('/api/bili-duty/config', { dmReplyPerDay: 20, dmOwnerUid: 42 })   // 回给 42 + 后面还要试好多次
  talkerUid = 42
  const lockedId = 'session-fake-locked-1'
  mkdirSync(join(BUCKET_DIR, lockedId), { recursive: true })
  writeFileSync(join(STATE, 'dm-session.json'), JSON.stringify({ sessionId: lockedId, ownerUid: 42 }))
  writeFileSync(LOCKED_FLAG, '1')
  const done6 = dmRuns().length
  const quotaBefore7 = quotaN()
  nextKey = 'k6'
  await until(() => dmRuns().length >= done6 + 2, 12000, '锁住的那条 + 重来的那条')
  const locked = dmRuns()[done6] || { short: [] }
  const retried = dmRuns()[done6 + 1] || { short: [] }
  check(locked.short.includes('--session-id') && locked.locked === lockedId, '第一条：想续那条被别人锁着的会话 ⇒ 失败')
  check(!retried.short.includes('--session-id') && !!retried.created, '紧接着**改用新会话重来一次**（没漏回）')
  check(retried.hasHist === true, '重来的那一跳**带上最近几句私信**（续不上也不失忆）')
  /* ⚠️ 记账 / 记 seen / 记额度都是**子进程退出之后**才做的 ⇒ 等它落盘再断言，别跟它抢（第一版就是抢输才红的） */
  await until(() => (dmRec() || {}).sessionId === retried.created, 6000, '⑦ 记账落盘')
  check((dmRec() || {}).sessionId === retried.created, '改记了新会话 id', String((dmRec() || {}).sessionId || ''))
  await until(() => seenOf('42') === 'k6' && quotaN() === quotaBefore7 + 1, 6000, '⑦ seen/额度落盘')
  check(seenOf('42') === 'k6', '重来回成之后才把这条记成"已回"')
  check(quotaN() === quotaBefore7 + 1, '这一次（含那次白跑的续会话）只占 1 条额度', `${quotaBefore7} → ${quotaN()}`)
  check(/改用新会话重来一次/.test(readFileSync(join(STATE, 'duty.log'), 'utf8')), '日志里明说为什么重来')
  rmSync(LOCKED_FLAG, { force: true })

  /* ⑧ 怎么都回不成：**不记 seen**（下一跳还会试），试满 3 次才放弃 */
  await settle()
  writeFileSync(join(STATE, 'dm-session.json'), JSON.stringify({}))   // 别让它走"续会话"那条路，专心验重试
  writeFileSync(FAIL_FLAG, '1')
  const done7 = dmRuns().length
  const quotaBefore8 = quotaN()
  nextKey = 'k7'
  await until(() => /试了 3 次都没回成/.test(readFileSync(join(STATE, 'duty.log'), 'utf8')), 20000, '试满 3 次')
  const failed = dmRuns().slice(done7).filter((l) => l.failed)
  check(failed.length === 3, '回不成的消息一共试了 3 次（不是一次就丢）', String(failed.length) + ' 次')
  check(quotaN() === quotaBefore8, '回不成的不占今天的额度', `${quotaBefore8} → ${quotaN()}`)
  check(seenOf('42') === 'k7', '试满 3 次才把它记成"已回"，不再刷')
  rmSync(FAIL_FLAG, { force: true })

  /* ⑨ 人设**变过** ⇒ 续用也会再贴一份（不然它就照旧那份说话）；贴完下一跳又不再贴 */
  // ⑧ 之后 dm-session.json 是空的 ⇒ 先来一跳把"新会话 + 当前人设指纹"记下来
  const done7b = dmRuns().length
  nextKey = 'k8'
  await until(() => dmRuns().length >= done7b + 1, 10000, '⑨a 新会话那一跳')
  check((dmRuns()[done7b] || {}).hasDoc === true, '⑨a 新会话照旧带人设')
  await until(() => !!(dmRec() || {}).sessionId, 6000, '⑨a 记账落盘')
  const base8 = dmRuns().length
  writeFileSync(join(WS, 'AGENTS.md'), '# 测试人设：本鲸是测试用的（改过了）\n标记-B')
  nextKey = 'k9'
  await until(() => dmRuns().length >= base8 + 1, 10000, '⑨b 设定改过之后那一跳')
  const changed = dmRuns()[base8] || { short: [] }
  check(changed.short.includes('--session-id') && changed.hasDoc === true, '设定改过 ⇒ 续用时**再贴一份**新设定')
  const base9 = dmRuns().length
  nextKey = 'k10'
  await until(() => dmRuns().length >= base9 + 1, 10000, '⑨c 再下一跳')
  const after = dmRuns()[base9] || { short: [] }
  check(after.hasDoc === false, '新设定贴过一次之后，又回到"不重复贴"')
} catch (e) {
  console.error('✗ 预检自己出错：' + (e?.stack || e))
  bad += 1
}

server.close()
console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全过（私信续会话这一套）')
process.exit(bad ? 1 : 0)
