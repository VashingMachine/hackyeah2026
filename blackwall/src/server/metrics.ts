import type { Core } from '../engine/core.ts';

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]!;
}

const summary = (values: number[]) => ({ count: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null });

/** Aggregates for the dashboard: real counts from the audit stream, never a synthetic "security score". */
export function metrics(core: Core) {
  const db = core.store.db;
  const all = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as unknown as T[];
  const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as unknown as T;

  const byEffect = all<{ effect: string; n: number }>(`SELECT effect, COUNT(*) n FROM events WHERE type IN ('decision.allowed','decision.denied','approval.requested') GROUP BY effect`);
  const reasons = all<{ reason_codes: string; n: number }>(`SELECT reason_codes, COUNT(*) n FROM events WHERE effect = 'deny' AND reason_codes IS NOT NULL GROUP BY reason_codes ORDER BY n DESC LIMIT 15`);
  const sessions = all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM sessions GROUP BY status`);
  const spend = one<{ tokens: number; cost: number; reserved: number }>(`SELECT COALESCE(SUM(tokens_spent),0) tokens, COALESCE(SUM(cost_micros),0) cost, COALESCE(SUM(tokens_reserved),0) reserved FROM sessions`);
  const counts = all<{ type: string; n: number }>(`SELECT type, COUNT(*) n FROM events WHERE type IN ('content.redacted','content.blocked','session.terminated','session.reviewing','topic.candidate_detected','topic.confirmed','topic.dismissed','guardian.reviewed','guardian.unavailable','judge.evaluated','model.completed','model.denied','budget.denied','approval.requested','approval.approved','approval.rejected','approval.expired','tool.started','tool.completed','tool.failed') GROUP BY type`);
  const feed = one<{ n: number }>(`SELECT COUNT(*) n FROM events WHERE reason_codes LIKE '%THREAT_FEED_MATCH%'`);

  const dec = all<{ data: string }>(`SELECT data FROM events WHERE type IN ('decision.allowed','decision.denied','approval.requested') ORDER BY id DESC LIMIT 2000`).map((r) => JSON.parse(r.data) as { timings_ms?: Record<string, number> });
  const stage = (k: string) => dec.map((d) => d.timings_ms?.[k]).filter((x): x is number => typeof x === 'number');
  const judge = all<{ data: string }>(`SELECT data FROM events WHERE type='judge.evaluated' ORDER BY id DESC LIMIT 1000`).map((r) => (JSON.parse(r.data) as { latency_ms: number }).latency_ms);
  const guardian = all<{ data: string }>(`SELECT data FROM events WHERE type='guardian.reviewed' ORDER BY id DESC LIMIT 1000`).map((r) => (JSON.parse(r.data) as { latency_ms: number }).latency_ms);
  const provider = all<{ data: string }>(`SELECT data FROM events WHERE type='model.completed' ORDER BY id DESC LIMIT 1000`).map((r) => (JSON.parse(r.data) as { provider_ms: number }).provider_ms);
  const detect = all<{ data: string }>(`SELECT data FROM events WHERE type='decision.allowed' OR type='decision.denied' ORDER BY id DESC LIMIT 1000`).map((r) => (JSON.parse(r.data) as { timings_ms?: Record<string, number> }).timings_ms?.supervision_detect).filter((x): x is number => typeof x === 'number');

  const map = (rows: { type: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.type, r.n]));
  return {
    generated_at: Date.now(),
    policy: { id: core.policy.policy_id, version: core.policy.version, profile: core.policy.profile, mode: core.policy.mode, embedder: core.detector.embedderName },
    decisions: Object.fromEntries(byEffect.map((r) => [r.effect ?? 'unknown', r.n])),
    deny_reasons: reasons.map((r) => ({ reasons: r.reason_codes, count: r.n })),
    sessions: Object.fromEntries(sessions.map((r) => [r.status, r.n])),
    spend: { tokens_spent: spend.tokens, tokens_reserved: spend.reserved, cost_usd_micros: spend.cost, cost_note: 'unpriced unless model aliases define prices' },
    events: map(counts),
    threat_feed_blocks: feed.n,
    latency_ms: {
      decision_total: summary(stage('total')),
      deterministic: summary(stage('deterministic')),
      topic_detection: summary(detect),
      judge_jev: summary(judge),
      guardian: summary(guardian),
      model_provider: summary(provider),
    },
    pending_approvals: core.store.pendingApprovals().length,
    open_reviews: core.store.openTopicReviews().length,
  };
}
