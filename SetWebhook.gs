/**
 * SetWebhook.gs — one-time registration of the deployed web app URL with
 * Telegram. Nothing works until this has been run once, after every
 * (re)deployment that changes the web app URL.
 *
 * Prerequisites (set in Project Settings > Script Properties before running):
 *   BOT_TOKEN       — from @BotFather
 *   WEBHOOK_SECRET  — any random string you choose; also appended to the
 *                     deployed URL as ?secret=... (see Webhook.gs)
 *   WEBAPP_URL      — the /exec URL from Deploy > Manage deployments,
 *                     WITHOUT the ?secret= query param (added here)
 */
function setWebhook() {
  const secret = getWebhookSecret();
  const baseUrl = getWebAppUrl();
  const url = baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'secret=' + encodeURIComponent(secret);

  const result = callSetWebhook_(url, secret);
  Logger.log(JSON.stringify(result));

  if (!result.ok) {
    throw new Error('setWebhook failed: ' + JSON.stringify(result));
  }
  Logger.log('Webhook registered at: ' + url);
  return result;
}

/** Confirms what Telegram currently has on file — run any time to check status. */
function getWebhookInfo() {
  const info = callGetWebhookInfo_();
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/** Emergency stop — proposal §7 "create an emergency method to revoke the bot token
 * and disable submissions". This half disables delivery; token revocation is done
 * via @BotFather /revoke. */
function deleteWebhook() {
  const result = callDeleteWebhook_();
  Logger.log(JSON.stringify(result));
  return result;
}
