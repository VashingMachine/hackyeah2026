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
  policy_id TEXT,
  policy_version INTEGER NOT NULL,
  profile TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  tokens_reserved INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  cost_reserved_micros INTEGER NOT NULL DEFAULT 0,
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
  actual INTEGER,
  cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  args_json TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  cwd TEXT,
  resource_hash TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decision_id TEXT
);
CREATE TABLE IF NOT EXISTS execution_grants (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  cwd TEXT,
  args_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  policy_id TEXT,
  profile TEXT,
  resource_hash TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS runtime_configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_hash TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  controls TEXT NOT NULL,
  feed TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
  policy_id: string | null;
  policy_version: number;
  profile: string | null;
  next_seq: number;
  tokens_spent: number;
  tokens_reserved: number;
  cost_micros: number;
  cost_reserved_micros: number;
  tool_attempts: number;
  model_requests: number;
  corrections: number;
  /** Derived from the newest audit event; absent on direct single-row reads. */
  last_event_at?: number | null;
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
  cwd: string | null;
  resource_hash: string | null;
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

export interface ExecutionGrantInput {
  decision_id: string;
  session_id: string;
  request_id: string;
  tool: string;
  cwd: string;
  args_hash: string;
  policy_id: string;
  policy_version: number;
  profile: string;
  resource_hash: string | null;
  expires_at: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // Keep existing demo databases usable as the approval binding is strengthened.
    const approvalColumns = this.db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[];
    if (!approvalColumns.some((c) => c.name === 'cwd')) this.db.exec('ALTER TABLE approvals ADD COLUMN cwd TEXT');
    if (!approvalColumns.some((c) => c.name === 'resource_hash')) this.db.exec('ALTER TABLE approvals ADD COLUMN resource_hash TEXT');
    const grantColumns = this.db.prepare('PRAGMA table_info(execution_grants)').all() as { name: string }[];
    if (!grantColumns.some((c) => c.name === 'cwd')) this.db.exec('ALTER TABLE execution_grants ADD COLUMN cwd TEXT');
    if (!grantColumns.some((c) => c.name === 'policy_id')) this.db.exec('ALTER TABLE execution_grants ADD COLUMN policy_id TEXT');
    if (!grantColumns.some((c) => c.name === 'profile')) this.db.exec('ALTER TABLE execution_grants ADD COLUMN profile TEXT');
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!sessionColumns.some((c) => c.name === 'cost_reserved_micros')) this.db.exec('ALTER TABLE sessions ADD COLUMN cost_reserved_micros INTEGER NOT NULL DEFAULT 0');
    if (!sessionColumns.some((c) => c.name === 'policy_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN policy_id TEXT');
    if (!sessionColumns.some((c) => c.name === 'profile')) this.db.exec('ALTER TABLE sessions ADD COLUMN profile TEXT');
    const reservationColumns = this.db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
    if (!reservationColumns.some((c) => c.name === 'cost_micros')) this.db.exec('ALTER TABLE reservations ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0');
  }

  close(): void {
    this.db.close();
  }

  latestConfiguration(baseHash: string): { policy_id: string; policy_version: number; controls: string; feed: string } | undefined {
    return this.db.prepare('SELECT policy_id,policy_version,controls,feed FROM runtime_configurations WHERE base_hash=? ORDER BY id DESC LIMIT 1').get(baseHash) as never;
  }

  /** Persist publication and invalidate approvals/grants/reviews in the same SQLite transaction. */
  publishConfiguration(baseHash: string, policyId: string, version: number, profile: string, controls: unknown, feed: unknown,
    topics: Record<string, { policy_id: string }>, event: 'policy.published' | 'feed.published'): void {
    this.tx(() => {
      const now = Date.now();
      this.db.prepare('INSERT INTO runtime_configurations(base_hash,policy_id,policy_version,controls,feed,created_at) VALUES(?,?,?,?,?,?)')
        .run(baseHash, policyId, version, JSON.stringify(controls), JSON.stringify(feed), now);
      this.db.prepare("UPDATE approvals SET status='invalidated',resolved_at=? WHERE status IN ('pending','approved')").run(now);
      this.db.prepare("UPDATE execution_grants SET status='invalidated' WHERE status='available'").run();
      this.db.prepare("UPDATE sessions SET status='blocked',status_reason='POLICY_CHANGED' WHERE status IN ('awaiting_approval','reviewing')").run();
      this.db.prepare('UPDATE sessions SET policy_id=?,policy_version=?,profile=?,updated_at=?').run(policyId, version, profile, now);
      this.db.prepare("UPDATE topic_reviews SET status='cancelled',note='POLICY_CHANGED',resolved_at=? WHERE status='open'").run(now);
      for (const label of this.db.prepare('SELECT DISTINCT topic_id FROM topic_labels').all() as { topic_id: string }[]) {
        if (Object.hasOwn(topics, label.topic_id)) this.db.prepare('UPDATE topic_labels SET policy_id=? WHERE topic_id=?').run(topics[label.topic_id]!.policy_id, label.topic_id);
        else this.db.prepare('DELETE FROM topic_labels WHERE topic_id=?').run(label.topic_id);
      }
      // Keep the raw history; version-bound cleared events cannot authorize new-policy traffic.
      this.db.prepare('INSERT INTO events(session_id,seq,ts,type,data) VALUES(NULL,NULL,?,?,?)')
        .run(now, event, JSON.stringify({ policy_id: policyId, policy_version: version, by: 'admin', feed_version: (feed as { version: number }).version,
          policy_attribution: { source: 'event_time', policy_id: policyId, policy_version: version, profile } }));
    });
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
  createSession(user: string, policyId: string, policyVersion: number, profile: string): { session: SessionRow; token: string } {
    const token = `bw_sess_${randomBytes(24).toString('base64url')}`;
    const id = newId('sess');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id,user_name,token_hash,status,created_at,updated_at,policy_id,policy_version,profile) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, user, hashToken(token), 'active', now, now, policyId, policyVersion, profile);
    return { session: this.getSession(id)!, token };
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  }

  getSessionByToken(token: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as unknown as SessionRow | undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db.prepare(`SELECT sessions.*, MAX(events.ts) AS last_event_at
      FROM sessions LEFT JOIN events ON events.session_id = sessions.id
      GROUP BY sessions.id
      ORDER BY COALESCE(MAX(events.ts), sessions.updated_at, sessions.created_at) DESC, sessions.id DESC
      LIMIT ?`).all(limit) as unknown as SessionRow[];
  }

  sessionLastEventAt(sessionId: string): number | null {
    const row = this.db.prepare('SELECT MAX(ts) AS last_event_at FROM events WHERE session_id=?').get(sessionId) as { last_event_at: number | null };
    return row.last_event_at;
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

  /** Mark a recorded content event as reviewed-and-passed. Only such events may be skipped on a resend. */
  markEventCleared(id: number): void {
    this.db.prepare(`UPDATE events SET data = json_set(data, '$.cleared', json('true')) WHERE id = ?`).run(id);
  }

  listEvents(f: { sessionId?: string; type?: string; sinceId?: number; limit?: number; order?: 'asc' | 'desc' } = {}): EventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.sessionId) (where.push('session_id = ?'), args.push(f.sessionId));
    if (f.type) (where.push('type LIKE ?'), args.push(f.type.replace(/\*/g, '%')));
    if (f.sinceId !== undefined) (where.push('id > ?'), args.push(f.sinceId));
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ${f.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`;
    args.push(f.limit ?? 200);
    return this.db.prepare(sql).all(...args) as unknown as EventRow[];
  }

  /** Upper event ID used to hold a stable boundary while session history is paged. */
  latestEventId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get() as { id: number };
    return row.id;
  }

  /** Newest page at or below a fixed snapshot, returned oldest first for timeline rendering. */
  sessionEventsPage(sessionId: string, snapshotId: number, beforeId: number | undefined, limit: number): { events: EventRow[]; hasMore: boolean; nextCursor: number | null } {
    const before = beforeId === undefined ? '' : ' AND id < ?';
    const args: (string | number)[] = beforeId === undefined ? [sessionId, snapshotId, limit + 1] : [sessionId, snapshotId, beforeId, limit + 1];
    const rows = this.db.prepare(`SELECT * FROM events WHERE session_id=? AND id<=?${before} ORDER BY id DESC LIMIT ?`).all(...args) as unknown as EventRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor = hasMore && page.length ? page[page.length - 1]!.id : null;
    return { events: page.reverse(), hasMore, nextCursor };
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
  reserveTokens(sessionId: string, requestId: string, tokens: number, limits: Limits, countModelRequest = true, costMicros = 0): { ok: true } | { ok: false; code: string; message: string } {
    return this.tx(() => {
      if (!Number.isSafeInteger(costMicros) || costMicros < 0) return { ok: false as const, code: 'INVALID_RESERVATION', message: 'Reserved cost must be a non-negative integer number of USD micros.' };
      const existing = this.db.prepare('SELECT session_id,tokens,cost_micros FROM reservations WHERE request_id = ?').get(requestId) as { session_id: string; tokens: number; cost_micros: number } | undefined;
      if (existing) return existing.session_id === sessionId && existing.tokens === tokens && existing.cost_micros === costMicros ? { ok: true as const } : { ok: false as const, code: 'REQUEST_ID_REUSED', message: 'This request id is already bound to a different reservation.' };
      const s = this.getSession(sessionId);
      if (!s) return { ok: false as const, code: 'SESSION_UNKNOWN', message: 'Unknown session.' };
      if (countModelRequest && limits.session_model_requests !== undefined && s.model_requests + 1 > limits.session_model_requests)
        return { ok: false as const, code: 'BUDGET_EXCEEDED', message: 'The model request limit for this session is used up.' };
      if (limits.session_total_tokens !== undefined && s.tokens_spent + s.tokens_reserved + tokens > limits.session_total_tokens)
        return {
          ok: false as const,
          code: 'BUDGET_EXCEEDED',
          message: `The token budget for this session does not cover another request (needs ${tokens}, ${Math.max(0, limits.session_total_tokens - s.tokens_spent - s.tokens_reserved)} left).`,
        };
      if (limits.session_cost_usd_micros !== undefined && s.cost_micros + s.cost_reserved_micros + costMicros > limits.session_cost_usd_micros)
        return { ok: false as const, code: 'BUDGET_EXCEEDED', message: `The cost budget for this session does not cover another request (needs $${costMicros} micros, $${Math.max(0, limits.session_cost_usd_micros - s.cost_micros - s.cost_reserved_micros)} micros left).` };
      this.db.prepare('INSERT INTO reservations (request_id,session_id,tokens,status,cost_micros) VALUES (?,?,?,?,?)').run(requestId, sessionId, tokens, 'reserved', costMicros);
      this.db.prepare('UPDATE sessions SET tokens_reserved = tokens_reserved + ?, cost_reserved_micros = cost_reserved_micros + ?, model_requests = model_requests + ?, updated_at = ? WHERE id = ?').run(tokens, costMicros, countModelRequest ? 1 : 0, Date.now(), sessionId);
      return { ok: true as const };
    });
  }

  settleTokens(requestId: string, actualTokens: number, costMicros: number): void {
    this.tx(() => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId) as { session_id: string; tokens: number; status: string; cost_micros: number } | undefined;
      if (!r || r.status !== 'reserved') return; // duplicate settle: no double count
      this.db.prepare(`UPDATE reservations SET status='settled', actual=?, cost_micros=? WHERE request_id=?`).run(actualTokens, costMicros, requestId);
      this.db
        .prepare('UPDATE sessions SET tokens_reserved = tokens_reserved - ?, tokens_spent = tokens_spent + ?, cost_reserved_micros = cost_reserved_micros - ?, cost_micros = cost_micros + ?, updated_at = ? WHERE id = ?')
        .run(r.tokens, actualTokens, r.cost_micros, costMicros, Date.now(), r.session_id);
    });
  }

  /**
   * A request whose outcome is unknown keeps its reservation as spent (conservative) instead of freeing it.
   */
  settleUnknown(requestId: string): void {
    this.tx(() => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId) as { session_id: string; tokens: number; status: string; cost_micros: number } | undefined;
      if (!r || r.status !== 'reserved') return;
      // Provider outcome is unknown: conservatively settle both token and worst-case cost reservations as spent.
      this.db.prepare(`UPDATE reservations SET status='unknown', actual=tokens WHERE request_id=?`).run(requestId);
      this.db.prepare('UPDATE sessions SET tokens_reserved = tokens_reserved - ?, tokens_spent = tokens_spent + ?, cost_reserved_micros = cost_reserved_micros - ?, cost_micros = cost_micros + ?, updated_at = ? WHERE id = ?').run(r.tokens, r.tokens, r.cost_micros, r.cost_micros, Date.now(), r.session_id);
    });
  }

  createExecutionGrant(g: ExecutionGrantInput): void {
    this.db.prepare(`INSERT INTO execution_grants (decision_id,session_id,request_id,tool,cwd,args_hash,policy_id,policy_version,profile,resource_hash,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'available')`)
      .run(g.decision_id, g.session_id, g.request_id, g.tool, g.cwd, g.args_hash, g.policy_id, g.policy_version, g.profile, g.resource_hash, g.expires_at);
  }

  getExecutionGrant(decisionId: string) {
    return this.db.prepare('SELECT * FROM execution_grants WHERE decision_id=?').get(decisionId) as {
      decision_id: string; session_id: string; request_id: string; tool: string; cwd: string | null; args_hash: string; policy_id: string | null; policy_version: number; profile: string | null;
      resource_hash: string | null; expires_at: number; status: string;
    } | undefined;
  }

  /** Claim an allow decision exactly once, while the session is still active. */
  claimExecutionGrant(decisionId: string, sessionId: string, requestId: string, tool: string, cwd: string, argsHash: string, policyVersion: number): { ok: true; resource_hash: string | null } | { ok: false; code: string } {
    return this.tx(() => {
      const g = this.getExecutionGrant(decisionId);
      if (!g || g.session_id !== sessionId || g.request_id !== requestId || g.tool !== tool || g.cwd !== cwd || g.args_hash !== argsHash || g.policy_version !== policyVersion)
        return { ok: false as const, code: 'EXECUTION_GRANT_MISMATCH' };
      if (g.status !== 'available') return { ok: false as const, code: 'EXECUTION_GRANT_USED' };
      if (Date.now() > g.expires_at) return { ok: false as const, code: 'EXECUTION_GRANT_EXPIRED' };
      const s = this.getSession(sessionId);
      if (!s || s.status !== 'active') return { ok: false as const, code: 'SESSION_NOT_ACTIVE' };
      const r = this.db.prepare(`UPDATE execution_grants SET status='claimed' WHERE decision_id=? AND status='available'`).run(decisionId);
      return Number(r.changes) === 1 ? { ok: true as const, resource_hash: g.resource_hash } : { ok: false as const, code: 'EXECUTION_GRANT_USED' };
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
        `INSERT INTO approvals (id,session_id,request_id,tool,args_hash,args_json,reason_codes,cwd,resource_hash,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(a.id, a.session_id, a.request_id, a.tool, a.args_hash, a.args_json, a.reason_codes, a.cwd, a.resource_hash ?? null, 'pending', a.created_at, a.expires_at);
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

  /** Atomically consume a pending approval only while its session is still waiting for that approval. */
  approvePendingApproval(id: string, sessionId: string): boolean {
    return this.tx(() => {
      const approval = this.db.prepare(`SELECT status, expires_at FROM approvals WHERE id=? AND session_id=?`).get(id, sessionId) as { status: string; expires_at: number } | undefined;
      const session = this.getSession(sessionId);
      if (!approval || approval.status !== 'pending' || approval.expires_at <= Date.now() || session?.status !== 'awaiting_approval') return false;
      const changed = this.db.prepare(`UPDATE approvals SET status='approved', resolved_at=? WHERE id=? AND status='pending'`).run(Date.now(), id);
      if (Number(changed.changes) !== 1) return false;
      this.db.prepare(`UPDATE sessions SET status='active', status_reason=NULL, updated_at=? WHERE id=? AND status='awaiting_approval'`).run(Date.now(), sessionId);
      return true;
    });
  }

  /** Atomic admin revoke: no concurrent approval can restore the session after it is blocked. */
  revokeSession(id: string, reason: string): number {
    return this.tx(() => {
      this.db.prepare(`UPDATE sessions SET status='blocked', status_reason=?, updated_at=? WHERE id=? AND status!='terminated'`).run(reason, Date.now(), id);
      return Number(this.db.prepare(`UPDATE approvals SET status='invalidated', resolved_at=? WHERE session_id=? AND status='pending'`).run(Date.now(), id).changes);
    });
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
