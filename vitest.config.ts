import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * Test files run one at a time.
     *
     * There is one test database, and the integration suites set up by
     * truncating the tables they own. Those sets overlap: the sync suite
     * truncates `roster_entries ... CASCADE`, which also empties `teachers`,
     * while the sign-in suite truncates both. Run in parallel they delete each
     * other's fixtures mid-test, and which file loses changes between runs — so
     * the suite fails somewhere different each time and never in the code under
     * test. Exactly the failure `src/test/global-setup.ts` describes for
     * migrations, one layer up.
     *
     * The alternative — a schema or a database per file — buys back a few
     * seconds on a suite that runs in about fifteen, and costs a fixture
     * mechanism that every future integration test has to understand. Not worth
     * it until the suite is slow enough to hurt.
     */
    fileParallelism: false,
    // Integration tests reach for a real PostgreSQL. They skip themselves when
    // TEST_DATABASE_URL is unset so the pure-logic suite still runs anywhere,
    // but a skipped test is not a passing test — see "Running the tests" in
    // README.md for the two commands that run them.
    globals: false,
    // Migrations run once, here, rather than in each integration file's
    // beforeEach: Drizzle's migrator holds no lock, so parallel test files
    // racing to apply 0000 against a fresh database failed at random. See
    // src/test/global-setup.ts.
    globalSetup: ['./src/test/global-setup.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/main.ts', 'src/test/**'],
    },
  },
});
