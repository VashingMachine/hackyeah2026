import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFixture, CountingJudge, StubGuardian } from '../helpers.ts';

function setup() {
  const judge = new CountingJudge(input => input.action.includes('publish the private ledger') ? 'deny' : 'allow');
  const fx = makeFixture({judge, guardian: new StubGuardian()});
  const s = fx.login('developer-demo');
  return {fx, s, judge, decide: (tool: string, args: Record<string, unknown>) => fx.core.decideTool(fx.core.store.getSession(s.id)!, {request_id: 'context-test', tool, arguments: args}, {cwd: join(fx.ws, 'project')})};
}

describe('the semantic reviewer sees the complete proposed effect', () => {
  it('reviews the tail of a shell command beyond 2000 characters', async () => {
    const t = setup();
    const command = `python3 -c "print('${'ordinary project test output '.repeat(90)}'); print('publish the private ledger')"`;
    expect(command.length).toBeGreaterThan(2000);
    expect((await t.decide('bash', {command})).effect).toBe('deny');
    expect(t.judge.count).toBe(1);
  });
  it('reviews the native Pi edit oldText/newText fields', async () => {
    const t = setup();
    const d = await t.decide('edit', {path: 'README.md', oldText: '#', newText: 'publish the private ledger'});
    expect(d.effect).toBe('deny');
    expect(t.judge.count).toBe(1);
  });
  it('rejects oversized native edits before paying for semantic review', async () => {
    const t = setup();
    const d = await t.decide('edit', {path: 'README.md', oldText: '#', newText: 'x'.repeat(262145)});
    expect(d.effect).toBe('deny');
    expect(d.reason_codes).toContain('INPUT_TOO_LARGE');
    expect(t.judge.count).toBe(0);
  });
  it('accepts the current Pi batch edit shape and reviews every replacement', async () => {
    const t = setup();
    const d = await t.decide('edit', {path: 'README.md', edits: [{oldText: '#', newText: 'ordinary heading'}, {oldText: 'demo', newText: 'publish the private ledger'}]});
    expect(d.effect).toBe('deny');
    expect(t.judge.count).toBe(1);
  });
  it('rejects a batch whose combined replacement bytes exceed the file limit', async () => {
    const t = setup();
    const d = await t.decide('edit', {path: 'README.md', edits: [{oldText: '#', newText: 'x'.repeat(140000)}, {oldText: 'demo', newText: 'y'.repeat(140000)}]});
    expect(d.reason_codes).toContain('INPUT_TOO_LARGE');
    expect(t.judge.count).toBe(0);
  });
  it('checks the size of the resulting file, not only the replacement fragment', async () => {
    const t = setup();
    const current = readFileSync(join(t.fx.ws, 'project/README.md'), 'utf8');
    const d = await t.decide('edit', {path: 'README.md', oldText: current.slice(0, 1), newText: 'x'.repeat(262144)});
    expect(d.reason_codes).toContain('INPUT_TOO_LARGE');
    expect(t.judge.count).toBe(0);
  });
});
