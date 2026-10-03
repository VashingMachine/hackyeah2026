import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { PolicySchema, type Policy } from './schema.ts';

export class ConfigError extends Error {}

/** `${NAME}` placeholders are filled from the environment (WORKSPACE defaults to ./demo-workspace). */
function interpolate(raw: string, env: Record<string, string | undefined>): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new ConfigError(`config references undefined variable \${${name}}`);
    return v;
  });
}

export function parsePolicy(raw: string, env: Record<string, string | undefined>, baseDir: string): Policy {
  let doc: unknown;
  try {
    doc = parse(interpolate(raw, env));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`policy is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`invalid policy:\n  ${issues.join('\n  ')}`);
  }
  const p = parsed.data;
  semanticChecks(p);
  // Relative paths in the policy are relative to the policy file.
  p.threat_feed.path = resolve(baseDir, p.threat_feed.path);
  p.audit.db_path = p.audit.db_path === ':memory:' ? ':memory:' : resolve(baseDir, p.audit.db_path);
  return p;
}

function semanticChecks(p: Policy): void {
  const errs: string[] = [];
  if (!p.profiles[p.profile]) errs.push(`profile "${p.profile}" is not defined under profiles`);
  for (const [id, t] of Object.entries(p.topics)) {
    if (!p.topic_policies[t.policy_id]) errs.push(`topic ${id} references unknown policy ${t.policy_id}`);
  }
  for (const a of p.global.models?.allow_aliases ?? []) {
    if (!p.model_aliases[a]) errs.push(`unknown model alias ${a} in global.models.allow_aliases`);
  }
  if (!p.model_aliases[p.topic_supervision.guardian_model_alias]) {
    errs.push(`unknown guardian_model_alias ${p.topic_supervision.guardian_model_alias}`);
  }
  const tokens = new Set<string>();
  for (const [name, u] of Object.entries(p.users)) {
    if (tokens.has(u.token)) errs.push(`user ${name} reuses another user's token`);
    tokens.add(u.token);
  }
  if (errs.length) throw new ConfigError(`invalid policy:\n  ${errs.join('\n  ')}`);
}

export function loadPolicyFile(path: string, env: Record<string, string | undefined> = process.env): Policy {
  const abs = resolve(path);
  const baseDir = dirname(abs);
  const e = { ...env };
  e.WORKSPACE ??= resolve(baseDir, '..', 'demo-workspace');
  return parsePolicy(readFileSync(abs, 'utf8'), e, baseDir);
}
