import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isNonPublicIp } from '../src/engine/network.ts';

export interface HttpOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  allowNonPublicIps: boolean;
  timeoutSeconds: number;
  maxResponseBytes: number;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  connectedTo: string;
}

/**
 * Controlled HTTP client. The address that is checked is the address that is connected to (the custom `lookup`
 * runs for the actual socket), so a DNS answer cannot change between check and use. Redirects are never followed.
 */
export function controlledRequest(o: HttpOptions): Promise<HttpResult> {
  const url = new URL(o.url);
  const req = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let connectedTo = '';
    const r = req(
      url,
      {
        method: o.method,
        headers: o.headers,
        timeout: o.timeoutSeconds * 1000,
        // Node may call lookup with `all: true` (happy eyeballs) and then expects an array of addresses.
        lookup: (host, lopts, cb) => {
          lookup(host, { all: true, verbatim: true }, (err, addrs) => {
            if (err) return (cb as (e: Error) => void)(err);
            const bad = addrs.find((a) => isNonPublicIp(a.address));
            if (bad && !o.allowNonPublicIps) return (cb as (e: Error) => void)(new Error(`blocked: ${host} resolves to a non-public address`));
            connectedTo = addrs[0]!.address;
            if ((lopts as { all?: boolean }).all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, addrs.map((a) => ({ address: a.address, family: a.family })));
            else (cb as (e: null, a: string, f: number) => void)(null, addrs[0]!.address, addrs[0]!.family);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (size + c.length > o.maxResponseBytes) {
            truncated = true;
            chunks.push(c.subarray(0, Math.max(0, o.maxResponseBytes - size)));
            size = o.maxResponseBytes;
            res.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            connectedTo,
          });
        res.on('end', done);
        res.on('close', done);
      },
    );
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    r.on('error', reject);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}
