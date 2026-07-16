import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Never scan orchestration worktrees or generated-harness output — they
    // carry their own copies of the suite and race on shared user state.
    exclude: ['**/node_modules/**', '.worktrees/**', '.harnage-build-*/**'],
    coverage: {
      provider: 'v8',
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
