import type { Core } from '../engine/core.ts';
import { scanText } from '../engine/secrets.ts';
import { newId, sha256, type SessionRow, type Store } from '../store/store.ts';
import { topicMessage } from '../engine/messages.ts';
import { z } from 'zod';
import { scanValue } from '../engine/secrets.ts';
import { responsesToChat, toResponsesRequest, type ReasoningContext } from './openai.ts';

/**
 * OpenAI-compatible chat completions in front of the real provider. Every request passes: session state,
 * model allowlist, input/tool-result inspection, secret scan of the whole prompt, token reservation. The
 * provider's answer is buffered and inspected before anything is released to the client.
 */

export interface ChatMessage {
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
  openaiKey?: string;
  anthropicKey?: string;
  baseUrl?: string;
  /** Evaluate tool calls proposed by the model inside the gateway (for agents without a Blackwall plugin). */
  evaluateToolCalls?: boolean;
  fetchImpl?: typeof fetch;
}

const MessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() })), z.null()]).optional(),
  tool_calls: z.array(z.object({ id: z.string().min(1), type: z.literal('function'), function: z.object({ name: z.string().min(1), arguments: z.string() }) })).optional(),
  tool_call_id: z.string().min(1).optional(), name: z.string().optional(),
}).superRefine((message, ctx) => {
  if (message.role === 'tool' && !message.tool_call_id) ctx.addIssue({ code: 'custom', message: 'Tool results require tool_call_id' });
  if (message.tool_calls?.length && message.role !== 'assistant') ctx.addIssue({ code: 'custom', message: 'Only assistant messages may call tools' });
});
const ChatSchema = z.object({
  model: z.string().min(1), messages: z.array(MessageSchema).min(1),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1), description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()), strict: z.boolean().nullable().optional() }) })).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) })]).optional(),
  stream: z.boolean().optional(), stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
});
const CompletionSchema = z.object({
  choices: z.array(z.object({ message: MessageSchema, finish_reason: z.string().nullable().optional() })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).passthrough(),
}).passthrough();

// Session ownership survives a policy-core replacement. Separate stores and sessions stay isolated.
const reasoningByStore = new WeakMap<Store, Map<string, ReasoningContext>>();
function reasoningFor(core: Core, sessionId: string): ReasoningContext {
  let sessions = reasoningByStore.get(core.store);
  if (!sessions) { sessions = new Map(); reasoningByStore.set(core.store, sessions); }
  let context = sessions.get(sessionId);
  if (!context) { context = new Map(); sessions.set(sessionId, context); }
  while (sessions.size > 256) sessions.delete(sessions.keys().next().value!);
  return context;
}

const textOf = (c: ChatMessage['content']): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n') : '';

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): GatewayResult => ({
  status,
  body: { error: { message, type: 'blackwall_error', code, ...extra } },
});

export async function handleChat(core: Core, session: SessionRow, req: ChatRequest, opts: GatewayOptions): Promise<GatewayResult> {
  const parsed = ChatSchema.safeParse(req);
  if (!parsed.success) return err(400, 'BAD_REQUEST', parsed.error.issues.map((issue) => issue.message).join('; '));
  return core.withSessionLock(session.id, () => handleChatLocked(core, session.id, parsed.data, opts));
}

async function handleChatLocked(core: Core, sessionId: string, req: ChatRequest, opts: GatewayOptions): Promise<GatewayResult> {
  const t0 = performance.now();
  const store = core.store;
  const policy = core.policy;
  let session = store.getSession(sessionId)!;
  const scope = core.scope(session);
  const audit = (type: string, data: Record<string, unknown>, extra: { reason_codes?: string[]; effect?: string } = {}) =>
    store.appendEvent(session.id, type, { ...data, policy_attribution: core.policyAttribution() }, {
      user_name: session.user_name,
      ...(typeof data.request_id === 'string' ? { request_id: data.request_id } : {}),
      ...extra,
    });

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

  // 3. new user messages and tool results are inspected once (DLP + topic detection + guardian), in order
  let messages: ChatMessage[] = req.messages.map((m) => ({ ...m }));
  let tools = req.tools;
  for (const m of messages) {
    const kind = m.role === 'user' ? 'user_input' : m.role === 'tool' ? 'tool_output' : undefined;
    if (!kind) continue;
    const text = textOf(m.content);
    if (!text || core.hasRecorded(session.id, text)) continue;
    const r = await core.inspectContent(session, kind, text);
    session = store.getSession(session.id)!;
    if (r.supervision.action !== 'pass') {
      audit('model.denied', { reason: r.supervision.reason_codes[0], stage: 'supervision', input_kind: kind }, { reason_codes: r.supervision.reason_codes, effect: 'deny' });
      return supervisionResult(r.supervision.action, r.supervision.reason_codes[0] ?? 'GUARDIAN_UNAVAILABLE', session.status);
    }
    if (r.action === 'block') return err(403, 'SECRET_IN_CONTENT', 'The message contains a secret and was not sent to the model.');
    if (r.action === 'redact') m.content = r.text;
  }

  // 4. whole-prompt secret scan (system prompt, earlier assistant turns, tool definitions): nothing sensitive leaves
  const prof = core.profile();
  const promptScan = scanValue({ messages, tools }, { pii: false });
  if (promptScan.findings.length) {
    if (prof.secrets === 'block') {
      audit('model.denied', { reason: 'SECRET_IN_PROMPT', findings: promptScan.findings.map((f) => f.type) }, { reason_codes: ['SECRET_IN_CONTENT'], effect: 'deny' });
      return err(403, 'SECRET_IN_CONTENT', 'The prompt contains a secret and was not sent to the model.');
    }
    ({ messages, tools } = promptScan.redacted as { messages: ChatMessage[]; tools: unknown[] | undefined });
    // Redacting an assignment can replace its JSON key/value pair. Never send broken function arguments.
    try { for (const message of messages) for (const call of message.tool_calls ?? []) JSON.parse(call.function.arguments); }
    catch { return err(403, 'SECRET_IN_CONTENT', 'Secret-bearing function arguments could not be safely redacted.'); }
  }

  const key = alias.provider === 'openai' ? opts.openaiKey : opts.anthropicKey;
  if (!key) return err(503, 'PROVIDER_NOT_CONFIGURED', 'The model provider is not configured.');

  // Construct the actual provider input first: replayed reasoning and function definitions consume tokens too.
  const upstream = alias.provider === 'openai' ? toResponsesRequest({ ...req, messages, tools }, alias.model, maxOut, alias.reasoning_effort ?? 'low', reasoningFor(core, session.id)) : {
    model: alias.model,
    messages: messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m)),
    max_tokens: maxOut,
    ...(tools?.length ? { tools } : {}),
    ...(req.tool_choice !== undefined && tools?.length ? { tool_choice: req.tool_choice } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
  };
  const upstreamJson = JSON.stringify(upstream);
  // One UTF-8 byte per token is a conservative upper bound for byte-level tokenization, including Polish/JSON.
  const approxIn = Buffer.byteLength(upstreamJson, 'utf8');
  if (scope.models.max_input_tokens !== undefined && approxIn > scope.models.max_input_tokens) {
    audit('model.denied', { reason: 'INPUT_TOO_LARGE', conservative_input_tokens: approxIn }, { reason_codes: ['INPUT_TOO_LARGE'], effect: 'deny' });
    return err(413, 'INPUT_TOO_LARGE', 'The prompt exceeds the conservative input limit allowed by the policy.');
  }

  // 5. Reserve all input plus full output before the model can run.
  const requestId = newId('mreq');
  const reserve = approxIn + maxOut;
  const price = alias.input_usd_micros_per_mtok !== undefined && alias.output_usd_micros_per_mtok !== undefined;
  if (scope.budgets.session_cost_usd_micros !== undefined && !price) {
    audit('budget.denied', { reason: 'COST_UNPRICED', alias: req.model }, { reason_codes: ['COST_UNPRICED'], effect: 'deny' });
    store.setStatusUnlessTerminated(session.id, 'blocked', 'COST_UNPRICED');
    return err(429, 'COST_UNPRICED', 'A financial budget requires configured input and output prices for this model.');
  }
  const reservedCost = price ? Math.ceil((approxIn * alias.input_usd_micros_per_mtok! + maxOut * alias.output_usd_micros_per_mtok!) / 1_000_000) : 0;
  const res = store.reserveTokens(session.id, requestId, reserve, scope.budgets, true, reservedCost);
  if (!res.ok) {
    audit('budget.denied', { reserve, message: res.message }, { reason_codes: [res.code], effect: 'deny' });
    store.setStatusUnlessTerminated(session.id, 'blocked', 'BUDGET_EXCEEDED');
    return err(429, res.code, res.message, { session_status: 'blocked' });
  }
  audit('budget.reserved', { request_id: requestId, tokens: reserve, cost_usd_micros: price ? reservedCost : 'unpriced' });

  // 6. Forward to the provider (the key stays here; clients never see it).
  const f = opts.fetchImpl ?? fetch;
  const tUp = performance.now();
  let resp: Response;
  try {
    resp = await f(opts.baseUrl ?? (alias.provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: upstreamJson,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    // The provider may have processed the request: keep the reservation as spent until reconciled.
    store.settleUnknown(requestId);
    audit('model.failed', { request_id: requestId, error: scanText((e as Error).message).redacted });
    return err(502, 'PROVIDER_UNREACHABLE', 'The model provider could not be reached.');
  }
  const upMs = Math.round(performance.now() - tUp);
  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 300);
    store.settleUnknown(requestId);
    audit('model.failed', { request_id: requestId, status: resp.status, body: scanText(txt).redacted });
    return err(502, 'PROVIDER_ERROR', `The model provider returned HTTP ${resp.status}.`);
  }
  let out: {
    choices?: { message?: ChatMessage; finish_reason?: string | null }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    [k: string]: unknown;
  };
  try {
    const body: unknown = await resp.json();
    out = CompletionSchema.parse(alias.provider === 'openai' ? responsesToChat(body, alias.model, reasoningFor(core, session.id)) : body);
  } catch {
    store.settleUnknown(requestId);
    audit('model.failed', { request_id: requestId, error: 'invalid provider response' });
    return err(502, 'PROVIDER_INVALID_RESPONSE', 'The model provider returned an invalid or incomplete response.');
  }
  const used = (out.usage?.prompt_tokens ?? 0) + (out.usage?.completion_tokens ?? 0);
  const cost = price
    ? Math.ceil(((out.usage?.prompt_tokens ?? 0) * alias.input_usd_micros_per_mtok! + (out.usage?.completion_tokens ?? 0) * alias.output_usd_micros_per_mtok!) / 1_000_000)
    : 0;
  store.settleTokens(requestId, used || reserve, cost);
  audit('model.completed', { request_id: requestId, alias: req.model, provider_model: alias.model, usage: out.usage, cost_usd_micros: price ? cost : 'unpriced', provider_ms: upMs });

  // 7. the buffered answer is inspected before release
  const inspectionSeqs: number[] = [];
  let generatedRefusal = false;
  const msg = out.choices?.[0]?.message;
  const text = msg?.content ? textOf(msg.content) : '';
  if (text) {
    const r = await core.inspectContent(session, 'model_output', text);
    if (r.supervision.seq !== null) inspectionSeqs.push(r.supervision.seq);
    session = store.getSession(session.id)!;
    if (r.supervision.action !== 'pass') return supervisionResult(r.supervision.action, r.supervision.reason_codes[0] ?? 'GUARDIAN_UNAVAILABLE', session.status);
    if (r.action === 'block') return err(403, 'SECRET_IN_CONTENT', 'The answer contained a secret and was withheld.');
    else if (r.action === 'redact' && msg) msg.content = r.text;
  }

  if (msg?.tool_calls?.length) {
    // Tool arguments are part of the model output and may contain a secret or a forbidden instruction.
    const scan = scanValue(msg.tool_calls, { pii: false });
    if (scan.findings.length) {
      if (prof.secrets === 'block') return err(403, 'SECRET_IN_CONTENT', 'The model proposed secret-bearing tool arguments; the answer was withheld.');
      msg.tool_calls = scan.redacted as ChatMessage['tool_calls'];
    }
    for (const call of msg.tool_calls ?? []) {
      try {
        const args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments');
      } catch { return err(502, 'PROVIDER_INVALID_RESPONSE', 'The model proposed invalid function arguments.'); }
      const reviewed = await core.inspectContent(session, 'model_output', call.function.arguments);
      if (reviewed.supervision.seq !== null) inspectionSeqs.push(reviewed.supervision.seq);
      session = store.getSession(session.id)!;
      if (reviewed.supervision.action !== 'pass') return supervisionResult(reviewed.supervision.action, reviewed.supervision.reason_codes[0] ?? 'GUARDIAN_UNAVAILABLE', session.status);
      if (reviewed.action === 'block') return err(403, 'SECRET_IN_CONTENT', 'The tool arguments were withheld by content inspection.');
      if (reviewed.action === 'redact') {
        try {
          const redactedArgs = JSON.parse(reviewed.text);
          if (!redactedArgs || typeof redactedArgs !== 'object' || Array.isArray(redactedArgs)) throw new Error('invalid arguments');
        } catch { return err(502, 'PROVIDER_INVALID_RESPONSE', 'Redacted function arguments are invalid; the answer was withheld.'); }
        call.function.arguments = reviewed.text;
      }
    }
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
        generatedRefusal = true;
        break;
      }
    }
  }

  out.model = req.model; // clients see the alias they asked for
  const releasedMessage = (out.choices as { message?: ChatMessage }[] | undefined)?.[0]?.message;
  const auditText = (value: string, maxChars: number) => {
    const redacted = scanText(value, { pii: true }).redacted;
    return { value: redacted.slice(0, maxChars), truncated: redacted.length > maxChars };
  };
  const releasedContent = auditText(textOf(releasedMessage?.content), 8_000);
  const releasedCalls = (releasedMessage?.tool_calls ?? []).slice(0, 8).map((call) => {
    const id = auditText(call.id, 128);
    const name = auditText(call.function.name, 128);
    const args = auditText(call.function.arguments, 2_000);
    return { id: id.value, name: name.value, arguments: args.value, truncated: id.truncated || name.truncated || args.truncated };
  });
  audit('model.message_released', {
    request_id: requestId,
    role: 'assistant',
    content: releasedContent.value,
    content_truncated: releasedContent.truncated,
    tool_calls: releasedCalls,
    tool_calls_truncated: (releasedMessage?.tool_calls?.length ?? 0) > releasedCalls.length,
    inspection_event_seqs: inspectionSeqs,
    origin: generatedRefusal ? 'blackwall_refusal' : 'model',
  });
  audit('model.released', { request_id: requestId, total_ms: Math.round(performance.now() - t0), provider_ms: upMs });
  return { status: 200, body: out, stream: !!req.stream, includeUsage: !!req.stream_options?.include_usage };
}

function supervisionResult(action: 'terminate' | 'review' | 'block' | 'pass', reason: string, status: string): GatewayResult {
  const code = action === 'terminate' ? 'SESSION_TERMINATED' : action === 'review' ? 'SESSION_REVIEWING' : reason;
  const http = action === 'block' && reason.startsWith('BUDGET_') ? 429 : action === 'terminate' ? 403 : action === 'review' ? 409 : 403;
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
