import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.ts';
import { CountingJudge, makeFixture, ROOT, StubGuardian } from '../helpers.ts';

const fixtures: { app: ReturnType<typeof buildApp>; fx: ReturnType<typeof makeFixture> }[] = [];
afterEach(async () => {
  for (const { app, fx } of fixtures.splice(0)) { await app.close(); fx.core.store.close(); }
});

async function reviewingSession() {
  const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(() => 'uncertain') });
  const login = fx.login('hr-demo');
  await fx.core.supervise(fx.core.store.getSession(login.id)!, 'user_input', 'Explain employee development conversations.');
  const event = fx.core.store.listEvents({ sessionId: login.id }).find(e => e.type === 'session.reviewing')!;
  const reviewId = JSON.parse(event.data).review_id as string;
  const app = buildApp(fx.core, { adminToken: 'test-admin', gateway: {}, dashboardDir: join(ROOT, 'dashboard') });
  fixtures.push({ app, fx });
  await app.ready();
  const headers = { authorization: 'Bearer test-admin' };
  const resolveReview = (outcome: 'no_violation' | 'violation') => app.inject({ method: 'POST', url: `/v1/admin/topic-reviews/${reviewId}/resolve`, headers, payload: { outcome, note: 'Human review of the current event against policy.' } });
  const revoke = () => app.inject({ method: 'POST', url: `/v1/admin/sessions/${login.id}/revoke`, headers });
  return { fx, app, login, reviewId, resolveReview, revoke };
}

describe('administrator review respects later session revocation', () => {
  it('a stale open review cannot resume a revoked session or consume the review', async () => {
    const t = await reviewingSession();
    expect((await t.revoke()).statusCode).toBe(200);
    const result = await t.resolveReview('no_violation');
    expect(result.statusCode).toBe(409);
    expect(t.fx.core.store.getSession(t.login.id)!.status).toBe('blocked');
    expect(t.fx.core.store.getTopicReview(t.reviewId)!.status).toBe('open');
    const decision = await t.fx.core.decideTool(t.fx.core.store.getSession(t.login.id)!, { request_id: 'after-revoke', tool: 'read', arguments: { path: 'development-conversations.md' } }, { cwd: t.fx.policy.users['hr-demo']!.workdir });
    expect(decision.reason_codes).toContain('SESSION_BLOCKED');
  });

  it('a queued revoke is applied before a concurrent stale review resolution', async () => {
    const t = await reviewingSession();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const held = t.fx.core.withSessionLock(t.login.id, async () => { entered(); await barrier; });
    await ready;
    const revoked = t.revoke();
    await new Promise(resolve => setImmediate(resolve));
    const resolved = t.resolveReview('no_violation');
    await new Promise(resolve => setImmediate(resolve));
    release();
    await held;
    expect((await revoked).statusCode).toBe(200);
    expect((await resolved).statusCode).toBe(409);
    expect(t.fx.core.store.getSession(t.login.id)!.status).toBe('blocked');
    expect(t.fx.core.store.getTopicReview(t.reviewId)!.status).toBe('open');
  });

  it('an older review cannot clear a newer pending event after an explicit admin resume', async () => {
    const t = await reviewingSession();
    await t.revoke();
    expect((await t.app.inject({ method: 'POST', url: `/v1/admin/sessions/${t.login.id}/resume`, headers: { authorization: 'Bearer test-admin' } })).statusCode).toBe(200);
    await t.app.inject({ method: 'POST', url: '/v1/content/inspect', headers: { authorization: `Bearer ${t.login.token}` }, payload: { kind: 'user_input', text: 'A different employee development conversation.' } });
    const latest = t.fx.core.store.listEvents({ sessionId: t.login.id }).find(e => e.type === 'session.reviewing')!;
    const newReviewId = JSON.parse(latest.data).review_id as string;
    expect(newReviewId).not.toBe(t.reviewId);
    expect((await t.resolveReview('no_violation')).statusCode).toBe(409);
    expect(t.fx.core.store.getSession(t.login.id)!.status).toBe('reviewing');
    expect(t.fx.core.store.getTopicReview(t.reviewId)!.status).toBe('open');
    expect(t.fx.core.store.getTopicReview(newReviewId)!.status).toBe('open');
    const resolved = await t.app.inject({ method: 'POST', url: `/v1/admin/topic-reviews/${newReviewId}/resolve`, headers: { authorization: 'Bearer test-admin' }, payload: { outcome: 'violation', note: 'Current event is forbidden.' } });
    expect(resolved.statusCode).toBe(200);
    expect(t.fx.core.store.getSession(t.login.id)!.status).toBe('terminated');
  });

  it.each(['no_violation', 'violation'] as const)('a current review resolves once with outcome %s', async outcome => {
    const t = await reviewingSession();
    const result = await t.resolveReview(outcome);
    expect(result.statusCode).toBe(200);
    expect(t.fx.core.store.getSession(t.login.id)!.status).toBe(outcome === 'violation' ? 'terminated' : 'active');
    expect(t.fx.core.store.getTopicReview(t.reviewId)!.status).toBe('resolved');
    expect((await t.resolveReview(outcome)).statusCode).toBe(409);
  });
});
