import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionStatus } from '../types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  tokens_reserved INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  tool_attempts INTEGER NOT NULL DEFAULT 0,
  model_requests INTEGER NOT NULL DEFAULT 0,
  corrections INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  seq INTEGER,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool TEXT,
  effect TEXT,
  reason_codes TEXT,
  request_id TEXT,
  decision_id TEXT,
  user_name TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS reservations (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  actual INTEGER
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  args_json TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decision_id TEXT
);
CREATE TABLE IF NOT EXISTS topic_labels (
  session_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  state TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  score REAL NOT NULL,
  policy_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, topic_id)
);
CREATE TABLE IF NOT EXISTS guardians (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_reviewed_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS topic_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
`;

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionRow {
  id: string;
  user_name: string;
  status: SessionStatus;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
  policy_version: number;
  next_seq: number;
  tokens_spent: number;
  tokens_reserved: number;
  cost_micros: number;
  tool_attempts: number;
  model_requests: number;
  corrections: number;
}

export interface EventRow {
  id: number;
  session_id: string | null;
  seq: number | null;
  ts: number;
  type: string;
  tool: string | null;
  effect: string | null;
  reason_codes: string | null;
  request_id: string | null;
  decision_id: string | null;
  user_name: string | null;
  data: string;
}

export interface EventExtras {
  tool?: string;
  effect?: string;
  reason_codes?: string[];
  request_id?: string;
  decision_id?: string;
  user_name?: string;
}

export interface ApprovalRow {
  id: string;
  session_id: string;
  request_id: string;
  tool: string;
  args_hash: string;
  args_json: string;
  reason_codes: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated' | 'consumed';
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  decision_id: string | null;
}

export interface Limits {
  session_total_tokens?: number;
  session_tool_attempts?: number;
  session_model_requests?: number;
  session_cost_usd_micros?: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in an immediate (write-locking) transaction so that check-then-update sequences are atomic. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- sessions
  createSession(user: string, policyVersion: number): { session: SessionRow; token: string } {
    const token = `bw_sess_${randomBytes(24).toString('base64url')}`;
    const id = newId('sess');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id,user_name,token_hash,status,created_at,updated_at,policy_version) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, user, hashToken(token), 'active', now, now, policyVersion);
    return { session: this.getSession(id)!, token };
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  }

  getSessionByToken(token: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as unknown as SessionRow | undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as SessionRow[];
  }

  setStatus(id: string, status: SessionStatus, reason?: string): void {
    this.db.prepare('UPDATE sessions SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(status, reason ?? null, Date.now(), id);
  }

  /** `terminated` is final: only the same status may be written over it. */
  setStatusUnlessTerminated(id: string, status: SessionStatus, reason?: string): boolean {
    const r = this.db
      .prepare(`UPDATE sessions SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status != 'terminated'`)
      .run(status, reason ?? null, Date.now(), id);
    return Number(r.changes) > 0;
  }

  // ---- events (the audit stream)
  appendEvent(sessionId: string | null, type: string, data: unknown, x: EventExtras = {}): { id: number; seq: number | null } {
    return this.tx(() => {
      let seq: number | null = null;
      if (sessionId) {
        const row = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?').get(sessionId) as { next_seq: number } | undefined;
        if (row) {
          seq = row.next_seq;
          this.db.prepare('UPDATE sessions SET next_seq = next_seq + 1 WHERE id = ?').run(sessionId);
        }
      }
      const r = this.db
        .prepare(
          `INSERT INTO events (session_id,seq,ts,type,tool,effect,reason_codes,request_id,decision_id,user_name,data)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          sessionId,
          seq,
          Date.now(),
          type,
          x.tool ?? null,
          x.effect ?? null,
          x.reason_codes ? x.reason_codes.join(',') : null,
          x.request_id ?? null,
          x.decision_id ?? null,
          x.user_name ?? null,
          JSON.stringify(data ?? {}),
        );
      return { id: Number(r.lastInsertRowid), seq };
    });
  }

  listEvents(f: { sessionId?: string; type?: string; sinceId?: number; limit?: number } = {}): EventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.sessionId) (where.push('session_id = ?'), args.push(f.sessionId));
    if (f.type) (where.push('type LIKE ?'), args.push(f.type.replace(/\*/g, '%')));
    if (f.sinceId !== undefined) (where.push('id > ?'), args.push(f.sinceId));
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(f.limit ?? 200);
    return this.db.prepare(sql).all(...args) as unknown as EventRow[];
  }

  /** Recent events of one session, oldest first, optionally filtered by type. */
  sessionHistory(sessionId: string, types: string[], limit: number): EventRow[] {
    const ph = types.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND type IN (${ph}) ORDER BY id DESC LIMIT ?`)
      .all(sessionId, ...types, limit) as unknown as EventRow[];
    return rows.reverse();
  }

  // ---- budgets (atomic reservation: spent + reserved + new <= limit)
  reserveTokens(sessionId: string, requestId: string, tokens: number, limits: Limits): { ok: true } | { ok: false; code: string; message: string } {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT status FROM reservations WHERE request_id = ?').get(requestId) as { status: string } | undefined;
      if (existing) return { ok: true as const }; // idempotent retry
      const s = this.getSession(sessionId);
      if (!s) return { ok: false as const, code: 'SESSION_UNKNOWN', message: 'Unknown session.' };
      if (limits.session_model_requests !== undefined && s.model_requests + 1 > limits.session_model_requests)
        return { ok: false as const, code: 'BUDGET_EXCEEDED', message: 'The model request limit for this session is used up.' };
      if (limits.session_total_tokens !== undefined && s.tokens_spent + s.tokens_reserved + tokens > limits.session_total_tokens)
        return {
          ok: false as const,
          code: 'BUDGET_EXCEEDED',
          message: `The token budget for this session does not cover another request (needs ${tokens}, ${Math.max(0, limits.session_total_tokens - s.tokens_spent - s.tokens_reserved)} left).`,
        };
      if (limits.session_cost_usd_micros !== undefined && s.cost_micros >= limits.session_cost_usd_micros)
        return { ok: false as const, code: 'BUDGET_EXCEEDED', message: 'The cost budget for this session is used up.' };
      this.db.prepare('INSERT INTO reservations (request_id,session_id,tokens,status) VALUES (?,?,?,?)').run(requestId, sessionId, tokens, 'reserved');
      this.db.prepare('UPDATE sessions SET tokens_reserved = tokens_reserved + ?, model_requests = model_requests + 1, updated_at = ? WHERE id = ?').run(tokens, Date.now(), sessionId);
      return { ok: true as const };
    });
  }

  settleTokens(requestId: string, actualTokens: number, costMicros: number): void {
    this.tx(() => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId) as { session_id: string; tokens: number; status: string } | undefined;
      if (!r || r.status !== 'reserved') return; // duplicate settle: no double count
      this.db.prepare(`UPDATE reservations SET status='settled', actual=? WHERE request_id=?`).run(actualTokens, requestId);
      this.db
        .prepare('UPDATE sessions SET tokens_reserved = tokens_reserved - ?, tokens_spent = tokens_spent + ?, cost_micros = cost_micros + ?, updated_at = ? WHERE id = ?')
        .run(r.tokens, actualTokens, costMicros, Date.now(), r.session_id);
    });
  }

  /**
   * A request whose outcome is unknown keeps its reservation as spent (conservative) instead of freeing it.
   */
  settleUnknown(requestId: string): void {
    this.tx(() => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId) as { session_id: string; tokens: number; status: string } | undefined;
      if (!r || r.status !== 'reserved') return;
      this.db.prepare(`UPDATE reservations SET status='unknown', actual=tokens WHERE request_id=?`).run(requestId);
      this.db.prepare('UPDATE sessions SET tokens_reserved = tokens_reserved - ?, tokens_spent = tokens_spent + ?, updated_at = ? WHERE id = ?').run(r.tokens, r.tokens, Date.now(), r.session_id);
    });
  }

  /** Count a tool attempt (blocked attempts count too, so repeated denials cannot loop for free). */
  countToolAttempt(sessionId: string, limit: number | undefined): { ok: true; attempts: number } | { ok: false; attempts: number } {
    return this.tx(() => {
      const s = this.getSession(sessionId)!;
      if (limit !== undefined && s.tool_attempts + 1 > limit) return { ok: false as const, attempts: s.tool_attempts };
      this.db.prepare('UPDATE sessions SET tool_attempts = tool_attempts + 1, updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
      return { ok: true as const, attempts: s.tool_attempts + 1 };
    });
  }

  addCorrection(sessionId: string): number {
    this.db.prepare('UPDATE sessions SET corrections = corrections + 1 WHERE id = ?').run(sessionId);
    return (this.getSession(sessionId) as SessionRow).corrections;
  }

  // ---- approvals
  createApproval(a: Omit<ApprovalRow, 'status' | 'resolved_at' | 'decision_id'>): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id,session_id,request_id,tool,args_hash,args_json,reason_codes,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(a.id, a.session_id, a.request_id, a.tool, a.args_hash, a.args_json, a.reason_codes, 'pending', a.created_at, a.expires_at);
  }

  getApproval(id: string): ApprovalRow | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as ApprovalRow | undefined;
  }

  /** Move a pending approval to a final state exactly once. Returns false if it was not pending. */
  transitionApproval(id: string, to: ApprovalRow['status'], decisionId?: string): boolean {
    const r = this.db
      .prepare(`UPDATE approvals SET status = ?, resolved_at = ?, decision_id = COALESCE(?, decision_id) WHERE id = ? AND status = 'pending'`)
      .run(to, Date.now(), decisionId ?? null, id);
    return Number(r.changes) > 0;
  }

  invalidateApprovals(sessionId: string): number {
    const r = this.db.prepare(`UPDATE approvals SET status='invalidated', resolved_at=? WHERE session_id=? AND status='pending'`).run(Date.now(), sessionId);
    return Number(r.changes);
  }

  pendingApprovals(): ApprovalRow[] {
    return this.db.prepare(`SELECT * FROM approvals WHERE status='pending' AND expires_at > ? ORDER BY created_at DESC`).all(Date.now()) as unknown as ApprovalRow[];
  }

  expiredPendingApprovals(): ApprovalRow[] {
    return this.db.prepare(`SELECT * FROM approvals WHERE status='pending' AND expires_at <= ?`).all(Date.now()) as unknown as ApprovalRow[];
  }

  // ---- topics and guardian
  upsertLabel(sessionId: string, topicId: string, state: 'candidate' | 'confirmed' | 'dismissed', seq: number, score: number, policyId: string): void {
    this.db
      .prepare(
        `INSERT INTO topic_labels (session_id,topic_id,state,first_seq,score,policy_id,created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(session_id,topic_id) DO UPDATE SET state = CASE WHEN topic_labels.state = 'confirmed' THEN 'confirmed' ELSE excluded.state END, score = MAX(topic_labels.score, excluded.score)`,
      )
      .run(sessionId, topicId, state, seq, score, policyId, Date.now());
  }

  setLabelState(sessionId: string, topicId: string, state: 'candidate' | 'confirmed' | 'dismissed'): void {
    this.db.prepare('UPDATE topic_labels SET state = ? WHERE session_id = ? AND topic_id = ?').run(state, sessionId, topicId);
  }

  labels(sessionId: string): { topic_id: string; state: string; first_seq: number; score: number; policy_id: string }[] {
    return this.db.prepare('SELECT topic_id,state,first_seq,score,policy_id FROM topic_labels WHERE session_id = ?').all(sessionId) as never;
  }

  /** Atomic spawn: at most one guardian per session, even under concurrent matches. */
  ensureGuardian(sessionId: string): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO guardians (session_id,status,started_at) VALUES (?,?,?)`).run(sessionId, 'active', Date.now());
    return Number(r.changes) > 0;
  }

  guardian(sessionId: string): { session_id: string; status: string; started_at: number; last_reviewed_seq: number } | undefined {
    return this.db.prepare('SELECT * FROM guardians WHERE session_id = ?').get(sessionId) as never;
  }

  setGuardianReviewed(sessionId: string, seq: number): void {
    this.db.prepare('UPDATE guardians SET last_reviewed_seq = MAX(last_reviewed_seq, ?) WHERE session_id = ?').run(seq, sessionId);
  }

  createTopicReview(sessionId: string, seq: number): string {
    const id = newId('rev');
    this.db.prepare('INSERT INTO topic_reviews (id,session_id,seq,status,created_at) VALUES (?,?,?,?,?)').run(id, sessionId, seq, 'open', Date.now());
    return id;
  }

  getTopicReview(id: string): { id: string; session_id: string; seq: number; status: string } | undefined {
    return this.db.prepare('SELECT * FROM topic_reviews WHERE id = ?').get(id) as never;
  }

  resolveTopicReview(id: string, note: string): boolean {
    const r = this.db.prepare(`UPDATE topic_reviews SET status='resolved', note=?, resolved_at=? WHERE id=? AND status='open'`).run(note, Date.now(), id);
    return Number(r.changes) > 0;
  }

  openTopicReviews(): { id: string; session_id: string; seq: number; created_at: number }[] {
    return this.db.prepare(`SELECT id,session_id,seq,created_at FROM topic_reviews WHERE status='open' ORDER BY created_at DESC`).all() as never;
  }
}
