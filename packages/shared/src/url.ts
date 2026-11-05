/**
 * Returns a credential-free HTTP(S) URL string, or null for every other value.
 *
 * Shared by report validation, export rendering and the web UI so a source can
 * never turn into a clickable `javascript:`, `data:` or otherwise unsafe link.
 */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // URLs are public citations, never a place to preserve embedded credentials.
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}
