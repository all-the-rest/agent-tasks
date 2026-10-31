import { z } from 'zod';
import { checkUrl, emailBlockSchema, NetworkPolicyError } from '@agent-tasks/shared';
import type { EmailBlock } from '@agent-tasks/shared';
import type { SearchProvider } from '@agent-tasks/browser-tools';
import type { BrowserRunnerClient } from '@agent-tasks/browser-tools';
import type { ToolDefinition } from '@agent-tasks/ai-providers';

export interface ToolContext {
  browser: BrowserRunnerClient;
  sessionId: string;
  search: SearchProvider;
  allowForms: boolean;
  visited: Set<string>;
  /** Number of successful page loads/clicks/navigations, including repeated URLs. */
  pageVisits: number;
  queries: string[];
  /** E-mail blocks the agent adds for the completion notification. */
  emailBlocks: EmailBlock[];
  onSource(source: { url: string; title?: string; retrievedAt: string; confidence: 'verified' | 'secondary' | 'unknown'; excerpt?: string }): void;
  limits: { maxPageVisits: number; maxSearchQueries: number; maxOutputBytes: number };
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
  preview: string;
  error?: string;
  blocked?: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: ToolDefinition['parameters'];
  run(input: unknown, context: ToolContext): Promise<ToolOutcome>;
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Truncate a string to a UTF-8 byte budget. Tool output is fed back into the model, so it
 * must respect `maxOutputBytes` even when the payload (page text, search snippets, JSON)
 * is larger than the byte limit. The ellipsis is included in the budget.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = maxBytes >= suffixBytes ? maxBytes - suffixBytes : maxBytes;
  let used = 0;
  let kept = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > budget) break;
    kept += character;
    used += size;
  }
  return maxBytes >= suffixBytes ? `${kept}${suffix}` : kept;
}

function pageBudgetExhausted(context: ToolContext): boolean {
  return context.pageVisits >= context.limits.maxPageVisits;
}

function recordPageVisit(context: ToolContext, url?: string): void {
  context.pageVisits += 1;
  if (url) context.visited.add(url);
}

const searchTool: AgentTool = {
  name: 'search_web',
  description: 'Search the public web and return candidate sources with titles, URLs and snippets. Use before opening pages.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query, 3–12 words' },
      limit: { type: 'integer', description: 'Maximum number of results', minimum: 1, maximum: 10, default: 5 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(input, context) {
    const parsed = z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(10).default(5) }).safeParse(input);
    if (!parsed.success) return { ok: false, content: 'invalid arguments', preview: 'invalid arguments', error: 'invalid_arguments' };
    if (context.queries.length >= context.limits.maxSearchQueries) {
      return { ok: false, content: 'search budget exhausted', preview: 'search budget exhausted', error: 'limit_exceeded' };
    }
    context.queries.push(parsed.data.query);
    const results = await context.search.search(parsed.data.query, parsed.data.limit);
    const filtered = results.filter((result) => {
      try {
        checkUrl(result.url);
        return true;
      } catch {
        return false;
      }
    });
    return {
      ok: true,
      content: truncateToBytes(asJson({ query: parsed.data.query, results: filtered }), context.limits.maxOutputBytes),
      preview: `${filtered.length} results for "${parsed.data.query}"`,
    };
  },
};

const openUrlTool: AgentTool = {
  name: 'open_url',
  description: 'Open a public web page in the isolated browser and return its title and visible text.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
    required: ['url'],
    additionalProperties: false,
  },
  async run(input, context) {
    const parsed = z.object({ url: z.string().max(2_000) }).safeParse(input);
    if (!parsed.success) return { ok: false, content: 'invalid arguments', preview: 'invalid arguments', error: 'invalid_arguments' };
    if (pageBudgetExhausted(context)) {
      return { ok: false, content: 'page visit budget exhausted', preview: 'page visit budget exhausted', error: 'limit_exceeded' };
    }
    try {
      checkUrl(parsed.data.url, { allowHttp: true });
    } catch (error) {
      if (error instanceof NetworkPolicyError) {
        return { ok: false, content: `blocked by network policy: ${error.message}`, preview: 'blocked', error: error.message, blocked: true };
      }
      throw error;
    }
    const result = await context.browser.act(context.sessionId, { action: 'open_url', url: parsed.data.url });
    if (!result.ok) {
      return { ok: false, content: result.blocked ?? result.error ?? 'page could not be opened', preview: 'open failed', error: result.blocked ?? result.error };
    }
    recordPageVisit(context, result.url ?? parsed.data.url);
    const text = truncateToBytes(result.text ?? '', Math.min(context.limits.maxOutputBytes, 12_000));
    context.onSource({
      url: result.url ?? parsed.data.url,
      title: result.title,
      retrievedAt: new Date().toISOString(),
      confidence: 'verified',
      excerpt: text.slice(0, 400),
    });
    return {
      ok: true,
      content: truncateToBytes(asJson({ url: result.url, title: result.title, text }), context.limits.maxOutputBytes),
      preview: `${result.title ?? 'page'} (${text.length} chars)`,
    };
  },
};

const extractPageTextTool: AgentTool = {
  name: 'extract_page_text',
  description: 'Read the already open page again and return more of its visible text.',
  parameters: {
    type: 'object',
    properties: { maxChars: { type: 'integer', description: 'Characters to return', minimum: 200, maximum: 50000, default: 12000 } },
    additionalProperties: false,
  },
  async run(input, context) {
    const parsed = z.object({ maxChars: z.number().int().min(200).max(50_000).default(12_000) }).safeParse(input ?? {});
    if (!parsed.success) return { ok: false, content: 'invalid arguments', preview: 'invalid arguments', error: 'invalid_arguments' };
    const maxChars = Math.min(parsed.data.maxChars, context.limits.maxOutputBytes);
    const result = await context.browser.act(context.sessionId, { action: 'extract_page_text', maxChars });
    const text = truncateToBytes(result.text ?? result.error ?? '', context.limits.maxOutputBytes);
    return { ok: result.ok, content: text, preview: `${text.length} chars` };
  },
};

const inspectPageTool: AgentTool = {
  name: 'inspect_page',
  description: 'List interactive elements and headings of the open page (read-only).',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, context) {
    const result = await context.browser.act(context.sessionId, { action: 'inspect_page' });
    return {
      ok: result.ok,
      content: truncateToBytes(asJson(result.elements ?? []), context.limits.maxOutputBytes),
      preview: `${result.elements?.length ?? 0} elements`,
    };
  },
};

const clickElementTool: AgentTool = {
  name: 'click_element',
  description: 'Click a navigation element (link or button) on the open page. Never use it to submit forms or authenticate.',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string', description: 'CSS selector of a link or button' } },
    required: ['selector'],
    additionalProperties: false,
  },
  async run(input, context) {
    const parsed = z.object({ selector: z.string().min(1).max(300) }).safeParse(input);
    if (!parsed.success) return { ok: false, content: 'invalid arguments', preview: 'invalid arguments', error: 'invalid_arguments' };
    if (pageBudgetExhausted(context)) {
      return { ok: false, content: 'page visit budget exhausted', preview: 'page visit budget exhausted', error: 'limit_exceeded' };
    }
    const result = await context.browser.act(context.sessionId, { action: 'click_element', selector: parsed.data.selector });
    if (result.ok) {
      recordPageVisit(context, result.url);
      if (result.url) context.onSource({ url: result.url, title: result.title, retrievedAt: new Date().toISOString(), confidence: 'verified' });
    }
    return {
      ok: result.ok,
      content: truncateToBytes(asJson({ url: result.url, title: result.title }), context.limits.maxOutputBytes),
      preview: result.ok ? `clicked ${parsed.data.selector}` : 'click failed',
      error: result.error,
    };
  },
};

const fillFormTool: AgentTool = {
  name: 'fill_form',
  description: 'Fill search/filter fields on a public page. Submitting is only allowed with explicit permission and never on login or payment pages.',
  parameters: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] },
      },
      submit: { type: 'boolean', default: false },
    },
    required: ['fields'],
    additionalProperties: false,
  },
  async run(input, context) {
    if (!context.allowForms) return { ok: false, content: 'form filling is disabled by policy', preview: 'denied', error: 'policy_denied', blocked: true };
    const parsed = z
      .object({ fields: z.array(z.object({ selector: z.string().min(1).max(300), value: z.string().max(2_000) })).min(1).max(20), submit: z.boolean().default(false) })
      .safeParse(input);
    if (!parsed.success) return { ok: false, content: 'invalid arguments', preview: 'invalid arguments', error: 'invalid_arguments' };
    const result = await context.browser.act(context.sessionId, { action: 'fill_form', ...parsed.data });
    return {
      ok: result.ok,
      content: truncateToBytes(asJson({ ok: result.ok, url: result.url }), context.limits.maxOutputBytes),
      preview: result.ok ? 'form filled' : 'form failed',
      error: result.error,
    };
  },
};

const navigateBackTool: AgentTool = {
  name: 'navigate_back',
  description: 'Go back in the browser history of this execution.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, context) {
    if (pageBudgetExhausted(context)) {
      return { ok: false, content: 'page visit budget exhausted', preview: 'page visit budget exhausted', error: 'limit_exceeded' };
    }
    const result = await context.browser.act(context.sessionId, { action: 'navigate_back' });
    if (result.ok) recordPageVisit(context, result.url);
    return {
      ok: result.ok,
      content: truncateToBytes(asJson({ url: result.url, title: result.title }), context.limits.maxOutputBytes),
      preview: 'went back',
    };
  },
};

const getPageTitleTool: AgentTool = {
  name: 'get_page_title',
  description: 'Return the title of the open page.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, context) {
    const result = await context.browser.act(context.sessionId, { action: 'get_page_title' });
    const title = truncateToBytes(result.title ?? '', context.limits.maxOutputBytes);
    return { ok: result.ok, content: title, preview: title };
  },
};

const getCurrentUrlTool: AgentTool = {
  name: 'get_current_url',
  description: 'Return the URL of the open page.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, context) {
    const result = await context.browser.act(context.sessionId, { action: 'get_current_url' });
    const url = truncateToBytes(result.url ?? '', context.limits.maxOutputBytes);
    return { ok: result.ok, content: url, preview: url };
  },
};

const extractLinksTool: AgentTool = {
  name: 'extract_links',
  description: 'List links on the open page so you can choose the next source.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
    additionalProperties: false,
  },
  async run(input, context) {
    const parsed = z.object({ limit: z.number().int().min(1).max(100).default(30) }).safeParse(input ?? {});
    if (!parsed.success) return { ok: false, content: 'invalid arguments', preview: 'invalid arguments', error: 'invalid_arguments' };
    const result = await context.browser.act(context.sessionId, { action: 'extract_links', limit: parsed.data.limit });
    return {
      ok: result.ok,
      content: truncateToBytes(asJson(result.links ?? []), context.limits.maxOutputBytes),
      preview: `${result.links?.length ?? 0} links`,
    };
  },
};


const MAX_EMAIL_BLOCKS = 20;

/**
 * Lets the agent compose the completion e-mail. The model passes flat fields; the
 * handler assembles the discriminated block, validates it (http(s) URLs, length)
 * and appends it. `imageText` is the required "image beside text" block.
 */
const addEmailBlockTool: AgentTool = {
  name: 'add_email_block',
  description:
    'Add a block to the e-mail sent to the task owner when this run finishes. Use imageText to place an image beside text; other blocks are heading, paragraph, image, button and divider. Image URLs must be http(s), text is escaped, and at most 20 blocks are accepted.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['heading', 'paragraph', 'image', 'imageText', 'button', 'divider'],
        description: 'Block type. imageText renders an image next to text.',
      },
      text: { type: 'string', description: 'Text for heading, paragraph or imageText.' },
      level: { type: 'integer', minimum: 1, maximum: 2, default: 2, description: 'Heading level (1 or 2).' },
      url: { type: 'string', description: 'http(s) URL for image or button.' },
      imageUrl: { type: 'string', description: 'http(s) image URL for imageText.' },
      alt: { type: 'string', description: 'Accessible image description.' },
      side: { type: 'string', enum: ['left', 'right'], default: 'left', description: 'Image side for imageText.' },
      imageWidth: { type: 'integer', minimum: 80, maximum: 320, default: 200 },
      width: { type: 'integer', minimum: 40, maximum: 600, default: 600 },
      label: { type: 'string', description: 'Button label.' },
    },
    required: ['type'],
    additionalProperties: false,
  },
  async run(input, context): Promise<ToolOutcome> {
    const raw = (input ?? {}) as Record<string, unknown>;
    let candidate: unknown;
    switch (raw.type) {
      case 'heading':
        candidate = { type: 'heading', text: raw.text, level: raw.level ?? 2 };
        break;
      case 'paragraph':
        candidate = { type: 'paragraph', text: raw.text };
        break;
      case 'image':
        candidate = { type: 'image', url: raw.url, alt: raw.alt ?? '', width: raw.width ?? 600 };
        break;
      case 'imageText':
        candidate = {
          type: 'imageText',
          imageUrl: raw.imageUrl,
          alt: raw.alt ?? '',
          text: raw.text,
          side: raw.side ?? 'left',
          imageWidth: raw.imageWidth ?? 200,
        };
        break;
      case 'button':
        candidate = { type: 'button', label: raw.label, url: raw.url };
        break;
      case 'divider':
        candidate = { type: 'divider' };
        break;
      default:
        return {
          ok: false,
          content: 'unsupported email block type; use heading, paragraph, image, imageText, button or divider',
          preview: 'unsupported email block type',
          error: 'invalid_arguments',
        };
    }

    const parsed = emailBlockSchema.safeParse(candidate);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      return { ok: false, content: `invalid email block: ${details}`, preview: 'invalid email block', error: 'invalid_arguments' };
    }
    if (context.emailBlocks.length >= MAX_EMAIL_BLOCKS) {
      return { ok: false, content: `email block limit reached (${MAX_EMAIL_BLOCKS})`, preview: 'email block limit reached', error: 'limit_reached' };
    }

    context.emailBlocks.push(parsed.data);
    const preview = parsed.data.type === 'imageText' ? `imageText (${parsed.data.side})` : parsed.data.type;
    return {
      ok: true,
      content: `Email block ${context.emailBlocks.length} added: ${preview}.`,
      preview: `email block ${context.emailBlocks.length}: ${preview}`,
    };
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  searchTool,
  openUrlTool,
  extractPageTextTool,
  inspectPageTool,
  clickElementTool,
  fillFormTool,
  navigateBackTool,
  getPageTitleTool,
  getCurrentUrlTool,
  extractLinksTool,
  addEmailBlockTool,
];

export const TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);

export function toolDefinitions(allowed: string[]): ToolDefinition[] {
  return AGENT_TOOLS.filter((tool) => allowed.includes(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}
