import { z } from 'zod';

const strArr = z.array(z.string());

export const FilesSchema = z.strictObject({
  read_roots: strArr.optional(),
  write_roots: strArr.optional(),
  deny_basenames: strArr.optional(),
  allowed_extensions: strArr.optional(),
  reject_symlinks: z.boolean().optional(),
  max_bytes: z.number().int().positive().optional(),
  require_approval_roots: strArr.optional(),
});

export const NetworkSchema = z.strictObject({
  allowed_schemes: strArr.optional(),
  allow_hosts: strArr.optional(),
  allow_subdomains: z.boolean().optional(),
  allowed_ports: z.array(z.number().int()).optional(),
  allowed_methods: strArr.optional(),
  deny_non_public_ips: z.boolean().optional(),
  follow_redirects: z.boolean().optional(),
  allow_endpoints: strArr.optional(),
  // Exact host:port pairs exempt from the non-public-address rule (test fixtures only).
  fixture_exceptions: strArr.optional(),
});

export const BudgetsSchema = z.strictObject({
  session_total_tokens: z.number().int().positive().optional(),
  session_tool_attempts: z.number().int().positive().optional(),
  session_model_requests: z.number().int().positive().optional(),
  session_wall_seconds: z.number().int().positive().optional(),
  session_cost_usd_micros: z.number().int().positive().optional(),
  tool_timeout_seconds: z.number().int().positive().optional(),
});

export const ShellSchema = z.strictObject({
  enabled: z.boolean().optional(),
  max_command_bytes: z.number().int().positive().optional(),
  timeout_seconds: z.number().int().positive().optional(),
  execution_profile: z.enum(['demo_prepared', 'isolated']).optional(),
  require_isolation: z.boolean().optional(),
});

export const ToolsSchema = z.strictObject({
  allow: strArr.optional(),
  deny: strArr.optional(),
});

export const ModelsSchema = z.strictObject({
  allow_aliases: strArr.optional(),
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

export const ContentSchema = z.strictObject({
  max_inspection_bytes: z.number().int().positive().optional(),
});

export const ScopeSchema = z.strictObject({
  tools: ToolsSchema.optional(),
  files: FilesSchema.optional(),
  network: NetworkSchema.optional(),
  budgets: BudgetsSchema.optional(),
  shell: ShellSchema.optional(),
  models: ModelsSchema.optional(),
  content: ContentSchema.optional(),
});

export const ProfileSchema = z.strictObject({
  // Which operations get a semantic (Jev) review before they may be allowed.
  semantic_evaluate: z.enum(['none', 'shell_and_outbound', 'mutating_and_outbound', 'all']),
  min_allow_probability: z.number().min(0).max(1),
  min_confidence: z.number().min(0).max(1),
  secrets: z.enum(['block', 'redact']),
  pii: z.enum(['off', 'redact', 'block']),
  on_uncertain: z.enum(['require_approval', 'deny']),
});

export const TopicSchema = z.strictObject({
  description: z.string(),
  policy_id: z.string(),
  examples: z.array(z.string()).min(1),
  similarity_threshold: z.number().min(0).max(1).optional(),
});

export const TopicPolicySchema = z.strictObject({
  version: z.number().int(),
  forbidden: z.string(),
  allowed: z.string(),
  reason_code: z.string(),
});

export const UserSchema = ScopeSchema.extend({
  token: z.string().min(8),
  description: z.string().optional(),
  // A trusted assignment can already identify sensitive policies before any semantic lookup.
  topic_ids: strArr.optional(),
  // Directory the managed launcher starts the agent in (relative paths in tool calls resolve here).
  workdir: z.string().optional(),
});

export const PolicySchema = z.strictObject({
  schema_version: z.literal(1),
  policy_id: z.string(),
  version: z.number().int().positive(),
  mode: z.enum(['enforce', 'observe']),
  profile: z.enum(['permissive', 'standard', 'strict']),
  profiles: z.record(z.string(), ProfileSchema),
  default_effect: z.literal('deny'),
  denials: z.strictObject({
    default_session_action: z.enum(['block', 'continue']),
    allow_correction_for: strArr,
    max_correction_attempts: z.number().int().min(0),
  }),
  approvals: z.strictObject({
    enabled: z.boolean(),
    eligible_reason_codes: strArr,
    ttl_seconds: z.number().int().positive(),
  }),
  model_aliases: z.record(
    z.string(),
    z.strictObject({
      provider: z.enum(['openai', 'anthropic']),
      model: z.string(),
      reasoning_effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
      input_usd_micros_per_mtok: z.number().int().nonnegative().optional(),
      output_usd_micros_per_mtok: z.number().int().nonnegative().optional(),
    }),
  ),
  global: ScopeSchema,
  semantic: z.strictObject({
    provider: z.enum(['jev']),
    model: z.string(),
    timeout_ms: z.number().int().positive(),
    rubric_version: z.number().int(),
  }),
  topic_supervision: z.strictObject({
    enabled: z.boolean(),
    embedding: z.strictObject({
      provider: z.enum(['openai', 'local', 'lexical']),
      model: z.string().optional(),
    }),
    guardian_model_alias: z.string(),
    chunk_chars: z.number().int().positive(),
    overlap_chars: z.number().int().min(0),
    max_history_events: z.number().int().positive(),
    on_error: z.enum(['block']),
    default_similarity_threshold: z.number().min(0).max(1),
  }),
  topics: z.record(z.string(), TopicSchema),
  topic_policies: z.record(z.string(), TopicPolicySchema),
  users: z.record(z.string(), UserSchema),
  threat_feed: z.strictObject({ path: z.string() }),
  audit: z.strictObject({ db_path: z.string() }),
});

export type Policy = z.infer<typeof PolicySchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
