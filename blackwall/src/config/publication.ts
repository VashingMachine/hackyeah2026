import { z } from 'zod';
import { PolicySchema, ProfileSchema, ScopeSchema, TopicSchema, TopicPolicySchema, type Policy } from './schema.ts';
import { semanticChecks } from './load.ts';

// Runtime edits cannot replace credentials, provider wiring, database paths or user identities.
// Nested scope fields are patches; arrays are replacements, including an explicit empty allowlist.
export const ControlsSchema = z.strictObject({
  profile: PolicySchema.shape.profile.optional(), mode: PolicySchema.shape.mode.optional(),
  profiles: z.record(z.string(), ProfileSchema.partial()).optional(),
  global: ScopeSchema.optional(), users: z.record(z.string(), ScopeSchema).optional(),
  approvals: PolicySchema.shape.approvals.partial().optional(),
  denials: PolicySchema.shape.denials.partial().optional(),
  topic_thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(),
  topics: z.record(z.string(), TopicSchema).optional(),
  topic_policies: z.record(z.string(), TopicPolicySchema).optional(),
});
export type Controls = z.infer<typeof ControlsSchema>;
export const PolicyPublicationSchema = z.strictObject({
  expected_version: z.number().int().positive(), changes: ControlsSchema,
});

function merge<T extends object>(original: T, patch: object): T {
  return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(patch)])].map(key => {
    const before = (original as Record<string, unknown>)[key];
    const after = (patch as Record<string, unknown>)[key];
    return [key, !Object.hasOwn(patch, key) ? before :
      before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)
        ? merge(before, after) : after];
  })) as T;
}

export function applyControls(base: Policy, raw: unknown, version: number): Policy {
  const changes = ControlsSchema.parse(raw);
  const p = structuredClone(base);
  if (changes.profile !== undefined) p.profile = changes.profile;
  if (changes.mode !== undefined) p.mode = changes.mode;
  for (const [name, patch] of Object.entries(changes.profiles ?? {})) {
    if (!Object.hasOwn(p.profiles, name)) throw new Error('Unknown profile');
    p.profiles[name] = merge(p.profiles[name]!, patch);
  }
  if (changes.global) p.global = merge(p.global, changes.global);
  for (const [name, patch] of Object.entries(changes.users ?? {})) {
    if (!Object.hasOwn(p.users, name)) throw new Error('Unknown user');
    p.users[name] = merge(p.users[name]!, patch);
  }
  if (changes.approvals) p.approvals = merge(p.approvals, changes.approvals);
  if (changes.denials) p.denials = merge(p.denials, changes.denials);
  // A catalog publication supplies complete topics/policies, rather than half of a new catalog.
  if ((changes.topics === undefined) !== (changes.topic_policies === undefined)) throw new Error('Publish a complete topic catalog');
  if (changes.topics) p.topics = changes.topics;
  if (changes.topic_policies) p.topic_policies = changes.topic_policies;
  for (const [id, threshold] of Object.entries(changes.topic_thresholds ?? {})) {
    if (!Object.hasOwn(p.topics, id)) throw new Error('Unknown topic');
    p.topics[id]!.similarity_threshold = threshold;
  }
  p.version = version;
  const validated = PolicySchema.parse(p);
  semanticChecks(validated);
  if (Object.keys(validated.topics).length === 0 || Object.keys(validated.topic_policies).length === 0) throw new Error('Empty topic catalog');
  return validated;
}

/** Complete editable controls; tokens, workdirs and provider settings never leave the server. */
export function editableControls(p: Policy): Controls {
  const users = Object.fromEntries(Object.entries(p.users).map(([id, user]) => [id,
    Object.fromEntries(Object.keys(ScopeSchema.shape).filter(key => Object.hasOwn(user, key)).map(key => [key, (user as Record<string, unknown>)[key]])),
  ]));
  return ControlsSchema.parse({ profile: p.profile, mode: p.mode, profiles: p.profiles, global: p.global,
    users, approvals: p.approvals, denials: p.denials, topics: p.topics, topic_policies: p.topic_policies });
}
