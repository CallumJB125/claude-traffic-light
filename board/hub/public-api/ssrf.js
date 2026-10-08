// Where an outbound webhook may go. A URL is https, has no credentials and
// names a host; every address the host resolves to must be public (no
// loopback, private, link-local, cloud metadata, carrier-grade NAT, multicast
// or reserved range). The caller then connects to the vetted address itself,
// so a second DNS answer cannot swap in an internal one.

import { BlockList, isIP } from 'node:net'; // privacy-flow: hub-outbound-webhooks
import { lookup as dnsLookup } from 'node:dns/promises'; // privacy-flow: hub-outbound-webhooks
import { HubError } from '../db.js';

const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6 = [
  ['::', 128], ['::1', 128], ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
const v4list = new BlockList();
for (const [a, p] of V4) v4list.addSubnet(a, p, 'ipv4');
const v6list = new BlockList();
for (const [a, p] of V6) v6list.addSubnet(a, p, 'ipv6');

const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** True when an address must never receive a webhook. */
export function blockedAddress(address) {
  const a = String(address ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = MAPPED.exec(a);
  if (mapped) return true;
  const family = isIP(a);
  if (family === 4) return v4list.check(a, 'ipv4');
  if (family === 6) return v6list.check(a, 'ipv6');
  return true;
}

const refuse = (message) => new HubError('VALIDATION', message, { reason: 'URL_REFUSED' });

/** → URL. Syntax only: https (http only where allowHttp), no credentials, a host, no fragment. */
export function parseEndpointUrl(raw, { allowHttp = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) throw refuse('url must be an https URL of at most 500 characters');
  let u;
  try { u = new URL(raw.trim()); } catch { throw refuse('url is not a URL'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw refuse('url must use https');
  if (u.username || u.password) throw refuse('url must not contain a user name or password');
  if (u.hash) throw refuse('url must not contain a fragment');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw refuse('url must name a public host');
  return u;
}

/**
 * → {url, host, address, family}: the URL and one vetted address to connect to.
 * Every resolved address is checked (one private answer refuses the host).
 * allowPrivate is for the hub's own tests only (config.outboundWebhooks).
 */
export async function vetEndpoint(raw, { allowHttp = false, allowPrivate = false, lookup = dnsLookup } = {}) {
  const url = parseEndpointUrl(raw, { allowHttp });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let answers;
  if (isIP(host)) answers = [{ address: host, family: isIP(host) }];
  else {
    try { answers = await lookup(host, { all: true, verbatim: true }); } catch { throw refuse('url host does not resolve'); }
  }
  if (!Array.isArray(answers) || !answers.length) throw refuse('url host does not resolve');
  if (!allowPrivate && answers.some((x) => blockedAddress(x.address))) throw refuse('url resolves to a private, loopback or reserved address');
  const pick = answers[0];
  return { url, host, address: pick.address, family: pick.family === 6 || isIP(pick.address) === 6 ? 6 : 4 };
}
