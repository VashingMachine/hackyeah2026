import type { Policy, Scope } from './schema.ts';
import { isWithin } from '../util/paths.ts';

/** The merged limits for one user: allowlists intersect, denies union, limits take the minimum. */
export interface EffectiveScope {
  tools: { allow: string[] | undefined; deny: string[] };
  files: {
    read_roots: string[] | undefined;
    write_roots: string[] | undefined;
    deny_basenames: string[];
    allowed_extensions: string[] | undefined;
    reject_symlinks: boolean;
    max_bytes: number | undefined;
    require_approval_roots: string[];
  };
  network: {
    allowed_schemes: string[] | undefined;
    allow_hosts: string[] | undefined;
    allow_subdomains: boolean;
    allowed_ports: number[] | undefined;
    allowed_methods: string[] | undefined;
    allow_endpoints: string[] | undefined;
    fixture_exceptions: string[];
    deny_non_public_ips: boolean;
    follow_redirects: boolean;
  };
  budgets: {
    session_total_tokens?: number;
    session_tool_attempts?: number;
    session_model_requests?: number;
    session_wall_seconds?: number;
    session_cost_usd_micros?: number;
    tool_timeout_seconds?: number;
  };
  shell: { enabled: boolean; max_command_bytes: number; timeout_seconds: number; execution_profile: string; require_isolation: boolean };
  models: { allow_aliases: string[] | undefined; max_input_tokens?: number; max_output_tokens?: number };
}

const union = (a: string[] | undefined, b: string[] | undefined): string[] => [...new Set([...(a ?? []), ...(b ?? [])])];

/** Intersection of two allowlists; `undefined` means "not restricted at this level". An empty list denies everything. */
export function intersect<T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

/** Intersection of two sets of path roots: a root survives only where both levels allow it. */
export function intersectRoots(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const out = new Set<string>();
  for (const x of a) for (const y of b) {
    if (isWithin(x, y)) out.add(y);
    else if (isWithin(y, x)) out.add(x);
  }
  return [...out];
}

const minDefined = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

export function effectiveScope(policy: Policy, userName: string | undefined): EffectiveScope {
  const g = policy.global;
  const u: Scope = (userName && policy.users[userName]) || {};
  const gf = g.files ?? {}, uf = u.files ?? {};
  const gn = g.network ?? {}, un = u.network ?? {};
  const gb = g.budgets ?? {}, ub = u.budgets ?? {};
  const gs = g.shell ?? {}, us = u.shell ?? {};
  const gm = g.models ?? {}, um = u.models ?? {};
  return {
    tools: { allow: intersect(g.tools?.allow, u.tools?.allow), deny: union(g.tools?.deny, u.tools?.deny) },
    files: {
      read_roots: intersectRoots(gf.read_roots, uf.read_roots),
      write_roots: intersectRoots(gf.write_roots, uf.write_roots),
      deny_basenames: union(gf.deny_basenames, uf.deny_basenames),
      allowed_extensions: intersect(gf.allowed_extensions, uf.allowed_extensions),
      reject_symlinks: (gf.reject_symlinks ?? true) || (uf.reject_symlinks ?? false),
      max_bytes: minDefined(gf.max_bytes, uf.max_bytes),
      require_approval_roots: union(gf.require_approval_roots, uf.require_approval_roots),
    },
    network: {
      allowed_schemes: intersect(gn.allowed_schemes, un.allowed_schemes),
      allow_hosts: intersect(gn.allow_hosts?.map((h) => h.toLowerCase()), un.allow_hosts?.map((h) => h.toLowerCase())),
      allow_subdomains: (gn.allow_subdomains ?? false) && (un.allow_subdomains ?? true),
      allowed_ports: intersect(gn.allowed_ports, un.allowed_ports),
      allowed_methods: intersect(gn.allowed_methods?.map((m) => m.toUpperCase()), un.allowed_methods?.map((m) => m.toUpperCase())),
      allow_endpoints: intersect(gn.allow_endpoints, un.allow_endpoints),
      fixture_exceptions: union(gn.fixture_exceptions, un.fixture_exceptions),
      deny_non_public_ips: (gn.deny_non_public_ips ?? true) || (un.deny_non_public_ips ?? false),
      follow_redirects: (gn.follow_redirects ?? false) && (un.follow_redirects ?? true),
    },
    budgets: {
      session_total_tokens: minDefined(gb.session_total_tokens, ub.session_total_tokens),
      session_tool_attempts: minDefined(gb.session_tool_attempts, ub.session_tool_attempts),
      session_model_requests: minDefined(gb.session_model_requests, ub.session_model_requests),
      session_wall_seconds: minDefined(gb.session_wall_seconds, ub.session_wall_seconds),
      session_cost_usd_micros: minDefined(gb.session_cost_usd_micros, ub.session_cost_usd_micros),
      tool_timeout_seconds: minDefined(gb.tool_timeout_seconds, ub.tool_timeout_seconds),
    },
    shell: {
      enabled: (gs.enabled ?? true) && (us.enabled ?? true),
      max_command_bytes: minDefined(gs.max_command_bytes, us.max_command_bytes) ?? 8192,
      timeout_seconds: minDefined(gs.timeout_seconds, us.timeout_seconds) ?? 30,
      execution_profile: gs.execution_profile ?? 'demo_prepared',
      require_isolation: (gs.require_isolation ?? false) || (us.require_isolation ?? false),
    },
    models: {
      allow_aliases: intersect(gm.allow_aliases, um.allow_aliases),
      max_input_tokens: minDefined(gm.max_input_tokens, um.max_input_tokens),
      max_output_tokens: minDefined(gm.max_output_tokens, um.max_output_tokens),
    },
  };
}
