import { readFileSync } from 'node:fs';

export interface Signature {
  id: string;
  title: string;
  category: string;
  source: string;
  cve?: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  targets: string[];
  pattern: string;
}

export interface FeedMatch {
  id: string;
  title: string;
  category: string;
  risk: Signature['risk'];
  cve?: string;
}

export class ThreatFeed {
  readonly catalogId: string;
  readonly version: number;
  private compiled: { sig: Signature; re: RegExp }[];

  constructor(raw: { catalog_id: string; version: number; signatures: Signature[] }) {
    this.catalogId = raw.catalog_id;
    this.version = raw.version;
    this.compiled = raw.signatures.map((sig) => {
      try {
        return { sig, re: new RegExp(sig.pattern, 'i') };
      } catch (e) {
        throw new Error(`feed signature ${sig.id} has an invalid pattern: ${(e as Error).message}`);
      }
    });
  }

  static fromFile(path: string): ThreatFeed {
    return new ThreatFeed(JSON.parse(readFileSync(path, 'utf8')));
  }

  get size(): number {
    return this.compiled.length;
  }

  /** Match `text` against every signature that targets `target` (a tool name or an event kind). Bounded input length. */
  match(target: string, text: string): FeedMatch[] {
    const bounded = text.length > 200_000 ? text.slice(0, 200_000) : text;
    const out: FeedMatch[] = [];
    for (const { sig, re } of this.compiled) {
      if (!sig.targets.includes(target)) continue;
      if (re.test(bounded)) out.push({ id: sig.id, title: sig.title, category: sig.category, risk: sig.risk, cve: sig.cve });
    }
    return out;
  }
}
