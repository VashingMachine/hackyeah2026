import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { FeedValidationError, ThreatFeed } from '../../src/engine/feed.ts';
import { ROOT } from '../helpers.ts';

const validFeed = () => ({
  catalog_id: 'test-feed',
  version: 1,
  signatures: [{
    id: 'TEST-001',
    title: 'Unsafe pickle load',
    category: 'unsafe_deserialization',
    source: 'https://example.test/advisory',
    risk: 'high',
    targets: ['bash'],
    pattern: 'pickle\\.loads?\\s*\\(',
  }],
});

describe('strict threat feed publication validation', () => {
  it('rejects malformed feed input without including raw values in the error', () => {
    const raw = { ...validFeed(), signatures: 'attacker-controlled-secret' };
    let error: unknown;
    try {
      new ThreatFeed(raw);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FeedValidationError);
    expect((error as Error).message).not.toContain('attacker-controlled-secret');
  });

  it('accepts a valid feed and returns detached serializable snapshots', () => {
    const feed = new ThreatFeed(validFeed());
    const copy = feed.snapshot();
    copy.signatures[0]!.title = 'changed';
    expect(feed.snapshot().signatures[0]!.title).toBe('Unsafe pickle load');
    expect(JSON.parse(JSON.stringify(feed))).toMatchObject({ catalog_id: 'test-feed', version: 1, signatures: [{ id: 'TEST-001' }] });
  });

  it.each([
    ['empty catalog id', (feed: any) => { feed.catalog_id = ''; }],
    ['oversized catalog id', (feed: any) => { feed.catalog_id = 'x'.repeat(129); }],
    ['nonpositive version', (feed: any) => { feed.version = 0; }],
    ['unknown top-level field', (feed: any) => { feed.unexpected = true; }],
    ['missing signature field', (feed: any) => { delete feed.signatures[0].source; }],
    ['unknown signature field', (feed: any) => { feed.signatures[0].extra = true; }],
    ['unknown target', (feed: any) => { feed.signatures[0].targets = ['made_up_tool']; }],
    ['duplicate target', (feed: any) => { feed.signatures[0].targets = ['bash', 'bash']; }],
    ['oversized pattern', (feed: any) => { feed.signatures[0].pattern = 'x'.repeat(513); }],
    ['duplicate signature id', (feed: any) => { feed.signatures.push({ ...feed.signatures[0] }); }],
    ['invalid regex', (feed: any) => { feed.signatures[0].pattern = '('; }],
    ['regex backreference', (feed: any) => { feed.signatures[0].pattern = '(a)\\1'; }],
    ['unsupported regex lookahead', (feed: any) => { feed.signatures[0].pattern = '(?=a)a'; }],
    ['signature count over limit', (feed: any) => { feed.signatures = Array.from({ length: 257 }, (_, i) => ({ ...feed.signatures[0], id: `T-${i}` })); }],
  ])('rejects %s', (_label, mutate) => {
    const raw = validFeed();
    mutate(raw);
    expect(() => new ThreatFeed(raw)).toThrow(FeedValidationError);
  });

  it('keeps the bundled feed compatible and matches representative attacks and safe text', () => {
    const feed = ThreatFeed.fromFile(join(ROOT, 'feed', 'demo-attacks.json'));
    expect(feed.size).toBe(9);
    expect(feed.match('bash', 'python3 -c "import pickle; pickle.loads(data)"').map((m) => m.id)).toContain('BW-FEED-001');
    expect(feed.match('bash', 'torch.load(\'model.pt\', weights_only=True)')).not.toContainEqual(expect.objectContaining({ id: 'BW-FEED-002' }));
    expect(feed.match('bash', 'torch.load(\'model.pt\')')).toContainEqual(expect.objectContaining({ id: 'BW-FEED-002' }));
    expect(feed.match('bash', 'torch.load(\'safe.pt\', weights_only=True); torch.load(\'unsafe.pt\')')).toContainEqual(expect.objectContaining({ id: 'BW-FEED-002' }));
    expect(feed.match('model_output', 'ordinary helpful answer')).toEqual([]);
  });

  it('matches a formerly catastrophic quantified pattern in bounded time', () => {
    const raw = validFeed();
    raw.signatures[0]!.pattern = 'a*'.repeat(250) + 'z';
    const feed = new ThreatFeed(raw);
    const input = 'a'.repeat(40) + 'b'.repeat(200_000);
    const start = performance.now();
    expect(feed.match('bash', input)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
