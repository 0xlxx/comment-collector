#!/usr/bin/env python
"""把语料的 embedding 缓存成 npz，便于反复调聚类参数（GPU 只跑一次）。"""
from __future__ import annotations
import argparse, time
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA, CACHE = ROOT / "data", ROOT / "cache"
from bench_models import MODEL_SPECS, encode_texts, tfidf_features, load_dataset


def build_corpus(name: str, n: int) -> tuple[list[str], np.ndarray, np.ndarray]:
    """返回 texts, labels(可全为 -1), source_index"""
    if name == "tnews":
        texts, y = load_dataset("tnews", n)
        return texts, y, np.arange(len(texts))
    p = Path(name).expanduser()
    if p.exists():
        from collect import load_corpus
        items = load_corpus(p)
        texts = [it.text for it in items]
        return texts, np.full(len(texts), -1), np.arange(len(texts))
    raise SystemExit(f"unknown corpus {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("corpus")
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--models", default="ritrieve-zh,qwen3-0.6b,bge-small-zh")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    texts, y, idx = build_corpus(args.corpus, args.n)
    tag = args.corpus if not Path(args.corpus).exists() else Path(args.corpus).stem
    print(f"[corpus] {tag} n={len(texts)}")
    for key in [m.strip() for m in args.models.split(",") if m.strip()]:
        out = CACHE / f"{tag}__{key}.npz"
        if out.exists():
            print(f"[skip] {out.name}")
            continue
        t0 = time.perf_counter()
        if key == "tfidf":
            X, _ = tfidf_features(texts)
            meta = {}
        else:
            X, meta = encode_texts(key, texts)
        np.savez_compressed(out, emb=X, labels=y, texts=np.array(texts, dtype=object), meta=meta,
                            model=key, corpus=tag, elapsed=time.perf_counter() - t0)
        print(f"[ok] {out.name} dim={X.shape[1]} in {time.perf_counter()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
