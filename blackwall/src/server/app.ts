import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { effectiveScope } from '../config/effective.ts';
import type { Core } from '../engine/core.ts';
import { handleChat, toSse, type ChatRequest, type GatewayOptions } from '../gateway/chat.ts';
import type { EventRow, SessionRow } from '../store/store.ts';
import { topicMessage } from '../engine/messages.ts';
import { metrics } from './metrics.ts';

export interface AppOptions {
  adminToken: string;
  gateway: GatewayOptions;
  dashboardDir: string;
  logger?: boolean;
}

const bearer = (req: FastifyRequest): string | undefined => {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
};

const ToolBody = z.object({
  request_id: z.string().min(1).max(100),
  tool: z.string().min(1).max(60),
  arguments: z.record(z.string(), z.unknown()),
  tool_call_id: z.string().optional(),
  context: z.object({ cwd: z.string().optional() }).optional(),
});
const InspectBody = z.object({
  kind: z.enum(['user_input', 'model_input', 'model_output', 'tool_arguments', 'tool_output']),
  text: z.string().max(2_000_000),
});
const ResolveBody = z.object({ resolution: z.enum(['approve', 'reject']), idempotency_key: z.string().optional(), cwd: z.string().optional() });
const ExecBody = z.object({
  request_id: z.string(),
  decision_id: z.string().optional(),
  phase: z.enum(['started', 'completed', 'failed']),
  error: z.string().max(500).optional(),
  exit_code: z.number().optional(),
  usage: z.unknown().optional(),
});

export function buildApp(core: Core, opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  const store = core.store;

  // ---- auth helpers
  const sessionAuth = (req: FastifyRequest, reply: FastifyReply): SessionRow | undefined => {
    const t = bearer(req);
    const s = t ? store.getSessionByToken(t) : undefined;
    if (!s) {
      void reply.code(401).header('Cache-Control', 'no-store').send({ error: { code: 'UNAUTHENTICATED', message: 'A valid session token is required.' } });
      return undefined;
    }
    return s;
  };
  const adminAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (bearer(req) !== opts.adminToken) {
      void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Administrator token required.' } });
      return false;
    }
    return true;
  };
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', async () => ({ ok: true, policy_version: core.policy.version, profile: core.policy.profile, mode: core.policy.mode }));

  // ---- sessions
  app.post('/v1/sessions', async (req, reply) => {
    const t = bearer(req);
    const user = t ? core.userForToken(t) : undefined;
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A valid user token is required.' } });
    const { session, token } = core.createSession(user);
    return { session_id: session.id, session_token: token, user, status: session.status, policy_version: core.policy.version, profile: core.policy.profile, workdir: core.policy.users[user]?.workdir ?? null };
  });

  app.get('/v1/session', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const sc = effectiveScope(core.policy, s.user_name);
    // What the session may do, so the agent can stay inside its boundaries instead of discovering them by refusal.
    return {
      ...sessionView(core, s),
      workdir: core.policy.users[s.user_name]?.workdir ?? null,
      allowed: {
        read_roots: sc.files.read_roots ?? [], write_roots: sc.files.write_roots ?? [], writes_to_existing_reports_need_approval_in: sc.files.require_approval_roots,
        http_hosts: sc.network.allow_hosts ?? [], http_methods: sc.network.allowed_methods ?? [], tools: (sc.tools.allow ?? []).filter((t) => !sc.tools.deny.includes(t)),
      },
    };
  });

  // ---- tool decisions
  app.post('/v1/tool-decisions', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const body = ToolBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } });
    const d = await core.decideTool(s, { request_id: body.data.request_id, tool: body.data.tool, arguments: body.data.arguments, tool_call_id: body.data.tool_call_id }, { cwd: body.data.context?.cwd });
    return d;
  });

  app.get('/v1/approvals/:id', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const ap = store.getApproval((req.params as { id: string }).id);
    if (!ap || ap.session_id !== s.id) return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Unknown approval.' } });
    return { id: ap.id, status: ap.status, tool: ap.tool, reason_codes: ap.reason_codes.split(','), expires_at: new Date(ap.expires_at).toISOString(), arguments: JSON.parse(ap.args_json) as unknown };
  });

  app.post('/v1/approvals/:id/resolve', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const body = ResolveBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'resolution must be approve or reject' } });
    const r = await core.resolveApproval(s, (req.params as { id: string }).id, body.data.resolution, body.data.cwd);
    if (!r.ok) return reply.code(409).send({ error: { code: r.code, message: r.message } });
    return r.decision;
  });

  app.post('/v1/content/inspect', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const body = InspectBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } });
    const status = core.store.getSession(s.id)!.status;
    if (status === 'terminated' || status === 'blocked') {
      const reason = status === 'terminated' ? 'SESSION_TERMINATED' : 'SESSION_BLOCKED';
      return { action: 'block', text: '', session_action: status === 'terminated' ? 'terminate' : 'block', session_status: status, reason_codes: [reason], message: topicMessage(reason), topic_ids: [] };
    }
    const r = await core.withSessionLock(s.id, () => core.inspectContent(core.store.getSession(s.id)!, body.data.kind, body.data.text));
    const now = core.store.getSession(s.id)!;
    const sup = r.supervision;
    if (sup.action !== 'pass') {
      const sessionAction = sup.action === 'terminate' ? 'terminate' : sup.action === 'review' ? 'await_user' : 'block';
      const reason = sup.reason_codes[0] ?? 'GUARDIAN_UNAVAILABLE';
      return { action: 'block', text: '', session_action: sessionAction, session_status: now.status, reason_codes: sup.reason_codes, message: topicMessage(sup.action === 'review' ? 'GUARDIAN_UNCERTAIN' : reason), topic_ids: sup.topic_ids };
    }
    return {
      action: r.action,
      text: r.text,
      findings: r.findings.map((f) => f.type),
      session_action: 'continue',
      session_status: now.status,
      reason_codes: r.action === 'allow' ? [] : [r.action === 'block' ? 'SECRET_IN_CONTENT' : 'CONTENT_REDACTED'],
      message: r.action === 'block' ? 'The content contains a secret and is not allowed to be used.' : r.action === 'redact' ? 'Sensitive values were replaced with markers.' : '',
      topic_ids: sup.topic_ids,
      timings_ms: sup.timings_ms,
    };
  });

  app.post('/v1/execution-events', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const body = ExecBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid execution event' } });
    core.recordExecution(s, body.data);
    return { ok: true };
  });

  // ---- model gateway (OpenAI-compatible)
  app.get('/v1/models', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const allow = effectiveScope(core.policy, s.user_name).models.allow_aliases ?? Object.keys(core.policy.model_aliases);
    return { object: 'list', data: allow.map((id) => ({ id, object: 'model', owned_by: 'blackwall' })) };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const s = sessionAuth(req, reply);
    if (!s) return;
    const body = req.body as ChatRequest | undefined;
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages))
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'model and messages are required' } });
    const r = await handleChat(core, s, body, opts.gateway);
    if (r.status === 200 && r.stream) {
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      reply.raw.end(toSse(r.body, !!r.includeUsage));
      return reply;
    }
    return reply.code(r.status).send(r.body);
  });

  // ---- admin
  app.get('/v1/admin/events', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const q = req.query as { session_id?: string; type?: string; since?: string; limit?: string };
    return { events: store.listEvents({ sessionId: q.session_id, type: q.type, sinceId: q.since ? Number(q.since) : undefined, limit: Math.min(Number(q.limit ?? 200), 1000) }).map(eventView) };
  });

  app.get('/v1/admin/sessions', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    return { sessions: store.listSessions(200).map((s) => sessionView(core, s)), pending_approvals: store.pendingApprovals(), open_reviews: store.openTopicReviews() };
  });

  app.get('/v1/admin/sessions/:id', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const s = store.getSession((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown session.' } });
    return { ...sessionView(core, s), events: store.listEvents({ sessionId: s.id, limit: 500 }).reverse().map(eventView) };
  });

  app.get('/v1/admin/sessions/:id/topics', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const id = (req.params as { id: string }).id;
    return { labels: store.labels(id), guardian: store.guardian(id) ?? null };
  });

  app.post('/v1/admin/sessions/:id/revoke', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const s = store.getSession((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown session.' } });
    store.setStatusUnlessTerminated(s.id, 'blocked', 'REVOKED_BY_ADMIN');
    store.invalidateApprovals(s.id);
    store.appendEvent(s.id, 'session.blocked', { by: 'admin' }, { reason_codes: ['REVOKED_BY_ADMIN'], effect: 'deny' });
    return sessionView(core, store.getSession(s.id)!);
  });

  app.post('/v1/admin/sessions/:id/resume', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const s = store.getSession((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown session.' } });
    // `terminated` is final; `reviewing` is resolved through a topic review, not resumed blindly
    if (s.status !== 'blocked') return reply.code(409).send({ error: { code: 'NOT_RESUMABLE', message: `A ${s.status} session cannot be resumed this way.` } });
    store.setStatus(s.id, 'active');
    store.appendEvent(s.id, 'session.resumed', { by: 'admin' });
    return sessionView(core, store.getSession(s.id)!);
  });

  app.post('/v1/admin/topic-reviews/:id/resolve', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const body = z.object({ outcome: z.enum(['no_violation', 'violation']), note: z.string().min(3).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'outcome (no_violation|violation) and a note are required' } });
    const rev = store.getTopicReview((req.params as { id: string }).id);
    if (!rev) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown review.' } });
    const s = store.getSession(rev.session_id)!;
    if (!store.resolveTopicReview(rev.id, body.data.note)) return reply.code(409).send({ error: { code: 'ALREADY_RESOLVED', message: 'Review already resolved.' } });
    // The admin clarifies the facts against the policy; there is no way here to waive a prohibition.
    if (body.data.outcome === 'violation') core.terminate(s, 'ADMIN_CONFIRMED_VIOLATION', { review_id: rev.id, note: body.data.note });
    else {
      store.setStatusUnlessTerminated(s.id, 'active');
      store.appendEvent(s.id, 'session.resumed', { by: 'admin', review_id: rev.id, note: body.data.note });
    }
    return sessionView(core, store.getSession(s.id)!);
  });

  app.get('/v1/admin/metrics', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    return metrics(core);
  });

  app.get('/v1/admin/policies/effective', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const user = (req.query as { user?: string }).user;
    const p = core.policy;
    return {
      policy_id: p.policy_id, version: p.version, mode: p.mode, profile: p.profile, profile_settings: p.profiles[p.profile], profiles: p.profiles,
      feed: { catalog_id: core.feed.catalogId, version: core.feed.version, signatures: core.feed.size },
      embedder: core.detector.embedderName,
      topics: Object.entries(p.topics).map(([id, t]) => ({ id, policy_id: t.policy_id, examples: t.examples.length })),
      users: Object.keys(p.users),
      effective: user ? effectiveScope(p, user) : effectiveScope(p, undefined),
      approvals: p.approvals, denials: p.denials,
    };
  });

  app.get('/v1/admin/export', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    const lines = store.listEvents({ limit: 100000 }).reverse().map((e) => JSON.stringify(eventView(e)));
    return reply.header('Content-Type', 'application/x-ndjson').send(lines.join('\n') + '\n');
  });

  // Server-sent events: new audit rows are pushed as they appear (poll of the audit table, ~1 s).
  app.get('/v1/admin/stream', async (req, reply) => {
    if (!adminAuth(req, reply)) return;
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = Number((req.query as { since?: string }).since ?? store.listEvents({ limit: 1 })[0]?.id ?? 0);
    const tick = () => {
      const rows = store.listEvents({ sinceId: last, limit: 200 }).reverse();
      for (const r of rows) {
        last = Math.max(last, r.id);
        reply.raw.write(`data: ${JSON.stringify(eventView(r))}\n\n`);
      }
      if (!rows.length) reply.raw.write(': keepalive\n\n');
    };
    const timer = setInterval(tick, 1000);
    req.raw.on('close', () => clearInterval(timer));
    return reply;
  });

  // ---- dashboard (static)
  const serveFile = (name: string, type: string) => async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.header('Content-Type', type).send(readFileSync(join(opts.dashboardDir, name)));
    } catch {
      return reply.code(404).send('not found');
    }
  };
  app.get('/', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/dashboard', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/dashboard/app.js', serveFile('app.js', 'text/javascript; charset=utf-8'));
  app.get('/dashboard/styles.css', serveFile('styles.css', 'text/css; charset=utf-8'));

  return app;
}

export function eventView(e: EventRow) {
  return {
    id: e.id, ts: e.ts, session_id: e.session_id, seq: e.seq, type: e.type, tool: e.tool, effect: e.effect,
    reason_codes: e.reason_codes ? e.reason_codes.split(',') : [], request_id: e.request_id, decision_id: e.decision_id, user: e.user_name,
    data: JSON.parse(e.data) as unknown,
  };
}

export function sessionView(core: Core, s: SessionRow) {
  const scope = effectiveScope(core.policy, s.user_name);
  return {
    id: s.id, user: s.user_name, status: s.status, status_reason: s.status_reason, created_at: s.created_at, updated_at: s.updated_at,
    policy_version: s.policy_version,
    budget: {
      tokens_spent: s.tokens_spent, tokens_reserved: s.tokens_reserved, token_limit: scope.budgets.session_total_tokens ?? null,
      tool_attempts: s.tool_attempts, tool_attempt_limit: scope.budgets.session_tool_attempts ?? null,
      model_requests: s.model_requests, model_request_limit: scope.budgets.session_model_requests ?? null,
      cost_usd_micros: s.cost_micros,
    },
    topics: core.store.labels(s.id),
    guardian: core.store.guardian(s.id) ?? null,
  };
}
