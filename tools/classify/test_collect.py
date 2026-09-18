#!/usr/bin/env python
"""回归测试：跑之前先确认解析与文本构造没有退化。

    .venv/bin/python test_collect.py

只测不需要模型的纯函数部分（解析、URL 处理），秒级完成。
模型相关的端到端断言见 results/REPORT.md §3.2~§3.4。
"""
from __future__ import annotations

import sys
from pathlib import Path

from collect import Item, load_bookmarks_html, load_jsonl, url_hint

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "bookmarks_sample.html"
FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not cond:
        FAILS.append(name)


def main() -> None:
    print("[1] 书签 HTML 解析")
    items = load_bookmarks_html(FIXTURE)
    check("解析出 20 条", len(items) == 20, f"实际 {len(items)}")
    check("kind 都是 bookmark", all(i.kind == "bookmark" for i in items))
    check("url 都保留", all(i.url.startswith("http") for i in items))

    print("[2] 正文不能含 URL（§3.3 的 bug）")
    polluted = [i for i in items if "http" in i.text or "//" in i.text]
    check("正文无 http:// 残留", not polluted,
          f"{len(polluted)} 条被污染，例如 {polluted[0].text[:60]}" if polluted else "")
    vercel = next(i for i in items if "Jev" in i.title)
    check("Vercel 那条正文 == 标题", vercel.text == vercel.title, repr(vercel.text[:60]))

    print("[3] url_hint 兜底")
    check("剥掉协议与域名",
          url_hint("https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway")
          == "vercel changelog typesafe jev now available gateway",
          url_hint("https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway"))
    check("丢掉 docs/index 这类噪声词",
          url_hint("https://www.postgresql.org/docs/current/indexes.html") == "postgresql indexes",
          url_hint("https://www.postgresql.org/docs/current/indexes.html"))
    check("空 URL 返回空串", url_hint("") == "")

    print("[4] 裸 URL 的书签用 slug 兜底")
    jsonl = Path("/tmp/_cc_urlonly.jsonl")
    jsonl.write_text(
        '{"title":"","url":"https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/",'
        '"source":"web","kind":"bookmark"}')
    got = load_jsonl(jsonl)
    check("有可读文本", len(got) == 1 and len(got[0].text) > 10, repr(got[0].text))
    check("仍有 http:// 残留", "http" not in got[0].text, repr(got[0].text))

    print()
    if FAILS:
        print(f"❌ {len(FAILS)} 项失败: {FAILS}")
        sys.exit(1)
    print("✅ 全部通过")


if __name__ == "__main__":
    main()
