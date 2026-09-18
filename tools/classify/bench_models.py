#!/usr/bin/env python
"""端侧小模型 × 聚类算法 对比：中文短文本分类/聚类。

用法:
  .venv/bin/python bench_models.py --dataset tnews --n 4000
  .venv/bin/python bench_models.py --dataset tnews --n 800 --models tfidf,bge-small-zh
"""
from __future__ import annotations

import argparse
import gc
import json
import resource
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RESULTS = ROOT / "results"


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)


# ---------------------------------------------------------------- datasets
def load_dataset(name: str, n: int, seed: int = 0) -> tuple[list[str], np.ndarray]:
    if name == "tnews":
        df = pd.read_parquet(DATA / "tnews_valid.parquet")
    elif name == "iflytek":
        df = pd.read_parquet(DATA / "iflytek_test.parquet")
    else:
        raise SystemExit(f"unknown dataset {name}")
    df = df[df["label"] >= 0].copy()
    if n and n < len(df):
        df = df.sample(n=n, random_state=seed).reset_index(drop=True)
    return df["text"].astype(str).tolist(), df["label"].to_numpy()


# ---------------------------------------------------------------- encoders
MODEL_SPECS: dict[str, dict] = {
    # 24M 参数 / 512 维 / 中文，ONNX 友好（约 100MB fp32，量化后 ~25MB）
    "bge-small-zh": dict(hf="BAAI/bge-small-zh-v1.5", doc_prefix="", trust=False),
    # 118M 参数 / 384 维 / 100+ 语言，Transformers.js 官方支持
    "e5-small-multi": dict(hf="intfloat/multilingual-e5-small", doc_prefix="passage: ", trust=False),
    # 0.3B / 中文榜分类分接近 8B 天花板
    "ritrieve-zh": dict(hf="richinfoai/ritrieve_zh_v1", doc_prefix="", trust=True),
    # 0.6B / 现代通用基线
    "qwen3-0.6b": dict(hf="Qwen/Qwen3-Embedding-0.6B", doc_prefix="", trust=True),
}


def encode_texts(model_key: str, texts: list[str], batch_size: int = 64) -> np.ndarray:
    import torch
    from sentence_transformers import SentenceTransformer

    spec = MODEL_SPECS[model_key]
    t0 = time.perf_counter()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = SentenceTransformer(spec["hf"], trust_remote_code=spec.get("trust", False), device=device)
    load_s = time.perf_counter() - t0

    payload = [f"{spec['doc_prefix']}{t}" for t in texts]
    t1 = time.perf_counter()
    emb = model.encode(
        payload,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    enc_s = time.perf_counter() - t1
    dim = emb.shape[1]
    del model
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    return emb.astype(np.float32), dict(load_s=round(load_s, 1), enc_s=round(enc_s, 1), dim=int(dim))


def tfidf_features(texts: list[str], max_features: int = 20000) -> np.ndarray:
    from sklearn.feature_extraction.text import TfidfVectorizer

    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=2, max_features=max_features, sublinear_tf=True)
    X = vec.fit_transform(texts).toarray().astype(np.float32)
    # L2 归一化，和 embedding 的口径对齐
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return X / norms, dict(dim=int(X.shape[1]), n_features=int(X.shape[1]))


# ---------------------------------------------------------------- metrics
def knn_accuracy(X_tr, y_tr, X_te, y_te, k: int = 10) -> float:
    from sklearn.neighbors import KNeighborsClassifier

    k = min(k, len(X_tr))
    clf = KNeighborsClassifier(n_neighbors=k, metric="cosine", weights="distance", n_jobs=-1)
    clf.fit(X_tr, y_tr)
    return float((clf.predict(X_te) == y_te).mean())


def logreg_accuracy(X_tr, y_tr, X_te, y_te) -> float:
    from sklearn.linear_model import LogisticRegression

    clf = LogisticRegression(max_iter=2000, C=4.0, n_jobs=-1)
    clf.fit(X_tr, y_tr)
    return float((clf.predict(X_te) == y_te).mean())


def cluster_metrics(y_true, y_pred) -> dict:
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

    y_pred = np.asarray(y_pred)
    mask = y_pred != -1
    out = dict(n_clusters=int(len(set(y_pred[mask])) if mask.any() else 0), noise_pct=round(float((~mask).mean() * 100), 1))
    if mask.sum() > 1 and len(set(y_pred[mask])) > 1:
        out["ari"] = round(float(adjusted_rand_score(np.asarray(y_true)[mask], y_pred[mask])), 4)
        out["nmi"] = round(float(normalized_mutual_info_score(np.asarray(y_true)[mask], y_pred[mask])), 4)
    else:
        out["ari"] = None
        out["nmi"] = None
    return out


def run_kmeans(X, y_true, k: int, seed: int = 0) -> dict:
    from sklearn.cluster import KMeans

    km = KMeans(n_clusters=k, n_init=10, random_state=seed)
    labels = km.fit_predict(X)
    return cluster_metrics(y_true, labels)


def run_hdbscan(X, y_true, min_cluster_size: int = 20) -> dict:
    import hdbscan

    clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size, metric="euclidean", cluster_selection_method="eom")
    labels = clusterer.fit_predict(X)
    return cluster_metrics(y_true, labels)


# ---------------------------------------------------------------- main
@dataclass
class Row:
    model: str
    dim: int
    n: int
    knn_acc: float | None = None
    logreg_acc: float | None = None
    kmeans: dict = field(default_factory=dict)
    hdbscan: dict = field(default_factory=dict)
    load_s: float | None = None
    enc_s: float | None = None
    ms_per_1k: float | None = None
    peak_rss_mb: float | None = None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="tnews")
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--train-frac", type=float, default=0.5)
    ap.add_argument("--models", default="tfidf,bge-small-zh,e5-small-multi,ritrieve-zh,qwen3-0.6b")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    RESULTS.mkdir(exist_ok=True)
    texts, y = load_dataset(args.dataset, args.n)
    n_classes = len(set(y.tolist()))
    print(f"[data] {args.dataset} n={len(texts)} classes={n_classes} avg_len={np.mean([len(t) for t in texts]):.1f}")

    # 固定划分，保证所有模型看到同一批样本
    rng = np.random.default_rng(0)
    idx = rng.permutation(len(texts))
    n_tr = int(len(texts) * args.train_frac)
    tr, te = idx[:n_tr], idx[n_tr:]
    texts_arr = np.array(texts, dtype=object)

    wanted = [m.strip() for m in args.models.split(",") if m.strip()]
    rows: list[Row] = []
    for key in wanted:
        print(f"\n=== {key} ===")
        t0 = time.perf_counter()
        if key == "tfidf":
            X, meta = tfidf_features(texts)
            load_s = time.perf_counter() - t0
            enc_s = 0.0
        elif key in MODEL_SPECS:
            X, meta = encode_texts(key, texts)
            load_s, enc_s = meta["load_s"], meta["enc_s"]
        else:
            print(f"  skip unknown model {key}")
            continue

        row = Row(model=key, dim=int(meta["dim"]), n=len(texts))
        row.load_s, row.enc_s = round(load_s, 1), round(enc_s, 1)
        row.ms_per_1k = round(enc_s / len(texts) * 1000, 1)
        row.peak_rss_mb = round(peak_rss_mb(), 1)

        X_tr, X_te = X[tr], X[te]
        y_tr, y_te = y[tr], y[te]
        row.knn_acc = round(knn_accuracy(X_tr, y_tr, X_te, y_te), 4)
        row.logreg_acc = round(logreg_accuracy(X_tr, y_tr, X_te, y_te), 4)

        # 无监督：只给测试集，不告诉它类别数（HDBSCAN）/告诉它类别数（KMeans 上界）
        Xte_only = X[te]
        yte_only = y[te]
        row.kmeans = run_kmeans(Xte_only, yte_only, k=n_classes)
        row.hdbscan = run_hdbscan(Xte_only, yte_only, min_cluster_size=max(8, len(te) // 200))
        rows.append(row)

        print(f"  dim={row.dim} knn={row.knn_acc} logreg={row.logreg_acc} "
              f"kmeans(ari={row.kmeans.get('ari')}) hdbscan(ari={row.hdbscan.get('ari')}, k={row.hdbscan.get('n_clusters')}, noise={row.hdbscan.get('noise_pct')}%)")

    out = RESULTS / f"{args.dataset}_{args.n}{('_' + args.tag) if args.tag else ''}.json"
    out.write_text(json.dumps(dict(dataset=args.dataset, n=len(texts), classes=n_classes,
                                   rows=[asdict(r) for r in rows]), ensure_ascii=False, indent=2))
    print(f"\n[saved] {out}")

    # markdown 表
    cols = ["model", "dim", "knn_acc", "logreg_acc", "kmeans_ari", "hdbscan_ari", "hdbscan_k", "noise%", "ms/1k", "rss_MB"]
    print("\n| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for r in rows:
        print("| " + " | ".join(str(v) for v in [
            r.model, r.dim, r.knn_acc, r.logreg_acc,
            r.kmeans.get("ari"), r.hdbscan.get("ari"), r.hdbscan.get("n_clusters"),
            r.hdbscan.get("noise_pct"), r.ms_per_1k, r.peak_rss_mb]) + " |")


if __name__ == "__main__":
    main()
