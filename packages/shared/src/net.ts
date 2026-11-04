import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'carrier_nat'
  | 'link_local'
  | 'metadata'
  | 'unique_local'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

export class NetworkPolicyError extends Error {
  constructor(
    message: string,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function inCidr(octets: number[], base: number[], bits: number): boolean {
  let value = 0;
  let network = 0;
  for (let i = 0; i < 4; i += 1) {
    value = (value << 8) | (octets[i] ?? 0);
    network = (network << 8) | (base[i] ?? 0);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

const IPV4_RULES: Array<{ bits: number; base: number[]; class: AddressClass }> = [
  { base: [0, 0, 0, 0], bits: 8, class: 'unspecified' },
  { base: [10, 0, 0, 0], bits: 8, class: 'private' },
  { base: [100, 64, 0, 0], bits: 10, class: 'carrier_nat' },
  { base: [127, 0, 0, 0], bits: 8, class: 'loopback' },
  { base: [169, 254, 169, 254], bits: 32, class: 'metadata' },
  { base: [169, 254, 0, 0], bits: 16, class: 'link_local' },
  { base: [172, 16, 0, 0], bits: 12, class: 'private' },
  { base: [192, 0, 0, 0], bits: 24, class: 'reserved' },
  { base: [192, 0, 2, 0], bits: 24, class: 'reserved' },
  { base: [192, 88, 99, 0], bits: 24, class: 'reserved' },
  { base: [192, 168, 0, 0], bits: 16, class: 'private' },
  { base: [198, 18, 0, 0], bits: 15, class: 'reserved' },
  { base: [198, 51, 100, 0], bits: 24, class: 'reserved' },
  { base: [203, 0, 113, 0], bits: 24, class: 'reserved' },
  { base: [224, 0, 0, 0], bits: 4, class: 'multicast' },
  { base: [240, 0, 0, 0], bits: 4, class: 'reserved' },
];

function expandIPv6(address: string): string[] | null {
  const zoneIndex = address.indexOf('%');
  const bare = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const dotted = bare.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = parseIPv4(dotted[2] ?? '');
    if (!octets) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    const head = (dotted[1] ?? '').replace(/:$/, '');
    return expandIPv6(`${head}:${high.toString(16)}:${low.toString(16)}`);
  }
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...right];
  if (groups.length !== 8) return null;
  return groups;
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIPv4(address);
    if (!octets) return 'reserved';
    for (const rule of IPV4_RULES) {
      if (inCidr(octets, rule.base, rule.bits)) return rule.class;
    }
    return 'public';
  }
  if (family !== 6) return 'reserved';

  const groups = expandIPv6(address);
  if (!groups) return 'reserved';
  const first = Number.parseInt(groups[0] ?? '0', 16);
  const second = Number.parseInt(groups[1] ?? '0', 16);
  const allZero = groups.every((group) => Number.parseInt(group, 16) === 0);

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) inherit the IPv4 policy.
  const isMapped = groups.slice(0, 5).every((g) => Number.parseInt(g, 16) === 0) && Number.parseInt(groups[5] ?? '0', 16) === 0xffff;
  const isNat64 = first === 0x64 && second === 0xff9b;
  if (isMapped || isNat64) {
    const last = groups.slice(6, 8).map((g) => Number.parseInt(g, 16));
    const embedded = `${(last[0] ?? 0) >> 8}.${(last[0] ?? 0) & 0xff}.${(last[1] ?? 0) >> 8}.${(last[1] ?? 0) & 0xff}`;
    return classifyAddress(embedded);
  }

  if (allZero) return 'unspecified';
  if (first === 0 && second === 0 && groups.slice(2, 7).every((g) => Number.parseInt(g, 16) === 0) && Number.parseInt(groups[7] ?? '0', 16) === 1) {
    return 'loopback';
  }
  if ((first & 0xfe00) === 0xfe00 || (first & 0xffc0) === 0xfec0) return 'link_local';
  if ((first & 0xfe00) === 0xfc00) return 'unique_local';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  if (first === 0x2001 && second === 0x0db8) return 'reserved';
  if (first === 0x2002) return 'reserved';
  return 'public';
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.home.arpa', '.lan', '.corp', '.docker'];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data',
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/**
 * Normalises a hostname: lowercase, punycode, no trailing dot, no URL brackets.
 * IPv6 literals are returned bare so `isIP` and the address policy can classify
 * them; the brackets are a URL syntax detail, not part of the address. Returns
 * null for garbage, including unbalanced or non-IP bracket forms.
 */
export function normalizeHostname(hostname: string): string | null {
  const trimmed = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253) return null;
  if (trimmed.startsWith('[') || trimmed.endsWith(']')) {
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    const inner = trimmed.slice(1, -1);
    return isIP(inner) === 6 ? inner : null;
  }
  if (isIP(trimmed)) return trimmed;
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(ascii)) return null;
  return ascii;
}

export interface UrlCheckOptions {
  /** Extra ports a project explicitly allows (default: 80 and 443 only). */
  allowedPorts?: number[];
  /** Allow plain http (default: true; production can force https). */
  allowHttp?: boolean;
}

export interface CheckedUrl {
  url: URL;
  hostname: string;
  port: number;
}

/**
 * Syntactic half of the egress policy. It cannot stop DNS rebinding on its own —
 * every caller must additionally resolve the hostname and check each address at
 * connect time (see `resolvePublicAddresses` and the browser runner's proxy).
 */
export function checkUrl(raw: string | URL, options: UrlCheckOptions = {}): CheckedUrl {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  } catch {
    throw new NetworkPolicyError('invalid URL', String(raw));
  }
  const allowedPorts = options.allowedPorts ?? [80, 443];
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError(`scheme ${url.protocol} is not allowed`, url.toString());
  }
  if (url.protocol === 'http:' && options.allowHttp === false) {
    throw new NetworkPolicyError('plain http is not allowed', url.toString());
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError('URLs with credentials are not allowed', url.toString());
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new NetworkPolicyError('invalid hostname', url.toString());
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new NetworkPolicyError(`port ${port} is not allowed`, url.toString());
  }
  if (BLOCKED_HOSTS.has(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new NetworkPolicyError(`host ${hostname} is blocked by policy`, url.toString());
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new NetworkPolicyError(`address ${hostname} is not public`, url.toString());
  }
  // IPv6 literals need brackets in a URL; the bare form is only an internal key
  // for isIP/classifyAddress and for callers that resolve the address.
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return { url, hostname, port };
}

export async function resolvePublicAddresses(
  hostname: string,
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<string[]> {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new NetworkPolicyError(`address ${hostname} is not public`);
    return [hostname];
  }
  const records = await lookup(hostname);
  if (records.length === 0) throw new NetworkPolicyError(`host ${hostname} did not resolve`);
  for (const record of records) {
    if (!isPublicAddress(record.address)) {
      throw new NetworkPolicyError(`host ${hostname} resolves to non-public address ${record.address}`);
    }
  }
  return records.map((record) => record.address);
}
