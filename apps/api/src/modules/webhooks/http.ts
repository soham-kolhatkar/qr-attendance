import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { badRequest } from '../../lib/errors.js';

/**
 * Webhooks send requests to addresses that institutes type in, so a webhook could be
 * pointed at something only our server can reach: the hosting provider's internal
 * services or metadata endpoint, or another app on the same network. Every address a
 * webhook connects to is checked at connection time (after DNS, so a name that resolves
 * to a private address is caught too), and redirects are never followed.
 */
const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv6');
}

/** IPv4 addresses hidden inside IPv6 forms (::ffff:10.0.0.1, 64:ff9b::a00:1) are checked as IPv4. */
function embeddedIpv4(address: string): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isPrivateAddress(address: string): boolean {
  const v4 = net.isIPv4(address) ? address : embeddedIpv4(address);
  if (v4) return PRIVATE.check(v4, 'ipv4');
  return net.isIPv6(address) ? PRIVATE.check(address, 'ipv6') : true;
}

/** Checks a webhook address as typed: https, no credentials, and not a private IP written out. */
export function parseWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('WEBHOOK_URL_INVALID', 'Enter a full address, e.g. https://erp.example.edu/hooks/attendance');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw badRequest('WEBHOOK_URL_INVALID', 'The address must start with https://');
  }
  if (url.username || url.password) throw badRequest('WEBHOOK_URL_INVALID', 'Put credentials in your receiver’s checks, not in the address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateAddress(host)))) {
    throw badRequest('WEBHOOK_URL_PRIVATE', 'The address must be reachable on the public internet');
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A DNS lookup that refuses names pointing at private addresses (exported for tests). */
export function safeLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        const blocked: NodeJS.ErrnoException = new Error(`${hostname} points to a private address`);
        blocked.code = 'EPRIVATE';
        return callback(blocked, []);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export type PostResult = { status: number; body: string };

/** POSTs a webhook body, refusing private addresses. Resolves with any HTTP response; rejects on network errors. */
export async function postWebhook(
  url: URL,
  body: string,
  headers: Record<string, string>,
  options: { allowPrivate: boolean; timeoutMs: number },
): Promise<PostResult> {
  parseWebhookUrl(url.toString(), options.allowPrivate);
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        lookup: safeLookup(options.allowPrivate) as unknown as net.LookupFunction,
        timeout: options.timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (text.length < 500) text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 500) }));
        res.on('error', reject);
      },
    );
    const fail = () => req.destroy(new Error(`No response within ${options.timeoutMs / 1000} s`));
    // An idle timeout, plus a hard limit for receivers that answer very slowly.
    req.on('timeout', fail);
    const deadline = setTimeout(fail, options.timeoutMs * 2);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(body);
  });
}
