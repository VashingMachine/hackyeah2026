import { readFileSync } from 'node:fs';
import { RE2 } from 're2-wasm';

export const FEED_TARGETS = [
  'read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'http_request',
  'user_input', 'model_input', 'model_output', 'tool_arguments', 'tool_output', 'user_document',
] as const;
export type FeedTarget = (typeof FEED_TARGETS)[number];
export type SignatureRisk = 'low' | 'medium' | 'high' | 'critical';

export interface Signature {
  id: string;
  title: string;
  category: string;
  source: string;
  cve?: string;
  risk: SignatureRisk;
  targets: FeedTarget[];
  pattern: string;
}

export interface RawThreatFeed {
  catalog_id: string;
  version: number;
  signatures: Signature[];
  note?: string;
}

export interface FeedMatch {
  id: string;
  title: string;
  category: string;
  risk: Signature['risk'];
  cve?: string;
}

export class FeedValidationError extends Error {
  constructor(message = 'Threat feed is invalid') {
    super(message);
    this.name = 'FeedValidationError';
  }
}

const TARGET_SET = new Set<string>(FEED_TARGETS);
const RISKS = new Set<string>(['low', 'medium', 'high', 'critical']);
const LIMITS = { catalogId: 128, note: 1024, signatures: 256, id: 128, title: 256, category: 128, source: 2048, cve: 64, targets: 16, pattern: 512 } as const;
const FEED_KEYS = new Set(['catalog_id', 'version', 'signatures', 'note']);
const SIGNATURE_KEYS = new Set(['id', 'title', 'category', 'source', 'cve', 'risk', 'targets', 'pattern']);

function invalid(): never {
  throw new FeedValidationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

const TORCH_LOAD_WITHOUT_WEIGHTS_PATTERN = String.raw`\btorch\.load\s*\((?![^)]*weights_only\s*=\s*True)`;
type SafePattern = { test(input: string): boolean };

/** RE2 guarantees linear-time matching; JS's backtracking RegExp is never used for feed patterns. */
function compilePattern(pattern: string): SafePattern {
  if (pattern === TORCH_LOAD_WITHOUT_WEIGHTS_PATTERN) {
    // RE2 does not implement lookahead. Preserve this exact bundled rule with a
    // linear prefix scan and a fixed 512-character check up to the first close paren.
    const calls = new RE2(String.raw`\btorch\.load\s*\(`, 'giu');
    const safeOption = new RE2(String.raw`weights_only\s*=\s*True`, 'iu');
    return {
      test(input: string): boolean {
        calls.lastIndex = 0;
        let match = calls.exec(input);
        while (match) {
          const start = match.index + (match[0]?.length ?? 0);
          const close = input.indexOf(')', start);
          const end = Math.min(start + 512, close < 0 ? input.length : close, input.length);
          if (!safeOption.test(input.slice(start, end))) return true;
          match = calls.exec(input);
        }
        return false;
      },
    };
  }
  return new RE2(pattern, 'iu');
}

function parseFeed(raw: unknown): RawThreatFeed {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !FEED_KEYS.has(key))) invalid();
  if (!boundedString(raw.catalog_id, LIMITS.catalogId) || !Number.isSafeInteger(raw.version) || (raw.version as number) <= 0) invalid();
  if (raw.note !== undefined && !boundedString(raw.note, LIMITS.note)) invalid();
  if (!Array.isArray(raw.signatures) || raw.signatures.length > LIMITS.signatures) invalid();

  const ids = new Set<string>();
  const signatures: Signature[] = raw.signatures.map((candidate): Signature => {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !SIGNATURE_KEYS.has(key))) invalid();
    const { id, title, category, source, cve, risk, targets, pattern } = candidate;
    if (!boundedString(id, LIMITS.id) || ids.has(id)) invalid();
    ids.add(id);
    if (!boundedString(title, LIMITS.title) || !boundedString(category, LIMITS.category) || !boundedString(source, LIMITS.source)) invalid();
    if (cve !== undefined && !boundedString(cve, LIMITS.cve)) invalid();
    if (typeof risk !== 'string' || !RISKS.has(risk)) invalid();
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > LIMITS.targets) invalid();
    const targetSet = new Set<string>();
    for (const target of targets) {
      if (typeof target !== 'string' || !TARGET_SET.has(target) || targetSet.has(target)) invalid();
      targetSet.add(target);
    }
    if (!boundedString(pattern, LIMITS.pattern)) invalid();
    try {
      compilePattern(pattern);
    } catch {
      invalid();
    }
    return {
      id, title, category, source,
      ...(cve === undefined ? {} : { cve }),
      risk: risk as SignatureRisk,
      targets: [...targets] as FeedTarget[],
      pattern,
    };
  });

  return {
    catalog_id: raw.catalog_id,
    version: raw.version as number,
    signatures,
    ...(raw.note === undefined ? {} : { note: raw.note as string }),
  };
}

/** Public parser for callers that want to validate before constructing a feed. */
export const FeedSchema = {
  parse: parseFeed,
};

export class ThreatFeed {
  readonly catalogId: string;
  readonly version: number;
  private readonly feed: RawThreatFeed;
  private readonly compiled: { sig: Signature; re: SafePattern }[];

  constructor(raw: unknown) {
    const parsed = FeedSchema.parse(raw);
    this.catalogId = parsed.catalog_id;
    this.version = parsed.version;
    this.feed = Object.freeze({
      ...parsed,
      signatures: Object.freeze(parsed.signatures.map((sig) => Object.freeze({ ...sig, targets: Object.freeze([...sig.targets]) as unknown as FeedTarget[] }))) as unknown as Signature[],
    });
    this.compiled = this.feed.signatures.map((sig) => ({ sig, re: compilePattern(sig.pattern) }));
  }

  static fromFile(path: string): ThreatFeed {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new FeedValidationError();
    }
    return new ThreatFeed(raw);
  }

  get size(): number {
    return this.compiled.length;
  }

  /** Return a detached, serializable copy suitable for atomic feed publication. */
  snapshot(): RawThreatFeed {
    return {
      catalog_id: this.feed.catalog_id,
      version: this.feed.version,
      signatures: this.feed.signatures.map((sig) => ({ ...sig, targets: [...sig.targets] })),
      ...(this.feed.note === undefined ? {} : { note: this.feed.note }),
    };
  }

  toJSON(): RawThreatFeed {
    return this.snapshot();
  }

  /** Match `text` against every signature that targets `target` (a tool name or an event kind). Bounded input length. */
  match(target: string, text: string): FeedMatch[] {
    const bounded = text.length > 200_000 ? text.slice(0, 200_000) : text;
    const out: FeedMatch[] = [];
    for (const { sig, re } of this.compiled) {
      if (!sig.targets.includes(target as FeedTarget)) continue;
      if (re.test(bounded)) out.push({ id: sig.id, title: sig.title, category: sig.category, risk: sig.risk, cve: sig.cve });
    }
    return out;
  }
}
