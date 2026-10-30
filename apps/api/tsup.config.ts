import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'scripts/seed.ts', 'scripts/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: ['@wallet/shared', '@wallet/db'],
});
