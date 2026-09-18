#!/usr/bin/env python
"""抓一份公开真实语料当基准：B 站热门 + 各分区排行。

只为验证分类效果用，不含任何个人数据。输出 data/bili_mixed.jsonl。
    .venv/bin/python fetch_public_corpus.py
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "bili_mixed.jsonl"
HDRS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "Referer": "https://www.bilibili.com/",
}
RIDS = [1, 3, 4, 5, 36, 188, 181, 119, 155, 160]   # 动画/音乐/游戏/娱乐/科技/数码/影视/鬼畜/时尚/生活


def get(url: str) -> dict:
    req = urllib.request.Request(url, headers=HDRS)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def main() -> None:
    items: list[dict] = []
    for pn in (1, 2, 3):
        d = get(f"https://api.bilibili.com/x/web-interface/popular?ps=50&pn={pn}")
        for v in (d.get("data") or {}).get("list", []):
            items.append(_row(v))
        time.sleep(0.05)

    for rid in RIDS:
        try:
            d = get(f"https://api.bilibili.com/x/web-interface/ranking/v2?rid={rid}&type=all")
            for v in (d.get("data") or {}).get("list", [])[:30]:
                items.append(_row(v))
            time.sleep(0.1)
        except Exception as e:
            print(f"  ranking rid={rid} 跳过: {e}")

    seen, uniq = set(), []
    for it in items:
        t = (it["text"] or "").strip()
        if not t or t in seen:
            continue
        seen.add(t)
        uniq.append(it)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(json.dumps(i, ensure_ascii=False) for i in uniq))
    print(f"-> {OUT} ({len(uniq)} 条)")


def _row(v: dict) -> dict:
    return dict(text=v.get("title", ""), title=v.get("title", ""),
                url=f"https://www.bilibili.com/video/{v.get('bvid')}",
                source="bilibili", kind="video",
                meta=dict(tname=v.get("tname"), up=(v.get("owner") or {}).get("name")))


if __name__ == "__main__":
    main()
