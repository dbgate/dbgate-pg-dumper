/**
 * Bundles the package as native ESM and emits declaration files for all public
 * types. Keeping the build configuration small makes the generated package
 * predictable for Node.js consumers and npm publishing tools.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    pg: 'src/pg.ts',
  },
  format: ['esm', 'cjs'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
