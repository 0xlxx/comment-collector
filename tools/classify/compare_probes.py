#!/usr/bin/env python
"""对比两个探针结果（本地 Qwen3-4B vs Jev）。

    .venv/bin/python compare_probes.py out/probe_bookmarks_local.json out/probe_jev_bookmarks.json

重点不是"谁更准"，而是三件事：
  1. 分类一致率
  2. 意图/时效性/保留价值的**分布是否塌缩**（本地 LLM 的已知病灶）
  3. 置信度是否可用（能不能拿来卡阈值）
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ALIAS = {"AI与模型": "ai", "编程开发": "dev", "数据与数据库": "data", "硬件数码": "hw",
         "影视娱乐": "media", "音乐": "music", "游戏": "game", "生活理财": "life",
         "旅行美食": "travel", "社科人文": "social", "其他": "other"}


def load(p: str) -> dict:
    d = json.loads(Path(p).read_text())
    alias = d.get("alias") or {}
    items = []
    for r in d["items"]:
        c = r.get("category")
        items.append({**r, "category": alias.get(c, ALIAS.get(c, c))})
    return {"name": Path(p).stem, "backend": d.get("backend", "?"), "items": items}


def dist(items, field) -> Counter:
    return Counter(str(i.get(field)) for i in items if i.get(field) is not None)


def spread(c: Counter, n: int) -> str:
    if not c:
        return "无数据"
    top, cnt = c.most_common(1)[0]
    return f"取值 {len(c)} 种，最高频 {top} 占 {cnt / n * 100:.0f}%"


def mid_ratio(items, field, lo, hi, n) -> float:
    v = [i[field] for i in items if isinstance(i.get(field), (int, float))]
    if not v:
        return float("nan")
    return sum(1 for x in v if lo <= x <= hi) / len(v)


def main() -> None:
    a, b = load(sys.argv[1]), load(sys.argv[2])
    print(f"A = {a['name']} ({a['backend']})   n={len(a['items'])}")
    print(f"B = {b['name']} ({b['backend']})   n={len(b['items'])}\n")

    n = min(len(a["items"]), len(b["items"]))
    agree = sum(1 for i in range(n)
                if a["items"][i].get("category") == b["items"][i].get("category"))
    print(f"{'='*70}\n1) 分类一致率\n{'='*70}")
    print(f"  {agree}/{n} = {agree / n * 100:.0f}%")
    for i in range(n):
        x, y = a["items"][i], b["items"][i]
        if x.get("category") != y.get("category"):
            print(f"    #{i+1:<3}{str(x.get('title'))[:34]:<36} A={x.get('category'):<7} B={y.get('category')}")

    print(f"\n{'='*70}\n2) 分布塌缩（本地 LLM 的已知病灶）\n{'='*70}")
    for field, label in [("intent", "意图"), ("perishable", "时效性"), ("keep", "保留价值")]:
        print(f"\n  ── {label} ({field}) ──")
        for d in (a, b):
            print(f"    {d['backend']:<10} {spread(dist(d['items'], field), len(d['items']))}")
        print(f"    {b['backend']:<10} perishable 中间档占比 "
              f"{mid_ratio(b['items'],'perishable',2,3,len(b['items']))*100:.0f}%")

    print(f"\n{'='*70}\n3) 置信度可用性（只有 Jev 会给）\n{'='*70}")
    for field in ("category_confidence", "intent_confidence", "perishable_confidence"):
        vals = [i[field] for i in b["items"] if isinstance(i.get(field), (int, float))]
        if not vals:
            print(f"  {field:<24} {b['backend']} 无置信度")
            continue
        vals.sort()
        print(f"  {field:<24} {b['backend']} n={len(vals)} min={vals[0]:.2f} "
              f"p50={vals[len(vals)//2]:.2f} max={vals[-1]:.2f} "
              f"<0.9 的比例={sum(1 for v in vals if v < 0.9)/len(vals)*100:.0f}%")
    lv = [i.get("perishable_confidence") for i in a["items"] if isinstance(i.get("perishable_confidence"), (int, float))]
    if not lv:
        print(f"  {'':<24} {a['backend']} —— 本地 LLM 不提供置信度，无法卡阈值")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main()
