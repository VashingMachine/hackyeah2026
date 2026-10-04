// Directory permission is not permission to read every descendant. Filter sources before search.
import { lstat, opendir } from 'node:fs/promises';
import { basename, join, matchesGlob, relative, sep } from 'node:path';
import { createGrepToolDefinition, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { EffectiveScope } from '../src/config/effective.ts';
import { checkFilePath } from '../src/engine/files.ts';
import { normalizeInputPath } from '../src/util/paths.ts';

export async function controlledFileTool(name: 'grep' | 'find' | 'ls', args: Record<string, unknown>, cwd: string, scope: EffectiveScope['files'], signal?: AbortSignal, timeoutSeconds = 30) {
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutSeconds * 1000)]);
  const root = normalizeInputPath(typeof args.path === 'string' ? args.path : '.', cwd);
  const gate = checkFilePath(root, 'list', scope).check;
  if (!gate.ok) throw new Error(`Search path denied (${gate.code}).`);
  const defaultLimit = name === 'ls' ? 500 : name === 'find' ? 1000 : 100;
  const limit = args.limit === undefined ? defaultLimit : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Search limit must be an integer between 1 and 10000.');
  const files: string[] = [], entries: string[] = [];
  let visited = 0, capped = false;
  const readAllowed = (path: string) => checkFilePath(path, 'read', scope).check.ok;
  async function walk(path: string, recursive: boolean) {
    abort.throwIfAborted();
    if (++visited > 10000 || files.length >= 1000) { capped = true; return; }
    const st = await lstat(path);
    if (st.isSymbolicLink()) return; // never follow a descendant link during discovery
    if (st.isFile()) {
      if (name === 'ls') throw new Error('The ls path must be a directory.');
      if (readAllowed(path)) files.push(path);
      return;
    }
    if (!st.isDirectory() || !checkFilePath(path, 'list', scope).check.ok) return;
    // Stream discovery: a large directory must not allocate/sort all entries before the cap.
    for await (const item of await opendir(path)) {
      abort.throwIfAborted();
      if (++visited > 10000) { capped = true; return; }
      const entry = item.name;
      if (entry === '.git' || entry === 'node_modules') continue;
      const child = join(path, entry);
      let childStat;
      try { childStat = await lstat(child); } catch { continue; }
      if (childStat.isSymbolicLink()) continue;
      if (childStat.isDirectory()) {
        if (!checkFilePath(child, 'list', scope).check.ok) continue;
        if (name === 'ls') entries.push(entry + '/');
        if (recursive) await walk(child, true);
      } else if (childStat.isFile() && readAllowed(child)) {
        if (name === 'ls') entries.push(entry);
        else files.push(child);
      }
      if (files.length >= 1000 || (name === 'ls' && entries.length > limit)) { capped = true; return; }
    }
  }
  await walk(root, name !== 'ls');
  const isMatch = (file: string, pattern: string) => matchesGlob(pattern.includes('/') ? relative(root, file).split(sep).join('/') : basename(file), pattern);
  let output: string;
  if (name === 'ls') output = entries.slice(0, limit).join('\n') || '(empty permitted directory)';
  else if (name === 'find') {
    if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('A find glob pattern is required.');
    const matches = files.filter(file => isMatch(file, args.pattern as string));
    capped ||= matches.length > limit;
    output = matches.slice(0, limit).map(file => (relative(root, file) || basename(file)).split(sep).join('/')).join('\n') || 'No permitted files found matching pattern';
  } else {
    if (typeof args.pattern !== 'string') throw new Error('A grep pattern is required.');
    const selected = files.filter(file => typeof args.glob !== 'string' || (args.glob.startsWith('!') ? !isMatch(file, args.glob.slice(1)) : isMatch(file, args.glob)));
    const tool = createGrepToolDefinition(cwd);
    const results: string[] = [];
    let lines = 0;
    for (const file of selected) {
      abort.throwIfAborted();
      // Fresh check immediately before the native grep opens this explicit file.
      if (!readAllowed(file) || (await lstat(file)).isSymbolicLink()) continue;
      const result = await tool.execute('controlled-search', {pattern: args.pattern, path: file, literal: args.literal === true, ignoreCase: args.ignoreCase === true,
        context: typeof args.context === 'number' ? Math.min(20, Math.max(0, args.context)) : 0, limit: Math.max(1, limit - lines)}, abort, undefined, {cwd} as ExtensionToolContext);
      const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('\n');
      if (!text || text === 'No matches found') continue;
      const available = text.split('\n').slice(0, Math.max(0, limit - lines));
      results.push(`${relative(root, file) || basename(file)}:\n${available.join('\n')}`);
      lines += available.length;
      if (lines >= limit || Buffer.byteLength(results.join('\n')) >= 262144) { capped = true; break; }
    }
    output = results.join('\n') || 'No matches found in permitted files';
  }
  const buffer = Buffer.from(output);
  if (buffer.length > 262144) { output = buffer.subarray(0, 262144).toString('utf8'); capped = true; }
  if (capped) output += '\n[Search limit reached; narrow the path or pattern.]';
  return {content: [{type: 'text' as const, text: output}], structuredContent: undefined, details: {policy_filtered: true, files_considered: files.length, truncated: capped}};
}
