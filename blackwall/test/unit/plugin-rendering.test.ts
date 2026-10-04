import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import blackwall from '../../plugin/blackwall.ts';
import { makeFixture, CountingJudge, StubGuardian, ROOT } from '../helpers.ts';

// Exercise Pi's actual interactive renderer merge: undefined restores native edit previews.
describe('Pi UI enforcement boundary', () => {
  it('never substitutes a native edit preview that reads a file before approval', async () => {
    const tools = new Map<string, any>();
    blackwall({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, registerProvider() {} } as any);
    const { withBuiltInRenderers } = await import(join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js'));
    const fx = makeFixture({judge: new CountingJudge(), guardian: new StubGuardian()});
    let invalidations = 0;
    const theme = {fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text};
    const context = {state: {}, cwd: fx.ws, argsComplete: true, executionStarted: false, invalidate() { invalidations++; }};
    const definition = withBuiltInRenderers('edit', tools.get('edit'));
    const view = definition.renderCall({path: join(fx.ws, 'output/atlas-kyc-draft.md'), edits: [{oldText: '#', newText: '# Changed'}]}, theme, context);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(view.render(100).join('\n')).toContain('edit · Blackwall');
    expect(invalidations).toBe(0);
    expect(context.state).toEqual({});
    expect(definition.renderResult).toBe(tools.get('edit').renderResult);
    fx.core.store.close();
  });
});
