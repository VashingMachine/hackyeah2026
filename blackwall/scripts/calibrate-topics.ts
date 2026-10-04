import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPolicyFile } from '../src/config/load.ts';
import { cosine, OpenAIEmbedder } from '../src/topics/detector.ts';

function dotenv(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) out[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
  } catch { return {}; }
}

const root = resolve(import.meta.dirname, '..');
const env = { ...dotenv(resolve(root, '.env')), ...process.env };
if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const model = process.argv[2] ?? 'text-embedding-3-small';
if (!['text-embedding-3-small', 'text-embedding-3-large'].includes(model)) throw new Error('Use text-embedding-3-small or text-embedding-3-large');
const policy = loadPolicyFile(resolve(root, 'config/policy.yaml'), env);
const corpus = JSON.parse(readFileSync(resolve(root, 'eval/topic-corpus.json'), 'utf8')) as {
  calibration: { topic: string; text: string }[];
  holdout: { topic: string; text: string }[];
};
const topicIds = Object.keys(policy.topics);
const allTexts = [...topicIds.flatMap((id) => policy.topics[id]!.examples), ...corpus.calibration.map((x) => x.text), ...corpus.holdout.map((x) => x.text)];
const embedder = new OpenAIEmbedder(env.OPENAI_API_KEY, model);
const started = Date.now();
const vectors = await embedder.embed(allTexts);
let offset = 0;
const examples = new Map<string, number[][]>();
for (const id of topicIds) {
  const count = policy.topics[id]!.examples.length;
  examples.set(id, vectors.slice(offset, offset + count));
  offset += count;
}
const calibrationVectors = vectors.slice(offset, offset + corpus.calibration.length);
offset += corpus.calibration.length;
const holdoutVectors = vectors.slice(offset);
const scoreRow = (vec: number[]) => Object.fromEntries(topicIds.map((id) => [id, Math.max(...examples.get(id)!.map((ex) => cosine(vec, ex)))]));
const calibration = corpus.calibration.map((item, i) => ({ ...item, scores: scoreRow(calibrationVectors[i]!) }));
const holdout = corpus.holdout.map((item, i) => ({ ...item, scores: scoreRow(holdoutVectors[i]!) }));
const thresholds = Object.fromEntries(topicIds.map((id) => {
  const negatives = calibration.filter((x) => x.topic !== id).map((x) => x.scores[id]!);
  const positives = calibration.filter((x) => x.topic === id).map((x) => x.scores[id]!);
  const maxNegative = Math.max(...negatives);
  const minPositive = Math.min(...positives);
  // Keep a small gap above observed calibration negatives to favor recall; holdout remains evaluation-only.
  const threshold = maxNegative < minPositive ? Math.min(minPositive, maxNegative + 0.02) : Math.min(...positives);
  return [id, { suggested: Number(threshold.toFixed(4)), maxCalibrationNegative: Number(maxNegative.toFixed(4)), minCalibrationPositive: Number(minPositive.toFixed(4)), separated: maxNegative < minPositive }];
}));
const holdoutMetrics = Object.fromEntries(topicIds.map((id) => {
  const threshold = thresholds[id]!.suggested;
  let tp = 0, fp = 0, fn = 0;
  for (const item of holdout) {
    const predicted = item.scores[id]! >= threshold;
    if (predicted && item.topic === id) tp++;
    else if (predicted) fp++;
    else if (item.topic === id) fn++;
  }
  return [id, { tp, fp, fn, positiveCount: holdout.filter((x) => x.topic === id).length }];
}));
const report = {
  generated_at: new Date().toISOString(), model, embedder: embedder.name,
  duration_ms: Date.now() - started,
  corpus: { calibration_count: corpus.calibration.length, holdout_count: corpus.holdout.length, calibration_is_separate_from_holdout: true },
  dimensions: vectors[0]?.length ?? 0, thresholds, holdout_metrics: holdoutMetrics,
  calibration_scores: calibration, holdout_scores: holdout,
  recommendation: 'Thresholds are max calibration-negative similarity + 0.02 where calibration separates classes. Validate against representative production-like traffic before enforcement. Similarity is candidate retrieval, not a policy verdict.'
};
mkdirSync(resolve(root, 'reports'), { recursive: true });
const date = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, `reports/topics-${model.replaceAll('-', '')}-${date}.json`);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, model, dimensions: report.dimensions, duration_ms: report.duration_ms, thresholds, holdout_metrics: holdoutMetrics }));
