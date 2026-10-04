import type { EffectiveScope } from './config/effective.ts';
export type Effect = 'allow' | 'deny' | 'require_approval';
export type SessionAction = 'continue' | 'await_user' | 'block' | 'terminate';
export type SessionStatus = 'active' | 'awaiting_approval' | 'reviewing' | 'blocked' | 'terminated';

export interface PolicyAttribution {
  source: 'event_time';
  policy_id: string;
  policy_version: number;
  profile: string;
}

export interface ToolRequest {
  request_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  tool_call_id?: string;
}

export interface ApprovalInfo {
  id: string;
  approver: 'session_owner';
  scope: 'single_operation';
  expires_at: string;
  cwd: string;
}

export interface Decision {
  decision_id: string;
  request_id: string;
  policy_id: string;
  policy_version: number;
  profile: string;
  policy_attribution: PolicyAttribution;
  effect: Effect;
  reason_codes: string[];
  message: string;
  retry_hint?: string;
  session_action: SessionAction;
  session_status: SessionStatus;
  approval: ApprovalInfo | null;
  /** Set when the policy mode is `observe`: what would have happened under enforcement. */
  observed_effect?: Effect;
  topic_ids?: string[];
  /** Constraints the executor must apply when it runs an allowed operation. */
  execution?: { allow_non_public_ips?: boolean; follow_redirects?: boolean; timeout_seconds?: number; shell_timeout_seconds?: number; max_response_bytes?: number; file_scope?: EffectiveScope['files'] };
  timings_ms?: Record<string, number>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
