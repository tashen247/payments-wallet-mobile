import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: ['@wallet/shared', '@wallet/db'],
  // Workspace packages are bundled; their npm dependencies stay external and come from node_modules.
  external: ['pg', 'drizzle-orm', 'zod'],
});
