import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlledFileTool } from '../../plugin/file-tools.ts';
import { effectiveScope } from '../../src/config/effective.ts';
import { CountingJudge, makeFixture, StubGuardian } from '../helpers.ts';

function fixture() {
  const fx = makeFixture({judge: new CountingJudge(), guardian: new StubGuardian()});
  const cwd = join(fx.ws, 'project');
  const scope = effectiveScope(fx.policy, 'developer-demo').files;
  writeFileSync(join(cwd, '.env'), 'INTERNAL_NOTE=private_hidden_canary\n');
  writeFileSync(join(cwd, 'notes.md'), 'INTERNAL_NOTE=public_readable\n');
  return {fx, cwd, scope};
}
const text = (r: Awaited<ReturnType<typeof controlledFileTool>>) => r.content[0]!.text;

describe('source authorization for recursive discovery/search', () => {
  it('grep can read the public match without opening a protected .env, including non-secret canaries', async () => {
    const t = fixture();
    const result = text(await controlledFileTool('grep', {path: '.', pattern: 'INTERNAL_NOTE'}, t.cwd, t.scope));
    expect(result).toContain('public_readable');
    expect(result).not.toContain('private_hidden_canary');
    expect(result).not.toContain('.env');
  });
  it('find and ls omit protected names, disallowed extensions, oversized files and descendant symlinks', async () => {
    const t = fixture();
    t.scope.max_bytes = 128;
    writeFileSync(join(t.cwd, 'oversized.md'), 'private_hidden_canary'.repeat(30));
    writeFileSync(join(t.cwd, 'disallowed.bin'), 'private_hidden_canary');
    symlinkSync(join(t.fx.ws, 'clients/boreal'), join(t.cwd, 'other-client'));
    mkdirSync(join(t.cwd, '.env-hidden'));
    t.scope.deny_basenames.push('.env-hidden');
    writeFileSync(join(t.cwd, '.env-hidden', 'private.md'), 'private_hidden_canary');
    for (const name of ['find', 'ls'] as const) {
      const result = text(await controlledFileTool(name, {path: '.', pattern: '**/*'}, t.cwd, t.scope));
      expect(result).toContain('notes.md');
      for (const denied of ['.env', 'oversized.md', 'disallowed.bin', 'other-client', 'private.md']) expect(result).not.toContain(denied);
    }
    expect(text(await controlledFileTool('grep', {pattern: 'private_hidden_canary'}, t.cwd, t.scope))).not.toContain('private_hidden_canary');
  });
  it('rejects explicit protected paths and paths outside the scope before native grep runs', async () => {
    const t = fixture();
    await expect(controlledFileTool('grep', {path: '.env', pattern: '.'}, t.cwd, t.scope)).rejects.toThrow('PROTECTED_FILE');
    await expect(controlledFileTool('find', {path: '../clients/boreal', pattern: '*'}, t.cwd, t.scope)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE');
  });
  it('keeps positive glob, nested pattern and explicit single-file cases functional', async () => {
    const t = fixture();
    mkdirSync(join(t.cwd, 'nested'));
    writeFileSync(join(t.cwd, 'nested', 'note.md'), 'INTERNAL_NOTE=nested_public\n');
    expect(text(await controlledFileTool('find', {pattern: '**/*.md'}, t.cwd, t.scope))).toContain('nested/note.md');
    const selected = text(await controlledFileTool('grep', {pattern: 'INTERNAL_NOTE', glob: 'nested/*.md'}, t.cwd, t.scope));
    expect(selected).toContain('nested_public');
    expect(selected).not.toContain('public_readable');
    expect(text(await controlledFileTool('grep', {pattern: 'INTERNAL_NOTE', path: 'notes.md'}, t.cwd, t.scope))).toContain('public_readable');
  });
  it('caps discovery and handles cancellation before producing results', async () => {
    const t = fixture();
    mkdirSync(join(t.cwd, 'large'));
    for (let i = 0; i < 1005; i++) writeFileSync(join(t.cwd, 'large', `note-${i}.md`), 'public');
    const result = await controlledFileTool('find', {path: 'large', pattern: '*.md', limit: 10000}, t.cwd, t.scope);
    expect(result.details.files_considered).toBe(1000);
    expect(result.details.truncated).toBe(true);
    expect(text(result)).toContain('Search limit reached');
    const controller = new AbortController();
    controller.abort();
    await expect(controlledFileTool('grep', {pattern: '.'}, t.cwd, t.scope, controller.signal)).rejects.toThrow();
  });
});
