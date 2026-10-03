import { lstatSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';

/** True when `child` is `root` itself or lies below it, compared by path component (so /a/b-old is not inside /a/b). */
export function isWithin(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

export function normalizeInputPath(p: string, cwd: string): string {
  const expanded = p.startsWith('@') ? p.slice(1) : p;
  return resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function matchesAnyBasename(path: string, patterns: string[]): string | undefined {
  const base = basename(path);
  return patterns.find((p) => globToRegExp(p).test(base));
}

export interface SymlinkCheck {
  symlink: boolean;
  exists: boolean;
}

/**
 * Detect symlinks in the part of `absPath` below `root`. For a path that does not exist yet
 * (a new file) every existing ancestor below the root is checked, so a new file cannot be created
 * through a symlinked directory. Components above the root are the operator's responsibility.
 */
export function checkSymlinks(absPath: string, root: string): SymlinkCheck {
  const r = resolve(root);
  const rel = resolve(absPath).slice(r.length).split(sep).filter(Boolean);
  let cur = r;
  let exists = true;
  for (const part of rel) {
    cur = resolve(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return { symlink: true, exists: true };
    } catch {
      exists = false;
      break;
    }
  }
  return { symlink: false, exists };
}

export function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
