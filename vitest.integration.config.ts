import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // SWC supports emitDecoratorMetadata (esbuild does not).
    // Required for Typegoose models in integration tests where the real
    // classes (with decorators) are loaded instead of being mocked.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    // Integration tests may need more time for MongoDB startup
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
