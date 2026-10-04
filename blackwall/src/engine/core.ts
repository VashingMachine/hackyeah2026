import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Policy, Profile } from '../config/schema.ts';
import { effectiveScope, type EffectiveScope } from '../config/effective.ts';
import type { Embedder } from '../topics/detector.ts';
import { chunkText, TopicDetector } from '../topics/detector.ts';
import type { Guardian, GuardianResult } from '../judge/guardian.ts';
import { GuardianError, policiesForTopics } from '../judge/guardian.ts';
import type { Judge, JudgeResult } from '../judge/jev.ts';
import { JudgeError } from '../judge/jev.ts';
import { Store, newId, sha256, type EventExtras, type SessionRow } from '../store/store.ts';
import type { Decision, Effect, PolicyAttribution, SessionAction, SessionStatus, ToolRequest } from '../types.ts';
import { checkFilePath } from './files.ts';
import { checkNetwork, checkResolvedAddresses, isCheck, parseTarget } from './network.ts';
import { ThreatFeed, type FeedMatch } from './feed.ts';
import { scanText, scanValue, type Finding } from './secrets.ts';
import { normalizeInputPath } from '../util/paths.ts';
import { messageFor } from './messages.ts';

export const KNOWN_TOOLS = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'http_request'] as const;
const CONTROLLED_TOOLS = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'http_request'];
const SUPERVISION_KINDS = ['user_input', 'model_output', 'tool_arguments', 'tool_output', 'model_input'];

/** Reasons that no one may override: state, auth, budget and anything the policy marks as a hard stop. */
const HARD = new Set([
  'SESSION_TERMINATED', 'SESSION_BLOCKED', 'SESSION_REVIEWING', 'AWAITING_APPROVAL', 'BUDGET_EXCEEDED', 'SESSION_UNKNOWN',
  'GUARDIAN_UNAVAILABLE', 'JUDGE_UNAVAILABLE', 'EMBEDDING_UNAVAILABLE', 'COST_UNPRICED',
]);

export interface Deps {
  policy: Policy;
  store: Store;
  feed: ThreatFeed;
  judge: Judge;
  guardian: Guardian;
  embedder: Embedder;
  configurationBaseHash?: string;
}

export type SupervisionKind = 'user_input' | 'model_input' | 'model_output' | 'tool_arguments' | 'tool_output';

export interface SupervisionOutcome {
  action: 'pass' | 'terminate' | 'review' | 'block';
  reason_codes: string[];
  topic_ids: string[];
  guardian?: GuardianResult;
  seq: number | null;
  timings_ms: Record<string, number>;
}

interface Step {
  effect: Effect;
  reasons: string[];
  /** The tool call was changed (e.g. redacted) rather than refused. */
  sanitized?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface InspectResult {
  action: 'allow' | 'block' | 'redact';
  text: string;
  findings: Finding[];
}

const nowIso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const stableJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};

export class Core {
  readonly policy: Policy;
  readonly store: Store;
  readonly feed: ThreatFeed;
  private judge: Judge;
  private guardian: Guardian;
  private readonly embedder: Embedder;
  readonly detector: TopicDetector;
  readonly configurationBaseHash: string;
  /** Serialises events of one session so a verdict applies to the event that follows it. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(d: Deps) {
    this.policy = d.policy;
    this.store = d.store;
    this.feed = d.feed;
    this.judge = d.judge;
    this.guardian = d.guardian;
    this.embedder = d.embedder;
    this.configurationBaseHash = d.configurationBaseHash ?? sha256(JSON.stringify(d.policy));
    this.detector = new TopicDetector(d.policy, d.embedder);
  }

  /** Prepare a complete candidate without mutating the active core or its verdict/cache state. */
  async reconfigure(policy: Policy, feed = this.feed): Promise<Core> {
    const candidate = new Core({ policy, feed, store: this.store, judge: this.judge, guardian: this.guardian, embedder: this.embedder, configurationBaseHash: this.configurationBaseHash });
    await candidate.detector.init();
    return candidate;
  }

  profile(): Profile {
    return this.policy.profiles[this.policy.profile]!;
  }

  policyAttribution(): PolicyAttribution {
    return { source: 'event_time', policy_id: this.policy.policy_id, policy_version: this.policy.version, profile: this.policy.profile };
  }

  private appendEvent(sessionId: string | null, type: string, data: unknown, extras: EventExtras = {}, attribution?: PolicyAttribution | null) {
    const policyAttribution = attribution === undefined ? this.policyAttribution() : attribution;
    const enriched = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), policy_attribution: policyAttribution }
      : data;
    return this.store.appendEvent(sessionId, type, enriched, extras);
  }

  withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(sessionId, next);
    next.finally(() => {
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId);
    }).catch(() => undefined);
    return next;
  }

  // ------------------------------------------------------------------ sessions
  createSession(user: string): { session: SessionRow; token: string } {
    const { session, token } = this.store.createSession(user, this.policy.policy_id, this.policy.version, this.policy.profile);
    const started = this.appendEvent(session.id, 'session.started', { profile: this.policy.profile, mode: this.policy.mode }, { user_name: user });
    // These labels are explicit policy assignments from trusted configuration, not model inference.
    for (const topicId of this.policy.users[user]?.topic_ids ?? []) {
      const topic = this.policy.topics[topicId];
      if (!topic) continue; // Config validation reports this before serving; remain fail-safe if constructed directly.
      this.store.upsertLabel(session.id, topicId, 'confirmed', started.seq ?? 0, 1, topic.policy_id);
      this.appendEvent(session.id, 'topic.assigned', { topic_id: topicId, policy_id: topic.policy_id, source: 'user_config' }, { user_name: user });
    }
    return { session, token };
  }

  userForToken(token: string): string | undefined {
    return Object.entries(this.policy.users).find(([, u]) => u.token === token)?.[0];
  }

  scope(session: SessionRow): EffectiveScope {
    return effectiveScope(this.policy, session.user_name);
  }

  private reserveAuxiliary(session: SessionRow, kind: 'embedding' | 'guardian' | 'judge', tokens: number): { ok: true; id: string; tokens: number } | { ok: false; code: string } {
    const scope = this.scope(session);
    // There is no configured, trustworthy price for the safety-control providers in this MVP.
    if (scope.budgets.session_cost_usd_micros !== undefined) return { ok: false, code: 'COST_UNPRICED' };
    const id = newId(`aux_${kind}`);
    const reserved = this.store.reserveTokens(session.id, id, tokens, scope.budgets, false);
    return reserved.ok ? { ok: true, id, tokens } : { ok: false, code: reserved.code };
  }

  /** What the user asked for, taken only from recorded user input (never from tool output or model text). */
  trustedTask(sessionId: string): string {
    const rows = this.store.sessionHistory(sessionId, ['content.user_input'], 4);
    return rows.map((r) => (JSON.parse(r.data) as { text?: string }).text ?? '').filter(Boolean).join('\n---\n');
  }

  // ------------------------------------------------------------------ supervision of text events
  /**
   * Record one text event and run it through topic detection and, when the session is labelled, the
   * guardian. The caller must hold the event back until this returns `pass`.
   */
  async supervise(session: SessionRow, kind: SupervisionKind, rawText: string): Promise<SupervisionOutcome> {
    const timings: Record<string, number> = {};
    const safeText = scanText(rawText, { pii: this.profile().pii !== 'off' }).redacted;
    const redacted = safeText;
    const rec = this.appendEvent(session.id, `content.${kind}`, { kind, text: clip(redacted, 4000), chars: rawText.length, sha: sha256(rawText).slice(0, 16), policy_version: this.policy.version, configuration_base: this.configurationBaseHash }, { user_name: session.user_name });
    const seq = rec.seq;
    // The event is "cleared" only when supervision actually let it through. A failed, uncertain or refused review leaves it
    // uncleared, so a resend after an admin resumes the session is inspected again instead of being skipped as already seen.
    const out = (o: Omit<SupervisionOutcome, 'seq' | 'timings_ms'>): SupervisionOutcome => {
      if (o.action === 'pass') this.store.markEventCleared(rec.id);
      return { ...o, seq, timings_ms: timings };
    };
    const ts = this.policy.topic_supervision;
    if (!ts.enabled || seq === null) return out({ action: 'pass', reason_codes: [], topic_ids: [] });

    // 1. detect
    let matches;
    const t0 = performance.now();
    const embeddingBytes = chunkText(safeText, ts.chunk_chars, ts.overlap_chars)
      .reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk, 'utf8'), 0);
    const embedReservation = this.reserveAuxiliary(session, 'embedding', Math.max(1, embeddingBytes));
    if (!embedReservation.ok) {
      this.appendEvent(session.id, 'budget.denied', { control: 'topic_embedding', reason: embedReservation.code }, { user_name: session.user_name, effect: 'deny', reason_codes: [embedReservation.code] });
      this.store.setStatusUnlessTerminated(session.id, 'blocked', embedReservation.code);
      return out({ action: 'block', reason_codes: [embedReservation.code], topic_ids: [] });
    }
    try {
      matches = await this.detector.detect(safeText);
      this.store.settleTokens(embedReservation.id, embedReservation.tokens, 0);
    } catch (e) {
      this.store.settleUnknown(embedReservation.id);
      this.appendEvent(session.id, 'topic.detection_failed', { error: (e as Error).message }, { user_name: session.user_name });
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'EMBEDDING_UNAVAILABLE');
      return out({ action: 'block', reason_codes: ['EMBEDDING_UNAVAILABLE'], topic_ids: [] });
    }
    timings.detect = Math.round(performance.now() - t0);
    this.appendEvent(session.id, 'topic.checked', { input_kind: kind, embedder: this.detector.embedderName, event_seq: seq, latency_ms: timings.detect, estimated_tokens: embedReservation.tokens }, { user_name: session.user_name });
    const before = new Map(this.store.labels(session.id).map((l) => [l.topic_id, l.state]));
    for (const m of matches) {
      this.store.upsertLabel(session.id, m.topic_id, 'candidate', seq, m.score, m.policy_id);
      if (!before.has(m.topic_id) || before.get(m.topic_id) === 'dismissed')
        this.appendEvent(session.id, 'topic.candidate_detected', { topic_id: m.topic_id, score: Number(m.score.toFixed(3)), embedder: this.detector.embedderName, event_seq: seq }, { user_name: session.user_name });
    }
    const labels = this.store.labels(session.id);
    const active = labels.filter((l) => l.state === 'candidate' || l.state === 'confirmed');
    if (active.length === 0) return out({ action: 'pass', reason_codes: [], topic_ids: [] });

    // 2. guardian: one per session, created atomically on the first match
    const topicIds = active.map((l) => l.topic_id);
    if (this.store.ensureGuardian(session.id))
      this.appendEvent(session.id, 'guardian.started', { topics: topicIds, model_alias: ts.guardian_model_alias }, { user_name: session.user_name });
    const history = this.store
      .sessionHistory(session.id, SUPERVISION_KINDS.map((k) => `content.${k}`), ts.max_history_events + 1)
      .filter((r) => r.seq !== seq)
      .map((r) => ({ kind: r.type.replace('content.', ''), text: (JSON.parse(r.data) as { text: string }).text, seq: r.seq ?? 0 }));
    const candidates = active.filter((l) => l.state === 'candidate').map((l) => l.topic_id);
    const t1 = performance.now();
    const guardianPayload = {
      trusted_policies: policiesForTopics(this.policy, topicIds),
      trusted_session_context: this.sessionContext(session),
      untrusted_history: history.map((event) => ({ ...event, text: clip(event.text, 1500) })),
      untrusted_event: { kind, text: safeText, seq },
      candidate_topics: candidates,
    };
    // Reserve for the exact variable JSON payload, fixed system/schema prompt and maximum response.
    const guardianEstimate = Buffer.byteLength(JSON.stringify(guardianPayload), 'utf8') + 8192 + 2000;
    const guardianReservation = this.reserveAuxiliary(session, 'guardian', guardianEstimate);
    if (!guardianReservation.ok) {
      this.appendEvent(session.id, 'budget.denied', { control: 'topic_guardian', reason: guardianReservation.code }, { user_name: session.user_name, effect: 'deny', reason_codes: [guardianReservation.code] });
      this.store.setStatusUnlessTerminated(session.id, 'blocked', guardianReservation.code);
      return out({ action: 'block', reason_codes: [guardianReservation.code], topic_ids: topicIds });
    }
    let g: GuardianResult;
    try {
      g = await this.guardian.review({
        policies: guardianPayload.trusted_policies,
        history,
        event: { kind, text: safeText, seq },
        candidateTopics: candidates,
        sessionContext: guardianPayload.trusted_session_context,
      });
    } catch (e) {
      this.store.settleUnknown(guardianReservation.id);
      timings.guardian = Math.round(performance.now() - t1);
      const msg = e instanceof GuardianError ? e.message : (e as Error).message;
      this.appendEvent(session.id, 'guardian.unavailable', { error: msg, event_seq: seq }, { user_name: session.user_name });
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'GUARDIAN_UNAVAILABLE');
      return out({ action: 'block', reason_codes: ['GUARDIAN_UNAVAILABLE'], topic_ids: topicIds });
    }
    timings.guardian = Math.round(performance.now() - t1);
    const guardianUsage = (g.usage?.input_tokens ?? 0) + (g.usage?.output_tokens ?? 0);
    this.store.settleTokens(guardianReservation.id, guardianUsage || guardianReservation.tokens, 0);
    this.store.setGuardianReviewed(session.id, seq);
    for (const t of g.topics_confirmed) this.store.setLabelState(session.id, t, 'confirmed');
    for (const t of g.topics_dismissed) {
      this.store.setLabelState(session.id, t, 'dismissed');
      this.appendEvent(session.id, 'topic.dismissed', { topic_id: t, event_seq: seq }, { user_name: session.user_name });
    }
    for (const t of g.topics_confirmed) this.appendEvent(session.id, 'topic.confirmed', { topic_id: t, event_seq: seq }, { user_name: session.user_name });
    this.appendEvent(session.id, 'guardian.reviewed', {
      verdict: g.verdict, policy_id: g.policy_id, reason_code: g.reason_code, evidence: g.evidence, reviewed_seq: g.reviewed_seq, event_kind: kind,
      model: g.model, usage: g.usage, latency_ms: g.latency_ms,
    }, { user_name: session.user_name, reason_codes: g.reason_code ? [g.reason_code] : [] });

    if (g.verdict === 'violation') {
      const reason = g.reason_code ?? 'TOPIC_POLICY_VIOLATION';
      this.terminate(session, reason, { policy_id: g.policy_id, evidence: g.evidence, event_seq: seq, topic_ids: topicIds });
      return out({ action: 'terminate', reason_codes: [reason], topic_ids: topicIds, guardian: g });
    }
    if (g.verdict === 'uncertain') {
      this.store.setStatusUnlessTerminated(session.id, 'reviewing', 'GUARDIAN_UNCERTAIN');
      const reviewId = this.store.createTopicReview(session.id, seq);
      this.appendEvent(session.id, 'session.reviewing', { review_id: reviewId, event_seq: seq }, { user_name: session.user_name, reason_codes: ['GUARDIAN_UNCERTAIN'] });
      return out({ action: 'review', reason_codes: ['GUARDIAN_UNCERTAIN'], topic_ids: topicIds, guardian: g });
    }
    return out({ action: 'pass', reason_codes: [], topic_ids: topicIds, guardian: g });
  }

  /** Final close: invalidates open approvals; nothing resumes a terminated session. */
  terminate(session: SessionRow, reason: string, data: Record<string, unknown>): void {
    this.store.setStatus(session.id, 'terminated', reason);
    const n = this.store.invalidateApprovals(session.id);
    this.appendEvent(session.id, 'session.terminated', { ...data, invalidated_approvals: n }, { user_name: session.user_name, reason_codes: [reason], effect: 'deny' });
  }

  // ------------------------------------------------------------------ content inspection (DLP + supervision)
  async inspectContent(session: SessionRow, kind: SupervisionKind, text: string): Promise<InspectResult & { supervision: SupervisionOutcome }> {
    const prof = this.profile();
    const scan = scanText(text, { pii: prof.pii !== 'off' });
    const secrets = scan.findings.filter((f) => f.kind === 'secret');
    const pii = scan.findings.filter((f) => f.kind === 'pii');
    let action: InspectResult['action'] = 'allow';
    let outText = text;
    if (secrets.length) {
      if (prof.secrets === 'block') action = 'block';
      else (action = 'redact', (outText = scan.redacted));
    }
    if (pii.length && action !== 'block') {
      if (prof.pii === 'block') action = 'block';
      else if (prof.pii === 'redact') (action = 'redact', (outText = scan.redacted));
    }
    if (scan.findings.length) {
      this.appendEvent(session.id, action === 'block' ? 'content.blocked' : 'content.redacted', { kind, findings: scan.findings.map((f) => ({ type: f.type, fingerprint: f.fingerprint })) }, { user_name: session.user_name, effect: action === 'block' ? 'deny' : 'allow', reason_codes: [action === 'block' ? 'SECRET_IN_CONTENT' : 'CONTENT_REDACTED'] });
    }
    // Topic supervision always looks at the text that would be released after redaction.
    const supervision = await this.supervise(session, kind, action === 'block' ? scan.redacted : outText);
    return { action, text: action === 'block' ? '' : outText, findings: scan.findings, supervision };
  }

  /** Dedupe messages the gateway sees again on every request: only those that were reviewed and passed. */
  hasRecorded(sessionId: string, text: string): boolean {
    const sha = sha256(text).slice(0, 16);
    return this.store.sessionHistory(sessionId, SUPERVISION_KINDS.map((k) => `content.${k}`), 400).some((r) => { const d = JSON.parse(r.data) as { sha: string; cleared?: boolean; policy_version?: number; configuration_base?: string }; return d.sha === sha && d.cleared === true && d.policy_version === this.policy.version && d.configuration_base === this.configurationBaseHash; });
  }

  // ------------------------------------------------------------------ tool decisions
  async decideTool(sessionIn: SessionRow, req: ToolRequest, opts: { cwd?: string; approvedReasons?: string[]; skipAttempt?: boolean } = {}): Promise<Decision> {
    return this.withSessionLock(sessionIn.id, () => this.decideToolUnlocked(sessionIn.id, req, opts));
  }

  async decideToolUnlocked(sessionId: string, req: ToolRequest, opts: { cwd?: string; approvedReasons?: string[]; skipAttempt?: boolean }): Promise<Decision> {
    const timings: Record<string, number> = {};
    const t0 = performance.now();
    const session = this.store.getSession(sessionId)!;
    const finish = (step: Step, extra: Partial<Decision> = {}): Decision => this.finalize(session, req, step, timings, extra, t0, { cwd: opts.cwd });

    // 1. session state: a closed or paused session accepts nothing
    const stateStep = this.stateGate(session);
    if (stateStep) return finish(stateStep);

    // 2. attempts and wall-time budget (blocked attempts count too, but an approval's re-check does not)
    const scope = this.scope(session);
    if (!opts.skipAttempt) {
      const c = this.store.countToolAttempt(session.id, scope.budgets.session_tool_attempts);
      if (!c.ok) return finish({ effect: 'deny', reasons: ['BUDGET_EXCEEDED'], details: { budget: 'session_tool_attempts' } });
    }
    if (scope.budgets.session_wall_seconds !== undefined && Date.now() - session.created_at > scope.budgets.session_wall_seconds * 1000)
      return finish({ effect: 'deny', reasons: ['BUDGET_EXCEEDED'], details: { budget: 'session_wall_seconds' } });

    // 3. tool allowed at all?
    if (!(KNOWN_TOOLS as readonly string[]).includes(req.tool)) return finish({ effect: 'deny', reasons: ['TOOL_UNKNOWN'] });
    if (scope.tools.deny.includes(req.tool) || (scope.tools.allow && !scope.tools.allow.includes(req.tool)))
      return finish({ effect: 'deny', reasons: ['TOOL_NOT_ALLOWED'] });

    // 4. deterministic checks specific to the tool
    const t1 = performance.now();
    const det = await this.deterministic(req, scope, opts.cwd ?? process.cwd());
    timings.deterministic = Math.round(performance.now() - t1);
    if (det.effect === 'deny') return finish(det);

    // 5. secrets in arguments and threat feed
    const prof = this.profile();
    const argText = canonicalArgs(req);
    const scan = scanValue(req.arguments, { pii: prof.pii !== 'off' });
    const secrets = scan.findings.filter((f) => f.kind === 'secret');
    const pii = scan.findings.filter((f) => f.kind === 'pii');
    let sanitized: Record<string, unknown> | undefined;
    if (secrets.length && prof.secrets === 'block') return finish({ effect: 'deny', reasons: ['SECRET_IN_CONTENT'], details: { findings: scan.findings.map((f) => f.type) } });
    if (pii.length && prof.pii === 'block') return finish({ effect: 'deny', reasons: ['PII_IN_CONTENT'], details: { findings: pii.map((f) => f.type) } });
    if ((secrets.length && prof.secrets === 'redact') || (pii.length && prof.pii === 'redact')) sanitized = scan.redacted as Record<string, unknown>;

    const safeReq = sanitized ? { ...req, arguments: sanitized } : req;
    const safeArgText = canonicalArgs(safeReq);
    const matches = this.feed.match(req.tool, argText);
    if (matches.length) return finish({ effect: 'deny', reasons: ['THREAT_FEED_MATCH'], details: { feed: matches, feed_version: this.feed.version } });

    // 6. topic supervision of what the tool is about to do (arguments are session traffic too)
    const sup = await this.supervise(session, 'tool_arguments', `${req.tool}: ${safeArgText}`);
    Object.assign(timings, prefixKeys('supervision_', sup.timings_ms));
    if (sup.action !== 'pass') return finish(this.supervisionStep(sup), { topic_ids: sup.topic_ids });

    // 7. semantic judge, as selected by the strictness profile
    let reasons = [...det.reasons];
    let judgeDetails: JudgeResult | undefined;
    if (this.needsJudge(req, prof)) {
      const t2 = performance.now();
      const judgeInput = {
        trustedTask: this.trustedTask(session.id),
        action: describeAction(safeReq),
        controlledTools: CONTROLLED_TOOLS,
        isShell: req.tool === 'bash',
        verified: this.verifiedFacts(req),
        policyContext: this.policyContext(session.id),
      };
      // UTF-8 bytes bound variable context; reserve 8 KiB more for the fixed typed rubric/schema and response.
      const judgeReservation = this.reserveAuxiliary(session, 'judge', Math.max(1, Buffer.byteLength(JSON.stringify(judgeInput), 'utf8') + 8192));
      if (!judgeReservation.ok) {
        this.appendEvent(session.id, 'budget.denied', { control: 'semantic_judge', reason: judgeReservation.code }, { user_name: session.user_name, tool: req.tool, request_id: req.request_id, effect: 'deny', reason_codes: [judgeReservation.code] });
        this.store.setStatusUnlessTerminated(session.id, 'blocked', judgeReservation.code);
        return finish({ effect: 'deny', reasons: [judgeReservation.code] });
      }
      try {
        judgeDetails = await this.judge.evaluate(judgeInput, prof);
      } catch (e) {
        this.store.settleUnknown(judgeReservation.id);
        timings.judge = Math.round(performance.now() - t2);
        return finish({ effect: 'deny', reasons: ['JUDGE_UNAVAILABLE'], details: { error: e instanceof JudgeError ? e.message : 'judge failed' } });
      }
      const judgeUsage = (judgeDetails.usage?.input_tokens ?? 0) + (judgeDetails.usage?.output_tokens ?? 0);
      this.store.settleTokens(judgeReservation.id, judgeUsage || judgeReservation.tokens, 0);
      timings.judge = Math.round(performance.now() - t2);
      this.appendEvent(session.id, 'judge.evaluated', { tool: req.tool, verdict: judgeDetails.verdict, reason_codes: judgeDetails.reason_codes, probabilities: judgeDetails.probabilities, confidence: judgeDetails.confidence, model: judgeDetails.model, usage: judgeDetails.usage, latency_ms: judgeDetails.latency_ms, source: judgeDetails.source }, { user_name: session.user_name, tool: req.tool, request_id: req.request_id });
      if (judgeDetails.verdict === 'deny') return finish({ effect: 'deny', reasons: judgeDetails.reason_codes, details: { judge: summarizeJudge(judgeDetails) } });
      if (judgeDetails.verdict === 'uncertain') reasons.push('SEMANTIC_UNCERTAIN');
    }

    // 8. anything that still needs a human
    if (det.effect === 'require_approval' || reasons.includes('SEMANTIC_UNCERTAIN')) {
      const needed = [...new Set(reasons)];
      const eligible = this.policy.approvals.enabled && needed.every((r) => this.policy.approvals.eligible_reason_codes.includes(r));
      if (!eligible) return finish({ effect: 'deny', reasons: needed, details: { approval: 'not_eligible' } });
      if (needed.every((r) => (opts.approvedReasons ?? []).includes(r))) return finish({ effect: 'allow', reasons: ['USER_APPROVED_OPERATION'], sanitized, details: { approved: needed, judge: judgeDetails ? summarizeJudge(judgeDetails) : undefined } }, this.executionFor(req, scope));
      return finish({ effect: 'require_approval', reasons: needed, sanitized, details: { judge: judgeDetails ? summarizeJudge(judgeDetails) : undefined } });
    }

    return finish({ effect: 'allow', reasons: sanitized ? ['CONTENT_REDACTED'] : ['CHECKS_PASSED'], sanitized, details: judgeDetails ? { judge: summarizeJudge(judgeDetails) } : undefined }, { topic_ids: sup.topic_ids, ...this.executionFor(req, scope) });
  }

  /** Trusted assignment of this session, from policy (never from messages), for the guardian and the judge. */
  private sessionContext(session: SessionRow): string[] {
    const sc = this.scope(session);
    const u = this.policy.users[session.user_name];
    const list = (a: string[] | undefined) => (a && a.length ? a.join(', ') : '(none)');
    return [
      `User role: ${u?.description ?? session.user_name}.`,
      `Permitted read locations: ${list(sc.files.read_roots)}. Permitted write locations: ${list(sc.files.write_roots)}.`,
      `Network allowlist (a technical limit only): ${list(sc.network.allow_hosts)}. Being on the allowlist does NOT mean the user authorised sending anything there: whether to send or publish is decided by what the user asked for.`,
      'Reading documents inside the permitted read locations is the user\'s assignment. Anything outside them is refused by deterministic rules before it reaches you.',
    ];
  }

  /** Facts the deterministic layer has already established for this exact call. */
  private verifiedFacts(req: ToolRequest): string[] {
    const v = ['The tool, its arguments and any file path were checked against the permitted locations, file types and size limits and passed.', 'No secrets were found in the arguments.'];
    if (req.tool === 'write' || req.tool === 'edit') v.push('The target is a local file inside a directory this user is permitted to write; nothing is sent anywhere.');
    if (req.tool === 'http_request') v.push('The host, method, port and endpoint are on the network allowlist.');
    return v;
  }

  /** Policy text for the topics active on this session; it tells the judge what the organisation forbids and allows. */
  private policyContext(sessionId: string): string[] {
    const out: string[] = [];
    for (const l of this.store.labels(sessionId)) {
      if (l.state === 'dismissed') continue;
      const tp = this.policy.topic_policies[l.policy_id];
      if (tp) out.push(`${l.policy_id} — forbidden: ${tp.forbidden} Allowed: ${tp.allowed}`);
    }
    return out;
  }

  private executionFor(req: ToolRequest, scope: EffectiveScope): Partial<Decision> {
    if (['grep', 'find', 'ls'].includes(req.tool)) return { execution: { file_scope: scope.files, timeout_seconds: scope.budgets.tool_timeout_seconds ?? 30 } };
    if (req.tool === 'bash') return { execution: { shell_timeout_seconds: Math.min(scope.shell.timeout_seconds, scope.budgets.tool_timeout_seconds ?? Infinity) } };
    if (req.tool !== 'http_request') return {};
    const t = parseTarget(String(req.arguments.url ?? ''), String(req.arguments.method ?? 'GET'));
    const fixture = !isCheck(t) && scope.network.fixture_exceptions.includes(`${t.host}:${t.port}`);
    return { execution: { allow_non_public_ips: fixture, follow_redirects: scope.network.follow_redirects, timeout_seconds: scope.budgets.tool_timeout_seconds ?? 30, max_response_bytes: 262144 } };
  }

  private stateGate(s: SessionRow): Step | undefined {
    const map: Partial<Record<SessionStatus, string>> = {
      terminated: 'SESSION_TERMINATED', blocked: 'SESSION_BLOCKED', reviewing: 'SESSION_REVIEWING', awaiting_approval: 'AWAITING_APPROVAL',
    };
    const r = map[s.status];
    return r ? { effect: 'deny', reasons: [r] } : undefined;
  }

  private supervisionStep(sup: SupervisionOutcome): Step {
    return { effect: 'deny', reasons: sup.reason_codes, details: { guardian: sup.guardian ? { verdict: sup.guardian.verdict, policy_id: sup.guardian.policy_id, evidence: sup.guardian.evidence } : undefined } };
  }

  private needsJudge(req: ToolRequest, prof: Profile): boolean {
    if (req.tool === 'bash') return true; // every allowed shell call is reviewed, whatever the profile
    const outbound = req.tool === 'http_request';
    const mutating = req.tool === 'write' || req.tool === 'edit';
    switch (prof.semantic_evaluate) {
      case 'all': return true;
      case 'mutating_and_outbound': return outbound || mutating;
      case 'shell_and_outbound': return outbound;
      default: return false;
    }
  }

  private async deterministic(req: ToolRequest, scope: EffectiveScope, cwd: string): Promise<Step> {
    const a = req.arguments;
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
    const files = scope.files;
    const deny = (code: string, details?: Record<string, unknown>): Step => ({ effect: 'deny', reasons: [code], details });

    switch (req.tool) {
      case 'read':
      case 'ls':
      case 'find':
      case 'grep': {
        const p = str('path') ?? (req.tool === 'read' ? undefined : '.');
        if (!p) return deny('ARGUMENTS_INVALID', { missing: 'path' });
        const abs = normalizeInputPath(p, cwd);
        const r = checkFilePath(abs, req.tool === 'read' ? 'read' : 'list', files);
        if (!r.check.ok) return deny(r.check.code, { path: abs });
        return { effect: 'allow', reasons: [] };
      }
      case 'write':
      case 'edit': {
        const p = str('path');
        if (!p) return deny('ARGUMENTS_INVALID', { missing: 'path' });
        const abs = normalizeInputPath(p, cwd);
        const r = checkFilePath(abs, 'write', files);
        if (!r.check.ok) return deny(r.check.code, { path: abs });
        if (req.tool === 'edit') {
          // edit changes an existing file: the read side of the same path must also be allowed
          const rr = checkFilePath(abs, 'read', files);
          if (!rr.check.ok) return deny(rr.check.code, { path: abs });
        }
        let size: number;
        if (req.tool === 'write') {
          const content = str('content');
          if (content === undefined) return deny('ARGUMENTS_INVALID', { missing: 'content' });
          size = Buffer.byteLength(content);
        } else {
          const edits = Array.isArray(a.edits) ? a.edits : [{ oldText: str('oldText'), newText: str('newText') }];
          if (!edits.length || edits.some(edit => !edit || typeof edit !== 'object' || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string')) return deny('ARGUMENTS_INVALID', { missing: 'edits[].oldText/newText' });
          const current = readFileSync(abs, 'utf8');
          // Pi can match whitespace fuzzily; without an exact match, use an upper bound that removes nothing.
          size = Buffer.byteLength(current) + edits.reduce((total, edit) => total + Buffer.byteLength(edit.newText) - (current.includes(edit.oldText) ? Buffer.byteLength(edit.oldText) : 0), 0);
        }
        if (files.max_bytes !== undefined && size > files.max_bytes) return deny('INPUT_TOO_LARGE', { bytes: size });
        if (r.needsApproval) return { effect: 'require_approval', reasons: ['OVERWRITE_EXISTING_FILE'], details: { path: abs } };
        return { effect: 'allow', reasons: [] };
      }
      case 'bash': {
        if (!scope.shell.enabled) return deny('SHELL_DISABLED');
        const cmd = str('command');
        if (!cmd) return deny('ARGUMENTS_INVALID', { missing: 'command' });
        if (Buffer.byteLength(cmd) > scope.shell.max_command_bytes) return deny('INPUT_TOO_LARGE');
        if (scope.shell.require_isolation && scope.shell.execution_profile !== 'isolated') return deny('ISOLATION_REQUIRED');
        return { effect: 'allow', reasons: [] };
      }
      case 'http_request': {
        const url = str('url');
        if (!url) return deny('ARGUMENTS_INVALID', { missing: 'url' });
        const t = parseTarget(url, str('method'));
        if (isCheck(t)) return deny(t.ok ? 'URL_INVALID' : t.code);
        const c = checkNetwork(t, scope.network);
        if (!c.ok) return deny(c.code, { host: t.host });
        if (scope.network.deny_non_public_ips && !scope.network.fixture_exceptions.includes(`${t.host}:${t.port}`)) {
          const dns = await checkResolvedAddresses(t.host);
          if (!dns.ok) return deny(dns.code, { host: t.host });
        }
        return { effect: 'allow', reasons: [] };
      }
    }
    return deny('TOOL_UNKNOWN');
  }

  // ------------------------------------------------------------------ approvals
  async resolveApproval(session: SessionRow, approvalId: string, resolution: 'approve' | 'reject', cwd?: string): Promise<{ ok: true; decision: Decision } | { ok: false; code: string; message: string }> {
    const ap = this.store.getApproval(approvalId);
    if (!ap || ap.session_id !== session.id) return { ok: false, code: 'APPROVAL_NOT_FOUND', message: 'Unknown approval.' };
    if (ap.status !== 'pending') return { ok: false, code: 'APPROVAL_NOT_PENDING', message: `Approval is already ${ap.status}.` };
    const req: ToolRequest = { request_id: ap.request_id, tool: ap.tool, arguments: JSON.parse(ap.args_json) as Record<string, unknown> };
    if (sha256(`${ap.tool}\n${stableJson(req.arguments)}`) !== ap.args_hash) {
      this.store.transitionApproval(ap.id, 'invalidated');
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'APPROVAL_BINDING_INVALID');
      return { ok: false, code: 'APPROVAL_BINDING_INVALID', message: 'The stored operation no longer matches the approval request.' };
    }
    const fresh = this.store.getSession(session.id)!;
    if (fresh.status !== 'awaiting_approval') {
      this.store.transitionApproval(ap.id, 'invalidated');
      return { ok: false, code: fresh.status === 'terminated' ? 'SESSION_TERMINATED' : 'SESSION_NOT_AWAITING_APPROVAL', message: 'The session is no longer waiting for this approval.' };
    }
    if (Date.now() > ap.expires_at) {
      this.store.transitionApproval(ap.id, 'expired');
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'APPROVAL_EXPIRED');
      this.appendEvent(session.id, 'approval.expired', { approval_id: ap.id }, { user_name: session.user_name, request_id: ap.request_id });
      return { ok: false, code: 'APPROVAL_EXPIRED', message: 'The approval expired; the session is blocked.' };
    }
    if (resolution === 'reject') {
      if (!this.store.transitionApproval(ap.id, 'rejected')) return { ok: false, code: 'APPROVAL_NOT_PENDING', message: 'Approval is no longer pending.' };
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'USER_REJECTED_OPERATION');
      this.appendEvent(session.id, 'approval.rejected', { approval_id: ap.id }, { user_name: session.user_name, request_id: ap.request_id });
      const decision = this.finalize(this.store.getSession(session.id)!, req, { effect: 'deny', reasons: ['USER_REJECTED_OPERATION'] }, {}, {}, performance.now(), { noEvent: true, cwd });
      return { ok: true, decision };
    }
    // Bind relative paths to the exact working directory shown when this approval was requested.
    const approvalCwd = ap.cwd;
    if (!approvalCwd || resolve(cwd ?? process.cwd()) !== approvalCwd) {
      this.store.transitionApproval(ap.id, 'invalidated');
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'APPROVAL_CWD_MISMATCH');
      this.appendEvent(session.id, 'approval.invalidated', { approval_id: ap.id, reason: 'APPROVAL_CWD_MISMATCH' }, { user_name: session.user_name, request_id: ap.request_id, reason_codes: ['APPROVAL_CWD_MISMATCH'], effect: 'deny' });
      return { ok: false, code: 'APPROVAL_CWD_MISMATCH', message: 'The approval must be resolved from the same working directory where the operation was checked.' };
    }
    // Bind approval to the exact pre-existing target content the user saw.
    if ((req.tool === 'write' || req.tool === 'edit') && this.resourceHash(req, approvalCwd) !== ap.resource_hash) {
      this.store.transitionApproval(ap.id, 'invalidated');
      this.store.setStatusUnlessTerminated(session.id, 'blocked', 'APPROVAL_RESOURCE_CHANGED');
      this.appendEvent(session.id, 'approval.invalidated', { approval_id: ap.id, reason: 'APPROVAL_RESOURCE_CHANGED' }, { user_name: session.user_name, request_id: ap.request_id, reason_codes: ['APPROVAL_RESOURCE_CHANGED'], effect: 'deny' });
      return { ok: false, code: 'APPROVAL_RESOURCE_CHANGED', message: 'The target changed after the approval request was shown; the session is blocked.' };
    }
    // Atomic state transition prevents a concurrent revoke from being overwritten by approval.
    if (!this.store.approvePendingApproval(ap.id, session.id)) return { ok: false, code: 'APPROVAL_NOT_PENDING', message: 'Approval is no longer pending or the session is no longer awaiting approval.' };
    this.appendEvent(session.id, 'approval.approved', { approval_id: ap.id }, { user_name: session.user_name, request_id: ap.request_id });
    const decision = await this.withSessionLock(session.id, () =>
      this.decideToolUnlocked(session.id, req, { cwd: approvalCwd, approvedReasons: ap.reason_codes.split(','), skipAttempt: true }),
    );
    return { ok: true, decision };
  }

  /** Consume a short-lived allow grant immediately before the executor starts the exact tool call. */
  async consumeDecision(sessionIn: SessionRow, decisionId: string, requestId: string, tool: string, args: Record<string, unknown>, cwd = process.cwd()): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    return this.withSessionLock(sessionIn.id, async () => {
      const session = this.store.getSession(sessionIn.id);
      const grant = this.store.getExecutionGrant(decisionId);
      if (!session || !grant || grant.session_id !== session.id || grant.request_id !== requestId || grant.tool !== tool || grant.args_hash !== sha256(`${tool}\n${stableJson(args)}`) || grant.policy_version !== this.policy.version || session.policy_version !== this.policy.version) {
        return { ok: false, code: 'EXECUTION_GRANT_MISMATCH', message: 'The execution grant does not match this operation or policy.' };
      }
      if (session.status !== 'active') return { ok: false, code: 'SESSION_NOT_ACTIVE', message: 'The session is no longer active.' };
      if (Date.now() > grant.expires_at) return { ok: false, code: 'EXECUTION_GRANT_EXPIRED', message: 'The execution grant expired; request a new decision.' };
      const req: ToolRequest = { request_id: requestId, tool, arguments: args };
      const scope = this.scope(session);
      const normalizedCwd = resolve(cwd);
      if (grant.cwd !== normalizedCwd) return { ok: false, code: 'EXECUTION_CWD_MISMATCH', message: 'The execution working directory differs from the one checked; request a new decision.' };
      const fresh = await this.deterministic(req, scope, normalizedCwd);
      if (fresh.effect === 'deny') return { ok: false, code: fresh.reasons[0] ?? 'POLICY_CHANGED', message: 'The operation no longer passes deterministic policy checks.' };
      if (this.resourceHash(req, normalizedCwd) !== grant.resource_hash) {
        this.store.setStatusUnlessTerminated(session.id, 'blocked', 'RESOURCE_CHANGED');
        this.appendEvent(session.id, 'execution.claim_denied', { decision_id: decisionId, reason: 'RESOURCE_CHANGED' }, { user_name: session.user_name, request_id: requestId, decision_id: decisionId, tool, reason_codes: ['RESOURCE_CHANGED'], effect: 'deny' });
        return { ok: false, code: 'RESOURCE_CHANGED', message: 'The target resource changed after the decision; the operation was not started.' };
      }
      const claim = this.store.claimExecutionGrant(decisionId, session.id, requestId, tool, normalizedCwd, sha256(`${tool}\n${stableJson(args)}`), this.policy.version);
      if (!claim.ok) return { ok: false, code: claim.code, message: 'This execution grant is invalid, expired, or already used.' };
      this.appendEvent(session.id, 'execution.claimed', { tool, decision_id: decisionId }, { user_name: session.user_name, request_id: requestId, decision_id: decisionId, tool, effect: 'allow' });
      return { ok: true };
    });
  }

  private resourceHash(req: ToolRequest, cwd = process.cwd()): string | null {
    if (req.tool !== 'write' && req.tool !== 'edit') return null;
    const p = req.arguments.path;
    if (typeof p !== 'string') return null;
    const abs = normalizeInputPath(p, cwd);
    try {
      const st = statSync(abs);
      return st.isFile() ? `sha256:${sha256(readFileSync(abs).toString('base64'))}` : 'not-file';
    } catch {
      return 'missing';
    }
  }

  /** An approval nobody resolved in time ends as `expired` and blocks its session; an expired grant is never usable. */
  sweepExpiredApprovals(): number {
    let n = 0;
    for (const ap of this.store.expiredPendingApprovals()) {
      if (!this.store.transitionApproval(ap.id, 'expired')) continue;
      const s = this.store.getSession(ap.session_id);
      if (s) {
        this.store.setStatusUnlessTerminated(s.id, 'blocked', 'APPROVAL_EXPIRED');
        this.appendEvent(s.id, 'approval.expired', { approval_id: ap.id }, { user_name: s.user_name, request_id: ap.request_id, reason_codes: ['APPROVAL_EXPIRED'] });
      }
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ decision bookkeeping
  private finalize(session: SessionRow, req: ToolRequest, step: Step, timings: Record<string, number>, extra: Partial<Decision>, t0: number, o: { noEvent?: boolean; cwd?: string } = {}): Decision {
    timings.total = Math.round(performance.now() - t0);
    let { effect } = step;
    let reasons = [...new Set(step.reasons)];
    const hard = reasons.some((r) => HARD.has(r));
    let observed: Effect | undefined;
    if (this.policy.mode === 'observe' && effect !== 'allow' && !hard && !reasons.some((r) => r === 'USER_REJECTED_OPERATION')) {
      observed = effect;
      effect = 'allow';
      reasons = ['OBSERVE_ONLY', ...reasons];
    }
    const fresh = this.store.getSession(session.id)!;
    let sessionAction: SessionAction = 'continue';
    let status: SessionStatus = fresh.status;
    let approval: Decision['approval'] = null;

    if (effect === 'deny') {
      if (reasons.includes('SESSION_TERMINATED') || fresh.status === 'terminated') sessionAction = 'terminate';
      else if (reasons.includes('GUARDIAN_UNCERTAIN') || reasons.includes('SESSION_REVIEWING')) sessionAction = 'await_user';
      else if (reasons.includes('AWAITING_APPROVAL')) sessionAction = 'await_user';
      else {
        const correctable = reasons.every((r) => this.policy.denials.allow_correction_for.includes(r)) && !hard;
        if (correctable) {
          const n = this.store.addCorrection(session.id);
          sessionAction = n <= this.policy.denials.max_correction_attempts ? 'continue' : 'block';
        } else sessionAction = this.policy.denials.default_session_action === 'continue' && !hard ? 'continue' : 'block';
        if (sessionAction === 'block' && fresh.status === 'active') {
          this.store.setStatusUnlessTerminated(session.id, 'blocked', reasons[0]);
          status = 'blocked';
        }
      }
      status = this.store.getSession(session.id)!.status;
      if (status === 'terminated') sessionAction = 'terminate';
    } else if (effect === 'require_approval') {
      sessionAction = 'await_user';
      const id = newId('appr');
      const now = Date.now();
      const exp = now + this.policy.approvals.ttl_seconds * 1000;
      const args = step.sanitized ?? req.arguments;
      this.store.createApproval({ id, session_id: session.id, request_id: req.request_id, tool: req.tool, args_hash: sha256(`${req.tool}\n${stableJson(args)}`), args_json: JSON.stringify(args), reason_codes: reasons.join(','), cwd: resolve(o.cwd ?? process.cwd()), resource_hash: this.resourceHash({ ...req, arguments: args }, o.cwd), created_at: now, expires_at: exp });
      this.store.setStatusUnlessTerminated(session.id, 'awaiting_approval', reasons[0]);
      status = 'awaiting_approval';
      approval = { id, approver: 'session_owner', scope: 'single_operation', expires_at: nowIso(exp), cwd: resolve(o.cwd ?? process.cwd()) };
    }

    const decision: Decision = {
      decision_id: newId('dec'),
      request_id: req.request_id,
      policy_id: this.policy.policy_id,
      policy_version: this.policy.version,
      profile: this.policy.profile,
      policy_attribution: this.policyAttribution(),
      effect,
      reason_codes: reasons,
      message: messageFor(reasons, effect, step.details),
      session_action: sessionAction,
      session_status: status,
      approval,
      ...(observed ? { observed_effect: observed } : {}),
      ...extra,
      timings_ms: timings,
    };
    const hint = hintFor(reasons);
    if (hint && sessionAction === 'continue' && effect === 'deny') decision.retry_hint = hint;
    if (step.sanitized && effect !== 'deny') (decision as Decision & { sanitized_arguments?: unknown }).sanitized_arguments = step.sanitized;

    if (effect === 'allow') {
      const args = step.sanitized ?? req.arguments;
      this.store.createExecutionGrant({
        decision_id: decision.decision_id, session_id: session.id, request_id: req.request_id, tool: req.tool, cwd: resolve(o.cwd ?? process.cwd()),
        args_hash: sha256(`${req.tool}\n${stableJson(args)}`), policy_id: this.policy.policy_id, policy_version: this.policy.version, profile: this.policy.profile,
        resource_hash: this.resourceHash({ ...req, arguments: args }, o.cwd), expires_at: Date.now() + 60_000,
      });
    }

    if (!o.noEvent) {
      const type = effect === 'allow' ? 'decision.allowed' : effect === 'deny' ? 'decision.denied' : 'approval.requested';
      this.appendEvent(
        session.id,
        type,
        { decision_id: decision.decision_id, tool: req.tool, args: auditArgs(req), reason_codes: reasons, session_action: sessionAction, observed_effect: observed, policy_version: this.policy.version, profile: this.policy.profile, details: step.details, timings_ms: timings, approval_id: approval?.id },
        { user_name: session.user_name, tool: req.tool, effect, reason_codes: reasons, request_id: req.request_id, decision_id: decision.decision_id },
      );
    }
    return decision;
  }

  /** Report back what the executor actually did. A decision is not proof of execution. */
  recordExecution(session: SessionRow, body: { request_id: string; decision_id?: string; phase: 'started' | 'completed' | 'failed'; usage?: unknown; error?: string; exit_code?: number }): boolean {
    if (!body.decision_id) return false;
    const db = this.store.db;
    const grant = this.store.getExecutionGrant(body.decision_id);
    if (!grant || grant.session_id !== session.id || grant.request_id !== body.request_id || grant.status !== 'claimed') return false;
    const alreadyStarted = !!db.prepare(`SELECT 1 FROM events WHERE session_id=? AND decision_id=? AND type='tool.started' LIMIT 1`).get(session.id, body.decision_id);
    const alreadyFinished = !!db.prepare(`SELECT 1 FROM events WHERE session_id=? AND decision_id=? AND type IN ('tool.completed','tool.failed') LIMIT 1`).get(session.id, body.decision_id);
    if (body.phase === 'started' ? alreadyStarted || alreadyFinished : !alreadyStarted || alreadyFinished) return false;
    const attribution: PolicyAttribution | null = grant.policy_id && grant.profile
      ? { source: 'event_time', policy_id: grant.policy_id, policy_version: grant.policy_version, profile: grant.profile }
      : null;
    this.appendEvent(session.id, `tool.${body.phase}`, { phase: body.phase, error: body.error, exit_code: body.exit_code, usage: body.usage, executor_reported: true }, { user_name: session.user_name, request_id: body.request_id, decision_id: body.decision_id, tool: grant.tool }, attribution);
    return true;
  }

  fileExists(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

function prefixKeys(prefix: string, o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [prefix + k, v]));
}

export function canonicalArgs(req: ToolRequest): string {
  const a = req.arguments;
  if (req.tool === 'bash' && typeof a.command === 'string') return a.command;
  if (req.tool === 'write') return `${String(a.path ?? '')}\n${String(a.content ?? '')}`;
  if (req.tool === 'edit') return JSON.stringify(a);
  return JSON.stringify(a);
}

function describeAction(req: ToolRequest): string {
  const a = req.arguments;
  switch (req.tool) {
    case 'bash': return `bash: ${String(a.command ?? '')}`;
    case 'http_request': return `HTTP ${String(a.method ?? 'GET')} ${String(a.url ?? '')}\narguments: ${JSON.stringify(a)}`;
    case 'write': return `write file ${String(a.path)} with content:\n${String(a.content ?? '')}`;
    case 'edit': return `edit file ${String(a.path)}: ${JSON.stringify(a)}`;
    default: return `${req.tool} ${JSON.stringify(a)}`;
  }
}

function auditArgs(req: ToolRequest): unknown {
  const r = scanValue(req.arguments, { pii: true }).redacted as Record<string, unknown>;
  const cut = (v: unknown): unknown => (typeof v === 'string' ? clip(v, 400) : Array.isArray(v) ? v.map(cut) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)])) : v);
  return cut(r);
}

function summarizeJudge(j: JudgeResult): unknown {
  return { verdict: j.verdict, reason_codes: j.reason_codes, probabilities: j.probabilities, model: j.model, latency_ms: j.latency_ms, source: j.source };
}

function hintFor(reasons: string[]): string | undefined {
  if (reasons.includes('PREFERRED_TOOL_REQUIRED')) return 'Use the read, write, edit, ls, find or grep tool for this operation instead of the shell.';
  if (reasons.includes('INPUT_TOO_LARGE')) return 'Reduce the amount of data in the request and try again.';
  return undefined;
}

export type { FeedMatch };
