import { describe, expect, it, vi } from 'vitest';
import {
  CRAWLER_USER_AGENT,
  parseRobotsTxt,
  SessionRobotsPolicy,
} from '../src/robots-policy.js';
import type { RobotsFetcher } from '../src/robots-policy.js';

describe('robots.txt parser', () => {
  it('selects the most specific user-agent groups instead of wildcard groups', () => {
    const policy = parseRobotsTxt(`
User-agent: *
Disallow: /

User-agent: AgentTasksResearchBot
Allow: /public
Disallow: /
`);

    expect(policy.isAllowed('https://example.com/public/article')).toBe(true);
    expect(policy.isAllowed('https://example.com/private')).toBe(false);
  });

  it('uses the longest path match, Allow on ties, and supports wildcard/end-anchor rules', () => {
    const policy = parseRobotsTxt(`
User-agent: AgentTasksResearchBot
Disallow: /private*
Allow: /private/public
Disallow: /exact$
Allow: /tie
Disallow: /tie
`);

    expect(policy.isAllowed('https://example.com/private/public/page')).toBe(true);
    expect(policy.isAllowed('https://example.com/private/secret')).toBe(false);
    expect(policy.isAllowed('https://example.com/exact')).toBe(false);
    expect(policy.isAllowed('https://example.com/exact/more')).toBe(true);
    expect(policy.isAllowed('https://example.com/tie')).toBe(true);
  });

  it('combines groups with the same matching user-agent and matches encoded paths and queries', () => {
    const policy = parseRobotsTxt(`
User-agent: AgentTasksResearchBot
Disallow: /first
Disallow: /files/~private
Disallow: /café

User-agent: AgentTasksResearchBot
Disallow: /second
Allow: /search?public=1
`);

    expect(policy.isAllowed('https://example.com/first')).toBe(false);
    expect(policy.isAllowed('https://example.com/files/%7Eprivate/item')).toBe(false);
    expect(policy.isAllowed('https://example.com/caf%C3%A9')).toBe(false);
    expect(policy.isAllowed('https://example.com/second')).toBe(false);
    expect(policy.isAllowed('https://example.com/search?public=1')).toBe(true);
    expect(policy.isAllowed('https://example.com/search?private=1')).toBe(true);
  });

  it('fails closed on over-budget rules and navigation paths', () => {
    const oversizedRules = parseRobotsTxt(`User-agent: *\nDisallow: ${'*'.repeat(65 * 1024)}`);
    const ordinaryPolicy = parseRobotsTxt('User-agent: *\nAllow: /');

    expect(oversizedRules.isAllowed('https://example.com/public')).toBe(false);
    expect(ordinaryPolicy.isAllowed(`https://example.com/${'x'.repeat(9 * 1024)}`)).toBe(false);
  });
});

describe('session robots policy', () => {
  it('allows missing robots files, uses the crawler user-agent, and caches by origin in the session', async () => {
    const fetchRobots = vi.fn<RobotsFetcher['fetchRobots']>().mockResolvedValue({ status: 404, body: '' });
    const session = new SessionRobotsPolicy({ fetchRobots });

    expect(await session.isAllowed('https://example.com/page')).toBe(true);
    expect(await session.isAllowed('https://example.com/other')).toBe(true);
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    expect(fetchRobots).toHaveBeenCalledWith('https://example.com/robots.txt', CRAWLER_USER_AGENT);
  });

  it('uses the configured allowed-port policy for robots origins', async () => {
    const fetchRobots = vi.fn<RobotsFetcher['fetchRobots']>().mockResolvedValue({ status: 404, body: '' });
    const session = new SessionRobotsPolicy({ fetchRobots }, { allowedPorts: [8080], allowHttp: true });

    expect(await session.isAllowed('https://example.com:8080/page')).toBe(true);
    expect(fetchRobots).toHaveBeenCalledWith('https://example.com:8080/robots.txt', CRAWLER_USER_AGENT);
  });

  it('fails closed on server errors, failed fetches, and unsafe origins', async () => {
    const unavailable = new SessionRobotsPolicy({
      fetchRobots: vi.fn<RobotsFetcher['fetchRobots']>().mockResolvedValue({ status: 503, body: '' }),
    });
    const failed = new SessionRobotsPolicy({
      fetchRobots: vi.fn<RobotsFetcher['fetchRobots']>().mockRejectedValue(new Error('proxy denied target')),
    });

    expect(await unavailable.isAllowed('https://example.com/page')).toBe(false);
    expect(await failed.isAllowed('https://example.com/page')).toBe(false);
    expect(await failed.isAllowed('http://127.0.0.1/private')).toBe(false);
  });

  it('keeps policy caches isolated between sessions', async () => {
    const fetchRobots = vi.fn<RobotsFetcher['fetchRobots']>().mockResolvedValue({ status: 404, body: '' });
    const firstSession = new SessionRobotsPolicy({ fetchRobots });
    const secondSession = new SessionRobotsPolicy({ fetchRobots });

    await firstSession.isAllowed('https://example.com/page');
    await firstSession.isAllowed('https://example.com/another');
    await secondSession.isAllowed('https://example.com/page');

    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it('caps cached origins and robots fetches per session', async () => {
    const fetchRobots = vi.fn<RobotsFetcher['fetchRobots']>().mockResolvedValue({ status: 404, body: '' });
    const session = new SessionRobotsPolicy({ fetchRobots });

    for (let index = 0; index < 100; index += 1) {
      expect(await session.isAllowed(`https://site-${index}.example/page`)).toBe(true);
    }
    expect(await session.isAllowed('https://site-over-limit.example/page')).toBe(false);
    expect(fetchRobots).toHaveBeenCalledTimes(100);
  });
});
