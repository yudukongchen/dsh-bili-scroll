#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr.py —— 把一条 B站 视频（或本地音视频文件）转成文字。
给"这个视频没有字幕、但又值得判断"的情况用。

用法（在插件的 ASR 环境里跑）：
    .venv-asr/Scripts/python.exe asr.py BV1xxxxxxxxx          # Windows
    .venv-asr/bin/python       asr.py https://www.bilibili.com/video/BV1xx
    .venv-asr/Scripts/python.exe asr.py D:\\some\\clip.mp4 -o out.txt
    …还可以加 --model small / --model medium 换模型（默认 small）

设计上的两个要点：
  ① **模型走国内镜像**（HF_ENDPOINT=hf-mirror.com）—— 否则 HuggingFace 拉不动
  ② **音频不落盘到别处**：yt-dlp 下到临时目录，转写完就随系统清理
"""
import argparse
import json
import os
import re
import sys
import tempfile

# ⭐ Windows 上 Python 默认按 GBK 编/解码标准输出 —— 中文或 emoji 打进管道会直接炸
#    （有用户反馈装依赖 / 跑转写时报 UnicodeDecodeError 或乱码）⇒ 这里钉死 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ⚠️ 临时目录必须待在家目录里：值班那一轮跑在沙箱里（只允许写工作区/cwd），
#    yt-dlp 默认往 %TEMP% 写、会被直接拒掉（2026-10-14 在主人机器上实证：
#    yt_dlp DownloadError: unable to open for writing: [Errno 13] Permission denied）
_HOME = os.path.dirname(os.path.abspath(__file__))
_TMP = os.path.join(_HOME, 'tmp', 'asr')
try:
    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP
except Exception:
    pass

# ⭐ 必须在 import faster_whisper **之前**设好，否则它已经去连 HuggingFace 了
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
# 模型缓存放本脚本所在目录（= 插件家）：默认的 ~/.cache 在本机拒绝写入
os.environ.setdefault('HF_HOME', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.hf-cache'))
# HuggingFace 新版存储（Xet）国内镜像不代理 ⇒ 关掉它，走老 CDN 通道（否则 401）
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def to_url(target: str) -> str:
    t = target.strip()
    if t.upper().startswith('BV') and len(t) <= 20:
        return 'https://www.bilibili.com/video/' + t
    return t


# ⭐⭐ B站 对"没登录"的 yt-dlp 拉流会直接回 **HTTP 412**（2026-10-21 实测：没字幕的视频全被拒，
#    报告里只能写"本地转写被 412 拒"）。修法：把插件家那份 `bili_credential.json` 变成
#    yt-dlp 认的 cookie 交上去，再配一个正常的桌面 UA —— 412 就没了。
#    ⚠️ 拿不到凭证（还没扫码 / 文件读不了）⇒ 照旧不发 cookie，行为跟以前完全一样 ✓
_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
_CRED_KEYS = (('SESSDATA', 'sessdata'), ('bili_jct', 'bili_jct'),
              ('buvid3', 'buvid3'), ('DedeUserID', 'dedeuserid'))


def _load_cookie_pairs():
    """从插件家那份凭证里取 cookie 键值；取不到就返回 []（不报错、不拦路）。"""
    try:
        with open(os.path.join(_HOME, 'bili_credential.json'), encoding='utf-8') as f:
            c = json.load(f)
    except Exception:
        return []
    if not isinstance(c, dict):
        return []
    return [(k, str(c.get(v) or '').strip()) for k, v in _CRED_KEYS if str(c.get(v) or '').strip()]


def _write_cookiefile(pairs) -> str:
    """写一份 Netscape 格式的 cookie 文件（yt-dlp 的 `cookiefile` 认这个）。

    ⚠️ 写在插件家的 `tmp/asr/` 里（沙箱只允许写那儿）；跑完不删 —— 下一轮直接复用。
    """
    path = os.path.join(_TMP, 'yt-dlp-cookies.txt')
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write('# Netscape HTTP Cookie File\n')
            for k, v in pairs:
                f.write('\t'.join(['.bilibili.com', 'TRUE', '/', 'FALSE', '0', k, v]) + '\n')
        try:
            os.chmod(path, 0o600)      # 里面有 SESSDATA，别让同机其他用户读到
        except Exception:
            pass
        return path
    except Exception:
        return ''


def _cookie_opts() -> dict:
    """给 yt-dlp 的 cookie 选项。

    优先 `cookiefile`（yt-dlp 自己把 cookie 塞进每个请求，最稳）；
    连文件都写不出来（沙箱把 tmp 也拒了）就退成 `Cookie` 请求头 —— 总之别两手空空去撞 412。
    """
    pairs = _load_cookie_pairs()
    if not pairs:
        return {}
    cf = _write_cookiefile(pairs)
    if cf:
        return {'cookiefile': cf}
    return {'http_headers': {'Cookie': '; '.join(f'{k}={v}' for k, v in pairs)}}


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """用 yt-dlp 把音频拉下来（B站 是 DASH 音视频分离，取 bestaudio 即可，不需要 ffmpeg 合并）"""
    from yt_dlp import YoutubeDL
    # ⭐⭐ 2026-10-21 实测踩到：上一次跑剩的音频（同一个 BV 重跑、或一轮里重试）会被 yt-dlp
    #    当成"续传起点" ⇒ 发 Range 请求、而文件其实已经下完了 ⇒ **HTTP 416** 整条挂掉 ✗
    #    ⇒ 先清掉同名残留，再明确"不续传、有就重下"。
    try:
        for f in os.listdir(tmp):
            if f.startswith(tag + '.'):
                os.remove(os.path.join(tmp, f))
    except Exception:
        pass
    opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(tmp, tag + '.%(ext)s'),   # ⭐ 用 BV 号当文件名：固定名会和别的轮次撞车（踩过）
        'paths': {'home': tmp, 'temp': tmp},   # 别让 yt-dlp 往 %TEMP% 写（沙箱会拒）
        'cachedir': False,                      # 顺手别去动用户目录里的缓存
        'continuedl': False,                    # ⭐ 不续传（416 的根因）
        'overwrites': True,                     # ⭐ 有同名文件就重下，别拿旧的凑
        # ⭐ nopart：不写 .part 再改名，直接落最终文件。
        #    沙箱里"新建文件 + 改名"会被拒，而这条能绕开（2026-10-14 值班那一轮自己试出来的）
        'nopart': True,
      # [2026-10-20 · 参考社区 PR #23] 进度条默认打到 stdout ⇒ 调用方"stdout 非空=成功"恒真 ✗
      #   我们是读文件走的，把进度关掉，别污染输出
      'noprogress': True,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'http_headers': {
            'Referer': 'https://www.bilibili.com',
            'User-Agent': _UA,
        },
    }
    opts.update(_cookie_opts())      # ⭐ 不带 cookie 会被 B站 回 412（见上面那段注释）
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.prepare_filename(info)


def main() -> int:
    ap = argparse.ArgumentParser(description='把一条视频转成文字（默认中文）')
    ap.add_argument('target', help='BV 号 / B站链接 / 本地音视频文件')
    ap.add_argument('-o', '--out', help='写到这个文件（不给就打到标准输出）')
    ap.add_argument('--model', default=os.environ.get('BILI_DUTY_ASR_MODEL', 'small'),
                    help='Whisper 模型大小：tiny / base / small / medium（默认 small）')
    ap.add_argument('--lang', default='zh', help='语言（默认 zh；不给就自动判断请传 auto）')
    args = ap.parse_args()

    src = args.target
    # ⚠️ 不用 mkdtemp：沙箱只允许写"子进程启动前就存在"的目录，新建的会被拒 ✗
    #    这个目录由宿主（插件）预先建好；文件名固定，跑完自己清掉
    tmp = _TMP
    # ⭐ 每个视频用**自己的**文件名：以前写死 audio.m4a ⇒ 两轮同时跑会互相覆盖，
    #    上一轮转出来的其实是另一个视频的内容（2026-10-14 值班那轮亲踩 ✗）
    tag = os.path.basename(src).rsplit('.', 1)[0] or 'clip'
    tag = re.sub(r'[^0-9A-Za-z_-]', '_', tag)[:40] or 'clip'
    try:
        if src.lower().startswith('http') or src.upper().startswith('BV'):
            print('[asr] 先下音频…', file=sys.stderr)
            src = fetch_audio(to_url(src), tmp, tag)
        if not os.path.exists(src):
            print('[asr] 找不到文件：' + src, file=sys.stderr)
            return 2

        from faster_whisper import WhisperModel
        print('[asr] 加载模型 %s（第一次会自动下模型，之后就是本地读）…' % args.model, file=sys.stderr)
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        print('[asr] 开始转写…', file=sys.stderr)
        segments, _info = model.transcribe(
            src,
            language=None if args.lang == 'auto' else args.lang,
            vad_filter=True,          # 掐掉静音段，省时间也少出错
        )
        text = ''.join(seg.text for seg in segments).strip()
    finally:
        # 临时音频不留在磁盘上
        try:
            import glob
            for f in glob.glob(os.path.join(tmp, tag + '.*')):
                try:
                    os.remove(f)
                except Exception:
                    pass
        except Exception:
            pass

    if not text:
        # ⭐ 空结果 = 这条视频**没有可识别的语音**（vad_filter 把纯音乐/静音全掐了 ⇒ 正常现象，
        #    **不是 ASR 坏了**）。章程里就是这么规定的：记「跳过（无语音）」、别重试、别写调试脚本。
        #    ⚠️ 别为了"出点字"去关 vad_filter —— 实测那条纯音乐的音频关掉 VAD 会吐出
        #    「字幕製作人Zither Harp」这种幻觉，比空更坏 ✗
        print('[asr] 没转出内容（这条视频大概没有语音）—— 按「无语音」跳过，别重试', file=sys.stderr)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('[asr] 已写入：' + args.out, file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
