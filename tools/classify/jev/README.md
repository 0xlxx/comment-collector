# Jev 探针

用同一组问题跑 Jev，和本地基线（`../probe_questions.py`）对比。

## 为什么要有这个

本地 Qwen3-4B 的实测病灶（见 `../results/REPORT.md` §10）：

| 字段 | 本地表现 |
|---|---|
| category（分类） | 85% 准确（剔除争议项 94%）—— **够用** |
| intent（意图） | 20 条里 19 条都答 `reference` —— **塌缩，无区分度** |
| perishable（时效性） | 100% 落在中间两档，从未用过 1 或 4 —— **无区分度** |
| keep（保留价值） | 100% 落在 0.6~0.8 —— **无区分度** |

也就是说：**本地 LLM 能做"选哪个"，做不好"有多"。**
而 "有多" 恰恰是需要校准概率的地方 —— 这是 Jev 的声称优势。

## 两条调用路径

### A. Vercel AI Gateway（AI SDK 7 `experimental_evaluate`）

```bash
cd jev && npm install
AI_GATEWAY_API_KEY=… node probe.mjs ../../data/bili_mixed.jsonl -o ../out/probe_jev.json
```

Key 来源：Vercel 控制台 → AI Gateway → API Keys。

### B. TypeSafe 官方 SDK（直连）

```bash
TYPESAFE_API_KEY=… .venv/bin/python ../jev_probe.py <corpus.jsonl> -o ../out/probe_jev.json
```

Key 来源：console.typesafe.ai（早期访问，可能需要排队）。

## 对比

```bash
.venv/bin/python ../compare_probes.py ../out/probe_bookmarks_local.json ../out/probe_jev_bookmarks.json
```

输出三件事：分类一致率 / 分布塌缩程度 / 置信度分布。

**判据**：如果 Jev 的 `intent` 和 `perishable` 仍然是单一值、或者 confidence 全部 > 0.95，
那它没解决我们的问题，不值得依赖。

## 安全

不要把 API key 写进命令参数或聊天。用环境变量，或 `~/.agents/skills/secret-handoff` 的目录交接方式。
