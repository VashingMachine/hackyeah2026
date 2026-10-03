import type { Core } from '../engine/core.ts';
import { scanText } from '../engine/secrets.ts';
import { newId, sha256, type SessionRow } from '../store/store.ts';
import { topicMessage } from '../engine/messages.ts';

/**
 * OpenAI-compatible chat completions in front of the real provider. Every request passes: session state,
 * model allowlist, input/tool-result inspection, secret scan of the whole prompt, token reservation. The
 * provider's answer is buffered and inspected before anything is released to the client.
 */

interface ChatMessage {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: unknown;
  [k: string]: unknown;
}

export interface GatewayResult {
  status: number;
  body: Record<string, unknown>;
  /** When the client asked for streaming and the call succeeded, the body is delivered as synthetic SSE chunks. */
  stream?: boolean;
  includeUsage?: boolean;
}

export interface GatewayOptions {
  anthropicKey: string;
  baseUrl?: string;
  /** Evaluate tool calls proposed by the model inside the gateway (for agents without a Blackwall plugin). */
  evaluateToolCalls?: boolean;
  fetchImpl?: typeof fetch;
}

const textOf = (c: ChatMessage['content']): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n') : '';

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): GatewayResult => ({
  status,
  body: { error: { message, type: 'blackwall_error', code, ...extra } },
});

export async function handleChat(core: Core, session: SessionRow, req: ChatRequest, opts: GatewayOptions): Promise<GatewayResult> {
  return core.withSessionLock(session.id, () => handleChatLocked(core, session.id, req, opts));
}

async function handleChatLocked(core: Core, sessionId: string, req: ChatRequest, opts: GatewayOptions): Promise<GatewayResult> {
  const t0 = performance.now();
  const store = core.store;
  const policy = core.policy;
  let session = store.getSession(sessionId)!;
  const scope = core.scope(session);
  const audit = (type: string, data: Record<string, unknown>, extra: { reason_codes?: string[]; effect?: string } = {}) =>
    store.appendEvent(session.id, type, data, { user_name: session.user_name, ...extra });

  // 1. session state
  const blocked: Record<string, [number, string]> = {
    terminated: [403, 'SESSION_TERMINATED'], blocked: [403, 'SESSION_BLOCKED'], reviewing: [409, 'SESSION_REVIEWING'], awaiting_approval: [409, 'AWAITING_APPROVAL'],
  };
  const b = blocked[session.status];
  if (b) {
    audit('model.denied', { reason: b[1], stage: 'state' }, { reason_codes: [b[1]], effect: 'deny' });
    return err(b[0], b[1], topicMessage(b[1]), { session_status: session.status });
  }

  // 2. model allowlist (by alias) and size limits
  const alias = policy.model_aliases[req.model];
  if (!alias || (scope.models.allow_aliases && !scope.models.allow_aliases.includes(req.model))) {
    audit('model.denied', { reason: 'MODEL_NOT_ALLOWED', requested: String(req.model).slice(0, 80) }, { reason_codes: ['MODEL_NOT_ALLOWED'], effect: 'deny' });
    return err(403, 'MODEL_NOT_ALLOWED', 'This model is not on the allowlist for this session.');
  }
  const maxOut = Math.min(req.max_completion_tokens ?? req.max_tokens ?? scope.models.max_output_tokens ?? 1024, scope.models.max_output_tokens ?? Infinity);
  const approxIn = Math.ceil((JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length) / 4);
  if (scope.models.max_input_tokens !== undefined && approxIn > scope.models.max_input_tokens) {
    audit('model.denied', { reason: 'INPUT_TOO_LARGE', approx_input_tokens: approxIn }, { reason_codes: ['INPUT_TOO_LARGE'], effect: 'deny' });
    return err(413, 'INPUT_TOO_LARGE', 'The prompt is larger than the policy allows.');
  }

  // 3. new user messages and tool results are inspected once (DLP + topic detection + guardian), in order
  const messages: ChatMessage[] = req.messages.map((m) => ({ ...m }));
  for (const m of messages) {
    const kind = m.role === 'user' ? 'user_input' : m.role === 'tool' ? 'tool_output' : undefined;
    if (!kind) continue;
    const text = textOf(m.content);
    if (!text || core.hasRecorded(session.id, text)) continue;
    const r = await core.inspectContent(session, kind, text);
    session = store.getSession(session.id)!;
    if (r.supervision.action !== 'pass') return supervisionResult(r.supervision.action, r.supervision.reason_codes[0] ?? 'GUARDIAN_UNAVAILABLE', session.status);
    if (r.action === 'block') return err(403, 'SECRET_IN_CONTENT', 'The message contains a secret and was not sent to the model.');
    if (r.action === 'redact') m.content = r.text;
  }

  // 4. whole-prompt secret scan (system prompt, earlier assistant turns, tool definitions): nothing sensitive leaves
  const prof = core.profile();
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text) continue;
    const s = scanText(text, { pii: false });
    if (!s.findings.length) continue;
    if (prof.secrets === 'block') {
      audit('model.denied', { reason: 'SECRET_IN_PROMPT', findings: s.findings.map((f) => f.type) }, { reason_codes: ['SECRET_IN_CONTENT'], effect: 'deny' });
      return err(403, 'SECRET_IN_CONTENT', 'The prompt contains a secret and was not sent to the model.');
    }
    m.content = s.redacted;
  }

  // 5. budget reservation (conservative: all input plus the full allowed output)
  const requestId = newId('mreq');
  const reserve = approxIn + maxOut;
  const res = store.reserveTokens(session.id, requestId, reserve, scope.budgets);
  if (!res.ok) {
    audit('budget.denied', { reserve, message: res.message }, { reason_codes: [res.code], effect: 'deny' });
    store.setStatusUnlessTerminated(session.id, 'blocked', 'BUDGET_EXCEEDED');
    return err(429, res.code, res.message, { session_status: 'blocked' });
  }
  audit('budget.reserved', { request_id: requestId, tokens: reserve });

  // 6. forward to the provider (the key stays here; clients never see it)
  const upstream = {
    model: alias.model,
    messages: messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m)),
    max_tokens: maxOut,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...(req.tool_choice !== undefined && req.tools?.length ? { tool_choice: req.tool_choice } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
  };
  const f = opts.fetchImpl ?? fetch;
  const tUp = performance.now();
  let resp: Response;
  try {
    resp = await f(opts.baseUrl ?? 'https://api.anthropic.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.anthropicKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(upstream),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    // The provider may have processed the request: keep the reservation as spent until reconciled.
    store.settleUnknown(requestId);
    audit('model.failed', { request_id: requestId, error: (e as Error).message });
    return err(502, 'PROVIDER_UNREACHABLE', 'The model provider could not be reached.');
  }
  const upMs = Math.round(performance.now() - tUp);
  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 300);
    store.settleUnknown(requestId);
    audit('model.failed', { request_id: requestId, status: resp.status, body: scanText(txt).redacted });
    return err(502, 'PROVIDER_ERROR', `The model provider returned HTTP ${resp.status}.`);
  }
  const out = (await resp.json()) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    [k: string]: unknown;
  };
  const used = (out.usage?.prompt_tokens ?? 0) + (out.usage?.completion_tokens ?? 0);
  const price = alias.input_usd_micros_per_mtok !== undefined && alias.output_usd_micros_per_mtok !== undefined;
  const cost = price
    ? Math.ceil(((out.usage?.prompt_tokens ?? 0) * alias.input_usd_micros_per_mtok! + (out.usage?.completion_tokens ?? 0) * alias.output_usd_micros_per_mtok!) / 1_000_000)
    : 0;
  store.settleTokens(requestId, used || reserve, cost);
  audit('model.completed', { request_id: requestId, alias: req.model, provider_model: alias.model, usage: out.usage, cost_usd_micros: price ? cost : 'unpriced', provider_ms: upMs });

  // 7. the buffered answer is inspected before release
  const msg = out.choices?.[0]?.message;
  const text = msg?.content ? textOf(msg.content) : '';
  if (text) {
    const r = await core.inspectContent(session, 'model_output', text);
    session = store.getSession(session.id)!;
    if (r.supervision.action !== 'pass') return supervisionResult(r.supervision.action, r.supervision.reason_codes[0] ?? 'GUARDIAN_UNAVAILABLE', session.status);
    if (r.action === 'block' && msg) msg.content = '[Blackwall] The answer contained a secret and was withheld.';
    else if (r.action === 'redact' && msg) msg.content = r.text;
  }

  // 8. optional: judge proposed tool calls here, for agents that have no Blackwall plugin
  if (opts.evaluateToolCalls && msg?.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const d = await core.decideToolUnlocked(session.id, { request_id: newId('gw'), tool: tc.function.name, arguments: args, tool_call_id: tc.id }, {});
      if (d.effect !== 'allow') {
        const refusal = `[Blackwall] ${tc.function.name} was not run. ${d.message}`;
        out.choices![0] = { message: { role: 'assistant', content: refusal }, finish_reason: 'stop' };
        break;
      }
    }
  }

  out.model = req.model; // clients see the alias they asked for
  audit('model.released', { request_id: requestId, total_ms: Math.round(performance.now() - t0), provider_ms: upMs });
  return { status: 200, body: out, stream: !!req.stream, includeUsage: !!req.stream_options?.include_usage };
}

function supervisionResult(action: 'terminate' | 'review' | 'block' | 'pass', reason: string, status: string): GatewayResult {
  const code = action === 'terminate' ? 'SESSION_TERMINATED' : action === 'review' ? 'SESSION_REVIEWING' : reason;
  const http = action === 'terminate' ? 403 : action === 'review' ? 409 : 403;
  return err(http, code, topicMessage(action === 'terminate' ? reason : code), { session_status: status, reason_code: reason });
}

/** Turn a buffered completion into OpenAI-style SSE chunks. */
export function toSse(body: Record<string, unknown>, includeUsage: boolean): string {
  const choice = (body.choices as { message?: ChatMessage; finish_reason?: string }[] | undefined)?.[0];
  const id = String(body.id ?? newId('chatcmpl'));
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
  const chunks: unknown[] = [];
  chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  const text = choice?.message ? textOf(choice.message.content) : '';
  if (text) chunks.push({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  (choice?.message?.tool_calls ?? []).forEach((tc, i) => {
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }] });
  if (includeUsage) chunks.push({ ...base, choices: [], usage: body.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

export { sha256 };
