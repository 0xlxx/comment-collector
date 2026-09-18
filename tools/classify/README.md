# 收藏自动分类（本地）

把收藏（插件导出的 JSON / 浏览器书签 HTML / 任意文本）跑成有意义的主题分类。
全流程离线，M4 Pro 上 150 条约 20 秒（不含本地大模型起名）。

## 安装

```bash
cd tools/classify
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

## 用法

```bash
# 1. 直接分类（embedding + UMAP + HDBSCAN），CLI 打印 + 写 out/
.venv/bin/python classify.py ~/Downloads/Bookmarks.html -o out

# 2. 让本地大模型给每一簇起中文名（推荐，Qwen3-4B 4bit ≈ 2.3GB，首次自动下载）
.venv/bin/python classify.py ~/Downloads/bilibili-favorites.json -o out --name

# 3. 不用大模型，纯统计关键词当标签（零成本、秒出，但抽象主题会起得糙）
.venv/bin/python classify.py export.json -o out --name-method ctfidf

# 4. 已经有一套自己的分类，只想归类，不想聚类
.venv/bin/python classify.py export.json -o out --taxonomy "AI,游戏,财经,生活,学习"

# 换模型（默认 ritrieve-zh；bge-small-zh 更快更小，适合塞进浏览器）
.venv/bin/python classify.py export.json -o out --model bge-small-zh
```

输出：`out/categorized.json`（每条带 `cluster` / `category`）、`out/report.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `collect.py` | 统一读入插件 JSON / 书签 HTML / JSONL / TXT |
| `bench_models.py` | 模型横评：kNN、LogReg、KMeans、HDBSCAN |
| `embed_cache.py` | embedding 缓存（GPU 只跑一次，方便反复调参） |
| `tune_cluster.py` | 聚类方案扫描（降维 × 算法 × 超参） |
| `classify.py` | 端到端主程序 |
| `labeling.py` | c-TF-IDF 关键词标签（无 LLM 兜底） |
| `llm.py` | 本地 MLX 大模型：簇命名 / 零样本归类 |

## 结论

见 [`results/REPORT.md`](results/REPORT.md)。
