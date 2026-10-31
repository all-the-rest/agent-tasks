# E-mail DSL

Agents compose the completion e-mail in a compact, Markdown-like DSL. The model
never writes HTML: the server parses the DSL into validated blocks and renders
table-based, inline-styled HTML plus a plain-text alternative.

The DSL is exposed through the `compose_email` tool. The tool is only offered
when the task setting is **Email me** (`notification: "email"`); a task without
e-mail notification cannot compose blocks.

## Grammar

| Syntax | Block |
| --- | --- |
| `# Heading` | Level-1 heading |
| `## Heading` | Level-2 heading |
| Text lines separated by a blank line | Paragraph (line breaks preserved) |
| `![alt text](https://example.com/image.png)` | Image |
| `{{Button label \| https://example.com/executions/1}}` | Button |
| `---` | Divider |
| `:::imageText side=left image=https://example.com/chart.png alt="Chart"`<br>`Text beside the image.`<br>`:::` | Image beside text (`side=left` or `right`, optional `width`) |

Only `http(s)` URLs are accepted. The total is capped at 20 blocks; text is
HTML-escaped and image/button targets are validated before rendering.

## Example

```text
# Weekly revenue report

Revenue grew 12% in the last quarter.

:::imageText side=right image=https://example.com/chart.png alt="Revenue chart"
The chart shows the quarterly trend. Numbers are from the cited sources.
:::

## Sources

- https://example.com/report

{{Open execution | https://tasks.example.com/executions/123}}
```

This yields: heading, paragraph, `imageText`, heading, paragraph, button. The
plain-text part mirrors the same content with `[image] <url>` lines.

## Errors

The parser returns a typed error that the model sees as the tool result, so it
can correct the call:

- `line N: unknown directive "gallery"`
- `line N: unterminated :::imageText block`
- `line N: only http(s) URLs are allowed`
- `the DSL produced no blocks`

## Where it lives

- Parser: `packages/shared/src/email-dsl.ts`
- Block schema + HTML/text renderer: `packages/shared/src/email-blocks.ts`
- Agent tools: `compose_email` and `add_email_block` in
  `packages/agent-runtime/src/tools.ts`
- Delivery: `apps/worker/src/executor.ts` and `apps/worker/src/mailer.ts`
