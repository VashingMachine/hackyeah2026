import { describe, expect, it } from 'vitest';
import { makeFixture, CountingJudge, StubGuardian } from '../helpers.ts';

describe('atomic monetary budget reservations', () => {
  it('reserves every overlapping embedding window before any embedding API call', async () => {
    let calls = 0;
    const fx = makeFixture({judge:new CountingJudge(), guardian:new StubGuardian(),
      embedder:{name:'counting', async embed(texts) { calls++; return texts.map(()=>[1,0]); }},
      tweak:p => {p.topic_supervision.chunk_chars=8; p.topic_supervision.overlap_chars=4; p.global.budgets!.session_total_tokens=32;}});
    const {session} = fx.core.createSession('developer-demo');
    // 21 bytes produce five overlapping windows totalling 37 bytes, not the old estimate of 29.
    const result = await fx.core.supervise(session,'user_input','abcdefghijklmnopqrstu');
    expect(result.action).toBe('block');
    expect(result.reason_codes).toContain('BUDGET_EXCEEDED');
    expect(calls).toBe(0);
    expect(fx.core.store.getSession(session.id)!.tokens_reserved).toBe(0);
  });
  it('reserves worst-case cost alongside tokens and releases the remainder on settlement', () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('developer-demo');
    const limits = { session_cost_usd_micros: 100 };

    expect(fx.core.store.reserveTokens(session.id, 'cost-a', 10, limits, true, 70).ok).toBe(true);
    expect(fx.core.store.reserveTokens(session.id, 'cost-b', 10, limits, true, 40)).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED' });
    expect(fx.core.store.getSession(session.id)).toMatchObject({ cost_micros: 0, cost_reserved_micros: 70 });

    fx.core.store.settleTokens('cost-a', 8, 50);
    expect(fx.core.store.getSession(session.id)).toMatchObject({ cost_micros: 50, cost_reserved_micros: 0 });
    expect(fx.core.store.reserveTokens(session.id, 'cost-c', 10, limits, true, 40).ok).toBe(true);
  });

  it('atomically admits no more than one concurrent reservation that fits the remaining cap', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('developer-demo');
    const limits = { session_cost_usd_micros: 100 };
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => fx.core.store.reserveTokens(session.id, 'parallel-a', 10, limits, true, 60)),
      Promise.resolve().then(() => fx.core.store.reserveTokens(session.id, 'parallel-b', 10, limits, true, 60)),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(fx.core.store.getSession(session.id)!.cost_reserved_micros).toBe(60);
  });

  it('counts the reserved worst-case cost as spent when provider outcome is unknown', () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('developer-demo');
    const limits = { session_cost_usd_micros: 100 };

    expect(fx.core.store.reserveTokens(session.id, 'unknown-cost', 10, limits, true, 80).ok).toBe(true);
    fx.core.store.settleUnknown('unknown-cost');

    expect(fx.core.store.getSession(session.id)).toMatchObject({ cost_micros: 80, cost_reserved_micros: 0 });
    expect(fx.core.store.reserveTokens(session.id, 'after-unknown', 10, limits, true, 21)).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED' });
  });
});
