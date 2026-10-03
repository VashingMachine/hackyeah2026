import { Core } from '../engine/core.ts';
import { ThreatFeed } from '../engine/feed.ts';
import { AnthropicGuardian, type Guardian } from '../judge/guardian.ts';
import { JevJudge, type Judge } from '../judge/jev.ts';
import { Store } from '../store/store.ts';
import { LexicalEmbedder, LocalEmbedder, OpenAIEmbedder, type Embedder } from '../topics/detector.ts';
import type { Policy } from '../config/schema.ts';

export interface Overrides {
  judge?: Judge;
  guardian?: Guardian;
  embedder?: Embedder;
  store?: Store;
}

export function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Wire real providers from the environment; tests may swap any piece. */
export function buildCore(policy: Policy, env: Record<string, string | undefined>, o: Overrides = {}): Core {
  const store = o.store ?? new Store(policy.audit.db_path);
  const feed = ThreatFeed.fromFile(policy.threat_feed.path);
  const judge = o.judge ?? new JevJudge(requireEnv(env, 'JEV_API_KEY'), policy.semantic.model, policy.semantic.timeout_ms);
  const gAlias = policy.model_aliases[policy.topic_supervision.guardian_model_alias]!;
  const guardian = o.guardian ?? new AnthropicGuardian(requireEnv(env, 'ANTHROPIC_API_KEY'), gAlias.model, 8000);
  const emb = policy.topic_supervision.embedding;
  const embedder =
    o.embedder ??
    (emb.provider === 'openai'
      ? new OpenAIEmbedder(requireEnv(env, 'OPENAI_API_KEY'), emb.model ?? 'text-embedding-3-small')
      : emb.provider === 'local'
        ? new LocalEmbedder(emb.model)
        : new LexicalEmbedder());
  return new Core({ policy, store, feed, judge, guardian, embedder });
}
