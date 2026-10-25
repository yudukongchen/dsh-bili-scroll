/**
 * lib/atfeed.mjs —— 「谁在评论里 @ 了我们」（只读，不花 token）
 * ============================================================================
 * 🔴 为什么要有它（2026-10-25 主人报：「插件没看到我几分钟前 @ 她的评论」）：
 *   B站 的「@我的」和「回复我的」是**两个不同的接口** ——
 *     · `x/v2/reply/received`（= MCP 的 `bili_received_replies`）**只有"直接回到我们那条评论下面"的**；
 *     · **在别人楼里 @ 我们、或者新起一条评论里 @ 我们** ⇒ 只在 `x/msgfeed/at` 里（就是 App 上的「@我的」）✗
 *   结果：主人在别人楼里 @ 了她，那一轮只能看到「回复我的」⇒ 什么都没看见。
 *   这里读的就是后者（跟 lib/dm.mjs 一个路子：宿主侧纯代码 GET，只读）。
 *
 * ⚠️ 真机上核过字段（2026-10-25，0.2.1-rc.2 的 B站 web 接口）：
 *   item.source_id   = **他这条评论的 rpid**（回复就用它 → `bili_reply(rpid=…)` 会回成楼中楼）
 *   item.target_id   = 那条楼中楼所属的根评论 rpid（顶层评论时用不上）
 *   item.uri         = 视频地址（BV 号从这里取）
 *   item.source_content = 评论正文（就是 @ 我们的那句）
 *   at_details[]     = 被 @ 的人（要确认里面确实有我们）
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 读凭证（跟 MCP 那边同一个文件、同样的四个字段） */
function credOf(stateDir) {
  try {
    const f = join(stateDir, 'bili_credential.json')
    if (!existsSync(f)) return null
    const c = JSON.parse(readFileSync(f, 'utf8'))
    return c?.sessdata ? c : null
  } catch { return null }
}

/**
 * 最近「@我的」（评论类）。
 * @returns {Promise<Array<{rpid:number, rootId:number, bvid:string, uid:number, nickname:string, text:string, title:string, ts:number}>>}
 */
export async function listAts(stateDir, { limit = 20 } = {}) {
  const cred = credOf(stateDir)
  if (!cred) return []
  const url = 'https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web&platform=web'
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://message.bilibili.com/',
      Origin: 'https://message.bilibili.com',
      Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}`,
    },
  })
  const j = await r.json().catch(() => null)
  if (!j || j.code !== 0) throw new Error(`HTTP ${r.status} code=${j?.code ?? '?'} ${j?.message || ''}`)
  const items = Array.isArray(j.data?.items) ? j.data.items.slice(0, limit) : []
  return items.map((it) => {
    const item = it?.item || {}
    return {
      rpid: Number(item.source_id) || 0,
      rootId: Number(item.target_id) || 0,
      bvid: (String(item.uri || '').match(/BV[0-9A-Za-z]{10}/) || [])[0] || '',
      uid: Number(it?.user?.mid) || 0,
      nickname: String(it?.user?.nickname || ''),
      text: String(item.source_content || '').slice(0, 200),
      title: String(item.title || '').slice(0, 80),
      ts: Number(it?.at_time) || 0,
    }
  })
    // 只认"评论里 @ 我们"的（动态/直播那些 type 不是 reply，跳过）；没 rpid / 没 BV 的也用不了
    .filter((x) => x.rpid > 0 && x.bvid && String(x.text || '').includes('@'))
}
