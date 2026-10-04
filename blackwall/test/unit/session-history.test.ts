import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.ts';
import { makeFixture, CountingJudge, StubGuardian, ROOT } from '../helpers.ts';

describe('admin session history API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let fx: ReturnType<typeof makeFixture> | undefined;
  afterEach(async () => {
    await app?.close(); app = undefined;
    fx?.core.store.close(); fx = undefined;
  });

  it('pages a stable per-session snapshot in ascending order and leaves legacy attribution unknown', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session, token } = fx.core.createSession('developer-demo');
    const { session: other } = fx.core.createSession('onboarding-demo');
    for (let i = 0; i < 9; i++) {
      const target = i % 2 ? other.id : session.id;
      fx.core.store.appendEvent(target, 'qa.history', { index: i, ...(i === 0 ? { policy_attribution: { source: 'event_time', policy_id: 'old-policy', policy_version: 4, profile: 'old-profile' } } : {}) });
    }
    app = buildApp(fx.core, { adminToken: 'admin', gateway: {} as never, dashboardDir: join(ROOT, 'dashboard') });
    const headers = { authorization: `Bearer ${token}` };
    const admin = { authorization: 'Bearer admin' };
    const first = await app.inject({ method: 'GET', url: `/v1/admin/sessions/${session.id}/events?limit=2`, headers: admin });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json();
    const snapshot = firstPage.snapshot_id as number;
    expect(firstPage.snapshot_id).toBe(snapshot);
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.events[0].id).toBeLessThan(firstPage.events[1].id);
    expect(firstPage.events[0].policy_attribution).toBeNull();
    const afterSnapshot = fx.core.store.appendEvent(session.id, 'qa.history', { index: 99 });
    expect(snapshot).toBeLessThan(afterSnapshot.id);

    const ids = [...firstPage.events.map((event: { id: number }) => event.id)];
    let cursor = firstPage.next_cursor as number;
    let hasMore = firstPage.has_more as boolean;
    while (hasMore) {
      const page = await app.inject({ method: 'GET', url: `/v1/admin/sessions/${session.id}/events?limit=2&before_id=${cursor}&snapshot_id=${snapshot}`, headers: admin });
      expect(page.statusCode).toBe(200);
      const data = page.json();
      ids.unshift(...data.events.map((event: { id: number }) => event.id));
      cursor = data.next_cursor;
      hasMore = data.has_more;
    }
    const expected = fx.core.store.listEvents({ sessionId: session.id, limit: 1000, order: 'asc' }).filter(event => event.id <= snapshot).map(event => event.id);
    expect(ids).toEqual(expected);
    expect(ids).not.toContain(afterSnapshot.id);

    const explicit = await app.inject({ method: 'GET', url: `/v1/admin/sessions/${session.id}/events?limit=100&snapshot_id=${snapshot}`, headers: admin });
    const attributed = explicit.json().events.find((event: { data: { index?: number } }) => event.data.index === 0);
    expect(attributed.policy_attribution).toEqual({ source: 'event_time', policy_id: 'old-policy', policy_version: 4, profile: 'old-profile' });
    const unauthorized = await app.inject({ method: 'GET', url: `/v1/admin/sessions/${session.id}/events` });
    expect(unauthorized.statusCode).toBe(401);
    const sessions = await app.inject({ method: 'GET', url: '/v1/admin/sessions', headers: admin });
    expect(sessions.json().sessions.find((item: { id: string }) => item.id === session.id).last_event_at).toBeTypeOf('number');
    expect((await app.inject({ method: 'GET', url: '/dashboard/session-browser.js' })).statusCode).toBe(200);
  });
});
