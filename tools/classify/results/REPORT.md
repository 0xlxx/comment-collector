# 端侧小模型做收藏分类：实测结论

日期：2026-09-18 · 机器：M4 Pro 24GB · Python 3.12 · torch 2.14 (MPS)

## TL;DR

| 环节 | 选择 | 为什么 |
|---|---|---|
| 文本表示 | **ritrieve_zh_v1 (0.3B, 1792 维)** | 分类、聚类双双第一，且只有 Qwen3-0.6B 一半大小 |
| 浏览器内表示 | **bge-small-zh-v1.5 (24M, 512 维, ONNX q8 ≈ 25MB)** | 有现成 ONNX；质量只掉一档，体积掉 10 倍 |
| 聚类 | **UMAP(5~10 维) + HDBSCAN** | 不用预先知道分类数，自动定簇 + 天然留出「未归类」 |
| 起名 | **本地 LLM（Qwen3-4B-4bit / MLX）** | 「社会观察」「地缘政治」这种名字只有 LLM 给得出来 |
| 起名兜底 | c-TF-IDF 关键词 | 零成本、离线，但抽象主题会起成「小学生·多少·不是」 |

一句话：**瓶颈不在模型大小，在「怎么把簇变成一个人类看得懂的名字」。**

## 一、模型横评

数据集：C-MTEB TNews 验证集抽样 4000 条（15 类中文短标题，平均 22 字）。
50/50 划分，kNN(k=10, cosine) 与 LogisticRegression 在留出集上评测；
聚类评测用同一份留出集。

| 模型 | 参数量 | 维度 | kNN | LogReg | KMeans ARI | HDBSCAN ARI | 噪声 | ms/1k |
|---|---|---|---|---|---|---|---|---|
| TF-IDF char 2-4gram | — | 20000 | 0.328 | 0.355 | 0.002 | 0.114 | 92.3% | ~0 |
| bge-small-zh-v1.5 | 24M | 512 | 0.487 | 0.504 | 0.176 | 0.033 | 84.3% | 0.5 |
| multilingual-e5-small | 118M | 384 | 0.480 | 0.524 | 0.127 | 0.223 | 94.8% | 0.5 |
| **ritrieve_zh_v1** | **0.3B** | **1792** | **0.547** | **0.571** | **0.247** | **0.527** | 83.2% | 3.7 |
| Qwen3-Embedding-0.6B | 0.6B | 1024 | 0.497 | 0.525 | 0.190 | 0.441 | 93.0% | 6.0 |

三条结论：

1. **词袋不够用**：TF-IDF 的 kNN 只有 33%，换成 embedding 直接 48~55%。短文本没有共现词就没法算相似。
2. **越大不一定越好**：Qwen3-Embedding 0.6B（2025 年新模型、下载量 850 万）全面输给 0.3B 的 ritrieve_zh_v1。
   参数量的收益被训练数据/任务对齐吃掉了。
3. **ritrieve_zh_v1 是端侧甜点**：0.3B / 3.7ms 每千条 / 分类与聚类都是第一。

### ritrieve_zh_v1 是什么

`richinfoai/ritrieve_zh_v1`，0.3B 双塔中文 embedding，蒸馏自 xiaobu-embedding-v2 + stella-large-zh-v3 + bge-multilingual-gemma2。
C-MTEB 分类榜上它 76.88 分，8B 的 Qwen3-Embedding 是 76.97 —— **差 0.09 分，小 26 倍**。

## 二、聚类方案横评

扫了 134 个组合：{降维 none/UMAP-5/UMAP-10} × {HDBSCAN / HDBSCAN-cosine / KMeans / 层次聚类} × 超参。
评测集同上（2000 条，15 类）。

**只看 ARI 的冠军（但不能用）**

| 方案 | ARI | 簇数 | 覆盖率 |
|---|---|---|---|
| ritrieve-zh + 原始 1792 维 + HDBSCAN(mcs=20, ms=3) | **0.480** | 12 | **21%** |

高维空间里点与点几乎等距，HDBSCAN 只好把不确信的都丢进噪声 —— 纯度很高，但 79% 的收藏没被归类，产品上等于没做。

**覆盖率 ≥ 70% 的可用区（推荐）**

| 模型 | 降维 | 算法 | 参数 | ARI | NMI | 簇数 | 覆盖率 |
|---|---|---|---|---|---|---|---|
| ritrieve-zh | UMAP-10 | HDBSCAN | mcs=40, ms=5 | **0.331** | 0.456 | 14 | 74.7% |
| ritrieve-zh | UMAP-5 | HDBSCAN | mcs=40, ms=3 | 0.330 | 0.459 | 14 | 74.2% |
| ritrieve-zh | UMAP-5 | HDBSCAN | mcs=40, ms=5 | 0.327 | 0.458 | 14 | 75.9% |
| ritrieve-zh | UMAP-5 | HDBSCAN | mcs=40, ms=1 | 0.319 | 0.444 | **15** | 77.8% |
| qwen3-0.6b | UMAP-5 | HDBSCAN | mcs=80, ms=1 | 0.299 | 0.405 | 10 | 71.0% |

按算法族取最好成绩：

| 算法族 | 最好 ARI | 覆盖率 | 要不要给簇数 |
|---|---|---|---|
| HDBSCAN + UMAP | **0.331** | 75% | 不用，自动定 |
| KMeans | 0.258 | 100% | 要，必须预先指定 k |
| 层次聚类 + 距离阈值 | 0.215 | 100% | 不用，但会碎成几十个簇 |

两个关键点：

- **UMAP 不是可选装饰**。它把 1792 维压到 5~10 维后，HDBSCAN 才能在高覆盖下工作（覆盖率 21% → 75%）。这正是 BERTopic 的标准配方。
- **自动定簇数真的准**：真实 15 类，UMAP-5 + HDBSCAN(mcs=40, ms=1) 给出 15 簇。参数按 `min_cluster_size ≈ n/50` 缩放即可。

## 三、端到端实测（真实语料）

语料：B 站全站热门 3 页 + 10 个分区排行，去重后 150 条真实视频标题（跨 30+ 分区）。

| 模型 | 维度 | 簇数 | 覆盖率 | 轮廓系数 |
|---|---|---|---|---|
| ritrieve-zh | 1792 | 13 | 86.0% | 0.077 |
| qwen3-0.6b | 1024 | 13 | 74.0% | 0.073 |
| bge-small-zh | 512 | 12 | 82.7% | 0.031 |
| e5-small-multi | 384 | 2 | 100% | 0.045 |

ritrieve-zh 的 13 个簇（LLM 命名）：

```
社会观察(24)  人生感悟(22)  异国体验(13)  同人动画(12)  原神角色(11)
地缘政治(9)   iPhone18(7)  极限挑战(7)   游戏对战(6)   电竞赛事(4)
音乐演绎(6)   生活日常(5)   萌系日常(3)   [未归类 21]
```

抽样验证：「原神角色」簇 11 条里 8 条来自手机游戏分区；「iPhone18」7 条里 5 条来自数码分区。

> 注意：和 B 站自己的 `tname` 分区做纯度比对只有 0.32 —— 这不是缺陷。
> B 站分区描述的是**形式**（鬼畜剧场 / 影视剪辑 / 小剧场），我们聚的是**主题**（原神 / 地缘政治）。
> 评测口径选错了才会得出「聚类不准」的结论。

## 四、起名方案对比

同一批簇（ritrieve-zh，13 簇），三种起名方式：

| 方式 | 耗时 | 「人生/情感」那簇的标签 | 判断 |
|---|---|---|---|
| 本地 LLM（Qwen3-4B-4bit / MLX） | **6.2s** | `人生感悟` | ✅ 用户能直接当收藏夹名 |
| c-TF-IDF 关键词（jieba） | 0.2s | `人格·瞬间·阿祖` | ⚠️ 具体主题还行（`原神·沃雅妮·斯纳`），抽象主题垮 |
| LLM + c-TF-IDF 提示词 | 6.2s | `人格瞬间` | ❌ 关键词反而把 LLM 带偏，不如纯 LLM |

**结论：直接让 LLM 看每簇 8 条代表样本（离质心最近的那几条），一次调用给全部簇命名。**
不要喂关键词，不要逐条分类。

另外测过 Chrome 内置 Gemini Nano（`LanguageModel` / `ai.languageModel` / `Translator` / `Summarizer`）：
在 Chrome 153 上全部 `undefined`，该 profile 没下载端侧模型组件 —— **可以当 bonus，不能当依赖**。

## 五、浏览器内可行性

用 Transformers.js 3.7.2 在 Chrome 里实跑 `Xenova/bge-small-zh-v1.5`：

| 指标 | 实测 |
|---|---|
| 模型体积 | ONNX q8 ≈ 25MB（int8）/ q4 更小 |
| 首次加载（含下载） | 5.9s |
| 8 条短标题推理 | 0.2s（wasm 后端） |

- `ritrieve_zh_v1` **没有 ONNX 版**（HF 上只有 GGUF），要进浏览器得自己转 ONNX。
- `Xenova/bge-small-zh-v1.5`、`Xenova/multilingual-e5-small`、`onnx-community/Qwen3-Embedding-0.6B-ONNX` 都有现成 ONNX。
- 测试用的 Chrome 实例 `navigator.gpu === undefined`（headless/临时 profile），所以只跑到 wasm。
  真实 Chrome + Apple Silicon 走 WebGPU 会更快。

## 六、建议的落地形态

```
收藏语料 ──> embedding ──> UMAP ──> HDBSCAN ──> LLM 命名 ──> 写回分类
           (0.3B 本地)   5~10维    自动定簇    一次调用
```

两条路线，按「在哪跑」分：

| | 浏览器扩展内 | 本地 CLI |
|---|---|---|
| 模型 | bge-small-zh ONNX q8 (25MB) | ritrieve_zh_v1 (0.3B) |
| 起名 | 云端 / Chrome 内置（有就用） | Qwen3-4B-4bit MLX |
| 优点 | 零安装、离线可用 | 质量最好、不用转 ONNX |
| 缺点 | 质量掉一档；转 ONNX 有维护成本 | 要装 Python |
| 适合 | 日常自动分类 | 首次全量整理 / 精修 |

推荐先做本地 CLI 把分类质量验证到位，再把同一套配方降级搬进扩展。

## 复现

```bash
cd tools/classify
.venv/bin/python bench_models.py --dataset tnews --n 4000          # 表一
.venv/bin/python tune_cluster.py cache/tnews__ritrieve-zh.npz \
    cache/tnews__qwen3-0.6b.npz --max-rows 2000 --tag tnews_sweep  # 表二
.venv/bin/python classify.py data/bili_mixed.jsonl -o out --name   # 表三、表四
```

原始数据：`results/tnews_4000.json`、`results/tnews_sweep.json`、`cache/*.npz`。
