import process from 'node:process';
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from src/db/schema.ts and committed as SQL.
 *
 * Generating the SQL and checking it in — rather than pushing the schema
 * straight at the database — means the exact statements that will run in
 * production are reviewable in a diff before they run anywhere.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://mopse:mopse@localhost:5432/mopse',
  },
  strict: true,
  verbose: true,
});
