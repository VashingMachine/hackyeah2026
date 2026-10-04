import { Core } from '../engine/core.ts';
import { ThreatFeed } from '../engine/feed.ts';
import { AnthropicGuardian, OpenAIGuardian, type Guardian } from '../judge/guardian.ts';
import { JevJudge, type Judge } from '../judge/jev.ts';
import { Store } from '../store/store.ts';
import { sha256 } from '../store/store.ts';
import { applyControls } from '../config/publication.ts';
import { LexicalEmbedder, LocalEmbedder, OpenAIEmbedder, type Embedder } from '../topics/detector.ts';
import type { Policy } from '../config/schema.ts';

export interface Overrides {
  judge?: Judge;
  guardian?: Guardian;
  embedder?: Embedder;
  store?: Store;
  feed?: ThreatFeed;
}

export function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Wire real providers from the environment; tests may swap any piece. */
export function buildCore(policy: Policy, env: Record<string, string | undefined>, o: Overrides = {}): Core {
  const store = o.store ?? new Store(policy.audit.db_path);
  const configurationBaseHash = sha256(JSON.stringify(policy));
  const persisted = store.latestConfiguration(configurationBaseHash);
  if (persisted) {
    if (persisted.policy_id !== policy.policy_id) throw new Error('Persisted configuration belongs to another policy');
    policy = applyControls(policy, JSON.parse(persisted.controls), persisted.policy_version);
  }
  const feed = o.feed ?? (persisted ? new ThreatFeed(JSON.parse(persisted.feed)) : ThreatFeed.fromFile(policy.threat_feed.path));
  const judge = o.judge ?? new JevJudge(requireEnv(env, 'JEV_API_KEY'), policy.semantic.model, policy.semantic.timeout_ms, env.JEV_BASE_URL);
  const gAlias = policy.model_aliases[policy.topic_supervision.guardian_model_alias]!;
  const guardianTimeout = Number(env.BLACKWALL_GUARDIAN_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(guardianTimeout) || guardianTimeout <= 0) throw new Error('BLACKWALL_GUARDIAN_TIMEOUT_MS must be positive');
  const guardian = o.guardian ?? (gAlias.provider === 'openai'
    ? new OpenAIGuardian(requireEnv(env, 'OPENAI_API_KEY'), gAlias.model, guardianTimeout, env.BLACKWALL_OPENAI_RESPONSES_URL, gAlias.reasoning_effort ?? 'low')
    : new AnthropicGuardian(requireEnv(env, 'ANTHROPIC_API_KEY'), gAlias.model, guardianTimeout));
  const emb = policy.topic_supervision.embedding;
  const embedder =
    o.embedder ??
    (emb.provider === 'openai'
      ? new OpenAIEmbedder(requireEnv(env, 'OPENAI_API_KEY'), emb.model ?? 'text-embedding-3-small')
      : emb.provider === 'local'
        ? new LocalEmbedder(emb.model)
        : new LexicalEmbedder());
  return new Core({ policy, store, feed, judge, guardian, embedder, configurationBaseHash });
}
