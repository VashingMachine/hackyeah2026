import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { EffectiveScope } from '../config/effective.ts';

export type Check = { ok: true } | { ok: false; code: string; message: string };
const ok: Check = { ok: true };
const no = (code: string, message: string): Check => ({ ok: false, code, message });

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (IPv4 and IPv6). */
export function isNonPublicIp(addr: string): boolean {
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1]!;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16), lo = parseInt(mappedHex[2]!, 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const kind = isIP(a);
  if (kind === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number, number, number];
    if (p === 0 || p === 10 || p === 127) return true;
    if (p === 100 && q >= 64 && q <= 127) return true;
    if (p === 169 && q === 254) return true;
    if (p === 172 && q >= 16 && q <= 31) return true;
    if (p === 192 && q === 168) return true;
    if (p === 192 && q === 0) return true;
    if (p === 198 && (q === 18 || q === 19)) return true;
    if (p >= 224) return true;
    return false;
  }
  if (kind === 6) {
    if (a === '::' || a === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(a)) return true; // link-local fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(a)) return true; // multicast
    if (/^(?:64:ff9b|2001:db8)/.test(a)) return true;
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

/** Parse an IPv4 literal in any of the odd forms URL parsers accept (decimal, hex, octal) — URL() already normalises these. */
export interface ParsedTarget {
  url: URL;
  host: string;
  port: number;
  method: string;
}

export function parseTarget(rawUrl: string, method: string | undefined): ParsedTarget | Check {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return no('URL_INVALID', 'The URL could not be parsed.');
  }
  if (url.username || url.password) return no('URL_CREDENTIALS', 'URLs with embedded credentials are not allowed.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const defaultPort = url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0;
  const port = url.port ? Number(url.port) : defaultPort;
  return { url, host, port, method: (method ?? 'GET').toUpperCase() };
}

export function isCheck(x: ParsedTarget | Check): x is Check {
  return 'ok' in x;
}

export function hostAllowed(host: string, allow: string[] | undefined, subdomains: boolean): boolean {
  if (allow === undefined) return false; // network access needs an explicit allowlist
  return allow.some((h) => host === h || (subdomains && host.endsWith('.' + h)));
}

/** Deterministic network rules on the parsed URL. DNS is checked separately by `checkResolvedAddresses`. */
export function checkNetwork(t: ParsedTarget, net: EffectiveScope['network']): Check {
  const scheme = t.url.protocol.replace(':', '');
  if (!(net.allowed_schemes ?? ['https']).includes(scheme)) return no('NETWORK_SCHEME_DENIED', `Scheme ${scheme} is not allowed.`);
  if (!hostAllowed(t.host, net.allow_hosts, net.allow_subdomains)) return no('NETWORK_HOST_DENIED', `Host ${t.host} is not on the allowlist.`);
  if (net.allowed_ports && !net.allowed_ports.includes(t.port)) return no('NETWORK_PORT_DENIED', `Port ${t.port} is not allowed.`);
  if (net.allowed_methods && !net.allowed_methods.includes(t.method)) return no('NETWORK_METHOD_DENIED', `Method ${t.method} is not allowed for this host.`);
  if (net.allow_endpoints && !net.allow_endpoints.some((e) => t.url.pathname === e || t.url.pathname.startsWith(e.endsWith('/') ? e : e + '/')))
    return no('NETWORK_ENDPOINT_DENIED', `Path ${t.url.pathname} is not an allowed endpoint.`);
  if (net.deny_non_public_ips && !net.fixture_exceptions.includes(`${t.host}:${t.port}`)) {
    const lit = t.host.startsWith('[') ? t.host.slice(1, -1) : t.host;
    if (isIP(lit) && isNonPublicIp(lit)) return no('NETWORK_NON_PUBLIC_IP', 'Requests to private, loopback or link-local addresses are not allowed.');
  }
  return ok;
}

/** Resolve the host and reject if any answer is non-public (guards against DNS names that point inside). */
export async function checkResolvedAddresses(host: string): Promise<Check> {
  if (isIP(host)) return isNonPublicIp(host) ? no('NETWORK_NON_PUBLIC_IP', 'Address is not public.') : ok;
  try {
    const answers = await lookup(host, { all: true, verbatim: true });
    if (answers.length === 0) return no('NETWORK_DNS_FAILED', 'Host did not resolve.');
    for (const a of answers) if (isNonPublicIp(a.address)) return no('NETWORK_NON_PUBLIC_IP', `Host ${host} resolves to a non-public address.`);
    return ok;
  } catch {
    return no('NETWORK_DNS_FAILED', `Host ${host} could not be resolved.`);
  }
}
