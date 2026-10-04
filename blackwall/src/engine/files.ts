import { lstatSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { EffectiveScope } from '../config/effective.ts';
import { checkSymlinks, isWithin, matchesAnyBasename, realOrSelf } from '../util/paths.ts';
import type { Check } from './network.ts';

const ok: Check = { ok: true };
const no = (code: string, message: string): Check => ({ ok: false, code, message });

export type FileOp = 'read' | 'write' | 'list';

export interface FileCheckResult {
  check: Check;
  /** For writes: the target exists, so replacing it may need a human. */
  existing: boolean;
  needsApproval: boolean;
}

/** Deterministic path rules: roots by component, deny-listed names, extensions, symlinks, size. */
export function checkFilePath(abs: string, op: FileOp, scope: EffectiveScope['files']): FileCheckResult {
  const roots = op === 'write' ? scope.write_roots : scope.read_roots;
  const fail = (code: string, msg: string): FileCheckResult => ({ check: no(code, msg), existing: false, needsApproval: false });

  const denied = matchesAnyBasename(abs, scope.deny_basenames);
  if (denied) return fail('PROTECTED_FILE', 'This file is protected by the secrets policy.');

  if (roots === undefined || roots.length === 0) return fail('PATH_OUTSIDE_WORKSPACE', 'No directory is allowed for this operation.');
  // macOS exposes /var and /tmp through trusted OS aliases. Pi reports the physical cwd.
  // Resolve the configured root only; symlinks below that anchor still get rejected.
  const root = roots.flatMap(r => [r, realOrSelf(r)]).find((r) => isWithin(r, abs));
  if (!root) return fail('PATH_OUTSIDE_WORKSPACE', 'The path is outside the directories allowed for this session.');

  if (scope.reject_symlinks) {
    const s = checkSymlinks(abs, root);
    if (s.symlink) return fail('SYMLINK_REJECTED', 'Symbolic links are not allowed in the path.');
  }

  if (op !== 'list' && scope.allowed_extensions) {
    const ext = extname(abs).toLowerCase();
    if (!scope.allowed_extensions.includes(ext)) return fail('EXTENSION_DENIED', `Files of type ${ext || '(none)'} are not allowed.`);
  }

  let existing = false;
  try {
    const st = statSync(abs);
    existing = true;
    if (op === 'read' && st.isFile() && scope.max_bytes !== undefined && st.size > scope.max_bytes)
      return fail('INPUT_TOO_LARGE', `The file is larger than the ${scope.max_bytes}-byte limit.`);
  } catch {
    existing = false;
  }
  if (op === 'read' && !existing) return { check: ok, existing, needsApproval: false }; // missing file: tool reports it

  let needsApproval = false;
  if (op === 'write' && existing) {
    try {
      if (lstatSync(abs).isFile()) needsApproval = scope.require_approval_roots.some((r) => isWithin(r, abs) || isWithin(realOrSelf(r), abs));
    } catch {
      /* treated as non-existing */
    }
  }
  return { check: ok, existing, needsApproval };
}
