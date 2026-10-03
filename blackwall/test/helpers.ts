import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadPolicyFile } from '../src/config/load.ts';
import type { Policy } from '../src/config/schema.ts';
import type { Core } from '../src/engine/core.ts';
import { buildCore, type Overrides } from '../src/server/build.ts';
import { Store } from '../src/store/store.ts';

export const ROOT = resolve(import.meta.dirname, '..');

/** Read ../.env into an object (real keys for live tests); missing file gives an empty object. */
export function dotenv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(ROOT, '..', '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  } catch {
    return {};
  }
}

export interface Fixture {
  core: Core;
  policy: Policy;
  ws: string;
  env: Record<string, string | undefined>;
  login(user: string): { id: string; token: string };
}

export interface FixtureOpts extends Overrides {
  /** Mutate the parsed policy (e.g. change profile) before wiring. */
  tweak?: (p: Policy) => void;
}

/** A fresh copy of the synthetic workspace plus an in-memory store, so tests never touch shared state. */
export function makeFixture(opts: FixtureOpts = {}): Fixture {
  const ws = mkdtempSync(join(tmpdir(), 'bw-ws-'));
  cpSync(join(ROOT, 'demo-workspace'), ws, { recursive: true });
  writeFileSync(join(ws, 'project', '.env'), 'DB_PASSWORD=hunter2hunter2hunter2\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n');
  mkdirSync(join(ws, 'output'), { recursive: true });
  const env = { ...dotenv(), ...process.env, WORKSPACE: ws };
  const policy = loadPolicyFile(join(ROOT, 'config', 'policy.yaml'), env);
  policy.audit.db_path = ':memory:';
  opts.tweak?.(policy);
  const core = buildCore(policy, env, { ...opts, store: opts.store ?? new Store(':memory:') });
  return {
    core,
    policy,
    ws,
    env,
    login(user: string) {
      const { session, token } = core.createSession(user);
      return { id: session.id, token };
    },
  };
}

import type { Guardian, GuardianInput, GuardianResult } from '../src/judge/guardian.ts';
import { StubJudge, type JudgeInput, type Verdict } from '../src/judge/jev.ts';

/** Test-only guardian: never touches a model. Live guardian behaviour is covered by test/live. */
export class StubGuardian implements Guardian {
  calls: GuardianInput[] = [];
  private readonly fn: (i: GuardianInput) => 'no_identified_violation' | 'violation' | 'uncertain' | Error;
  constructor(fn: (i: GuardianInput) => 'no_identified_violation' | 'violation' | 'uncertain' | Error = () => 'no_identified_violation') {
    this.fn = fn;
  }
  async review(i: GuardianInput): Promise<GuardianResult> {
    this.calls.push(i);
    const v = this.fn(i);
    if (v instanceof Error) throw new (await import('../src/judge/guardian.ts')).GuardianError(v.message);
    return {
      verdict: v,
      policy_id: v === 'violation' ? i.policies[0]!.policy_id : null,
      reason_code: v === 'violation' ? i.policies[0]!.reason_code : null,
      evidence: null,
      topics_confirmed: i.candidateTopics,
      topics_dismissed: [],
      reviewed_seq: i.event.seq,
      model: 'stub',
      usage: { input_tokens: 0, output_tokens: 0 },
      latency_ms: 0,
    };
  }
}

export class CountingJudge extends StubJudge {
  count = 0;
  constructor(fn: (i: JudgeInput) => Verdict | Error = () => 'allow') {
    super(fn);
  }
  override async evaluate(i: JudgeInput) {
    this.count++;
    return super.evaluate(i);
  }
}
