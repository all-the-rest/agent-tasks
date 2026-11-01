/**
 * The SPA is served by the API image, so one policy must cover both the static
 * files and the JSON/API responses. It matches the former nginx container:
 * same-origin scripts/styles, data images, no framing, no inline scripts.
 *
 * This module has no runtime dependencies so the web tests can assert the
 * generated header without loading the API's Fastify stack.
 */
export const WEB_CSP_DIRECTIVES: Record<string, string[]> = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

export const WEB_CONTENT_SECURITY_POLICY = Object.entries(WEB_CSP_DIRECTIVES)
  .map(([directive, values]) => `${directive.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)} ${values.join(' ')}`)
  .join(';');
