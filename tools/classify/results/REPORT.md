# 端侧小模型给收藏分类：完整实测结论

> **单一事实来源（SSOT）**：所有实验、数字、结论、踩坑、未决问题都记在这里。
> 日期：2026-09-18 · 机器：Apple M4 Pro / 24GB · macOS · Python 3.12.11 · torch 2.14.0 (MPS)

---

## TL;DR

| 环节 | 选择 | 一句话理由 |
|---|---|---|
| 文本表示（本地） | **ritrieve_zh_v1 (0.3B, 1792 维)** | 分类、聚类双双第一，且只有 Qwen3-0.6B 一半大小 |
| 文本表示（浏览器内） | **bge-small-zh-v1.5 (24M, 512 维, ONNX q8 ≈ 25MB)** | 有现成 ONNX；质量只掉一档，体积掉 10 倍 |
| 聚类 | **UMAP(5~10 维) + HDBSCAN** | 不用预先知道分几类，自动定簇 + 天然留出「未归类」 |
| 起名 | **本地 LLM（Qwen3-4B-4bit / MLX）** | 「社会观察」「地缘政治」这种名字只有 LLM 给得出来 |
| 起名兜底 | c-TF-IDF 关键词 | 零成本、离线，但抽象主题会起成「小学生·多少·不是」 |

**一句话结论：瓶颈不在模型大小，在「怎么把一堆向量变成一个人类看得懂的类名」。**

---

## 0. 第一性原理：分类这件事只有三个冲程

像理解发动机只需知道四个冲程、不必知道每个零件规格一样，收藏分类这条链路的核心只有三步，缺一不可：

1. **表示（embedding）——把文字变成向量。**
   机器不认识「游戏」这两个字，它只会算两段文字在向量空间里离得近不近。
   这一步的精度是整条链路的**天花板**，后面怎么调参都补不回来。

2. **分组（clustering）——决定「多近算一类」。**
   真正的难点不是分组，而是**没人告诉你该分几类**，而且收藏里必然有孤例
   （一条冷门评论可能不属于任何类，硬塞进某一类反而污染它）。

3. **命名（labeling）——把簇变成人话。**
   聚类输出的只是 `簇 3`、`簇 7`。要变成「地缘政治」「原神角色」，
   需要一个「会说话」的东西。

**本次实测最重要的发现**：第 1 步选错模型，第 3 步再强也救不回来；
而第 1 步选对了，第 3 步反而是最容易翻车的地方（见 §4）。

---

## 1. 模型横评

数据集：C-MTEB **TNews 验证集**抽样 4000 条（15 类中文短标题，平均 22 字）。
50/50 划分；kNN(k=10, cosine) 与 LogisticRegression 在留出集上评测；聚类评测用同一份留出集。

| 模型 | 参数量 | 维度 | kNN | LogReg | KMeans ARI | HDBSCAN ARI | 噪声 | ms/1k |
|---|---|---|---|---|---|---|---|---|
| TF-IDF char 2-4gram | — | 20000 | 0.328 | 0.355 | 0.002 | 0.114 | 92.3% | ~0 |
| bge-small-zh-v1.5 | 24M | 512 | 0.487 | 0.504 | 0.176 | 0.033 | 84.3% | 0.5 |
| multilingual-e5-small | 118M | 384 | 0.480 | 0.524 | 0.127 | 0.223 | 94.8% | 0.5 |
| **ritrieve_zh_v1** | **0.3B** | **1792** | **0.547** | **0.571** | **0.247** | **0.527** | 83.2% | 3.7 |
| Qwen3-Embedding-0.6B | 0.6B | 1024 | 0.497 | 0.525 | 0.190 | 0.441 | 93.0% | 6.0 |

三条结论：

1. **词袋不够用。** TF-IDF 的 kNN 只有 33%，换成 embedding 直接 48~55%。
   短文本没有共现词就没法算相似度——这不是调参能解决的。
2. **越大不一定越好。** Qwen3-Embedding-0.6B（2025 年新模型、HF 下载量 850 万）
   **全面输给** 0.3B 的 ritrieve_zh_v1。参数量的收益被训练数据 / 任务对齐吃掉了。
3. **ritrieve_zh_v1 是端侧甜点。** 0.3B / 3.7ms 每千条 / 分类与聚类都是第一。

### ritrieve_zh_v1 是什么

`richinfoai/ritrieve_zh_v1`，0.3B 双塔中文 embedding，
蒸馏自 xiaobu-embedding-v2 + stella-large-zh-v3 + bge-multilingual-gemma2。
C-MTEB 分类榜上它 76.88 分，8B 的 Qwen3-Embedding 是 76.97 —— **差 0.09 分，小 26 倍**。

---

## 2. 聚类方案横评

扫了 **134 个组合**：{降维 none / UMAP-5 / UMAP-10} × {HDBSCAN / HDBSCAN-cosine / KMeans / 层次聚类} × 超参。
评测集同上（2000 条，真实 15 类）。其中 100 组跑出了有效 ARI。

### 2.1 只看 ARI 的冠军 —— 但不能用

| 方案 | ARI | 簇数 | 覆盖率 |
|---|---|---|---|
| ritrieve-zh + 原始 1792 维 + HDBSCAN(mcs=20, ms=3) | **0.480** | 12 | **21%** |

高维空间里点与点几乎等距，HDBSCAN 只好把不确信的全部丢进噪声。
纯度很高，但 **79% 的收藏没被归类**——产品上等于没做。

### 2.2 覆盖率 ≥ 70% 的可用区（推荐）

| 模型 | 降维 | 算法 | 参数 | ARI | NMI | 簇数 | 覆盖率 |
|---|---|---|---|---|---|---|---|
| ritrieve-zh | UMAP-10 | HDBSCAN | mcs=40, ms=5 | **0.331** | 0.456 | 14 | 74.7% |
| ritrieve-zh | UMAP-5 | HDBSCAN | mcs=40, ms=3 | 0.330 | 0.459 | 14 | 74.2% |
| ritrieve-zh | UMAP-5 | HDBSCAN | mcs=40, ms=5 | 0.327 | 0.458 | 14 | 75.9% |
| ritrieve-zh | UMAP-5 | HDBSCAN | mcs=40, ms=1 | 0.319 | 0.444 | **15** | 77.8% |
| qwen3-0.6b | UMAP-5 | HDBSCAN | mcs=80, ms=1 | 0.299 | 0.405 | 10 | 71.0% |

### 2.3 按算法族取最好成绩

| 算法族 | 最好 ARI | 覆盖率 | 要不要预先给簇数 |
|---|---|---|---|
| **HDBSCAN + UMAP** | **0.331** | 75% | 不用，自动定 |
| KMeans | 0.258 | 100% | 要，必须预先指定 k |
| 层次聚类 + 距离阈值 | 0.215 | 100% | 不用，但会碎成几十个簇 |

### 2.4 两个关键点

- **UMAP 不是可选装饰。** 它把 1792 维压到 5~10 维后，HDBSCAN 才能在高覆盖下工作
  （覆盖率 21% → 75%）。这正是 BERTopic 的标准配方。
- **自动定簇数真的准。** 真实 15 类，`UMAP-5 + HDBSCAN(mcs=40, ms=1)` 给出 **15 簇**。
  超参可直接按 `min_cluster_size ≈ n/50`、`min_samples ∈ {1,3,5}` 缩放。

---

## 3. 端到端实测（真实语料）

语料：B 站全站热门 3 页 + 10 个分区排行，去重后 **150 条真实视频标题**（跨 30+ 分区）。

| 模型 | 维度 | 簇数 | 覆盖率 | 轮廓系数 |
|---|---|---|---|---|
| ritrieve-zh | 1792 | 13 | 86.0% | 0.077 |
| qwen3-0.6b | 1024 | 13 | 74.0% | 0.073 |
| bge-small-zh | 512 | 12 | 82.7% | 0.031 |
| e5-small-multi | 384 | 2 | 100% | 0.045 |

ritrieve-zh 的 13 个簇（本地 LLM 命名）：

```
社会观察(24)  人生感悟(22)  异国体验(13)  同人动画(12)  原神角色(11)
地缘政治(9)   iPhone18(7)  极限挑战(7)   游戏对战(6)   电竞赛事(4)
音乐演绎(6)   生活日常(5)   萌系日常(3)   [未归类 21]
```

抽样验证：「原神角色」簇 11 条里 8 条来自手机游戏分区；「iPhone18」7 条里 5 条来自数码分区。
耗时：150 条约 13 秒（含模型加载），纯推理约 3.7ms/千条。

> ⚠️ **评测口径会骗人。** 和 B 站自己的 `tname` 分区做纯度比对只有 **0.32**——这不是缺陷。
> B 站分区描述的是**形式**（鬼畜剧场 / 影视剪辑 / 小剧场），我们聚的是**主题**（原神 / 地缘政治）。
> 指标选错了，才会得出「聚类不准」的结论。

### 3.1 插件真实收藏的冒烟测试

手上只有 9 月 9 日导出的 **6 条真实收藏**（B 站评论），走固定分类零样本模式：

| 类别 | 条数 | 例子 |
|---|---|---|
| AI与科技 | 3 | 「ai无论如何也不可能在数学方面超越人类顶尖人才…」 |
| 影视 | 2 | 「我记得有一部和这个差不多的电影…」 |
| 学习 | 1 | 「我也是😭」 |

**结论：格式与链路都通了，零样本归类可用。**
但也暴露一个点——一份 Post Malone 歌单被分进「AI与科技」，
因为给的分类表里没有「音乐」这个选项。
**固定分类模式下，分类表漏掉一个类，就会产生系统性错分；聚类模式没有这个问题。**

---

## 4. 起名方案对比

同一批簇（ritrieve-zh，13 簇），三种起名方式：

| 方式 | 耗时 | 「人生/情感」那簇的标签 | 判断 |
|---|---|---|---|
| 本地 LLM（Qwen3-4B-4bit / MLX） | **6.2s** | `人生感悟` | ✅ 用户能直接当收藏夹名 |
| c-TF-IDF 关键词（jieba） | 0.2s | `人格·瞬间·阿祖` | ⚠️ 具体主题还行（`原神·沃雅妮·斯纳`），抽象主题垮 |
| LLM + c-TF-IDF 关键词提示 | 6.2s | `人格瞬间` | ❌ 关键词反而把 LLM 带偏，不如纯 LLM |

**结论：直接让 LLM 看每簇 8 条代表样本（离质心最近的那几条），一次调用给全部簇命名。**
不要喂关键词，不要逐条分类。

耗时参考：热启动 6.2s 命名 13 个簇；冷启动（首次从磁盘加载 4.2GB 权重 + 内存压力）实测出现过 233s。
命名是**一次性的离线步骤**，不是每次浏览都要跑。

### Chrome 内置 Gemini Nano 的实测

在 Chrome 153 上探测 `LanguageModel` / `ai.languageModel` / `Translator` / `Summarizer`：
**全部 `undefined`**，该 profile 没下载端侧模型组件。
→ **可以当 bonus，不能当依赖。**

---

## 5. 浏览器内可行性

用 Transformers.js 3.7.2 在 Chrome 里实跑 `Xenova/bge-small-zh-v1.5`：

| 指标 | 实测 |
|---|---|
| 模型体积 | ONNX q8 ≈ 25MB（int8）；q4 / q4f16 更小 |
| 首次加载（含下载） | 5.9s |
| 8 条短标题推理 | 0.2s（wasm 后端） |

ONNX 供给情况：

| 模型 | 现成 ONNX | 仓库 |
|---|---|---|
| bge-small-zh-v1.5 | ✅ fp32/fp16/int8/q4/q4f16/bnb4 | `Xenova/bge-small-zh-v1.5` |
| multilingual-e5-small | ✅ 同上 | `Xenova/multilingual-e5-small` |
| Qwen3-Embedding-0.6B | ✅ | `onnx-community/Qwen3-Embedding-0.6B-ONNX` |
| **ritrieve_zh_v1** | ❌ 只有 GGUF | 要进浏览器需自行转 ONNX |

环境限制：测试用的 Chrome 实例 `navigator.gpu === undefined`（headless / 临时 profile），
所以只跑到 wasm 后端。真实 Chrome + Apple Silicon 走 WebGPU 会更快。

---

## 6. 数据来源与限制

### 6.1 已拿到

| 来源 | 内容 | 路径 |
|---|---|---|
| 插件 JSON 导出 | 9 条（去重后 6 条）真实 B 站评论收藏 | `~/Downloads/bilibili-favorites-*.json` |
| B 站公开 API | 150 条真实标题（热门 3 页 + 10 分区排行） | `tools/classify/data/bili_mixed.jsonl` |
| C-MTEB | TNews 验证集 10000 条（用 4000） | `tools/classify/data/tnews_valid.parquet` |

### 6.2 拿不到的：macOS TCC

直接读浏览器数据**全部被拒**：

```
ls ~/Library/Application Support/Google/Chrome  → Operation not permitted
ls ~/Library/Safari                              → Operation not permitted
ls ~/Library/Mail                                → Operation not permitted
ls ~/Library/Messages                            → Operation not permitted
```

这是 macOS 的 TCC（隐私保护）拦截，不是文件权限问题（`ls -ld` 显示属主就是当前用户，`drwx------`）。
运行本进程的 app（ChatGPT.app / Codex）**没有「完全磁盘访问权限」**，
因此拿不到 **Chrome 书签**、也拿不到浏览器里那批真实收藏。

### 6.3 三条取数路径

1. **最快**：Chrome 打开书签管理器 `⌥⌘B` → 右上角 `⋮` → 导出书签 → 存到 `~/Downloads`
2. **一劳永逸**：系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 打开 ChatGPT/Codex → 重启 app，
   之后可直接读 Chrome 数据，无需每次导出
3. **插件自带的**：收藏面板的「导出 JSON 备份」按钮 → 存到 `~/Downloads`

工具的 `collect.py` **三种格式都已支持**：插件 JSON / 浏览器书签 HTML / JSONL / TXT。
拿到数据即可直接跑，无需改代码。

---

## 7. 落地形态建议

```
收藏语料 ──> embedding ──> UMAP ──> HDBSCAN ──> LLM 命名 ──> 写回分类
           (0.3B 本地)   5~10维    自动定簇    一次调用
```

两条路线，按「在哪跑」分：

| | 浏览器扩展内 | 本地 CLI |
|---|---|---|
| 模型 | bge-small-zh ONNX q8 (25MB) | **ritrieve_zh_v1 (0.3B)** |
| 起名 | 云端 / Chrome 内置（有就用） | **Qwen3-4B-4bit MLX** |
| 优点 | 零安装、离线可用 | 质量最好、不用转 ONNX |
| 缺点 | 质量掉一档；转 ONNX 有维护成本 | 要装 Python |
| 适合 | 日常自动分类 | 首次全量整理 / 精修 |

**推荐路径：先用本地 CLI 把分类质量验证到位，再把同一套配方降级搬进扩展。**

---

## 8. 反直觉发现 / 踩过的坑

1. **更大不等于更好。** 0.6B 的 Qwen3-Embedding 输给 0.3B 的 ritrieve_zh_v1。
   「新模型 + 参数多 + 下载量高」三个信号同时失效。
2. **指标冠军往往不能用。** HDBSCAN 在原始高维空间 ARI 0.48 全场最高，
   但覆盖率只有 21%。**聚类必须同时看 ARI 和覆盖率**，单看一个都会选错。
3. **UMAP 不是装饰。** 不降维 → 覆盖率 21%；降到 5~10 维 → 覆盖率 75%。
   同一算法、同一数据，只差这一步。
4. **评测口径会骗人。** 与 B 站 `tname` 比纯度只有 0.32，
   但原因是 `tname` 描述「形式」、我们聚的是「主题」，不是聚类失败。
   **选错参照物会得出完全相反的结论。**
5. **给 LLM 喂关键词反而更差。** c-TF-IDF 关键词做提示词，
   把 `人生感悟` 带偏成 `人格瞬间`。纯样本比「样本+关键词」好。
6. **Chrome 内置 AI 不可依赖。** Chrome 153 上 `LanguageModel` 全为 `undefined`。
7. **轮廓系数在原始高维空间会虚高。** TF-IDF 轮廓 0.1425 反而最高，
   那是稀疏词袋在自娱自乐；不能拿它跨模型比较。
8. **最好的模型未必进得了浏览器。** ritrieve_zh_v1 在 HF 上**没有 ONNX**（只有 GGUF），
   要进浏览器得自己转。
9. **固定分类表漏项 = 系统性错分。** Post Malone 歌单因为没有「音乐」选项被塞进「AI与科技」。
   要么给全分类表，要么用聚类自动发现。
10. **小语料下模型加载时间会盖过推理时间。** 150 条跑 13 秒，其中大部分是加载 0.3B 权重。
    批量任务一次加载、多次复用才划算。

---

## 9. 未决问题与下一步

| # | 待决 | 阻塞在哪 |
|---|---|---|
| 1 | 用**真实全量收藏**跑一遍 | 需要上面的 §6.3 三条路径之一 |
| 2 | 「浏览器书签」vs「插件收藏」两类数据分类效果对比 | 同上 |
| 3 | 分类结果如何写回插件面板（按分类分组展示） | 待 §7 路线定案 |
| 4 | 是否把 bge-small-zh ONNX + Transformers.js 搬进 userscript | 待质量验证后定 |
| 5 | CLS（内容布局偏移）与毛玻璃面板的稳定性 | 独立 UI 任务，与本报告无关 |
| 6 | 增量分类：新增收藏时不重跑全量 | 设计问题（可用「分配最近簇质心」实现增量） |

---

## 附录 A · 复现命令

```bash
cd tools/classify
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt

# 语料（公开数据，无个人内容）
.venv/bin/python fetch_public_corpus.py          # -> data/bili_mixed.jsonl（150 条）
curl -sSL -o data/tnews_valid.parquet \
  https://huggingface.co/datasets/C-MTEB/TNews-classification/resolve/main/data/validation-00000-of-00001-b1f0617526744b05.parquet

# 表 1（§1 模型横评）
.venv/bin/python bench_models.py --dataset tnews --n 4000

# 表 2~4（§2 聚类扫描，134 组）
.venv/bin/python tune_cluster.py cache/tnews__ritrieve-zh.npz \
    cache/tnews__qwen3-0.6b.npz --max-rows 2000 --tag tnews_sweep

# §3 / §4（端到端 + 起名）
.venv/bin/python classify.py data/bili_mixed.jsonl -o out --model ritrieve-zh --name

# §3.1（固定分类零样本）
.venv/bin/python classify.py ~/Downloads/bilibili-favorites.json -o out \
    --model ritrieve-zh --taxonomy "AI与科技,游戏,学习,生活,影视"
```

## 附录 B · 工具文件清单

| 文件 | 作用 |
|---|---|
| `collect.py` | 统一读入：插件 JSON / 书签 HTML / JSONL / TXT |
| `bench_models.py` | 模型横评：kNN、LogReg、KMeans、HDBSCAN |
| `embed_cache.py` | embedding 缓存（GPU 只跑一次，便于反复调参） |
| `tune_cluster.py` | 聚类方案扫描（降维 × 算法 × 超参） |
| `classify.py` | 端到端主程序（聚类模式 / 固定分类模式 / 三种命名） |
| `labeling.py` | c-TF-IDF 关键词标签（无 LLM 兜底） |
| `llm.py` | 本地 MLX 大模型：簇命名 / 零样本归类 |
| `fetch_public_corpus.py` | 抓公开基准语料（B 站热门 + 分区排行），无个人数据 |

## 附录 C · 环境与依赖

```
Apple M4 Pro / 24GB / macOS
Python 3.12.11 (uv)
torch 2.14.0 (MPS 可用) · transformers 5.17.0 · sentence-transformers 6.0.1
umap-learn 0.5.12 · hdbscan · scikit-learn · jieba 0.42.1 · mlx-lm 0.31.3
```

模型体积（本地磁盘，含 fp32 权重）：

| 模型 | 体积 |
|---|---|
| bge-small-zh-v1.5 | 184 MB |
| multilingual-e5-small | 962 MB |
| Qwen3-Embedding-0.6B | 2.2 GB |
| ritrieve_zh_v1 | 2.4 GB |
| Qwen3-4B-Instruct-2507-4bit (MLX) | 4.2 GB |

## 附录 D · 原始数据

| 文件 | 内容 |
|---|---|
| `results/tnews_4000.json` | §1 模型横评全量结果（每模型 10 项指标） |
| `results/tnews_sweep.json` | §2 聚类扫描 134 组完整配置与指标 |
| `cache/tnews__*.npz` | TNews 4000 条的 embedding 缓存 |
| `cache/bili_mixed__*.npz` | 150 条真实 B 站标题的 embedding 缓存（5 个模型） |
| `data/bili_mixed.jsonl` | 150 条真实 B 站标题语料（含分区 tname），由 `fetch_public_corpus.py` 生成 |
| `data/tnews_valid.parquet` | C-MTEB TNews 验证集（10000 条，用 4000） |
