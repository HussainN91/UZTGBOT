/**
 * Point Telegram at this server.
 *
 * In the Apps Script version this was a function someone had to remember to run
 * from the editor, and the secret travelled in the URL. Here it is a deployment
 * step with an explicit secret token, so the header check in the web process has
 * something to compare against.
 *
 *   npm run build && node dist/scripts/set-webhook.js
 *   npx tsx src/scripts/set-webhook.ts --show     # report current state, change nothing
 *   npx tsx src/scripts/set-webhook.ts --delete   # unhook, e.g. before decommissioning
 */
import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../log.js';
import { WEBHOOK_PATH } from '../web/routes.js';

async function main(): Promise<void> {
  const settings = env();
  const bot = new Bot(settings.TELEGRAM_BOT_TOKEN);
  await bot.init();
  const args = new Set(process.argv.slice(2));

  if (args.has('--show')) {
    const info = await bot.api.getWebhookInfo();
    log.info(
      {
        url: info.url || '(none)',
        pendingUpdates: info.pending_update_count,
        lastErrorMessage: info.last_error_message ?? null,
        lastErrorDate: info.last_error_date ?? null,
        maxConnections: info.max_connections ?? null,
      },
      'current webhook registration',
    );
    return;
  }

  if (args.has('--delete')) {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    log.info('webhook deleted; Telegram will stop delivering updates');
    return;
  }

  const url = `${settings.PUBLIC_URL}${WEBHOOK_PATH}`;
  await bot.api.setWebhook(url, {
    secret_token: settings.TELEGRAM_WEBHOOK_SECRET,
    /**
     * Ask only for what is handled. Telegram omits the rest entirely, which
     * keeps the update stream small and makes an unexpected update type a
     * deliberate decision rather than something that quietly starts arriving.
     */
    allowed_updates: ['message', 'callback_query'],
    /**
     * Deliberately false. Updates queued while the server was down are teachers
     * waiting for an answer; dropping them silently discards real requests.
     */
    drop_pending_updates: false,
  });

  log.info({ url, username: bot.botInfo.username }, 'webhook registered with secret token in header');
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'could not register the webhook');
  process.exit(1);
});
