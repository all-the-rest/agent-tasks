import type { ReactElement } from 'react';
import type { EmailBlock } from '@agent-tasks/shared';

/**
 * Read-only preview of the blocks the agent composed for the completion e-mail.
 *
 * The blocks are already schema-validated, but this renderer still maps them to
 * React elements instead of injecting the e-mail HTML itself: no raw HTML sink,
 * and non-http(s) URLs are dropped defensively.
 */
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function ImageBlock({ url, alt, width }: { url: string; alt: string; width: number }): ReactElement | null {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <img
      src={href}
      alt={alt}
      width={width}
      className="h-auto max-w-full rounded-md border border-base-300"
      loading="lazy"
    />
  );
}

export function EmailBlocksPreview({ blocks }: { blocks: EmailBlock[] }): ReactElement {
  return (
    <div className="flex flex-col gap-4" data-testid="email-block-preview">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case 'heading':
            return block.level === 1 ? (
              <h4 key={key} className="text-lg font-semibold">
                {block.text}
              </h4>
            ) : (
              <h5 key={key} className="text-base font-semibold">
                {block.text}
              </h5>
            );
          case 'paragraph':
            return (
              <p key={key} className="whitespace-pre-line text-sm leading-relaxed">
                {block.text}
              </p>
            );
          case 'image':
            return <ImageBlock key={key} url={block.url} alt={block.alt} width={block.width} />;
          case 'imageText': {
            const image = <ImageBlock url={block.imageUrl} alt={block.alt} width={block.imageWidth} />;
            const text = (
              <p key={`${key}-text`} className="whitespace-pre-line text-sm leading-relaxed">
                {block.text}
              </p>
            );
            return (
              <div key={key} className="flex flex-wrap items-start gap-4">
                {block.side === 'left' ? image : text}
                {block.side === 'left' ? text : image}
              </div>
            );
          }
          case 'button': {
            const href = safeUrl(block.url);
            if (!href) return null;
            return (
              <a
                key={key}
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="btn btn-primary btn-sm w-fit"
              >
                {block.label}
              </a>
            );
          }
          case 'divider':
            return <hr key={key} className="border-base-300" />;
        }
      })}
    </div>
  );
}
