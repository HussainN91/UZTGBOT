# VPS deployment — handoff

**Date:** 31 July 2026 · **Status:** in progress · **Goal:** a working test deployment, with fake
teacher data, before the real one goes live for MoPSE

This is a separate document from `docs/plans/2026-07-29-stage-4-handoff.md`, which tracks feature
development stages. This one tracks getting the built software running on a real server, which is
operational work rather than a numbered stage.

---

## ⚠️ The rule that governs every session on this task

**The assistant never receives a password, token, or key — not in this chat, ever.** The head of
project runs every command themselves, over their own SSH connection to the server, and pastes the
output back. The assistant's role is to say exactly what to type and where, and to read the output
that comes back — never to be handed the secret itself.

If a step needs a credential, the assistant says "type this into `.env` on the server" or similar —
never "paste it here."

---

## 1. Where this stands, in one paragraph

The server is up, updated, rebooted, and has Docker installed — **but `docker run hello-world` was
never confirmed to actually work**; that request was made and then the conversation moved to the
domain before the result came back. The domain is chosen and its A record is added and confirmed by
the registrar's panel, but **not yet confirmed to have propagated**. Nothing about getting the code
onto the server, filling in `.env`, or starting the containers has happened yet. No credential of any
kind has been generated, gathered, or entered anywhere.

## 2. The server

| | |
|---|---|
| **IP** | `46.8.195.231` |
| **OS** | Ubuntu 24.04.4 LTS, kernel `6.8.0-136-generic` |
| **Login** | `ssh ubuntu@46.8.195.231`, password auth. Password is known only to the head of project |
| **Hostname** | Reports as `ubuntu`, not the `TGBMOP` the provider's panel names it. Cosmetic; not blocking |
| **Specs** | 4 vCPU, 4 GB RAM, 75 GB disk — above the deploy guide's minimum of 2/4/50 |

**Done:**
- `apt update && apt upgrade -y` — 149 updates applied, one security update among them
- Removed a stale `file:/cdrom` line from `/etc/apt/sources.list` that was throwing an error
- Rebooted for a kernel update; confirmed `0 updates` and no restart-required banner afterward
- Installed Docker via `curl -fsSL https://get.docker.com | sh`
- Ran `sudo usermod -aG docker "$USER"`, then logged out and back in for the group to take effect

**⚠️ Not confirmed, and the first thing to do on resuming:**
```bash
docker run hello-world
```
This was asked for but the result was never pasted back. Do not assume it works — verify it.

## 3. The domain

**Domain:** `fteacherssupport.uz`, already owned, registered at **airnet.uz**. It was previously used
for a different, now-closed project.

**What was wrong and what was fixed:** the domain's nameserver setting was "Specify DNS-servers" with
**empty** nameserver fields — a broken leftover, not something to have submitted. Switched to "Use
company DNS-servers" instead, which put airnet's own DNS (`dns1.airnet.uz`, `dns2.airnet.uz`) in
charge and revealed a DNS records editor that had been hidden.

**Added, and confirmed by the panel ("DNS-record successfully added"):**

| Name | Type | Value |
|---|---|---|
| `bot.fteacherssupport.uz.` | A | `46.8.195.231` |

**Left alone on purpose — pre-existing records from the old project, unrelated to this deployment:**
a root `A` record at `176.96.243.100`, an `MX` record, and `CNAME`s for `mail`, `www`, and `ftp`. None
of these were touched or need to be.

**Not yet done:** confirming the new record has actually propagated. Check with:
```bash
nslookup bot.fteacherssupport.uz
```
run from the head of project's own Windows machine (PowerShell), or any online DNS checker. Until
this resolves to `46.8.195.231`, Caddy cannot obtain a certificate and Telegram cannot deliver
webhooks — this blocks step 6 below.

## 4. Decisions already made, and why

- **This is a test run, not the real launch.** Before any real teacher data goes near this server:
  copy the spreadsheet, empty the `ROSTER` tab completely, and add the head of project's own row plus
  one or two invented teachers. The bot cannot tell the difference. **Not yet done.**
- **Do not create the real Telegram bot.** A bot's ownership cannot be transferred between Telegram
  accounts later — only its token can be swapped out. Create a throwaway test bot via @BotFather now
  (e.g. `@mopse_test_bot`); MoPSE creates the real one from their own account when ready, and only
  `TELEGRAM_BOT_TOKEN` in `.env` changes when that happens. **Not yet done.**
- **Google Cloud is free at this scale.** No billing account is needed for a service account or the
  Sheets API. The service account gets **Viewer only** on the test copy of the spreadsheet, never
  Editor.
- **Everything except the server, the domain, and backup storage transfers to MoPSE later with no
  rework** — the Google service account, the Sheet, the Forms, support contact, ops chat. Only the
  Telegram bot itself has to be recreated by them, for the ownership reason above.

## 5. Open questions, neither of them blocking today's test

- **What does "BKM" (the provider's location code) actually mean?** `deploy/README.md` requires
  Uzbekistan hosting so real teacher data never leaves the country. Ask the provider directly. Not
  blocking now because no real data is going on this server; it must be resolved before the real
  launch.
- **A found clue, not proof:** `apt update` used `ru.archive.ubuntu.com`, Russia's regional Ubuntu
  mirror, which is normally only the default when a server image was provisioned assuming a
  Russia-region location. Worth raising with the provider alongside the question above.
- **How will the code get onto the server?** This local repository has no git remote. `deploy/README.md`
  assumes `git clone` and, for later updates, `git pull` (RUNBOOK §2.1). **Recommendation: create a
  PRIVATE repository** (GitHub or GitLab — it must be private, `FAQ-import.csv` is confidential
  ministry content), push this repo to it, and clone from there. The alternative — copying files up
  directly with `scp`/`rsync` — works for a one-off test but does not match the update procedure the
  runbook describes. **Not yet decided.**

## 6. What's next, in order

1. **Verify Docker**: `docker run hello-world`.
2. **Verify DNS**: `nslookup bot.fteacherssupport.uz` resolves to `46.8.195.231`.
3. **Decide and set up code delivery** — private repo (recommended) or direct copy.
4. **Get the code onto the server** and `cp .env.example .env`.
5. **Prepare the test-safe spreadsheet copy** (empty roster, fake teachers) and the throwaway
   Telegram bot, in parallel with step 4 — neither depends on the other.
6. **Fill in `.env` on the server**, generating what should be generated (`openssl rand -hex 32` for
   the webhook secret; a strong random value for the Postgres password) rather than inventing values.
   None of this is typed into this chat.
7. **Continue with `deploy/README.md` from "3. Start it" onward** — not yet reached.
8. Eventually, **`RUNBOOK.md` Part 3** — the fifteen numbered launch checks — once the bot is running.

**Backup credentials (`BACKUP_DATABASE_URL`, `BACKUP_PASSPHRASE`, `BACKUP_REMOTE`) are required by
`deploy/backup.sh` but not by the bot's own startup check** (`src/config/env.ts` requires eleven
other variables, not these three). They can be deferred past getting the bot itself running for a
test, but must be in place — and the restore drill actually run — before any real launch.
