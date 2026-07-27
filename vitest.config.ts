import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Integration tests reach for a real PostgreSQL. They skip themselves when
    // TEST_DATABASE_URL is unset so the pure-logic suite still runs anywhere,
    // but a skipped test is not a passing test — see deploy/README.md.
    globals: false,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/main.ts'],
    },
  },
});
