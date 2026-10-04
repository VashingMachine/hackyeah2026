import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.ts';
import { buildCore } from '../../src/server/build.ts';
import { CountingJudge, StubGuardian, makeFixture } from '../helpers.ts';
import { LexicalEmbedder, type Embedder } from '../../src/topics/detector.ts';

describe('live policy publication', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let fx: ReturnType<typeof makeFixture> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    fx?.core.store.close();
    fx = undefined;
  });

  const adminHeaders = { authorization: 'Bearer test-admin-token' };

  it('applies an admin policy update to the next tool decision in the same active session', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(), tweak: (policy) => {
      policy.topic_supervision.enabled = false;
    } });
    const { session, token } = fx.core.createSession('developer-demo');
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });

    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({
      method: 'POST', url: '/v1/tool-decisions', headers,
      payload: { request_id: 'live-policy-before', tool: 'read', arguments: { path: 'project/README.md' }, context: { cwd: fx.ws } },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ effect: 'allow' });

    const publication = await app.inject({
      method: 'POST', url: '/v1/admin/policies',
      headers: adminHeaders,
      payload: { expected_version: 1, changes: { global: { tools: { deny: ['read'] } } } },
    });
    expect(publication.statusCode).toBe(200);
    expect(publication.json()).toMatchObject({ policy_version: 2 });
    expect(fx.core.store.getSession(session.id)?.status).toBe('active');

    const second = await app.inject({
      method: 'POST', url: '/v1/tool-decisions', headers,
      payload: { request_id: 'live-policy-after', tool: 'read', arguments: { path: 'project/README.md' }, context: { cwd: fx.ws } },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ effect: 'deny', reason_codes: ['TOOL_NOT_ALLOWED'], policy_version: 2 });
    expect(fx.core.store.getSession(session.id)?.status).toBe('blocked');
  });

  it('exposes credential-free editable controls and rejects invalid, unauthorized, and stale updates unchanged', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/admin/policies/editable' });
    expect(unauthorized.statusCode).toBe(401);
    const editable = await app.inject({ method: 'GET', url: '/v1/admin/policies/editable', headers: adminHeaders });
    expect(editable.statusCode).toBe(200);
    expect(editable.json()).toMatchObject({ expected_version: 1, changes: { profile: fx.policy.profile, mode: fx.policy.mode } });
    expect(editable.body).not.toContain(fx.policy.users['developer-demo']!.token);
    expect(editable.json().changes.users['developer-demo']).not.toHaveProperty('workdir');

    const malformed = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { global: { tools: { typo: true } } } } });
    const unknown = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { surprise: true } } });
    const unknownUser = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { users: { intruder: { tools: { deny: ['read'] } } } } } });
    const stale = await app.inject({
      method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 2, changes: { global: { tools: { deny: ['read'] } } } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(unknownUser.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);

    const current = await app.inject({ method: 'GET', url: '/v1/admin/policies/editable', headers: adminHeaders });
    expect(current.json().expected_version).toBe(1);
    expect(fx.core.policy.version).toBe(1);
  });

  it('publishes a newer threat feed atomically and rejects a wrong catalog or nonincreasing version', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });
    const snapshot = await app.inject({ method: 'GET', url: '/v1/admin/threat-feed', headers: adminHeaders });
    expect(snapshot.statusCode).toBe(200);
    const current = snapshot.json();
    expect(current).toMatchObject({ expected_policy_version: 1, expected_feed_version: 1 });

    const publishedFeed = { ...current.feed, version: 2 };
    const published = await app.inject({ method: 'POST', url: '/v1/admin/threat-feed', headers: adminHeaders,
      payload: { expected_policy_version: 1, expected_feed_version: 1, feed: publishedFeed } });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ policy_version: 2, feed_version: 2 });

    const wrongCatalog = await app.inject({ method: 'POST', url: '/v1/admin/threat-feed', headers: adminHeaders,
      payload: { expected_policy_version: 2, expected_feed_version: 2, feed: { ...publishedFeed, catalog_id: 'other' } } });
    const staleFeed = await app.inject({ method: 'POST', url: '/v1/admin/threat-feed', headers: adminHeaders,
      payload: { expected_policy_version: 2, expected_feed_version: 2, feed: publishedFeed } });
    const malformed = await app.inject({ method: 'POST', url: '/v1/admin/threat-feed', headers: adminHeaders,
      payload: { expected_policy_version: 2, expected_feed_version: 2, feed: { catalog_id: current.feed.catalog_id, version: 3, signatures: 'bad' } } });
    expect(wrongCatalog.statusCode).toBe(409);
    expect(staleFeed.statusCode).toBe(409);
    expect(malformed.statusCode).toBe(400);
    const after = await app.inject({ method: 'GET', url: '/v1/admin/threat-feed', headers: adminHeaders });
    expect(after.json()).toMatchObject({ expected_policy_version: 2, expected_feed_version: 2, feed: publishedFeed });
  });

  it('restores published controls and feed from the same store when buildCore restarts on the base policy', async () => {
    const judge = new CountingJudge();
    const guardian = new StubGuardian();
    fx = makeFixture({ judge, guardian });
    const basePolicy = structuredClone(fx.policy);
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });
    const response = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { mode: 'observe', global: { tools: { deny: ['read'] } } } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ policy_version: 2 });

    const feedSnapshot = await app.inject({ method: 'GET', url: '/v1/admin/threat-feed', headers: adminHeaders });
    const activeFeed = feedSnapshot.json();
    const feedPublication = await app.inject({ method: 'POST', url: '/v1/admin/threat-feed', headers: adminHeaders,
      payload: { expected_policy_version: 2, expected_feed_version: 1, feed: { ...activeFeed.feed, version: 2 } } });
    expect(feedPublication.statusCode).toBe(200);
    expect(feedPublication.json()).toMatchObject({ policy_version: 3, feed_version: 2 });

    const restored = buildCore(basePolicy, fx.env, { store: fx.core.store, judge, guardian, embedder: new LexicalEmbedder() });
    expect(restored.policy.version).toBe(3);
    expect(restored.policy.mode).toBe('observe');
    expect(restored.policy.global.tools?.deny).toContain('read');
    expect(restored.feed.version).toBe(2);
  });

  it('leaves active controls unchanged when candidate detector initialization fails', async () => {
    const failingEmbedder: Embedder = { name: 'failing-test', async embed() { throw new Error('injected embedding failure'); } };
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(), embedder: failingEmbedder });
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });
    const response = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { global: { tools: { deny: ['read'] } } } } });
    expect(response.statusCode).toBe(400);
    expect(fx.core.policy.version).toBe(1);
    const editable = await app.inject({ method: 'GET', url: '/v1/admin/policies/editable', headers: adminHeaders });
    expect(editable.json().expected_version).toBe(1);
    expect(editable.json().changes.global.tools.deny).not.toContain('read');

    const feedSnapshot = await app.inject({ method: 'GET', url: '/v1/admin/threat-feed', headers: adminHeaders });
    const feed = feedSnapshot.json();
    const feedPublication = await app.inject({ method: 'POST', url: '/v1/admin/threat-feed', headers: adminHeaders,
      payload: { expected_policy_version: 1, expected_feed_version: 1, feed: { ...feed.feed, version: 2 } } });
    expect(feedPublication.statusCode).toBe(400);
    const unchangedFeed = await app.inject({ method: 'GET', url: '/v1/admin/threat-feed', headers: adminHeaders });
    expect(unchangedFeed.json()).toMatchObject({ expected_policy_version: 1, expected_feed_version: 1, feed: feed.feed });
  });

  it('waits for an in-flight chat before publishing and rechecks previously cleared input under the new policy', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(), tweak: policy => { policy.topic_supervision.enabled = false; } });
    const { token } = fx.core.createSession('developer-demo');
    let enterFetch!: () => void;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>(resolve => { enterFetch = resolve; });
    const fetchBarrier = new Promise<void>(resolve => { releaseFetch = resolve; });
    let providerCalls = 0;
    const fetchImpl = (async () => {
      providerCalls++;
      enterFetch();
      await fetchBarrier;
      return Response.json({ id: 'resp_test', status: 'completed', created_at: 1,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
    }) as typeof fetch;
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: { openaiKey: 'test-key', fetchImpl }, dashboardDir: '' });
    const sessionHeaders = { authorization: `Bearer ${token}` };
    const chatPayload = { model: 'demo-agent', max_tokens: 128, messages: [{ role: 'user', content: 'Check PESEL 44051401359.' }] };
    const chat = app.inject({ method: 'POST', url: '/v1/chat/completions', headers: sessionHeaders, payload: chatPayload });
    await fetchStarted;

    let publicationDone = false;
    const publication = app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { profile: 'strict' } } }).then(response => { publicationDone = true; return response; });
    await new Promise(resolve => setImmediate(resolve));
    expect(publicationDone).toBe(false);
    releaseFetch();
    const firstChat = await chat;
    const published = await publication;
    expect(firstChat.statusCode).toBe(200);
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ policy_version: 2 });

    const replay = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: sessionHeaders, payload: chatPayload });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.code).toBe('SECRET_IN_CONTENT');
    expect(providerCalls).toBe(1);
  });

  it('requires complete topic catalogs and rejects unknown topic thresholds without changing active controls', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });
    const editable = await app.inject({ method: 'GET', url: '/v1/admin/policies/editable', headers: adminHeaders });
    const changes = editable.json().changes;
    const partialCatalog = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { topics: { client_onboarding: changes.topics.client_onboarding } } } });
    const halfCatalog = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { topics: changes.topics } } });
    const unknownThreshold = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { topic_thresholds: { not_a_topic: 0.5 } } } });
    expect(partialCatalog.statusCode).toBe(400);
    expect(halfCatalog.statusCode).toBe(400);
    expect(unknownThreshold.statusCode).toBe(400);

    const complete = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { topics: changes.topics, topic_policies: changes.topic_policies } } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ policy_version: 2 });
  });

  it('invalidates pending approvals and unconsumed grants on publication without reviving terminated sessions', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(), tweak: policy => { policy.topic_supervision.enabled = false; } });
    const pending = fx.core.createSession('onboarding-demo');
    const approved = await fx.core.decideTool(pending.session, {
      request_id: 'publication-pending-approval', tool: 'write',
      arguments: { path: join(fx.ws, 'output/atlas-kyc-draft.md'), content: 'replacement draft' },
    }, { cwd: fx.ws });
    expect(approved.effect).toBe('require_approval');

    const granted = fx.core.createSession('developer-demo');
    const decision = await fx.core.decideTool(granted.session, {
      request_id: 'publication-unused-grant', tool: 'read', arguments: { path: 'project/README.md' },
    }, { cwd: fx.ws });
    expect(decision.effect).toBe('allow');

    const terminated = fx.core.createSession('analyst-demo');
    fx.core.terminate(terminated.session, 'TEST_TERMINATION', {});
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });
    const publication = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { mode: 'observe' } } });
    expect(publication.statusCode).toBe(200);
    expect(fx.core.store.getApproval(approved.approval!.id)?.status).toBe('invalidated');
    expect(fx.core.store.getSession(pending.session.id)?.status).toBe('blocked');
    expect(fx.core.store.getSession(terminated.session.id)?.status).toBe('terminated');

    const resolve = await app.inject({ method: 'POST', url: `/v1/approvals/${approved.approval!.id}/resolve`,
      headers: { authorization: `Bearer ${pending.token}` }, payload: { resolution: 'approve', cwd: fx.ws } });
    expect(resolve.statusCode).toBe(409);
    const consume = await app.inject({ method: 'POST', url: `/v1/tool-decisions/${decision.decision_id}/consume`,
      headers: { authorization: `Bearer ${granted.token}` },
      payload: { request_id: 'publication-unused-grant', tool: 'read', arguments: { path: 'project/README.md' }, context: { cwd: fx.ws } } });
    expect(consume.statusCode).toBe(409);
  });

  it('preserves nested global controls and treats an explicitly empty user allowlist as deny-all', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
    const { session, token } = fx.core.createSession('developer-demo');
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: {} as never, dashboardDir: '' });
    const publication = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { global: { tools: { deny: ['read'] } }, users: { 'developer-demo': { tools: { allow: [] } } } } } });
    expect(publication.statusCode).toBe(200);
    const currentControls = await app.inject({ method: 'GET', url: '/v1/admin/policies/editable', headers: adminHeaders });
    expect(currentControls.json().changes.global.tools.allow).toContain('write');
    expect(currentControls.json().changes.global.tools.deny).toEqual(['read']);

    const view = await app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: `Bearer ${token}` } });
    expect(view.json().allowed.tools).toEqual([]);
    const decision = await app.inject({ method: 'POST', url: '/v1/tool-decisions', headers: { authorization: `Bearer ${token}` },
      payload: { request_id: 'empty-explicit-allowlist', tool: 'read', arguments: { path: 'project/README.md' }, context: { cwd: fx.ws } } });
    expect(decision.json()).toMatchObject({ effect: 'deny', reason_codes: ['TOOL_NOT_ALLOWED'], policy_version: 2 });
    expect(fx.core.store.getSession(session.id)?.status).toBe('blocked');
  });

  it('keeps encrypted reasoning for the same session across a successful policy publication', async () => {
    fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian(), tweak: policy => { policy.topic_supervision.enabled = false; } });
    const { token } = fx.core.createSession('developer-demo');
    const bodies: Record<string, unknown>[] = [];
    let providerCalls = 0;
    const fetchImpl = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      providerCalls++;
      const output = providerCalls === 1
        ? [{ type: 'reasoning', encrypted_content: 'opaque-session-reasoning' }, { type: 'function_call', call_id: 'call_1', name: 'read', arguments: JSON.stringify({ path: 'project/README.md' }) }]
        : [{ type: 'reasoning', encrypted_content: 'opaque-next-reasoning' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }];
      return Response.json({ id: `resp_${providerCalls}`, status: 'completed', created_at: 1, output,
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
    }) as typeof fetch;
    app = buildApp(fx.core, { adminToken: 'test-admin-token', gateway: { openaiKey: 'test-key', fetchImpl }, dashboardDir: '' });
    const headers = { authorization: `Bearer ${token}` };
    const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const first = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers,
      payload: { model: 'demo-agent', max_tokens: 128, tools, messages: [{ role: 'user', content: 'Read the project README.' }] } });
    expect(first.statusCode).toBe(200);
    const assistant = first.json().choices[0].message;
    expect(assistant.tool_calls[0].id).toBe('call_1');

    const publication = await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: adminHeaders,
      payload: { expected_version: 1, changes: { mode: 'observe' } } });
    expect(publication.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers,
      payload: { model: 'demo-agent', max_tokens: 128, tools, messages: [
        { role: 'user', content: 'Read the project README.' },
        assistant,
        { role: 'tool', tool_call_id: 'call_1', content: 'README contents' },
      ] } });
    expect(second.statusCode).toBe(200);
    const nextInput = JSON.stringify(bodies[1]!.input);
    expect(nextInput).toContain('opaque-session-reasoning');
    expect(nextInput.indexOf('opaque-session-reasoning')).toBeLessThan(nextInput.indexOf('function_call'));
  });
});
