#!/usr/bin/env node
/**
 * Jev 探针：对每条收藏问同一组问题，拿到 typed 答案 + 校准概率。
 *
 *   AI_GATEWAY_API_KEY=... node probe.mjs ../../data/bili_mixed.jsonl -o ../out/probe_jev.json
 *
 * 走 Vercel AI Gateway（AI SDK 7 的 experimental_evaluate）。
 * 与 ../probe_questions.py 的本地基线是同一组问题，可直接对比。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluate as experimental_evaluate } from 'ai';

// —— 与本地基线完全一致的类目表（人定的，不是聚类出来的）——
const TAXONOMY = {
  ai: 'AI 与模型（大模型、embedding、AI 工具与产品）',
  dev: '编程开发（语言、框架、工程实践）',
  data: '数据与数据库',
  hw: '硬件数码（设备、芯片、外设）',
  media: '影视娱乐',
  music: '音乐',
  game: '游戏',
  life: '生活理财（钱、房、税、投资）',
  travel: '旅行美食',
  social: '社科人文（历史、法律、心理、社会观察）',
  other: '以上都不是',
};

const PERISHABLE = [
  '基本永久有效（原理、方法论、经典资料）',
  '有效期数年（工具用法、技术栈、教程）',
  '有效期一年内（版本发布说明、时效性资讯）',
  '很快过期（新闻、临时活动、价格）',
];

const QUESTIONS = {
  category: {
    type: 'choice',
    instructions: '这条收藏的主题属于哪一类？',
    criteria: TAXONOMY,
  },
  intent: {
    type: 'choice',
    instructions: '用户收藏它时更可能的意图是什么？',
    criteria: {
      todo: '马上要用的工具或方法',
      reference: '以后备查的参考资料',
      interest: '单纯觉得有意思，不一定会用',
    },
  },
  perishable: {
    type: 'score',
    instructions: '这条内容本身有多容易过时？',
    criteria: PERISHABLE,
  },
  keep: {
    type: 'boolean',
    instructions: '这条内容值得长期保留（而不是看完就该删）。',
  },
};

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('-'));
const outIdx = Math.max(args.indexOf('-o'), args.indexOf('--out'));
const output = outIdx !== -1 ? args[outIdx + 1] : 'probe_jev.json';
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 0;
const concIdx = args.indexOf('--concurrency');
const concurrency = concIdx !== -1 ? Number(args[concIdx + 1]) : 4;
const model = process.env.JEV_MODEL || 'typesafe-ai/jev';

if (!input) {
  console.error('用法: AI_GATEWAY_API_KEY=... node probe.mjs <corpus.jsonl> -o out.json [--limit N]');
  process.exit(2);
}
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('缺少 AI_GATEWAY_API_KEY');
  process.exit(2);
}

const items = readFileSync(input, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .slice(0, limit || undefined);

console.log(`[corpus] ${items.length} 条 <- ${input}  model=${model}`);

async function classifyOne(item, i) {
  const state = {
    title: String(item.title || item.text || '').slice(0, 300),
    url: item.url || '',
    source: item.source || '',
    kind: item.kind || '',
    body: String(item.text || '').slice(0, 600),
  };
  const t0 = Date.now();
  try {
    const res = await experimental_evaluate({ model, state, questions: QUESTIONS });
    const ms = Date.now() - t0;
    const a = res.answers;
    const conf = (x) => (typeof x?.confidence === 'number' ? x.confidence : null);
    const record = {
      title: state.title,
      url: state.url,
      source: state.source,
      category: a.category?.choice ?? null,
      category_confidence: conf(a.category),
      category_probabilities: a.category?.probabilities ?? null,
      intent: a.intent?.choice ?? null,
      intent_confidence: conf(a.intent),
      intent_probabilities: a.intent?.probabilities ?? null,
      perishable: a.perishable?.score ?? null,
      perishable_confidence: conf(a.perishable),
      keep_probability: a.keep?.probability ?? null,
      latency_ms: ms,
      usage: res.usage ?? null,
      raw: a,
    };
    console.log(
      `  [${String(i).padStart(2)}/${items.length}] ${(record.category ?? '?').padEnd(7)}` +
        ` conf=${record.category_confidence ?? '-'}  intent=${(record.intent ?? '?').padEnd(9)}` +
        ` conf=${record.intent_confidence ?? '-'}  perish=${record.perishable}  keep=${record.keep_probability}` +
        `  ${ms}ms  | ${state.title.slice(0, 34)}`,
    );
    return record;
  } catch (e) {
    console.error(`  [${String(i).padStart(2)}/${items.length}] ERROR ${e?.message || e}`);
    return { title: state.title, url: state.url, error: String(e?.message || e), latency_ms: Date.now() - t0 };
  }
}

const out = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await classifyOne(items[i], i + 1);
    }
  }),
);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify({ backend: 'jev', model, taxonomy: TAXONOMY, perishable: PERISHABLE, items: out }, null, 2),
);
const lat = out.filter((r) => r.latency_ms).map((r) => r.latency_ms).sort((a, b) => a - b);
console.log(
  `\n[out] ${output}` +
    (lat.length ? `\n[latency] p50=${lat[Math.floor(lat.length / 2)]}ms  max=${lat[lat.length - 1]}ms` : ''),
);
