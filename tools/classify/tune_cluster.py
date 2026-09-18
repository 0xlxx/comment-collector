#!/usr/bin/env python
"""在缓存的 embedding 上扫聚类方案，回答「怎么分最好」。

维度：降维(none/UMAP) × 算法(HDBSCAN/KMeans/Agglomerative) × 超参
指标：ARI/NMI(有标注时) + 簇数 + 噪声率 + 覆盖率
"""
from __future__ import annotations

import argparse
import itertools
import json
import warnings
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
CACHE, RESULTS = ROOT / "cache", ROOT / "results"
warnings.filterwarnings("ignore")


def load(npz: Path):
    z = np.load(npz, allow_pickle=True)
    return z["emb"].astype(np.float32), z["labels"], np.array([str(t) for t in z["texts"]]), z["model"].item()


def reduce_umap(X, n_components: int, n_neighbors: int, seed: int = 42):
    import umap

    n_neighbors = max(2, min(n_neighbors, len(X) - 1))
    n_components = max(2, min(n_components, len(X) - 2))
    return umap.UMAP(n_components=n_components, n_neighbors=n_neighbors, min_dist=0.0,
                     metric="cosine", random_state=seed).fit_transform(X)


def score(y_true, labels) -> dict:
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

    labels = np.asarray(labels)
    mask = labels != -1
    n_clusters = len(set(labels[mask].tolist())) if mask.any() else 0
    out = dict(n_clusters=int(n_clusters), noise_pct=round(float((~mask).mean() * 100), 1),
               coverage_pct=round(float(mask.mean() * 100), 1))
    if 1 < n_clusters < len(labels) and mask.sum() > n_clusters:
        if y_true is not None and len(set(np.asarray(y_true)[mask].tolist())) > 1:
            out["ari"] = round(float(adjusted_rand_score(np.asarray(y_true)[mask], labels[mask])), 4)
            out["nmi"] = round(float(normalized_mutual_info_score(np.asarray(y_true)[mask], labels[mask])), 4)
    return out


def sil_score(X, labels) -> float | None:
    from sklearn.metrics import silhouette_score

    labels = np.asarray(labels)
    mask = labels != -1
    if mask.sum() < 3 or len(set(labels[mask].tolist())) < 2:
        return None
    try:
        return round(float(silhouette_score(X[mask], labels[mask], metric="cosine")), 4)
    except Exception:
        return None


def run_hdbscan(X, min_cluster_size, min_samples, metric, method="eom", eps=0.0):
    import hdbscan

    if metric == "cosine":           # hdbscan 不支持 cosine，单位化后 euclidean 等价
        n = np.linalg.norm(X, axis=1, keepdims=True)
        n[n == 0] = 1.0
        X, metric = X / n, "euclidean"
    return hdbscan.HDBSCAN(min_cluster_size=min_cluster_size, min_samples=min_samples, metric=metric,
                           cluster_selection_method=method, cluster_selection_epsilon=eps).fit_predict(X)


def run_kmeans(X, k, seed=42):
    from sklearn.cluster import KMeans

    return KMeans(n_clusters=k, n_init=10, random_state=seed).fit_predict(X)


def run_agglo(X, k=None, threshold=None, metric="cosine", linkage="average"):
    from sklearn.cluster import AgglomerativeClustering

    if threshold is not None:
        return AgglomerativeClustering(n_clusters=None, distance_threshold=threshold, metric=metric,
                                       linkage=linkage).fit_predict(X)
    return AgglomerativeClustering(n_clusters=k, metric=metric, linkage=linkage).fit_predict(X)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("npz", nargs="+")
    ap.add_argument("--tag", default="sweep")
    ap.add_argument("--reduction", default="none,umap5,umap10")
    ap.add_argument("--max-rows", type=int, default=2000)
    args = ap.parse_args()

    reductions = []
    for r in args.reduction.split(","):
        if r == "none":
            reductions.append(("none", None))
        elif r.startswith("umap"):
            reductions.append((r, int(r[4:])))

    out_rows = []
    for f in args.npz:
        p = Path(f)
        X, y, texts, model = load(p)
        if args.max_rows and len(X) > args.max_rows:
            rs = np.random.default_rng(0)
            sel = rs.choice(len(X), args.max_rows, replace=False)
            X, y = X[sel], (y[sel] if y is not None and len(y) == len(texts) else y)
        has_labels = y is not None and len(set(np.asarray(y).tolist()) - {-1}) > 1
        print(f"\n### {p.name}  n={len(X)} dim={X.shape[1]} labelled={has_labels}")

        for rname, rdim in reductions:
            Xr = X if rdim is None else reduce_umap(X, rdim, n_neighbors=min(30, max(5, len(X) // 20)))
            mr = "euclidean" if rdim is not None else "cosine"

            # HDBSCAN：自动定簇数
            n = len(Xr)
            for mcs, ms in itertools.product([max(3, n // 100), max(5, n // 50), max(8, n // 25), max(15, n // 12)],
                                             [1, 3, 5]):
                mcs = int(mcs)
                if mcs >= n:
                    continue
                try:
                    labels = run_hdbscan(Xr, mcs, ms, "euclidean" if rdim is not None else "cosine")
                except Exception as e:
                    print("  skip hdbscan", mcs, ms, e); continue
                s = score(y if has_labels else None, labels)
                s.update(model=model, reduction=rname, algo="hdbscan", params=dict(mcs=mcs, ms=ms),
                         sil=sil_score(X, labels), ms_per_1k=None)
                out_rows.append(s)

            # HDBSCAN + cosine metric（不降维时）
            if rdim is None:
                for mcs, ms in itertools.product([max(3, n // 50), max(8, n // 25)], [1, 5]):
                    mcs = int(mcs)
                    try:
                        labels = run_hdbscan(Xr, mcs, ms, "cosine")
                    except Exception as e:
                        print("  skip hdbscan-cos", e); continue
                    s = score(y if has_labels else None, labels)
                    s.update(model=model, reduction=rname, algo="hdbscan-cos", params=dict(mcs=mcs, ms=ms),
                             sil=sil_score(X, labels))
                    out_rows.append(s)

            # KMeans：需要指定 k
            for k in (8, 12, 15, 20):
                if k >= len(Xr):
                    continue
                labels = run_kmeans(Xr, k)
                s = score(y if has_labels else None, labels)
                s.update(model=model, reduction=rname, algo="kmeans", params=dict(k=k), sil=sil_score(X, labels))
                out_rows.append(s)

            # 层次聚类 + 距离阈值：不需要指定 k
            for th in (0.3, 0.4, 0.5, 0.6, 0.7):
                labels = run_agglo(Xr, threshold=th)
                s = score(y if has_labels else None, labels)
                s.update(model=model, reduction=rname, algo="agglo-th", params=dict(th=th), sil=sil_score(X, labels))
                out_rows.append(s)

    RESULTS.mkdir(exist_ok=True)
    (RESULTS / f"{args.tag}.json").write_text(json.dumps(out_rows, ensure_ascii=False, indent=2))

    for r in sorted([x for x in out_rows if "ari" in x and x.get("ari") is not None],
                    key=lambda x: -x["ari"])[:25]:
        print(f"ARI={r['ari']:.4f} NMI={r.get('nmi')} k={r['n_clusters']:>3} noise={r['noise_pct']:>5}% "
              f"sil={r.get('sil')} | {r['model']:<14} {r['reduction']:<6} {r['algo']:<12} {r['params']}")
    print(f"\n[total] {len(out_rows)} configs -> results/{args.tag}.json")


if __name__ == "__main__":
    main()
