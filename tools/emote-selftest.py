#!/usr/bin/env python3
"""表情包库 · 自检（**只读**，不发任何评论）。

它验的是"那一轮到底能不能用表情"这条链：
  ① 白名单：`bili_emote_list` 在、危险工具（上传视频 / 发动态 / 发私信…）不在；
  ② 库能读：`bili_emote_list` 返回 24 条，情绪桶齐全；
  ③ 筛得动：按 mood / query 过滤有结果，过滤假桶返回 0；
  ④ 换插件升级后重跑一遍，就知道补丁还在不在。

用法：
  python3 tools/emote-selftest.py
  BILI_MEME_DIR=/path/to/memes python3 tools/emote-selftest.py   # 库在别处时
（要真发一条图片评论再删掉的**实测**，见同目录 `emote-e2e.py --post`）
"""
import json
import os
import subprocess
import sys

STATE = os.environ.get("BILI_DUTY_HOME", os.path.expanduser("~/.dsh/bili-duty"))
# 表情包库在哪儿：默认按插件自己的规矩 = 家目录下的 memes/；
# 库放在别处（例如工作区下面的 memes/）就显式给：BILI_MEME_DIR=<那个目录> python3 tools/…
MEME_DIR = os.environ.get("BILI_MEME_DIR") or os.path.join(STATE, "memes")
PY = os.path.join(STATE, ".venv", "Scripts" if os.name == "nt" else "bin",
                  "python.exe" if os.name == "nt" else "python")
MCP = os.path.join(STATE, "mcp_server.py")

# 跟 index.js 的 mcpWhitelist() 在"开了自动评论 + 回复评论"时发下来的一致
WHITELIST = ("bili_search,bili_subtitle,bili_comments,bili_video_info,"
             "bili_reply,bili_received_replies,bili_emote_list")
MUST_HAVE = {"bili_search", "bili_subtitle", "bili_comments", "bili_video_info",
             "bili_reply", "bili_received_replies", "bili_emote_list"}
MUST_NOT_HAVE = {"bili_upload_video", "bili_send_dynamic", "bili_send_opus",
                 "bili_send_message", "bili_login", "bili_crawl"}


class Client:
    def __init__(self, env):
        self.p = subprocess.Popen(
            [PY, MCP], cwd=STATE, env={**os.environ, **env},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self.id = 0
        self.req("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "emote-selftest", "version": "1"}})
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

    def tools(self):
        return {t["name"] for t in self.req("tools/list", {}).get("tools", [])}


def main() -> int:
    bad = []
    c = Client({"BILI_MCP_TOOLS": WHITELIST, "BILI_MEME_DIR": MEME_DIR})

    got = c.tools()
    missing = MUST_HAVE - got
    leaked = MUST_NOT_HAVE & got
    print(f"① 白名单：看到 {len(got)} 个工具")
    if missing:
        bad.append(f"白名单里少了：{'、'.join(sorted(missing))}")
        print("   ❌ 少了：", "、".join(sorted(missing)), "⇒ index.js 的白名单补丁没打上")
    if leaked:
        bad.append(f"不该放行的工具出现了：{'、'.join(sorted(leaked))}")
        print("   ❌ 多出来这些（危险）：", "、".join(sorted(leaked)))
    if not missing and not leaked:
        print("   ✓ 该有的都在，危险的一个都没有")

    lst = c.call("bili_emote_list", {})
    if not isinstance(lst, dict) or not lst.get("ok"):
        bad.append(f"bili_emote_list 报错：{lst}")
        print("   ❌ 列表读不出来：", lst)
        return finish(bad)
    print(f"② 库：{lst['dir']} —— {lst['count']} 条；情绪桶 {'、'.join(lst['moods'])}")
    if lst["count"] != 24:
        print(f"   ⚠️ 不是 24 条（{lst['count']} 条）—— 库被改过？")
    if not lst.get("moods"):
        bad.append("catalog.json 里没有 moods")

    hit = c.call("bili_emote_list", {"mood": "sad"})
    hit2 = c.call("bili_emote_list", {"query": "干饭"})
    hit3 = c.call("bili_emote_list", {"mood": "meiyouzhege"})
    print(f"③ 筛：mood=sad → {hit.get('count')} 条；query=干饭 → {hit2.get('count')} 条；"
          f"假桶 → {hit3.get('count')} 条")
    if not hit.get("count") or not hit2.get("count") or hit3.get("count") != 0:
        bad.append("筛选不对（mood / query / 空结果）")

    c.p.kill()
    return finish(bad)


def finish(bad) -> int:
    print()
    if bad:
        print("❌ 自检没过：")
        for b in bad:
            print("   -", b)
        print("   ⇒ 多半是 profile 里装的那份不是本仓库：`dsh plugin --profile web add github:yudukongchen/dsh-bili-scroll` 重装一次；"
              "还是不行就看 duty.log / 重跑 node selfcheck.mjs")
        return 1
    print("✅ 全过：那一轮能看到表情库，库也能读")
    return 0


if __name__ == "__main__":
    sys.exit(main())
