import { z } from 'zod';

export const openUrlAction = z.object({
  action: z.literal('open_url'),
  url: z.string().url().max(2_000),
});

export const extractPageTextAction = z.object({
  action: z.literal('extract_page_text'),
  maxChars: z.number().int().min(200).max(50_000).default(12_000),
});

export const inspectPageAction = z.object({
  action: z.literal('inspect_page'),
});

export const clickElementAction = z.object({
  action: z.literal('click_element'),
  selector: z.string().min(1).max(300),
});

export const fillFormAction = z.object({
  action: z.literal('fill_form'),
  fields: z.array(z.object({ selector: z.string().min(1).max(300), value: z.string().max(2_000) })).min(1).max(20),
  submit: z.boolean().default(false),
});

export const navigateBackAction = z.object({ action: z.literal('navigate_back') });
export const getPageTitleAction = z.object({ action: z.literal('get_page_title') });
export const getCurrentUrlAction = z.object({ action: z.literal('get_current_url') });
export const extractLinksAction = z.object({
  action: z.literal('extract_links'),
  limit: z.number().int().min(1).max(100).default(30),
});

export const browserActionSchema = z.discriminatedUnion('action', [
  openUrlAction,
  extractPageTextAction,
  inspectPageAction,
  clickElementAction,
  fillFormAction,
  navigateBackAction,
  getPageTitleAction,
  getCurrentUrlAction,
  extractLinksAction,
]);

export type BrowserAction = z.infer<typeof browserActionSchema>;

export const browserResultSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  links: z.array(z.object({ text: z.string(), href: z.string() })).optional(),
  elements: z.array(z.object({ tag: z.string(), text: z.string(), selector: z.string().optional() })).optional(),
  blocked: z.string().optional(),
  error: z.string().optional(),
});
export type BrowserResult = z.infer<typeof browserResultSchema>;
