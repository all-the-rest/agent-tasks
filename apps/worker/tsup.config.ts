import { defineConfig } from 'tsup';

export default defineConfig({
  // Workspace packages export TypeScript sources for development. The runtime image
  // only ships the bundle, so their code must be part of it.
  noExternal: [/^@agent-tasks\//],
});
