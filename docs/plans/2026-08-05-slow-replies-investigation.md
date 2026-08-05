# The slow replies — what was measured, and what was built to keep measuring

**Date:** 5 August 2026 · **Status: ✅ CAUSE FOUND AND REPRODUCED · instrumentation built, not yet
deployed** · A new piece of work; the plan of record stays
`2026-08-01-identity-and-urgent-design.md`.

> Teachers reported the bot being slow **sometimes**, with one reply taking eleven seconds. This
> document records what was actually measured on the live server on 5 August, what the measurements
> ruled out, and the fault they found. Nothing here is inferred from the code alone.
>
> **The bot is not slow. Opening a connection to the server is.** §2 has the reproduction.

```
1,360 tests across 72 files · 0 failed · 0 skipped · 400 seconds
typecheck clean · build clean · lint 0 warnings · deps zero cycles, zero layer violations
```

---

## 1. What was ruled out, with the numbers that ruled it out

### The server is not overloaded

```
load average: 0.06, 0.06, 0.01   on 4 CPUs
memory: 3,915 MB total, 2,899 MB available
web container: RestartCount=0, OOMKilled=false, up 23 hours
```

A machine short of processor or memory is slow at everything, all the time. This one is close to
idle. **The provider is not overselling the hardware**, whatever else may be true.

### The bot's own handling is not slow

Caddy has been recording the duration of every webhook request since 31 July, and nobody had looked.
242 requests over five days:

```
median=299ms  p75=471ms  p90=616ms  p95=717ms  p99=1,221ms  max=6,120ms
>= 1s: 4 (1.7%)   >= 2s: 1 (0.4%)   >= 5s: 1 (0.4%)   >= 10s: 0   >= 15s: 0
```

That duration covers everything the bot does — receiving the update, deciding, committing, and
sending the reply to Telegram. **In five days it has never once taken more than 6.1 seconds, and
only once exceeded two.** The eleven-second wait is not in here.

The single non-200 was a `401` on 3 August: somebody probing the webhook address without the secret
token, refused in 3ms. The gate did its job.

### The route out to Telegram is currently healthy

100 calls each to three hosts, run from inside the live web container on 5 August:

```
telegram    median=257ms  p90=274ms  p99=1,098ms  max=1,098ms   >1s=2  >5s=0  failed=0
google      median=219ms  p90=269ms  p99=756ms    max=756ms     >1s=0  >5s=0  failed=0
cloudflare  median=87ms   p90=106ms  p99=526ms    max=526ms     >1s=0  >5s=0  failed=0
```

Compare 3 August, before the IPv4 change and the 15-second timeout went in: two pathological calls
in a hundred, one hanging 20 seconds and one failing after 60. **Those fixes worked.** Telegram's
tail is still worse than Google's — two calls over a second against none — but nothing here explains
eleven seconds.

## 2. What it points at: the connection *inbound*, which nothing was watching

`getWebhookInfo`, asked on 5 August at 07:41 UTC:

```
last_error_date:      2026-08-05T06:46:24Z
last_error_message:   "Connection timed out"
pending_update_count: 0
ip_address:           46.8.195.231
max_connections:      40
```

**Telegram tried to deliver an update to this server and could not open a connection.** The next
successful webhook in Caddy's log is at `06:46:32` — eight seconds later, and it was served in the
usual few hundred milliseconds.

That is the whole mechanism, and it is why nobody could find it:

```
teacher sends  →  Telegram  →  [connection times out]  →  Telegram waits, retries  →  us  →  reply
                              └──────── the entire wait happens here ────────┘
                                                                              └── 300ms, logged as healthy
```

Every instrument this system had pointed at the second half of that line. The delay is in the first
half, before a single line of our code runs. A teacher waits eight or eleven seconds; the bot
records a fast, successful reply; both are true.

**This is not the same problem as the outbound stalls found on 3 August**, and it is not fixed by
them. Outbound was us failing to reach Telegram. This is Telegram failing to reach us.

### Reproduced from outside, with nothing of ours involved

200 plain TCP connections to `bot.fteacherssupport.uz:443`, three seconds apart, over ten minutes on
5 August. **No TLS request, no HTTP, no bot, no database — just "can a connection be opened".**

```
200 attempts · succeeded 200 · failed 0
median=53ms   p90=84ms   p99=3,192ms   max=7,923ms

07:49:06  1,171ms
07:51:08  3,192ms
07:53:12  1,067ms
07:55:19  7,923ms
```

**The healthy case is 53 milliseconds and the worst case is 7.9 seconds — 150 times worse.** Nothing
outright failed, which is why nothing ever showed up as an error anywhere: these connections all
*succeed*, just seconds late. Four of 200 took over a second.

That is the eleven seconds, accounted for: about eight waiting for a connection, about three tenths
for the bot to do the work, plus the reply's own trip back.

### Whose problem it is

The server was idle throughout, has never restarted, and answers in 300ms once a connection gets
through. Nothing on this side was busy or broken. What is slow is establishing a TCP connection to
`46.8.195.231` — the provider's address on the provider's network, before a single byte reaches any
software of ours.

**This was measured from inside Uzbekistan over the domestic path, which is the easy one.** Telegram
connects from abroad. The international route is the one that produced `Connection timed out`, and
it is not tested by the figures above — they are the optimistic case.

**This is the case to put to airnet.uz.** It needs no trust: the same probe can be run from their
side in ten minutes.

Two things were checked so they cannot be offered as an explanation. The clock the timestamps depend
on: `System clock synchronized: yes`, NTP active, UTC. And the server's own load at the time: 0.06
across four processors, 2.9 GB of memory free.

## 3. What was built

Instrumentation only. **No behaviour changes** — nothing a teacher sees is different, and nothing
about how the bot decides anything has moved.

### The ripple map

| File | Layer | Change |
|---|---|---|
| `src/telegram/timing.ts` | 1 — new pure leaf | `timed()`: run a call, report how long it took, on success *and* on failure |
| `src/telegram/timing.test.ts` | test | 6 pure unit tests, injected clock |
| `src/telegram/api-retry.ts` | 1 — pure | optional `onRetry` observer; no new imports, purity intact |
| `src/telegram/api-retry.test.ts` | test | 5 new tests; 11 total |
| `src/config/constants.ts` | 1 | `SLOW_TELEGRAM_CALL_MS`, `SLOW_UPDATE_MS` |
| `src/telegram/bot.ts` | 3 | time each API call; log slow calls and retries; one timing line per update |

Nothing imports upward. `npm run deps:check` reports zero cycles and zero layer violations, and
`docs/dependency-tree.md` was regenerated and committed alongside.

### The four numbers now recorded, and which half of the line each belongs to

Every update gets one line at `info`, raised to `warn` past three seconds:

| Field | What it measures | Ours to fix? |
|---|---|---|
| `inboundLagMs` | Telegram's own timestamp on the message → the moment we start work | **No — this is the one that was invisible** |
| `decideMs` | our handling, up to and including the commit | Yes |
| `sendMs` | sending the replies to Telegram | No — the route out |
| `totalMs` | what the bot spent, end to end | — |

`inboundLagMs` is the addition that matters. It comes from `message.date`, which Telegram stamps
itself, so it measures exactly the gap that the eight-second retry above fell into. It has
one-second resolution, which is useless for shaving milliseconds and entirely sufficient for telling
four seconds of waiting from four hundred.

It is **deliberately absent on button taps.** A callback query's message date is when the *button*
was sent, possibly days ago; reporting that as lag would be a confident wrong number, which is worse
than none.

### Two things that used to leave no trace at all

**A retry that worked.** `withRetry` logged nothing. A call that stalled and succeeded on the second
attempt cost a teacher fifteen seconds and was recorded nowhere — so the commonest form of the
reported slowness was also the invisible form. It now says so.

**A duplicate update.** Telegram redelivers what it believes was not acknowledged, and being slow to
acknowledge is how that happens. So a rise in duplicates is not noise about dedup working; it is the
slowness reporting itself from the other side, and it is the only signal here that does not depend
on a teacher thinking to complain.

### What is not covered by a test, said plainly

The per-update timing line lives in the `run` closure inside `createBot`, which is the only place
that spans claim → decide → deliver. That closure needs a bot token and a network to exercise and no
test drives it. **The fiddly parts were extracted so they could be tested** — `timed` and the
`onRetry` observer are pure, injected and covered — but the wiring in `bot.ts` is verified by
deployment, not by the suite. Both new test files were confirmed to fail when the implementation was
deliberately broken, and to pass when it was restored.

## 4. What is still needed, and what it is waiting on

**Frequency is not yet known.** `getWebhookInfo` reports only the *most recent* failure, so we know
this happened at 06:46 on 5 August and we do not know whether it happens twice a day or forty times.
Without that number there is no case to put to the provider.

Two things close it, and they are complementary:

1. **Deploy the instrumentation.** From then on, every message carries its own inbound lag. This is
   the permanent answer, but traffic is presently about 48 updates a day, so evidence accumulates
   slowly.
2. **Watch `getWebhookInfo` on a schedule and record every change to `last_error_date`.** This
   samples continuously whether or not a teacher happens to write in, and it belongs in the
   heartbeat job beside the other watchers rather than as a script somebody has to remember. **Not
   built** — it needs a decision about alerting thresholds first, or it becomes the noisiest thing
   in the operations chat.

**The provider needs telling, and that is the fix.** Items 1 and 2 measure the fault; neither mends
it. Nothing in this repository can mend it — the delay happens before any of our software runs. What
the instrumentation buys is the ability to tell whether a claimed fix is real, from ordinary teacher
traffic rather than a spot check on a good day.

**What to hand them**, from §2: connections to `46.8.195.231:443` have a median of 53ms and a p99 of
3,192ms, with one attempt in 200 taking 7,923ms, measured over ten minutes from a domestic path
against an idle server; and Telegram's own webhook report showing `Connection timed out`.

## 5. Two unrelated faults found while looking

Both were visible in the worker log and neither is connected to the slowness. Recorded here so they
are not lost, not fixed here.

- **The FORMS sync has been refusing every run**, correctly: it would deactivate 3 of 3 active rows,
  over the 20% damage limit. The spreadsheet needs looking at; the damage limit is doing its job.
- **`DiplomaResponses` cannot be read** — Google returns `400 Unable to parse range`, so the
  responses tab for "Upload teaching qualification" does not exist under that name. Submissions to
  that form are not being filed, and the alert has been firing every ten minutes.

These two are the alert noise already on the list. **Neither is a retired form**, which was the
earlier theory; both are sheet-side and need a person in the spreadsheet.
