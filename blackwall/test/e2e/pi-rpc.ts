import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.ts';

export interface PiRun {
  events: Record<string, unknown>[];
  /** Every text the agent produced or received as tool output, joined (to assert that nothing sensitive appeared). */
  transcript: string;
  toolCalls: { name: string; args: Record<string, unknown>; isError?: boolean; text?: string }[];
  confirms: { title: string; message: string }[];
  /** What the user would have seen in the chat, in order (assistant turns incl. provider errors). */
  assistant: { text: string; stopReason?: string; error?: string }[];
  stderr: string;
}

export interface PiOptions {
  baseUrl: string;
  sessionToken: string;
  cwd: string;
  /** Decides the approval dialog, standing in for the human user. */
  onConfirm?: (title: string, message: string) => boolean;
  timeoutMs?: number;
}

const CLI = join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');

/** A real Pi process in RPC mode with only the Blackwall extension. One instance can run several prompts. */
export class PiSession {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private waiters: ((e: Record<string, unknown>) => void)[] = [];
  readonly run: PiRun = { events: [], transcript: '', toolCalls: [], confirms: [], assistant: [], stderr: '' };
  private readonly opts: PiOptions;
  private seq = 0;
  private exited: string | undefined;

  constructor(opts: PiOptions) {
    this.opts = opts;
    this.child = spawn(
      process.execPath,
      [CLI, '--mode', 'rpc', '--no-session', '-ne', '-ns', '-np', '--no-themes', '-nc', '-e', join(ROOT, 'plugin', 'blackwall.ts'), '--provider', 'blackwall', '--model', 'demo-agent', '--tools', 'read,write,edit,ls,find,grep,bash,http_request'],
      {
        cwd: opts.cwd,
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), 'bw-pi-')), PI_OFFLINE: '1', BLACKWALL_URL: opts.baseUrl, BLACKWALL_SESSION_TOKEN: opts.sessionToken },
      },
    );
    this.child.stderr.on('data', (d: Buffer) => (this.run.stderr += d.toString()));
    this.child.stdout.on('data', (d: Buffer) => this.onData(d));
    // A dead Pi must fail the run at once, with its exit code and stderr, instead of waiting for a timeout.
    this.child.on('exit', (code, signal) => {
      this.exited = `Pi exited (code ${code}, signal ${signal}). stderr: ${this.run.stderr.slice(-600) || '(empty)'}`;
      for (const w of this.waiters.splice(0)) w({ type: 'pi_exited' });
    });
    this.child.on('error', (e) => {
      this.exited = `Pi failed to start: ${e.message}`;
      for (const w of this.waiters.splice(0)) w({ type: 'pi_exited' });
    });
  }

  private onData(d: Buffer): void {
    this.buf += d.toString('utf8');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(e);
    }
  }

  private handle(e: Record<string, unknown>): void {
    this.run.events.push(e);
    if (e.type === 'extension_ui_request' && e.method === 'confirm') {
      const title = String(e.title ?? '');
      const message = String(e.message ?? '');
      this.run.confirms.push({ title, message });
      const ok = this.opts.onConfirm ? this.opts.onConfirm(title, message) : false;
      this.send({ type: 'extension_ui_response', id: e.id, confirmed: ok });
    }
    if (e.type === 'tool_execution_start') this.run.toolCalls.push({ name: String(e.toolName), args: (e.args ?? {}) as Record<string, unknown> });
    if (e.type === 'tool_execution_end') {
      const call = [...this.run.toolCalls].reverse().find((c) => c.name === e.toolName && c.text === undefined);
      const content = ((e.result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []).map((c) => c.text ?? '').join('\n');
      if (call) {
        call.isError = Boolean(e.isError);
        call.text = content;
      }
      this.run.transcript += `\n${content}`;
    }
    if (e.type === 'message_end') {
      const m = e.message as { role?: string; content?: { type: string; text?: string }[] | string; stopReason?: string; errorMessage?: string };
      if (m?.role === 'assistant' && Array.isArray(m.content)) {
        const text = m.content.map((c) => c.text ?? '').join('\n').trim();
        this.run.transcript += '\n' + text;
        if (text || m.errorMessage) this.run.assistant.push({ text, stopReason: m.stopReason, error: m.errorMessage });
      }
    }
    for (const w of this.waiters.splice(0)) w(e);
  }

  private send(cmd: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  /** Send a prompt and wait until Pi has nothing more to do on its own. */
  async prompt(message: string): Promise<void> {
    const id = `p-${++this.seq}`;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi did not settle in time. stderr: ${this.run.stderr.slice(-400)}`)), this.opts.timeoutMs ?? 180_000);
      const check = (e: Record<string, unknown>) => {
        if (e.type === 'pi_exited') {
          clearTimeout(timer);
          reject(new Error(this.exited ?? 'Pi exited'));
        } else if (e.type === 'agent_settled') {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
    if (this.exited) throw new Error(this.exited);
    this.send({ id, type: 'prompt', message });
    await done;
  }

  close(): void {
    this.child.kill('SIGKILL');
  }
}
