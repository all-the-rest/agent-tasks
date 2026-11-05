import { checkUrl } from '@agent-tasks/shared';
import type { UrlCheckOptions } from '@agent-tasks/shared';

export const CRAWLER_USER_AGENT = 'AgentTasksResearchBot/0.2';
export const CRAWLER_PRODUCT_TOKEN = 'AgentTasksResearchBot';

const MAX_CACHED_ORIGINS_PER_SESSION = 100;
const MAX_ROBOTS_FETCHES_PER_SESSION = 100;
const POLICY_CACHE_TTL_MS = 10 * 60_000;
const FAILURE_CACHE_TTL_MS = 30_000;
const MAX_ROBOTS_CONTENT_BYTES = 512 * 1024;
const MAX_RULE_BYTES = 64 * 1024;
const MAX_MATCH_PATH_BYTES = 8 * 1024;

export interface RobotsResponse {
  status: number;
  body: string;
}

export interface RobotsFetcher {
  fetchRobots(url: string, userAgent: string): Promise<RobotsResponse>;
}

interface Rule {
  allow: boolean;
  parts: string[];
  startsWith: boolean;
  endsWith: boolean;
  trailingWildcard: boolean;
  specificity: number;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface RobotsPolicy {
  isAllowed(target: string | URL): boolean;
}

function normalizeEscapes(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (escape, hex: string) => {
    const octet = Number.parseInt(hex, 16);
    const character = String.fromCharCode(octet);
    return /^[a-z0-9._~-]$/i.test(character) ? character : escape.toUpperCase();
  });
}

function normalizeRobotsOctets(value: string): string {
  let encoded = '';
  for (const character of value) {
    encoded += character.charCodeAt(0) > 0x7f ? encodeURIComponent(character) : character;
  }
  return normalizeEscapes(encoded);
}

function compileRule(value: string, allow: boolean): Rule | null {
  if (!value) return null;
  const normalized = normalizeRobotsOctets(value);
  const anchoredAtEnd = normalized.endsWith('$');
  const body = anchoredAtEnd ? normalized.slice(0, -1) : normalized;
  const parts = body.split('*');
  const literal = parts.join('');
  return {
    allow,
    parts,
    startsWith: !body.startsWith('*'),
    endsWith: anchoredAtEnd,
    trailingWildcard: body.endsWith('*'),
    specificity: Buffer.byteLength(literal, 'utf8'),
  };
}

function matchesRule(path: string, rule: Rule): boolean {
  let pathOffset = 0;
  const nonEmptyParts = rule.parts.filter(Boolean);
  for (let index = 0; index < nonEmptyParts.length; index += 1) {
    const part = nonEmptyParts[index] ?? '';
    if (index === 0 && rule.startsWith) {
      if (!path.startsWith(part)) return false;
      pathOffset = part.length;
      continue;
    }
    const isFinalPart = index === nonEmptyParts.length - 1;
    if (isFinalPart && rule.endsWith && !rule.trailingWildcard) {
      const suffixOffset = path.length - part.length;
      if (suffixOffset < pathOffset || !path.endsWith(part)) return false;
      pathOffset = path.length;
      continue;
    }
    const matchOffset = path.indexOf(part, pathOffset);
    if (matchOffset < 0) return false;
    pathOffset = matchOffset + part.length;
  }
  return !rule.endsWith || rule.trailingWildcard || pathOffset === path.length;
}

function selectedRules(groups: Group[], productToken: string): Rule[] {
  const agent = productToken.toLowerCase();
  const matching = groups.flatMap((group) => {
    const specificity = group.agents.reduce((best, name) => {
      const token = name.toLowerCase();
      if (token === '*') return best;
      return agent.includes(token) ? Math.max(best, token.length) : best;
    }, -1);
    return specificity >= 0 ? [{ specificity, rules: group.rules }] : [];
  });
  const bestSpecificity = matching.reduce((best, group) => Math.max(best, group.specificity), -1);
  if (bestSpecificity >= 0) {
    return matching.filter((group) => group.specificity === bestSpecificity).flatMap((group) => group.rules);
  }
  return groups.filter((group) => group.agents.some((name) => name.trim() === '*')).flatMap((group) => group.rules);
}

export function parseRobotsTxt(content: string, productToken = CRAWLER_PRODUCT_TOKEN): RobotsPolicy {
  if (Buffer.byteLength(content, 'utf8') > MAX_ROBOTS_CONTENT_BYTES) return { isAllowed: () => false };
  const groups: Group[] = [];
  let current: Group | null = null;
  let ruleBytes = 0;
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  for (const rawLine of text.split(/\r\n?|\n/)) {
    const line = rawLine.split('#', 1)[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.rules.length > 0 || current.agents.length === 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value);
      continue;
    }

    if (!current || (field !== 'allow' && field !== 'disallow')) continue;
    ruleBytes += Buffer.byteLength(value, 'utf8');
    if (ruleBytes > MAX_RULE_BYTES) return { isAllowed: () => false };
    const rule = compileRule(value, field === 'allow');
    if (rule) current.rules.push(rule);
  }

  const rules = selectedRules(groups, productToken);
  return {
    isAllowed(target) {
      let url: URL;
      try {
        url = target instanceof URL ? target : new URL(target);
      } catch {
        return false;
      }
      const path = normalizeRobotsOctets(`${url.pathname}${url.search}`);
      if (Buffer.byteLength(path, 'utf8') > MAX_MATCH_PATH_BYTES) return false;
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!matchesRule(path, rule)) continue;
        if (!best || rule.specificity > best.specificity
          || (rule.specificity === best.specificity && rule.allow && !best.allow)) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}

interface CacheEntry {
  expiresAt: number;
  policy: Promise<RobotsPolicy | null>;
}

/** A cache scoped to one BrowserContext; it is never shared across executions. */
export class SessionRobotsPolicy {
  private readonly cache = new Map<string, CacheEntry>();
  private fetchCount = 0;

  constructor(private readonly fetcher: RobotsFetcher, private readonly urlOptions: UrlCheckOptions = {}) {}

  async isAllowed(target: string | URL): Promise<boolean> {
    let checked: URL;
    try {
      checked = checkUrl(target, this.urlOptions).url;
    } catch {
      return false;
    }

    const origin = checked.origin;
    const existing = this.cache.get(origin);
    if (existing && existing.expiresAt > Date.now()) {
      const policy = await existing.policy;
      return policy?.isAllowed(checked) ?? false;
    }
    if (this.fetchCount >= MAX_ROBOTS_FETCHES_PER_SESSION) return false;

    if (!existing && this.cache.size >= MAX_CACHED_ORIGINS_PER_SESSION) {
      const oldest = [...this.cache.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (!oldest || oldest[1].expiresAt > Date.now()) return false;
      this.cache.delete(oldest[0]);
    }

    this.fetchCount += 1;
    const entry: CacheEntry = { expiresAt: Date.now() + FAILURE_CACHE_TTL_MS, policy: Promise.resolve(null) };
    entry.policy = this.load(origin).then(({ policy, ttl }) => {
      entry.expiresAt = Date.now() + ttl;
      return policy;
    }).catch(() => {
      entry.expiresAt = Date.now() + FAILURE_CACHE_TTL_MS;
      return null;
    });
    this.cache.set(origin, entry);
    const policy = await entry.policy;
    return policy?.isAllowed(checked) ?? false;
  }

  private async load(origin: string): Promise<{ policy: RobotsPolicy | null; ttl: number }> {
    const robotsUrl = new URL('/robots.txt', origin);
    // checkUrl is also run by the proxy for each redirect, before any socket is opened.
    const checkedRobotsUrl = checkUrl(robotsUrl, this.urlOptions).url;
    const response = await this.fetcher.fetchRobots(checkedRobotsUrl.toString(), CRAWLER_USER_AGENT);
    if (response.status >= 200 && response.status < 300) {
      return { policy: parseRobotsTxt(response.body), ttl: POLICY_CACHE_TTL_MS };
    }
    if (response.status >= 400 && response.status < 500) {
      // RFC 9309 treats a 4xx robots response as unavailable, so crawling is permitted.
      return { policy: parseRobotsTxt(''), ttl: POLICY_CACHE_TTL_MS };
    }
    // 5xx, malformed statuses, and other errors are unreachable: fail closed.
    return { policy: null, ttl: FAILURE_CACHE_TTL_MS };
  }
}
