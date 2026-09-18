#!/usr/bin/env python
"""不依赖 LLM 的簇命名：c-TF-IDF（BERTopic 的经典做法）。

原理：把整个簇当成一篇"文档"，算词在簇内 vs 全局的权重，
取权重最高的词作为标签。纯统计、零成本、可离线。
"""
from __future__ import annotations

import math
import re
from collections import Counter

import jieba

_STOP = set("""的 了 是 我 你 他 她 它 们 这 那 有 和 与 就 都 也 还 很 太 在 会 能 要 把 被 让 给 对 从 到 又 而 但 如果 因为 所以 一个 什么 怎么 为什么 这样 那样 自己 我们 你们 他们 视频 up 主 官方 合集 第 一 二 三 期 集 版 中 上 下 的 吧 啊 呢 吗 呀 哦 诶 哈 哈哈 真 好 最 更 没 不 我 了""".split())


def tokens(text: str) -> list[str]:
    text = re.sub(r"[^\w\u4e00-\u9fff]+", " ", text)
    out = []
    for w in jieba.cut(text):
        w = w.strip()
        if len(w) < 2 or w in _STOP or w.isdigit():
            continue
        if re.fullmatch(r"[a-zA-Z]+", w):
            w = w.lower()
            if len(w) < 3:
                continue
        out.append(w)
    return out


def ctfidf_labels(texts: list[str], labels, top_k: int = 3, max_words: int = 3) -> dict[int, str]:
    """返回 {cluster_id: "词A·词B"}"""
    docs = [tokens(t) for t in texts]
    global_df = Counter()
    for d in docs:
        global_df.update(set(d))
    n_docs = len(docs)

    out: dict[int, str] = {}
    clusters = sorted({int(c) for c in labels if c != -1})
    for c in clusters:
        idx = [i for i, v in enumerate(labels) if int(v) == c]
        tf = Counter()
        for i in idx:
            tf.update(docs[i])
        # c-TF-IDF: 词频 × log(1 + 该类平均词频 / 全局词频)
        avg = sum(tf.values()) / max(1, len(clusters))
        scores = {}
        for w, f in tf.items():
            if len(w) < 2 or w in _STOP:
                continue
            if global_df[w] == n_docs and n_docs > 5:   # 到处都是的词
                continue
            scores[w] = math.log(1 + f / max(1e-9, avg)) * f * math.log(1 + n_docs / max(1, global_df[w]))
        ranked = [w for w, _ in sorted(scores.items(), key=lambda kv: -kv[1]) if len(w) >= 2]
        seen, pick = set(), []
        for w in ranked:
            if any(w in p or p in w for p in pick):
                continue
            pick.append(w)
            if len(pick) >= max_words:
                break
        out[c] = "·".join(pick) if pick else f"簇{c}"
    return out
