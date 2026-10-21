#!/usr/bin/env python3
"""favops.py —— 「刷B站」的收藏边车（宿主直接调，不经过 MCP，模型拿不到这只手）

用法：
  python favops.py folders            # 列收藏夹 → 末行 JSON {"ok":true,"folders":[{id,title,count}]}
  python favops.py add <bvid> <fid>   # 收藏 → {"ok":true} / {"ok":false,"error":"..."}
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 凭证找两处：优先**当前工作目录**（宿主 spawn 时 cwd = 插件家，凭证就在那儿），
# 退回脚本旁边（脚本被铺到插件家后两者一致）
CRED_CANDIDATES = [
    os.path.join(os.getcwd(), 'bili_credential.json'),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bili_credential.json'),
]
CRED_FILE = next((p for p in CRED_CANDIDATES if os.path.exists(p)), CRED_CANDIDATES[0])


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def load():
    from bilibili_api import Credential
    if not os.path.exists(CRED_FILE):
        out({'ok': False, 'error': '还没扫码登录（bili_credential.json 不存在）'})
    d = json.load(open(CRED_FILE, encoding='utf-8'))
    return Credential(
        sessdata=d['sessdata'],
        bili_jct=d['bili_jct'],
        buvid3=d.get('buvid3', ''),
        dedeuserid=str(d['dedeuserid']),
    ), int(d['dedeuserid'])


async def folders():
    from bilibili_api import favorite_list
    cred, uid = load()
    res = await favorite_list.get_video_favorite_list(uid, credential=cred)
    items = (res or {}).get('list') or []
    out({'ok': True, 'folders': [{'id': it.get('id'), 'title': it.get('title'), 'count': it.get('media_count', 0)} for it in items]})


async def add(bvid, fid):
    """把一条视频加进收藏夹。

    ⚠️⚠️ 0.1.19 这段是照着**不存在的 API** 写的（2026-10-21 实测）：
      · `favorite_list.FavoriteListResource` 这个类库里根本没有；
      · `add()` 里连 `favorite_list` 都没 import（只有 `folders()` 里 import 了）⇒
        点「补收藏今天的」必然 `name 'favorite_list' is not defined`，一条也进不去 ✗；
      · 而且 `favorite_list.FavoriteList` 只有 get_info / get_content（**只读**），没有 add；
      · 这个库的端点表里也没有"把视频加进收藏夹"的端点（只有 move / copy / rm / clean）。
    ⇒ 现在直接走官方那个端点的原始 spec：POST `/x/v3/fav/resource/deal`
      （`rid`=aid、`type`=2 视频、`add_media_ids`=目标收藏夹、`del_media_ids` 留空）。
      用库自己的 `Api` 发，CSRF（bili_jct）由它按 `verify: True` 自动带 ✓
    """
    from bilibili_api import video as ba_video
    from bilibili_api.utils.network import Api
    cred, _ = load()
    v = ba_video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = int(info['aid'])
    api = {
        'url': 'https://api.bilibili.com/x/v3/fav/resource/deal',
        'method': 'POST',
        'verify': True,          # verify=True ⇒ 库会带上 csrf（bili_jct）
        'data': {
            'rid': 'int: 稿件 avid',
            'type': 'int: 2 = 视频',
            'add_media_ids': 'str: 要加入的收藏夹 ID（多个用逗号）',
            'del_media_ids': 'str: 要移出的收藏夹 ID，留空',
        },
    }
    data = {'rid': aid, 'type': 2, 'add_media_ids': str(int(fid)), 'del_media_ids': ''}
    try:
        res = await Api(**api, credential=cred).update_data(**data).result
    except Exception as error:  # noqa: BLE001
        msg = str(error)
        # 已经收藏过不算失败（B站 对重复收藏回的是错误码/文案）
        if '已经' in msg or 'already' in msg.lower():
            out({'ok': True, 'already': True})
        out({'ok': False, 'error': msg[:200]})
    out({'ok': True, 'data': res if isinstance(res, (int, str)) else None})


def main():
    args = sys.argv[1:]
    if not args:
        out({'ok': False, 'error': '没有子命令（folders / add）'})
    try:
        if args[0] == 'folders':
            asyncio.run(folders())
        elif args[0] == 'add' and len(args) >= 3:
            asyncio.run(add(args[1], int(args[2])))
        else:
            out({'ok': False, 'error': '子命令不认识：' + ' '.join(args)})
    except Exception as error:  # noqa: BLE001
        out({'ok': False, 'error': str(error)[:300]})


if __name__ == '__main__':
    main()
