import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.ts';
import { makeFixture, CountingJudge, StubGuardian } from '../helpers.ts';

describe('admin live event stream', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let fx: ReturnType<typeof makeFixture> | undefined;
  afterEach(async () => {
    await app?.close(); app = undefined;
    fx?.core.store.close(); fx = undefined;
  });

  it('delivers every row after the cursor in ascending batches larger than the poll limit', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const cursor = fx.core.store.latestEventId();
    const expected: number[] = [];
    for (let i = 0; i < 405; i++) expected.push(fx.core.store.appendEvent(null, 'qa.stream', { ordinal: i }).id);
    app = buildApp(fx.core, { adminToken: 'admin', gateway: {} as never, dashboardDir: '' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/admin/stream?since=${cursor}`, {
        headers: { authorization: 'Bearer admin' }, signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const received: number[] = [];
      while (received.length < expected.length) {
        const part = await reader.read();
        if (part.done) break;
        pending += decoder.decode(part.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)).id);
      }
      expect(received).toEqual(expected);
      await reader.cancel();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});
