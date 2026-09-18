#!/usr/bin/env python
"""本地 LLM：给簇起名字 / 直接零样本分类。默认 MLX（Apple Silicon 原生）。"""
from __future__ import annotations

import json
import re
from typing import Iterable

_CACHE: dict = {}


def _load_mlx(repo: str):
    if repo not in _CACHE:
        from mlx_lm import load

        model, tok = load(repo)
        _CACHE[repo] = (model, tok)
    return _CACHE[repo]


def chat(prompt: str, repo: str = "mlx-community/Qwen3-4B-Instruct-2507-4bit",
         max_tokens: int = 1024, temperature: float = 0.2) -> str:
    from mlx_lm import generate
    from mlx_lm.sample_utils import make_sampler

    model, tok = _load_mlx(repo)
    messages = [{"role": "user", "content": prompt}]
    text = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
    return generate(model, tok, prompt=text, max_tokens=max_tokens, verbose=False,
                    sampler=make_sampler(temp=temperature))


def extract_json(s: str):
    """从 LLM 输出里抠出第一个 JSON（容忍 ```json 包裹和前后废话）。"""
    s = s.strip()
    s = re.sub(r"^```(?:json)?|```$", "", s, flags=re.M).strip()
    for opener, closer in (("[", "]"), ("{", "}")):
        i, j = s.find(opener), s.rfind(closer)
        if i != -1 and j > i:
            try:
                return json.loads(s[i:j + 1])
            except Exception:
                pass
    raise ValueError(f"no json in: {s[:200]}")


NAMING_PROMPT = """你是一个中文收藏夹整理助手。下面是从用户收藏里自动聚类出的若干组内容。

请为每一组起一个 **2-6 个汉字** 的中文标签，要求：
- 标签是名词短语，像用户自己会建的收藏夹名字（例如「AI 工具」「前端性能」「宏观经济」）
- 同一批标签之间不要语义重复；如果两组主题相同，请给出完全相同的标签
- 不要输出「其他」「杂项」「综合」这类无信息量的词

只输出 JSON 数组，每项形如 {{"i": 组号, "label": "标签"}}，不要解释。

{groups}"""


def name_clusters(clusters: dict[int, list[str]], repo: str, per_cluster: int = 8) -> dict[int, str]:
    """clusters: {cluster_id: [代表样本...]} -> {cluster_id: label}"""
    blocks = []
    for cid, samples in clusters.items():
        lines = "\n".join(f"  - {s[:120]}" for s in samples[:per_cluster])
        blocks.append(f"组 {cid}：\n{lines}")
    prompt = NAMING_PROMPT.format(groups="\n\n".join(blocks))
    raw = chat(prompt, repo=repo, max_tokens=1024)
    try:
        data = extract_json(raw)
    except Exception:
        return {}
    out: dict[int, str] = {}
    for item in data if isinstance(data, list) else []:
        try:
            out[int(item["i"])] = str(item["label"]).strip()
        except Exception:
            continue
    return out


ZERO_SHOT_PROMPT = """把下面的条目归入最合适的一个类别。类别只能是这些之一：
{taxonomy}

条目：
{items}

只输出 JSON 数组，每项形如 {{"i": 序号, "c": "类别名"}}，不要解释。"""


def zero_shot(items: list[str], taxonomy: Iterable[str], repo: str, batch: int = 40) -> list[str]:
    tax = "、".join(taxonomy)
    out: list[str] = []
    for s in range(0, len(items), batch):
        chunk = items[s:s + batch]
        body = "\n".join(f"{i+1}. {t[:160]}" for i, t in enumerate(chunk))
        raw = chat(ZERO_SHOT_PROMPT.format(taxonomy=tax, items=body), repo=repo, max_tokens=2048)
        try:
            data = extract_json(raw)
        except Exception:
            out.extend([""] * len(chunk))
            continue
        got = {int(d["i"]): str(d["c"]).strip() for d in data if isinstance(d, dict) and "i" in d}
        out.extend(got.get(i + 1, "") for i in range(len(chunk)))
    return out
