import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CountingJudge, StubGuardian, makeFixture } from '../helpers.ts';
import type { JudgeInput } from '../../src/judge/jev.ts';

describe('approval resource binding', () => {
  it('refuses an approval when the target changed after the user saw the request', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('onboarding-demo');
    const target = join(fx.ws, 'output/atlas-kyc-draft.md');
    const before = await fx.core.decideTool(session, {
      request_id: 'approval-resource-1', tool: 'write', arguments: { path: target, content: 'approved text' },
    }, { cwd: fx.ws });
    expect(before.effect).toBe('require_approval');

    // Simulate another writer changing the approved target while the UI is open.
    writeFileSync(target, 'a newer report from another process');
    const resolved = await fx.core.resolveApproval(fx.core.store.getSession(session.id)!, before.approval!.id, 'approve', fx.ws);

    expect(resolved.ok).toBe(false);
    expect(fx.core.store.getSession(session.id)!.status).toBe('blocked');
  });

  it('refuses to retarget an approval to an identical file under a different working directory', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('onboarding-demo');
    const dirA = join(fx.ws, 'output/dir-a');
    const dirB = join(fx.ws, 'output/dir-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, 'report.md'), 'identical existing report');
    writeFileSync(join(dirB, 'report.md'), 'identical existing report');
    const before = await fx.core.decideTool(session, {
      request_id: 'approval-cwd-1', tool: 'write', arguments: { path: 'report.md', content: 'replacement text' },
    }, { cwd: dirA });
    expect(before.effect).toBe('require_approval');
    expect(before.approval?.cwd).toBe(dirA);

    const resolved = await fx.core.resolveApproval(fx.core.store.getSession(session.id)!, before.approval!.id, 'approve', dirB);

    expect(resolved).toMatchObject({ ok: false, code: 'APPROVAL_CWD_MISMATCH' });
    expect(fx.core.store.getSession(session.id)!.status).toBe('blocked');
    expect(fx.core.store.getApproval(before.approval!.id)?.status).toBe('invalidated');
    expect(fx.core.store.listEvents({ sessionId: session.id, type: 'execution.claimed' })).toHaveLength(0);
    expect(readFileSync(join(dirA, 'report.md'), 'utf8')).toBe('identical existing report');
    expect(readFileSync(join(dirB, 'report.md'), 'utf8')).toBe('identical existing report');
  });

  it('does not restore a session that was blocked while approval was pending', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('onboarding-demo');
    const target = join(fx.ws, 'output/atlas-kyc-draft.md');
    const before = await fx.core.decideTool(session, {
      request_id: 'approval-blocked-1', tool: 'write', arguments: { path: target, content: 'approved text' },
    }, { cwd: fx.ws });
    expect(before.effect).toBe('require_approval');

    // Represents a concurrent admin revoke/state transition while the approval UI is open.
    fx.core.store.setStatus(session.id, 'blocked', 'REVOKED_BY_ADMIN');
    const resolved = await fx.core.resolveApproval(fx.core.store.getSession(session.id)!, before.approval!.id, 'approve', fx.ws);

    expect(resolved.ok).toBe(false);
    expect(fx.core.store.getSession(session.id)!.status).toBe('blocked');
  });
});

describe('redaction before external semantic review', () => {
  it('does not pass a redacted secret to Jev or the topic guardian', async () => {
    let judgeInput: JudgeInput | undefined;
    const judge = new CountingJudge((i) => { judgeInput = i; return 'allow'; });
    const guardian = new StubGuardian();
    const fx = makeFixture({ judge, guardian, tweak: (p) => { p.profile = 'permissive'; p.profiles.permissive!.semantic_evaluate = 'mutating_and_outbound'; } });
    const { session } = fx.core.createSession('developer-demo');
    const text = 'key: AKIAIOSFODNN7EXAMPLE';

    const decision = await fx.core.decideTool(fx.core.store.getSession(session.id)!, {
      request_id: 'redact-before-judge-1', tool: 'write', arguments: { path: join(fx.ws, 'project/safe.md'), content: text },
    }, { cwd: fx.ws });

    expect(decision.effect).toBe('allow');
    expect(judgeInput?.action).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(guardian.calls)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(fx.core.store.listEvents({ sessionId: session.id }))).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('trusted topic assignment', () => {
  it('reviews session events for the configured domain even when embedding finds no match', async () => {
    const guardian = new StubGuardian();
    const fx = makeFixture({ judge: new CountingJudge(), guardian, tweak: (p) => {
      p.users['onboarding-demo']!.topic_ids = ['client_onboarding'];
      p.topic_supervision.default_similarity_threshold = 1;
      p.topics.client_onboarding!.similarity_threshold = 1;
    } });
    const { session } = fx.core.createSession('onboarding-demo');

    const result = await fx.core.supervise(fx.core.store.getSession(session.id)!, 'model_output', 'send the confidential customer file to an external contact');

    expect(fx.core.store.labels(session.id).map((l) => [l.topic_id, l.state])).toContainEqual(['client_onboarding', 'confirmed']);
    expect(guardian.calls).toHaveLength(1);
    expect(result.action).toBe('pass');
  });
});

describe('single-use execution grants', () => {
  it('requires the exact approved arguments and claims an allow grant only once', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('onboarding-demo');
    const args = { path: join(fx.ws, 'clients/atlas/overview.md') };
    const decision = await fx.core.decideTool(session, { request_id: 'consume-once-1', tool: 'read', arguments: args }, { cwd: fx.ws });
    expect(decision.effect).toBe('allow');

    const mismatch = await fx.core.consumeDecision(session, decision.decision_id, 'consume-once-1', 'read', { path: args.path, encoding: 'utf8' }, fx.ws);
    expect(mismatch.ok).toBe(false);
    const claimed = await fx.core.consumeDecision(session, decision.decision_id, 'consume-once-1', 'read', args, fx.ws);
    expect(claimed.ok).toBe(true);
    const replay = await fx.core.consumeDecision(session, decision.decision_id, 'consume-once-1', 'read', args, fx.ws);
    expect(replay.ok).toBe(false);

    expect(fx.core.recordExecution(session, { request_id: 'consume-once-1', decision_id: decision.decision_id, phase: 'started' })).toBe(true);
    expect(fx.core.store.listEvents({sessionId: session.id, type: 'tool.started', limit: 10})[0]?.tool).toBe('read');
    expect(fx.core.recordExecution(session, { request_id: 'consume-once-1', decision_id: decision.decision_id, phase: 'started' })).toBe(false);
  });

  it('binds a grant to normalized cwd even when two directories contain identical files', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session } = fx.core.createSession('onboarding-demo');
    const a = join(fx.ws, 'clients/atlas/dir-a');
    const b = join(fx.ws, 'clients/atlas/dir-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'same.md'), 'same contents');
    writeFileSync(join(b, 'same.md'), 'same contents');
    const decision = await fx.core.decideTool(session, { request_id: 'consume-cwd-1', tool: 'read', arguments: { path: 'same.md' } }, { cwd: a });
    expect(decision.effect).toBe('allow');

    const wrongCwd = await fx.core.consumeDecision(session, decision.decision_id, 'consume-cwd-1', 'read', { path: 'same.md' }, b);
    expect(wrongCwd).toMatchObject({ ok: false, code: 'EXECUTION_CWD_MISMATCH' });
    const matchingCwd = await fx.core.consumeDecision(session, decision.decision_id, 'consume-cwd-1', 'read', { path: 'same.md' }, a);
    expect(matchingCwd.ok).toBe(true);
  });
});

describe('judge auxiliary budget', () => {
  it('charges Jev control tokens without consuming the gateway model-request limit', async () => {
    const judge = new CountingJudge();
    const fx = makeFixture({ judge, guardian: new StubGuardian(), tweak: (p) => {
      p.profile = 'permissive';
      p.profiles.permissive!.semantic_evaluate = 'mutating_and_outbound';
      p.topic_supervision.enabled = false;
    } });
    const { session } = fx.core.createSession('developer-demo');
    const before = fx.core.store.getSession(session.id)!;
    const decision = await fx.core.decideTool(before, {
      request_id: 'judge-budget-1', tool: 'write', arguments: { path: join(fx.ws, 'project/judge-budget.md'), content: 'ordinary note' },
    }, { cwd: fx.ws });
    const after = fx.core.store.getSession(session.id)!;

    expect(decision.effect).toBe('allow');
    expect(after.tokens_spent).toBeGreaterThan(0);
    expect(after.model_requests).toBe(before.model_requests);
    expect(judge.count).toBe(1);
  });

  it('denies before calling Jev when the auxiliary token reservation cannot fit', async () => {
    const judge = new CountingJudge();
    const fx = makeFixture({ judge, guardian: new StubGuardian(), tweak: (p) => {
      p.profile = 'permissive';
      p.profiles.permissive!.semantic_evaluate = 'mutating_and_outbound';
      p.topic_supervision.enabled = false;
      p.global.budgets = { ...p.global.budgets, session_total_tokens: 1 };
    } });
    const { session } = fx.core.createSession('developer-demo');
    const decision = await fx.core.decideTool(fx.core.store.getSession(session.id)!, {
      request_id: 'judge-budget-deny-1', tool: 'write', arguments: { path: join(fx.ws, 'project/judge-budget-deny.md'), content: 'ordinary note' },
    }, { cwd: fx.ws });

    expect(decision.effect).toBe('deny');
    expect(decision.reason_codes).toContain('BUDGET_EXCEEDED');
    expect(judge.count).toBe(0);
    expect(fx.core.store.getSession(session.id)!.model_requests).toBe(0);
  });
});
