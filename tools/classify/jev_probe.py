#!/usr/bin/env python
"""Jev 探针（TypeSafe 官方 SDK 直连）。

对每条收藏问同一组问题，拿到 typed 答案 + 校准概率。
与 probe_questions.py 的本地基线是同一组问题，可直接对比。

    TYPESAFE_API_KEY=... .venv/bin/python jev_probe.py /tmp/bookmark_titles.jsonl -o out/probe_jev_bookmarks.json

另一条路是 Vercel AI Gateway（见 jev/probe.mjs）。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from collect import load_corpus                                   # noqa: E402

# —— 与本地基线完全一致的类目表（人定的，不是聚类出来的）——
TAXONOMY = {
    "ai": "AI 与模型（大模型、embedding、AI 工具与产品）",
    "dev": "编程开发（语言、框架、工程实践）",
    "data": "数据与数据库",
    "hw": "硬件数码（设备、芯片、外设）",
    "media": "影视娱乐",
    "music": "音乐",
    "game": "游戏",
    "life": "生活理财（钱、房、税、投资）",
    "travel": "旅行美食",
    "social": "社科人文（历史、法律、心理、社会观察）",
    "other": "以上都不是",
}
# 本地基线用的中文类目名 → 这里的选择键，便于对齐比较
TAXONOMY_ALIAS = {"AI与模型": "ai", "编程开发": "dev", "数据与数据库": "data", "硬件数码": "hw",
                  "影视娱乐": "media", "音乐": "music", "游戏": "game", "生活理财": "life",
                  "旅行美食": "travel", "社科人文": "social", "其他": "other"}

PERISHABLE = [
    "基本永久有效（原理、方法论、经典资料）",
    "有效期数年（工具用法、技术栈、教程）",
    "有效期一年内（版本发布说明、时效性资讯）",
    "很快过期（新闻、临时活动、价格）",
]


def build_questions():
    from typesafe_sdk import Choice, Noul, Score

    return {
        "category": Choice(instructions="这条收藏的主题属于哪一类？", criteria=TAXONOMY),
        "intent": Choice(
            instructions="用户收藏它时更可能的意图是什么？",
            criteria={
                "todo": "马上要用的工具或方法",
                "reference": "以后备查的参考资料",
                "interest": "单纯觉得有意思，不一定会用",
            },
        ),
        "perishable": Score(instructions="这条内容本身有多容易过时？", criteria=PERISHABLE),
        "keep": Noul(instructions="这条内容值得长期保留（而不是看完就该删）。"),
    }


def to_record(item, ans, ms: float) -> dict:
    cat = ans.get("category")
    it = ans.get("intent")
    per = ans.get("perishable")
    keep = ans.get("keep")
    return {
        "title": item.title or item.text,
        "url": item.url,
        "source": item.source,
        "category": getattr(cat, "choice", None),
        "category_confidence": getattr(cat, "confidence", None),
        "category_probabilities": getattr(cat, "probabilities", None),
        "intent": getattr(it, "choice", None),
        "intent_confidence": getattr(it, "confidence", None),
        "intent_probabilities": getattr(it, "probabilities", None),
        "perishable": getattr(per, "score", None),
        "perishable_confidence": getattr(per, "confidence", None),
        "keep_probability": getattr(keep, "noul", None),
        "latency_ms": round(ms * 1000),
    }


async def run(items, api_key: str, model: str | None, concurrency: int):
    from typesafe_sdk import AsyncTypeSafeClient

    client = AsyncTypeSafeClient(api_key=api_key)
    questions = build_questions()
    sem = asyncio.Semaphore(concurrency)
    out: list[dict] = [None] * len(items)      # type: ignore[list-item]

    async def one(i: int, item):
        state = {"title": (item.title or item.text)[:300], "url": item.url,
                 "source": item.source, "kind": item.kind, "body": item.text[:600]}
        async with sem:
            t0 = time.perf_counter()
            try:
                kw = {"model": model} if model else {}
                res = await client.system_one(state, questions, **kw)
                rec = to_record(item, res.answers, time.perf_counter() - t0)
                print(f"  [{i:>2}/{len(items)}] {str(rec['category']):<7} conf={rec['category_confidence']}  "
                      f"intent={str(rec['intent']):<9} conf={rec['intent_confidence']}  "
                      f"perish={rec['perishable']}  keep={rec['keep_probability']}  "
                      f"{rec['latency_ms']}ms  | {rec['title'][:34]}", flush=True)
            except Exception as e:                                # noqa: BLE001
                rec = {"title": item.title or item.text, "url": item.url, "error": str(e),
                       "latency_ms": round((time.perf_counter() - t0) * 1000)}
                print(f"  [{i:>2}/{len(items)}] ERROR {e}", flush=True)
            out[i - 1] = rec

    await asyncio.gather(*(one(i, it) for i, it in enumerate(items, 1)))
    await client.aclose()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--model", default=None, help="默认用 SDK 的默认模型")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=4)
    args = ap.parse_args()

    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        sys.exit("缺少 TYPESAFE_API_KEY（console.typesafe.ai 获取；早期访问需排队）")

    items = load_corpus(Path(args.input).expanduser())
    if args.limit:
        items = items[:args.limit]
    print(f"[corpus] {len(items)} 条 <- {args.input}  backend=typesafe")

    t0 = time.perf_counter()
    out = asyncio.run(run(items, key, args.model, args.concurrency))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(
        dict(backend="typesafe", model=args.model, taxonomy=TAXONOMY, perishable=PERISHABLE,
             alias=TAXONOMY_ALIAS, items=out, elapsed=round(time.perf_counter() - t0, 1)),
        ensure_ascii=False, indent=2))
    lat = sorted(r["latency_ms"] for r in out if r and r.get("latency_ms"))
    print(f"\n[out] {args.out}")
    if lat:
        print(f"[latency] p50={lat[len(lat)//2]}ms  max={lat[-1]}ms")


if __name__ == "__main__":
    main()
