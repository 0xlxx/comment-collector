#!/usr/bin/env python
"""端到端：收藏语料 -> 主题分类。

    .venv/bin/python classify.py data/bili_mixed.jsonl --name
    .venv/bin/python classify.py ~/Downloads/Bookmarks.html --model bge-small-zh

流程：embedding -> UMAP 降维 -> HDBSCAN 聚类 -> 本地 LLM 命名 -> 输出 json/markdown
"""
from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
from bench_models import MODEL_SPECS, encode_texts
from collect import Item, load_corpus


# ---------------------------------------------------------------- 聚类
def auto_params(n: int, n_components: int = 5) -> dict:
    """按语料规模自动定超参。

    两条经验规律（都来自实测，见 results/REPORT.md §3.2）：
      - min_cluster_size ≈ n/50，**不设上限**（n=2000 时 40 明显优于被截到 20）
      - n < 50 时必须单独处理：邻域放宽到 ~n、min_samples 降到 2，
        否则 UMAP+HDBSCAN 会塌成 1~2 个大簇，颗粒度全丢
    """
    mcs = max(2, round(n / 50))
    if n < 50:
        return dict(n_components=int(np.clip(n_components, 2, max(2, n - 2))),
                    n_neighbors=int(max(3, min(n - 1, 15))),
                    min_cluster_size=mcs, min_samples=2)
    return dict(n_components=int(np.clip(n_components, 2, max(2, n - 2))),
                n_neighbors=int(np.clip(round(n / 10), 5, 30)),
                min_cluster_size=mcs, min_samples=3)


def cluster(X: np.ndarray, min_cluster_size: int | None = None, min_samples: int | None = None,
            n_components: int = 5, seed: int = 42) -> np.ndarray:
    import hdbscan
    import umap

    p = auto_params(len(X), n_components)
    if min_cluster_size is not None:
        p["min_cluster_size"] = min_cluster_size
    if min_samples is not None:
        p["min_samples"] = min_samples
    Xr = umap.UMAP(n_components=p["n_components"], n_neighbors=p["n_neighbors"], min_dist=0.0,
                   metric="cosine", random_state=seed).fit_transform(X)
    return hdbscan.HDBSCAN(min_cluster_size=p["min_cluster_size"], min_samples=p["min_samples"],
                           metric="euclidean", cluster_selection_method="eom").fit_predict(Xr)


def representatives(X: np.ndarray, labels: np.ndarray, k: int = 8) -> dict[int, list[int]]:
    """每个簇挑离质心最近（最典型）的 k 条。"""
    out: dict[int, list[int]] = {}
    for c in sorted({int(v) for v in labels if v != -1}):
        idx = np.where(labels == c)[0]
        cen = X[idx].mean(axis=0, keepdims=True)
        cen /= (np.linalg.norm(cen) + 1e-9)
        sim = X[idx] @ cen.T
        order = idx[np.argsort(-sim.ravel())][:k]
        out[c] = [int(i) for i in order]
    return out


# ---------------------------------------------------------------- 主流程
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--outdir", default="out")
    ap.add_argument("--model", default="ritrieve-zh", choices=sorted(MODEL_SPECS))
    ap.add_argument("--min-cluster-size", type=int, default=None)
    ap.add_argument("--min-samples", type=int, default=None)
    ap.add_argument("--no-umap", action="store_true", help="跳过降维（更纯但覆盖率低）")
    ap.add_argument("--name", action="store_true", help="给簇起名（等价于 --name-method llm）")
    ap.add_argument("--name-method", default="none", choices=["none", "llm", "ctfidf", "both"],
                    help="簇命名方式：llm=本地大模型，ctfidf=纯统计零成本，both=统计做兜底")
    ap.add_argument("--llm", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--taxonomy", default="", help="逗号分隔的固定分类；给了就跳过聚类，直接零样本归类")
    args = ap.parse_args()
    if args.name and args.name_method == "none":
        args.name_method = "llm"

    items = load_corpus(Path(args.input).expanduser())
    print(f"[corpus] {len(items)} 条 <- {args.input}")
    texts = [it.text for it in items]

    t0 = time.perf_counter()
    X, meta = encode_texts(args.model, texts)
    print(f"[embed] {args.model} dim={X.shape[1]} {time.perf_counter()-t0:.1f}s")

    taxonomy = [t.strip() for t in args.taxonomy.split(",") if t.strip()]
    if not taxonomy and len(items) < 10:
        print(f"[warn] 只有 {len(items)} 条，聚类在这种规模下没有意义（实测 n<10 恒为 0 簇）。"
              f"\n       改用固定分类：--taxonomy \"AI工具,游戏,学习,生活,影视\"")
    names: dict[int, str] = {}
    if taxonomy:
        import llm

        t0 = time.perf_counter()
        got = llm.zero_shot([it.text for it in items], taxonomy, repo=args.llm)
        lab2name = {i: (g or "未归类") for i, g in enumerate(got)}
        uniq = {n: i for i, n in enumerate(dict.fromkeys(lab2name.values()))}
        labels = np.array([uniq[lab2name[i]] for i in range(len(items))])
        names = {v: k for k, v in uniq.items()}
        print(f"[taxonomy] 固定分类零样本归类完成 {time.perf_counter()-t0:.1f}s "
              f"{ {k: sum(1 for v in lab2name.values() if v == k) for k in names.values()} }")
    else:
        if args.no_umap:
            import hdbscan
            p = auto_params(len(X))
            labels = hdbscan.HDBSCAN(min_cluster_size=args.min_cluster_size or p["min_cluster_size"],
                                     min_samples=args.min_samples or p["min_samples"],
                                     metric="euclidean").fit_predict(X)
        else:
            labels = cluster(X, args.min_cluster_size, args.min_samples)

    n_clusters = len({int(v) for v in labels if v != -1})
    noise = int((labels == -1).sum())
    if not taxonomy:
        print(f"[cluster] {n_clusters} 簇, {len(X)-noise} 条已归类, {noise} 条未归类 ({noise/len(X)*100:.1f}%)")

    rep = representatives(X, labels)
    if args.name_method in ("ctfidf", "both") and rep:
        from labeling import ctfidf_labels
        names = {**ctfidf_labels([it.title or it.text for it in items], labels), **names}
    if args.name_method in ("llm", "both") and rep and not taxonomy:
        import llm

        t0 = time.perf_counter()
        if args.name_method == "both":       # 用 c-TF-IDF 关键词给 LLM 做提示
            from labeling import ctfidf_labels
            hints = ctfidf_labels([it.title or it.text for it in items], labels)
            payload = {c: [f"[关键词] {hints.get(c,'')}"] + [items[i].title or items[i].text for i in idx]
                       for c, idx in rep.items()}
        else:
            payload = {c: [items[i].title or items[i].text for i in idx] for c, idx in rep.items()}
        llm_names = llm.name_clusters(payload, repo=args.llm)
        names = {**names, **llm_names}
        print(f"[name] {len(llm_names)}/{len(payload)} 个簇命名成功 {time.perf_counter()-t0:.1f}s")
    for c, lbl in sorted(names.items()):
        print(f"   {lbl}  ({int((labels==c).sum())} 条)  ← 例: {(items[rep[c][0]].title if rep.get(c) else '')[:40]}")

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    recs = []
    for i, it in enumerate(items):
        c = int(labels[i])
        recs.append(dict(**it.to_dict(), cluster=c,
                         category=names.get(c) if c != -1 else None))
    (outdir / "categorized.json").write_text(json.dumps(recs, ensure_ascii=False, indent=2))

    # markdown 报告
    lines = [f"# 收藏分类结果\n", f"- 条目：{len(items)}", f"- 模型：{args.model}",
             f"- 簇数：{n_clusters}", f"- 未归类：{noise} ({noise/len(X)*100:.1f}%)\n"]
    buckets: dict[int, list[int]] = defaultdict(list)
    for i, c in enumerate(labels):
        buckets[int(c)].append(i)
    ordered = sorted([c for c in buckets if c != -1],
                     key=lambda c: -len(buckets[c]))
    for c in ordered:
        idx = buckets[c]
        lines.append(f"\n## {names.get(c) or f'簇 {c}'} ({len(idx)})")
        for i in idx[:15]:
            t = items[i].title or items[i].text
            lines.append(f"- {t[:100]}")
    if buckets.get(-1):
        lines.append(f"\n## 未归类 ({len(buckets[-1])})")
        for i in buckets[-1][:20]:
            lines.append(f"- {(items[i].title or items[i].text)[:100]}")
    (outdir / "report.md").write_text("\n".join(lines))
    print(f"[out] {outdir}/categorized.json , {outdir}/report.md")


if __name__ == "__main__":
    main()
