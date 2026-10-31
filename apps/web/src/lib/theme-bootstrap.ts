import { applyTheme, storedTheme } from './theme';

/**
 * Applies the persisted colour scheme before React renders.
 *
 * This used to be an inline <script> in index.html, which the production nginx
 * CSP (`script-src 'self'`) blocks. As part of the bundled entrypoint it is
 * covered by 'self' and there is no inline script to allow.
 */
applyTheme(storedTheme());
