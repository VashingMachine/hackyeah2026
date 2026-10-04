import type { Policy } from '../config/schema.ts';

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {}

export class OpenAIEmbedder implements Embedder {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  constructor(apiKey: string, model: string, timeoutMs = 8000, baseUrl = 'https://api.openai.com/v1/embeddings') {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.name = `openai:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
      throw new EmbeddingError('embedding input must contain non-empty strings');
    }
    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new EmbeddingError(`embedding request failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new EmbeddingError(`embedding service returned HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new EmbeddingError('embedding service returned invalid JSON');
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new EmbeddingError('embedding response has the wrong shape');
    const ordered: number[][] = new Array(texts.length);
    let dimensions: number | undefined;
    for (const item of data) {
      const row = item as { embedding?: unknown; index?: unknown } | null;
      const index = row?.index;
      const embedding = row?.embedding;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= texts.length || ordered[index as number]) {
        throw new EmbeddingError('embedding response has invalid or duplicate indices');
      }
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new EmbeddingError('embedding response contains an invalid vector');
      }
      if (dimensions !== undefined && embedding.length !== dimensions) throw new EmbeddingError('embedding response vectors have inconsistent dimensions');
      dimensions = embedding.length;
      ordered[index as number] = embedding as number[];
    }
    if (ordered.some((vector) => vector === undefined)) throw new EmbeddingError('embedding response is missing an index');
    return ordered;
  }
}

/** Local sentence embeddings (MiniLM via transformers.js, ONNX on CPU): no API key, no data leaves the machine. English only. */
export class LocalEmbedder implements Embedder {
  readonly name: string;
  private readonly model: string;
  private extractor: Promise<(texts: string[], o: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>> | undefined;
  constructor(model = 'Xenova/all-MiniLM-L6-v2') {
    this.model = model;
    this.name = `local:${model}`;
  }
  private load() {
    this.extractor ??= import('@huggingface/transformers').then(
      (m) => m.pipeline('feature-extraction', this.model, { dtype: 'q8' }) as unknown as Promise<never>,
    );
    return this.extractor;
  }
  async embed(texts: string[]): Promise<number[][]> {
    try {
      const ext = await this.load();
      const out = await ext(texts, { pooling: 'mean', normalize: true });
      return out.tolist();
    } catch (e) {
      throw new EmbeddingError(`local embedding failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Local hashed bag-of-words embedder. A temporary stand-in until an embeddings API key is available:
 * it matches shared vocabulary, NOT paraphrases. Labelled `lexical-fallback` everywhere it shows up.
 */
export class LexicalEmbedder implements Embedder {
  readonly name = 'lexical-fallback';
  private readonly dims = 1024;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }
  private vec(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const words = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    const stem = (w: string) => w.replace(/(ing|ed|es|s|ly|ment|ation)$/, '');
    const toks = words.map(stem);
    for (let i = 0; i < toks.length; i++) {
      v[hash(toks[i]!) % this.dims]! += 1;
      if (i + 1 < toks.length) v[hash(toks[i] + '_' + toks[i + 1]) % this.dims]! += 1.5;
    }
    return v;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

export interface TopicMatch {
  topic_id: string;
  score: number;
  policy_id: string;
}

interface ExampleVec {
  topic_id: string;
  vec: number[];
}

export class TopicDetector {
  private examples: ExampleVec[] = [];
  private ready: Promise<void> | undefined;
  private cache = new Map<string, number[]>();
  private readonly policy: Policy;
  private readonly embedder: Embedder;

  constructor(policy: Policy, embedder: Embedder) {
    this.policy = policy;
    this.embedder = embedder;
  }

  get embedderName(): string {
    return this.embedder.name;
  }

  /** Embed the example sentences once (publication time), so each event costs one embedding call. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      const texts: string[] = [];
      const owners: string[] = [];
      for (const [id, t] of Object.entries(this.policy.topics)) {
        for (const ex of t.examples) {
          texts.push(ex);
          owners.push(id);
        }
      }
      if (texts.length === 0) { this.examples = []; return; }
      const vecs = await this.embedder.embed(texts);
      if (vecs.length !== texts.length || vecs.some((vec) => !validVector(vec)) || new Set(vecs.map((vec) => vec.length)).size > 1) {
        throw new EmbeddingError('embedder returned invalid example vectors');
      }
      this.examples = vecs.map((vec, i) => ({ topic_id: owners[i]!, vec }));
    })();
    this.ready = this.ready.catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /** Every window of the text is compared, so a signal in the middle of a long document is not missed. */
  async detect(text: string): Promise<TopicMatch[]> {
    if (!text.trim()) return [];
    await this.init();
    const ts = this.policy.topic_supervision;
    const chunks = chunkText(text, ts.chunk_chars, ts.overlap_chars);
    const missing = [...new Set(chunks.filter((c) => !this.cache.has(c)))];
    const currentVectors = new Map<string, number[]>();
    if (missing.length) {
      const vecs = await this.embedder.embed(missing);
      const dimensions = this.examples[0]?.vec.length;
      if (vecs.length !== missing.length || vecs.some((vec) => !validVector(vec) || (dimensions !== undefined && vec.length !== dimensions))) {
        throw new EmbeddingError('embedder returned invalid query vectors');
      }
      missing.forEach((c, i) => {
        currentVectors.set(c, vecs[i]!);
        this.cache.delete(c);
        this.cache.set(c, vecs[i]!);
      });
      while (this.cache.size > 2000) {
        const oldest = [...this.cache.keys()].find((key) => !chunks.includes(key));
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    const best = new Map<string, number>();
    for (const c of chunks) {
      const v = this.cache.get(c) ?? currentVectors.get(c)!;
      if (!currentVectors.has(c) && this.cache.has(c)) {
        this.cache.delete(c);
        this.cache.set(c, v);
      }
      for (const ex of this.examples) {
        const s = cosine(v, ex.vec);
        if (s > (best.get(ex.topic_id) ?? -1)) best.set(ex.topic_id, s);
      }
    }
    const out: TopicMatch[] = [];
    for (const [topic_id, score] of best) {
      const t = this.policy.topics[topic_id]!;
      const thr = t.similarity_threshold ?? ts.default_similarity_threshold;
      if (score >= thr) out.push({ topic_id, score, policy_id: t.policy_id });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

function validVector(vec: unknown): vec is number[] {
  return Array.isArray(vec) && vec.length > 0 && vec.every((n) => typeof n === 'number' && Number.isFinite(n));
}
