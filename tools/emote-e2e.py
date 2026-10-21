#!/usr/bin/env python3
"""表情图片评论 · **真发一条**的端到端实测（发完自己删掉）。

⚠️⚠️ 它会**用你的账号在一条真视频下发一条公开评论**（几秒后删掉）。所以默认**不干**，
     必须显式加 `--post` 才会真发。图省事但别乱跑。

为什么还留着它：B站 那边的"能不能发图片评论"是**账号级的**（图片评论要过审、部分号会被拒），
只跑只读自检看不出这个 —— 换号 / 插件大版本升级后，值得真发一条确认。

用法（BV 自己选一条**你本来就会评论**的）：
  python3 tools/emote-e2e.py --post --bv BV1xxxxxxxxx --emote deyi
  python3 tools/emote-e2e.py --post --bv BV1xxxxxxxxx --emote deyi --text "本鲸试一下贴表情（马上删）"

流程：起 MCP（跟那一轮同一份白名单）→ bili_reply 带 emote → 按时间翻最新评论复核
      → 看 `content.pictures` 在不在 → 删掉 → 再确认没了。
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request

STATE = os.environ.get("BILI_DUTY_HOME", os.path.expanduser("~/.dsh/bili-duty"))
# 表情包库在哪儿：默认按插件自己的规矩 = 家目录下的 memes/；
# 库放在别处（例如工作区下面的 memes/）就显式给：BILI_MEME_DIR=<那个目录> python3 tools/…
MEME_DIR = os.environ.get("BILI_MEME_DIR") or os.path.join(STATE, "memes")
PY = os.path.join(STATE, ".venv", "Scripts" if os.name == "nt" else "bin",
                  "python.exe" if os.name == "nt" else "python")
MCP = os.path.join(STATE, "mcp_server.py")
WHITELIST = ("bili_search,bili_subtitle,bili_comments,bili_video_info,"
             "bili_reply,bili_received_replies,bili_emote_list")


class Client:
    def __init__(self):
        self.p = subprocess.Popen(
            [PY, MCP], cwd=STATE,
            env={**os.environ, "BILI_MCP_TOOLS": WHITELIST, "BILI_MEME_DIR": MEME_DIR},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self.id = 0
        self.req("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "emote-e2e", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def req(self, method, params):
        self.id += 1
        self.send({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("MCP 起不来/退出了：" + self.p.stderr.read()[-400:])
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def call(self, name, args=None):
        r = self.req("tools/call", {"name": name, "arguments": args or {}})
        txt = "\n".join(c.get("text", "") for c in r.get("content", []))
        try:
            return json.loads(txt)
        except Exception:
            return txt


def http(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return json.loads(r.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--post", action="store_true", help="真的发（不加就只打印计划，什么都不发）")
    ap.add_argument("--bv", default="", help="发到哪条视频（BV 号）")
    ap.add_argument("--emote", default="deyi", help="贴哪张（默认 deyi）")
    ap.add_argument("--text", default="本鲸试一下贴表情（马上删）", help="评论正文")
    a = ap.parse_args()

    if not a.post or not a.bv:
        print("没给 --post 或 --bv ⇒ 什么都不发。计划是这样的：")
        print(f"  python3 {os.path.basename(__file__)} --post --bv BV… --emote {a.emote}")
        print("（真要跑，选一条你本来就会评论的视频；它会发完立刻删）")
        return 0

    cred = json.load(open(os.path.join(STATE, "bili_credential.json")))
    H = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/",
         "Cookie": f"SESSDATA={cred['sessdata']}; bili_jct={cred['bili_jct']}; buvid3={cred.get('buvid3', '')}"}

    c = Client()
    print(f"① 发：{a.bv} · emote={a.emote} · 「{a.text}」")
    res = c.call("bili_reply", {"bvid": a.bv, "text": a.text, "emote": a.emote})
    print("   回执：", json.dumps(res, ensure_ascii=False))
    if not res.get("success"):
        print("❌ 没发出去 —— 到此为止（本来也没留下东西）")
        return 1
    if res.get("emote_skipped"):
        print("⚠️ 图没贴上（退回纯文字了），原因：", res["emote_skipped"])
    rpid = int(res.get("rpid") or 0)

    aid = http(f"https://api.bilibili.com/x/web-interface/view?bvid={a.bv}", H)["data"]["aid"]
    hit = None
    print("② 复核（按时间翻最新一页找我们那条）…")
    for i in range(6):
        time.sleep(4)
        d = http(f"https://api.bilibili.com/x/v2/reply/main?type=1&oid={aid}&mode=2&next=0&ps=20", H)
        hit = next((r for r in (d.get("data", {}).get("replies") or []) if r.get("rpid") == rpid), None)
        if hit:
            break
        print(f"   第 {i + 1} 次还没看到（可能还在审核）…")
    if hit:
        pics = (hit.get("content") or {}).get("pictures") or []
        print("   ✓ 公开可见；pictures：", json.dumps(pics, ensure_ascii=False))
        if not pics:
            print("   ⚠️ 评论在、但 pictures 是空的 —— B站 把图丢了")
    else:
        print("   最新一页没查到（可能还在审核；**不等于没发出去**）")

    sys.path.insert(0, STATE)
    from bilibili_api import Credential, comment
    credobj = Credential.from_cookies(cred)

    async def rm():
        cm = comment.Comment(oid=aid, type_=comment.CommentResourceType.VIDEO, rpid=rpid, credential=credobj)
        return await cm.delete()

    print("③ 删掉测试评论：", json.dumps(asyncio.run(rm()), ensure_ascii=False))
    time.sleep(3)
    d = http(f"https://api.bilibili.com/x/v2/reply/main?type=1&oid={aid}&mode=2&next=0&ps=20", H)
    still = [r for r in (d.get("data", {}).get("replies") or []) if r.get("rpid") == rpid]
    print("   删完再看：", "还在（？）" if still else "没了 ✓")
    c.p.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
