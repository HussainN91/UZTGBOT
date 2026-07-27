/**
 * Every setting the bot needs, validated once at start-up.
 *
 * Apps Script read settings lazily from Script Properties, so a missing or
 * placeholder value surfaced as a runtime failure in front of a teacher, hours
 * or weeks after deploy. Here the process refuses to start. A server that will
 * not boot is a far cheaper failure than a bot that boots and misbehaves.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * The Apps Script version shipped this literal string and the runbook listed
 * replacing it as a pre-launch blocker, where it stayed unreplaced. Anything
 * still carrying the marker is rejected, so the blocker cannot be forgotten —
 * it stops the server instead of reaching a teacher who is asking for help.
 */
const PLACEHOLDER_MARKER = 'PLACEHOLDER';

const notPlaceholder = (label: string) =>
  z.string().trim().min(1).refine((v) => !v.toUpperCase().includes(PLACEHOLDER_MARKER), {
    message: `${label} is still a placeholder. Set a real value — this is a launch blocker, not a formality.`,
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /** Postgres. Holds every record, every in-progress conversation, and the job queue. */
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required'),

  /** From @BotFather. Anyone holding this can impersonate the bot to every teacher. */
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'TELEGRAM_BOT_TOKEN does not look like a bot token (<digits>:<secret>)'),

  /**
   * Sent by Telegram in the X-Telegram-Bot-Api-Secret-Token header on every
   * webhook call, and compared in constant time.
   *
   * The Apps Script version carried this in the webhook URL's query string,
   * because Apps Script could not read request headers reliably. A URL lands in
   * proxy logs, browser history and referrer headers; a header does not. Telegram
   * permits 1-256 chars of A-Z a-z 0-9 _ and -.
   */
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .trim()
    .min(32, 'TELEGRAM_WEBHOOK_SECRET must be at least 32 characters — generate it randomly, do not invent one')
    .regex(/^[A-Za-z0-9_-]+$/, 'Telegram only accepts A-Z, a-z, 0-9, _ and - in the webhook secret'),

  /** Public HTTPS origin Telegram posts to, e.g. https://bot.example.uz — no trailing path. */
  PUBLIC_URL: z
    .string()
    .trim()
    .refine((v) => v.startsWith('https://'), 'PUBLIC_URL must be https:// — Telegram refuses plaintext webhooks')
    .refine((v) => !v.endsWith('/'), 'PUBLIC_URL must not end with a slash'),

  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  /**
   * A real MoPSE support email or phone, shown to any teacher the roster does not
   * recognise and to anyone exercising their privacy rights.
   */
  SUPPORT_CONTACT: notPlaceholder('SUPPORT_CONTACT'),

  /** Google Sheet the FAQ and roster are read from. Read-only; the bot never writes to it. */
  GOOGLE_SHEET_ID: z.string().trim().min(1).optional(),
  /** Service-account JSON key, as a single line. Needs read access to that sheet only. */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().trim().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parse and validate the environment. Reports every problem at once rather than
 * one per restart — an operator setting up a new server should see the whole
 * list, not discover it a variable at a time.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Configuration is not valid, so the bot will not start.\n${issues}\n\n` +
        `See .env.example for every required value.`,
    );
  }
  return parsed.data;
}

/** The validated environment. Throws on first use if anything is wrong. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test seam: forget the cached environment. */
export function resetEnvForTests(): void {
  cached = null;
}
