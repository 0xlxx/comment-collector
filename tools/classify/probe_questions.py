#!/usr/bin/env python
"""同一组问题，多个后端：本地 MLX / （预留）Jev。

用来给「Jev 值不值得依赖」提供对照基线：
每条收藏问四个问题 —— 分类(choice) / 意图(choice) / 时效性(score) / 是否留下(boolean)。

    .venv/bin/python probe_questions.py /tmp/bookmark_titles.jsonl -o out/probe_local.json

Jev 后端见 jev/ 目录（走 Vercel AI Gateway）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from collect import load_corpus                     # noqa: E402

# 一套「用户自己会建」的类目 —— 注意这是人定的，不是聚类出来的
TAXONOMY = ["AI与模型", "编程开发", "数据与数据库", "硬件数码",
            "影视娱乐", "音乐", "游戏", "生活理财", "旅行美食", "社科人文", "其他"]

INTENTS = {"todo": "马上要用的工具或方法", "reference": "以后备查的参考资料", "interest": "单纯觉得有意思"}

PROMPT = """你在帮用户整理收藏。对下面这一条，回答四个问题。

条目标题：{title}
来源：{source}
正文/备注：{body}

可选类目：{taxonomy}
可选意图：todo={todo} / reference={reference} / interest={interest}

只输出一个 JSON 对象，不要解释、不要 markdown 代码块：
{{"category":"<上面的类目之一>","intent":"<todo|reference|interest>","perishable":<1-4 的整数，1=永久有效 4=很快过期>,"keep":<0 到 1 之间的小数，代表长期保留的价值>}}
"""


def ask_local(title: str, source: str, body: str, repo: str) -> dict:
    import llm

    prompt = PROMPT.format(title=title[:200], source=source, body=body[:400],
                           taxonomy="、".join(TAXONOMY), **INTENTS)
    raw = llm.chat(prompt, repo=repo, max_tokens=200, temperature=0.0)
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return {"error": f"no json: {raw[:120]}"}
    try:
        d = json.loads(m.group(0))
    except Exception as e:
        return {"error": f"bad json: {e}"}
    if d.get("category") not in TAXONOMY:
        d["invalid_category"] = d.get("category")
        d["category"] = "其他"
    if d.get("intent") not in INTENTS:
        d["intent"] = "reference"
    return d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--out", default="out/probe_local.json")
    ap.add_argument("--backend", default="local", choices=["local", "jev"])
    ap.add_argument("--llm", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    items = load_corpus(Path(args.input).expanduser())
    if args.limit:
        items = items[:args.limit]
    print(f"[corpus] {len(items)} 条 <- {args.input}  backend={args.backend}")

    if args.backend == "jev":
        print("Jev 后端见 jev/probe.mjs（需要 AI_GATEWAY_API_KEY）")
        return

    out = []
    t0 = time.perf_counter()
    for i, it in enumerate(items, 1):
        r = ask_local(it.title or it.text, it.source, it.text, args.llm)
        out.append(dict(title=it.title or it.text, url=it.url, source=it.source, kind=it.kind, **r))
        flag = "ERR" if "error" in r else r.get("category")
        print(f"  [{i:>2}/{len(items)}] {flag:<10} {r.get('intent','?'):<10} "
              f"perish={r.get('perishable','?')} keep={r.get('keep','?')}  | {(it.title or '')[:40]}",
              flush=True)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(dict(
        backend=args.backend, model=args.llm, taxonomy=TAXONOMY, items=out,
        elapsed=round(time.perf_counter() - t0, 1)), ensure_ascii=False, indent=2))
    print(f"\n[out] {args.out}  ({time.perf_counter()-t0:.0f}s)")


if __name__ == "__main__":
    main()
