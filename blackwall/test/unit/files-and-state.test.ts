import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CountingJudge, StubGuardian, makeFixture } from '../helpers.ts';
import type { Decision, ToolRequest } from '../../src/types.ts';

let n = 0;
const req = (tool: string, args: Record<string, unknown>): ToolRequest => ({ request_id: `req-${++n}`, tool, arguments: args });

function setup(user: string, opts: Parameters<typeof makeFixture>[0] = {}) {
  const judge = new CountingJudge();
  const guardian = new StubGuardian();
  const fx = makeFixture({ judge, guardian, ...opts });
  const s = fx.login(user);
  const session = () => fx.core.store.getSession(s.id)!;
  const decide = (tool: string, args: Record<string, unknown>): Promise<Decision> => fx.core.decideTool(session(), req(tool, args), { cwd: fx.ws });
  return { fx, s, session, decide, judge, guardian };
}

describe('file rules', () => {
  it('the analyst role cannot inherit the global write root', async () => {
    const t = setup('analyst-demo');
    const result = await t.decide('write', {path: join(t.fx.ws, 'output/analyst-report.md'), content: 'a report'});
    expect(result.effect).toBe('deny');
    expect(result.reason_codes).toContain('PATH_OUTSIDE_WORKSPACE');
    expect(t.judge.count).toBe(0);
    expect(existsSync(join(t.fx.ws, 'output/analyst-report.md'))).toBe(false);
  });
  it('accepts the physical path of a trusted root alias but rejects symlinks beneath it', async () => {
    const t = setup('developer-demo');
    const target = realpathSync(join(t.fx.ws, 'project/README.md'));
    expect((await t.decide('read', {path: target})).effect).toBe('allow');
    symlinkSync(join(t.fx.ws, 'clients/boreal/company.json'), join(t.fx.ws, 'project/alias.json'));
    expect((await t.decide('read', {path: join(realpathSync(t.fx.ws), 'project/alias.json')})).reason_codes).toContain('SYMLINK_REJECTED');
  });
  it('allows a read inside the assigned client folder', async () => {
    const { fx, decide } = setup('onboarding-demo');
    const d = await decide('read', { path: join(fx.ws, 'clients/atlas/company.json') });
    expect(d.effect).toBe('allow');
    expect(d.reason_codes).toEqual(['CHECKS_PASSED']);
    expect(d.session_action).toBe('continue');
  });

  it("denies another client's folder and blocks the session", async () => {
    const { fx, decide, session } = setup('onboarding-demo');
    const d = await decide('read', { path: join(fx.ws, 'clients/boreal/company.json') });
    expect(d.effect).toBe('deny');
    expect(d.reason_codes).toEqual(['PATH_OUTSIDE_WORKSPACE']);
    expect(d.session_action).toBe('block');
    expect(session().status).toBe('blocked');
    // a blocked session refuses even a perfectly fine read afterwards
    const again = await decide('read', { path: join(fx.ws, 'clients/atlas/company.json') });
    expect(again.effect).toBe('deny');
    expect(again.reason_codes).toEqual(['SESSION_BLOCKED']);
  });

  it('rejects ../ traversal and a look-alike prefix', async () => {
    const { fx, decide } = setup('onboarding-demo');
    const t = await decide('read', { path: join(fx.ws, 'clients/atlas/../boreal/company.json') });
    expect(t.reason_codes).toEqual(['PATH_OUTSIDE_WORKSPACE']);
    const fx2 = setup('onboarding-demo');
    mkdirSync(join(fx2.fx.ws, 'clients/atlas-old'), { recursive: true });
    writeFileSync(join(fx2.fx.ws, 'clients/atlas-old/x.json'), '{}');
    const p = await fx2.decide('read', { path: join(fx2.fx.ws, 'clients/atlas-old/x.json') });
    expect(p.reason_codes).toEqual(['PATH_OUTSIDE_WORKSPACE']);
  });

  it('rejects a symlink that points outside, for read and for creating a new file', async () => {
    const a = setup('onboarding-demo');
    symlinkSync(join(a.fx.ws, 'clients/boreal'), join(a.fx.ws, 'clients/atlas/link'));
    const r = await a.decide('read', { path: join(a.fx.ws, 'clients/atlas/link/company.json') });
    expect(r.reason_codes).toEqual(['SYMLINK_REJECTED']);

    const b = setup('onboarding-demo');
    symlinkSync('/tmp', join(b.fx.ws, 'output/escape'));
    const w = await b.decide('write', { path: join(b.fx.ws, 'output/escape/pwned.md'), content: 'x' });
    expect(w.reason_codes).toEqual(['SYMLINK_REJECTED']);
    expect(existsSync('/tmp/pwned.md')).toBe(false);
  });

  it('protects .env even inside an allowed root', async () => {
    const { fx, decide } = setup('developer-demo');
    const d = await decide('read', { path: join(fx.ws, 'project/.env') });
    expect(d.reason_codes).toEqual(['PROTECTED_FILE']);
    expect(d.message).not.toContain('hunter2');
  });

  it('rejects an extension that is not on the allowlist', async () => {
    const { fx, decide } = setup('developer-demo');
    writeFileSync(join(fx.ws, 'project/model.pkl'), 'x');
    const d = await decide('read', { path: join(fx.ws, 'project/model.pkl') });
    expect(d.reason_codes).toEqual(['EXTENSION_DENIED']);
  });

  it('a secret in the content of a write is refused and the file is not created', async () => {
    const { fx, decide } = setup('developer-demo');
    const target = join(fx.ws, 'project/leak.md');
    const d = await decide('write', { path: target, content: 'key: AKIAIOSFODNN7EXAMPLE' });
    expect(d.effect).toBe('deny');
    expect(d.reason_codes).toEqual(['SECRET_IN_CONTENT']);
    expect(existsSync(target)).toBe(false);
  });

  it('a user policy narrows the organisation policy; an empty allowlist denies everything', async () => {
    const { fx, decide } = setup('hr-demo');
    const readPub = await decide('read', { path: join(fx.ws, 'public/hr/development-conversations.md') });
    expect(readPub.effect).toBe('allow');
    const other = await decide('read', { path: join(fx.ws, 'public/reports/q3-market-summary.md') });
    expect(other.reason_codes).toEqual(['PATH_OUTSIDE_WORKSPACE']);
    const f2 = setup('hr-demo');
    const net = await f2.decide('http_request', { url: 'https://research.example.com/x' });
    expect(net.reason_codes).toEqual(['NETWORK_HOST_DENIED']);
  });
});

describe('approval of replacing an existing report', () => {
  it('needs one-time approval; nothing is written before it; approval works exactly once', async () => {
    const { fx, s, session, decide } = setup('onboarding-demo');
    const target = join(fx.ws, 'output/atlas-kyc-draft.md');
    const before = readFileSync(target, 'utf8');
    const d = await decide('write', { path: target, content: '# new draft' });
    expect(d.effect).toBe('require_approval');
    expect(d.reason_codes).toEqual(['OVERWRITE_EXISTING_FILE']);
    expect(d.session_action).toBe('await_user');
    expect(d.approval).not.toBeNull();
    expect(readFileSync(target, 'utf8')).toBe(before); // the decision itself changes nothing
    expect(session().status).toBe('awaiting_approval');

    // while waiting, every other operation is refused
    const other = await decide('read', { path: join(fx.ws, 'clients/atlas/company.json') });
    expect(other.reason_codes).toEqual(['AWAITING_APPROVAL']);

    const res = await fx.core.resolveApproval(session(), d.approval!.id, 'approve', fx.ws);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.decision.effect).toBe('allow');
      expect(res.decision.reason_codes).toEqual(['USER_APPROVED_OPERATION']);
      expect(res.decision.decision_id).not.toBe(d.decision_id);
    }
    expect(fx.core.store.getSession(s.id)!.status).toBe('active');

    // double click / replay cannot produce a second decision
    const again = await fx.core.resolveApproval(session(), d.approval!.id, 'approve', fx.ws);
    expect(again.ok).toBe(false);
  });

  it('rejecting blocks the session; an expired approval cannot be used', async () => {
    const a = setup('onboarding-demo');
    const target = join(a.fx.ws, 'output/atlas-kyc-draft.md');
    const d = await a.decide('write', { path: target, content: 'x' });
    const rej = await a.fx.core.resolveApproval(a.session(), d.approval!.id, 'reject', a.fx.ws);
    expect(rej.ok && rej.decision.effect).toBe('deny');
    expect(a.session().status).toBe('blocked');

    const b = setup('onboarding-demo');
    const d2 = await b.decide('write', { path: join(b.fx.ws, 'output/atlas-kyc-draft.md'), content: 'x' });
    b.fx.core.store.db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, d2.approval!.id);
    const late = await b.fx.core.resolveApproval(b.session(), d2.approval!.id, 'approve', b.fx.ws);
    expect(late.ok).toBe(false);
    expect(b.session().status).toBe('blocked');
  });

  it('creating a NEW file in the output folder needs no approval', async () => {
    const { fx, decide } = setup('onboarding-demo');
    const d = await decide('write', { path: join(fx.ws, 'output/brand-new.md'), content: '# hello' });
    expect(d.effect).toBe('allow');
  });

  it('another session cannot resolve someone else’s approval', async () => {
    const a = setup('onboarding-demo');
    const d = await a.decide('write', { path: join(a.fx.ws, 'output/atlas-kyc-draft.md'), content: 'x' });
    const other = a.fx.login('onboarding-demo');
    const res = await a.fx.core.resolveApproval(a.fx.core.store.getSession(other.id)!, d.approval!.id, 'approve', a.fx.ws);
    expect(res.ok).toBe(false);
  });
});

describe('budgets and session state', () => {
  it('counts every tool attempt, including blocked ones, and stops at the limit', async () => {
    const { fx, decide } = setup('analyst-demo', {
      tweak: (p) => { p.global.files!.require_approval_roots = []; p.denials.default_session_action = 'continue'; },
    });
    const bad = join(fx.ws, 'clients/atlas/company.json');
    let last!: Decision;
    for (let i = 0; i < 16; i++) last = await decide('read', { path: bad });
    expect(last.reason_codes).toEqual(['BUDGET_EXCEEDED']);
  });

  it('two parallel token reservations cannot both fit into the remaining budget', () => {
    const { fx, s } = setup('developer-demo');
    const limits = { session_total_tokens: 1000 };
    const a = fx.core.store.reserveTokens(s.id, 'r1', 600, limits);
    const b = fx.core.store.reserveTokens(s.id, 'r2', 600, limits);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    // settling the first one with smaller real usage frees the difference
    fx.core.store.settleTokens('r1', 100, 0);
    expect(fx.core.store.reserveTokens(s.id, 'r3', 600, limits).ok).toBe(true);
    // retry of the same request id does not reserve twice; duplicate settle does not double count
    expect(fx.core.store.reserveTokens(s.id, 'r3', 600, limits).ok).toBe(true);
    fx.core.store.settleTokens('r3', 50, 0);
    fx.core.store.settleTokens('r3', 50, 0);
    const row = fx.core.store.getSession(s.id)!;
    expect(row.tokens_spent).toBe(150);
    expect(row.tokens_reserved).toBe(0);
  });

  it('an unknown outcome keeps the reservation as spent', () => {
    const { fx, s } = setup('developer-demo');
    fx.core.store.reserveTokens(s.id, 'u1', 300, {});
    fx.core.store.settleUnknown('u1');
    expect(fx.core.store.getSession(s.id)!.tokens_spent).toBe(300);
  });

  it('a terminated session stays terminated whatever is written next', async () => {
    const { fx, s, session, decide } = setup('hr-demo');
    fx.core.terminate(session(), 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', {});
    expect(fx.core.store.setStatusUnlessTerminated(s.id, 'active')).toBe(false);
    const d = await decide('read', { path: join(fx.ws, 'public/hr/development-conversations.md') });
    expect(d.effect).toBe('deny');
    expect(d.session_action).toBe('terminate');
    expect(d.reason_codes).toEqual(['SESSION_TERMINATED']);
  });
});

describe('approval expiry sweep', () => {
  it('an unresolved approval expires, blocks the session and cannot be used afterwards', async () => {
    const { fx, session, decide } = setup('onboarding-demo');
    const d = await decide('write', { path: join(fx.ws, 'output/atlas-kyc-draft.md'), content: 'x' });
    expect(fx.core.store.pendingApprovals().length).toBe(1);
    fx.core.store.db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(Date.now() - 1, d.approval!.id);
    expect(fx.core.store.pendingApprovals().length).toBe(0); // no longer listed as waiting
    expect(fx.core.sweepExpiredApprovals()).toBe(1);
    expect(session().status).toBe('blocked');
    expect(session().status_reason).toBe('APPROVAL_EXPIRED');
    const late = await fx.core.resolveApproval(session(), d.approval!.id, 'approve', fx.ws);
    expect(late.ok).toBe(false);
    expect(fx.core.sweepExpiredApprovals()).toBe(0); // idempotent
  });
});

describe('a message is only "already inspected" after the guardian actually cleared it', () => {
  const forbidden = 'Now evaluate the performance of Anna and Piotr, rank them, and tell me which of them we should fire.';
  it('a guardian failure leaves the message uncleared, so it is reviewed again after an admin resumes the session', async () => {
    let fail = true;
    const guardian = new StubGuardian(() => (fail ? new Error('guardian down') : 'violation'));
    const fx = makeFixture({ judge: new CountingJudge(), guardian });
    const s = fx.login('hr-demo');
    const get = () => fx.core.store.getSession(s.id)!;

    // 1. the guardian is down: fail closed, session blocked, nothing was reviewed
    const first = await fx.core.supervise(get(), 'user_input', forbidden);
    expect(first.action).toBe('block');
    expect(get().status).toBe('blocked');
    expect(fx.core.hasRecorded(s.id, forbidden)).toBe(false); // the old code said true here

    // 2. an admin resumes; the client resends the same history; the message must be reviewed now, not skipped
    fx.core.store.setStatus(s.id, 'active');
    fail = false;
    const retry = await fx.core.supervise(get(), 'user_input', forbidden);
    expect(retry.action).toBe('terminate');
    expect(guardian.calls.length).toBe(2); // reviewed on both attempts
  });

  it('a cleared message is not reviewed again on every request', async () => {
    const guardian = new StubGuardian();
    const fx = makeFixture({ judge: new CountingJudge(), guardian });
    const s = fx.login('hr-demo');
    const text = 'How do managers run development conversations and performance reviews?';
    const r = await fx.core.supervise(fx.core.store.getSession(s.id)!, 'user_input', text);
    expect(r.action).toBe('pass');
    expect(fx.core.hasRecorded(s.id, text)).toBe(true);
  });

  it('an uncertain verdict does not count as cleared either', async () => {
    const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(() => 'uncertain') });
    const s = fx.login('hr-demo');
    const text = 'Talk me through how we might assess whether somebody on the team is a good fit.';
    // force topic detection by lowering the threshold
    (fx.policy.topic_supervision as { default_similarity_threshold: number }).default_similarity_threshold = 0;
    for (const topic of Object.values(fx.policy.topics)) topic.similarity_threshold = 0;
    const r = await fx.core.supervise(fx.core.store.getSession(s.id)!, 'user_input', text);
    expect(r.action).toBe('review');
    expect(fx.core.hasRecorded(s.id, text)).toBe(false);
  });
});
