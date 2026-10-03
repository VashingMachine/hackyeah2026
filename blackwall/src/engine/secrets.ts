import { createHmac, randomBytes } from 'node:crypto';

export type FindingKind = 'secret' | 'pii';
export interface Finding {
  kind: FindingKind;
  type: string;
  /** HMAC fingerprint, never the value. */
  fingerprint: string;
}

interface Detector {
  kind: FindingKind;
  type: string;
  re: RegExp;
  validate?: (m: string) => boolean;
}

// Per-process key: fingerprints correlate repeated findings in one run without being reversible.
const FP_KEY = randomBytes(16);
const fingerprint = (v: string) => createHmac('sha256', FP_KEY).update(v).digest('hex').slice(0, 12);

function peselValid(s: string): boolean {
  if (!/^\d{11}$/.test(s)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = w.reduce((a, wi, i) => a + wi * Number(s[i]), 0);
  return (10 - (sum % 10)) % 10 === Number(s[10]);
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const DETECTORS: Detector[] = [
  { kind: 'secret', type: 'PRIVATE_KEY', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: 'secret', type: 'AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'secret', type: 'ANTHROPIC_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'secret', type: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: 'secret', type: 'GITHUB_TOKEN', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { kind: 'secret', type: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'secret', type: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'secret', type: 'API_KEY_ASSIGNMENT', re: /\b(?:api[_-]?key|secret|passwd|password|token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{12,}["']?/gi },
  { kind: 'pii', type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g, validate: ibanValid },
  { kind: 'pii', type: 'PESEL', re: /\b\d{11}\b/g, validate: peselValid },
  { kind: 'pii', type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'pii', type: 'PHONE', re: /(?<![\d])\+\d{2}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/g },
];

export interface ScanResult {
  findings: Finding[];
  /** Text with every secret and PII match replaced by a marker (callers choose whether to use it). */
  redacted: string;
}

export function scanText(text: string, opts: { pii?: boolean } = {}): ScanResult {
  const findings: Finding[] = [];
  let redacted = text;
  for (const d of DETECTORS) {
    if (d.kind === 'pii' && opts.pii === false) continue;
    redacted = redacted.replace(d.re, (m) => {
      if (d.validate && !d.validate(m)) return m;
      findings.push({ kind: d.kind, type: d.type, fingerprint: fingerprint(m) });
      return `[REDACTED:${d.type}]`;
    });
  }
  return { findings, redacted };
}

/** Same as scanText but over any JSON-like value; returns findings and a redacted deep copy. */
export function scanValue(value: unknown, opts: { pii?: boolean } = {}): { findings: Finding[]; redacted: unknown } {
  const findings: Finding[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = scanText(v, opts);
      findings.push(...r.findings);
      return r.redacted;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { findings, redacted: walk(value) };
}
