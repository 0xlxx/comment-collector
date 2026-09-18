#!/usr/bin/env python
"""把各种收藏来源统一成一个语料。

支持：
  - 本插件导出的 JSON（bilibili-favorites-*.json）
  - 浏览器书签 HTML（Chrome/Edge/Brave/Safari 导出的 .html）
  - 纯文本（每行一条）
  - JSONL（{"text":..., "title":..., "url":...}）
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path


@dataclass
class Item:
    text: str                      # 用于 embedding 的主文本
    title: str = ""                # 原始标题 / 评论正文
    url: str = ""
    source: str = ""               # bilibili / youtube / x / bookmark
    kind: str = ""                 # video / comment / post / bookmark
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return dict(text=self.text, title=self.title, url=self.url,
                    source=self.source, kind=self.kind, meta=self.meta)


def _clean(s: str) -> str:
    s = re.sub(r"\s+", " ", (s or "")).strip()
    return s


# ---------------------------------------------------------------- 插件导出的收藏
def load_plugin_json(path: Path) -> list[Item]:
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("favorites") or data.get("items") or []
    out: list[Item] = []
    for it in data:
        content = _clean(it.get("content") or it.get("text") or "")
        uname = _clean(it.get("uname") or it.get("author") or "")
        page = it.get("page") or it.get("url") or ""
        title = _clean(it.get("videoTitle") or it.get("title") or "")
        # 评论类：正文是主信息；视频标题作为上下文补进去（很短就补）
        parts = []
        if content:
            parts.append(content[:400])
        if title and title not in content:
            parts.append(title)
        if uname:
            parts.append(uname)
        if len(" ".join(parts)) < 4:          # 全空才用 URL 兜底
            parts.append(url_hint(page))
        out.append(Item(text=" ｜ ".join(parts), title=content or title, url=page,
                        source=_site_of(page), kind="comment" if content else "video", meta=it))
    return out


_URL_NOISE = {"https", "http", "www", "com", "cn", "org", "net", "io", "html", "htm",
              "index", "en", "zh", "docs", "doc", "blog", "article", "post", "watch",
              "video", "zh-cn", "latest", "main", "current"}


def url_hint(url: str, max_words: int = 8) -> str:
    """从 URL 路径里抠出有信息量的 slug 词。

    只在标题为空/过短时兜底——把 URL 直接拼进正文会**污染 embedding**：
    所有条目共享 https/www/com 这类词，均值池化后把向量拉向同一个方向，
    实测会把 4 个主题簇压成 2 个大杂烩（见 results/REPORT.md §3.3）。
    """
    if not url:
        return ""
    path = re.sub(r"^[a-z]+://", "", url.lower())
    path = path.split("?", 1)[0].split("#", 1)[0]
    parts = re.split(r"[/_.\-]+", path)
    words = []
    for w in parts:
        if not w or w in _URL_NOISE or w.isdigit() or len(w) < 3:
            continue
        if len(w) < 2 or w in words:
            continue
        words.append(w)
        if len(words) >= max_words:
            break
    return " ".join(words)


def _site_of(url: str) -> str:
    u = (url or "").lower()
    if "bilibili.com" in u:
        return "bilibili"
    if "youtube.com" in u or "youtu.be" in u:
        return "youtube"
    if "x.com" in u or "twitter.com" in u:
        return "x"
    return "web"


# ---------------------------------------------------------------- 浏览器书签
class _BM(HTMLParser):
    """极简 Chrome/Edge 书签 HTML 解析：只认 <A HREF> 和它前面的 <H3> 文件夹名。"""

    def __init__(self) -> None:
        super().__init__()
        self.folder_stack: list[str] = []
        self.pending_h3 = False
        self.items: list[tuple[str, str, list[str]]] = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "h3":
            self.pending_h3 = True
        elif tag == "a":
            href = d.get("href", "")
            self._last_a = href
            self.pending_a = True
        elif tag == "dl":
            pass

    def handle_endtag(self, tag):
        if tag == "h3":
            self.pending_h3 = False

    def handle_data(self, data):
        d = _clean(data)
        if not d:
            return
        if self.pending_h3:
            self.folder_stack.append(d)
            self.pending_h3 = False
        elif getattr(self, "pending_a", False):
            href = getattr(self, "_last_a", "").replace("&amp;", "&")
            self.items.append((d, href, list(self.folder_stack)))
            self.pending_a = False


def load_bookmarks_html(path: Path) -> list[Item]:
    html = path.read_text(encoding="utf-8", errors="ignore")
    # 用更稳的正则配对解析：<A HREF="...">title</A>  +  <H3>folder</H3>
    tokens = re.findall(r'<H3[^>]*>(.*?)</H3>|<A\s+HREF="([^"]*)"[^>]*>(.*?)</A>', html, re.I | re.S)
    out: list[Item] = []
    for folder, href, title in tokens:
        if folder:
            continue
        title = _clean(re.sub(r"<[^>]+>", "", title))
        href = href.replace("&amp;", "&")
        if not title and not href:
            continue
        body = title if len(title) >= 4 else _clean(f"{title} {url_hint(href)}")
        out.append(Item(text=body, title=title or href, url=href,
                        source=_site_of(href), kind="bookmark"))
    return out


def load_txt(path: Path) -> list[Item]:
    return [Item(text=t, title=t, source="web", kind="note")
            for t in (_clean(l) for l in path.read_text().splitlines()) if t]


def load_jsonl(path: Path) -> list[Item]:
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        title = _clean(d.get("title") or d.get("text") or "")
        extra = _clean(d.get("text") or "")
        url = d.get("url") or ""
        body = _clean(f"{title} {extra if extra != title else ''}").strip()
        if len(body) < 4:                      # 只有裸 URL 的书签，才从 slug 里取词
            body = url_hint(url)
        out.append(Item(text=body, title=title or url_hint(url), url=url,
                        source=d.get("source") or _site_of(url), kind=d.get("kind") or "", meta=d))
    return out


def load_corpus(path: Path) -> list[Item]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        return load_plugin_json(path)
    if suffix in (".html", ".htm"):
        return load_bookmarks_html(path)
    if suffix == ".jsonl":
        return load_jsonl(path)
    return load_txt(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--out", default="corpus.jsonl")
    args = ap.parse_args()
    items: list[Item] = []
    for p in args.inputs:
        got = load_corpus(Path(p).expanduser())
        print(f"{p}: {len(got)} items")
        items.extend(got)
    # 去重（按文本）
    seen, uniq = set(), []
    for it in items:
        k = it.text[:200]
        if not k or k in seen:
            continue
        seen.add(k)
        uniq.append(it)
    out = Path(args.out)
    out.write_text("\n".join(json.dumps(i.to_dict(), ensure_ascii=False) for i in uniq))
    print(f"-> {out} ({len(uniq)} unique)")


if __name__ == "__main__":
    main()
