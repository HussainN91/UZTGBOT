# Review phase — what the tools actually found

**Status: all six tasks run on 30 July 2026. Committed 31 July 2026** together with the four
decisions it was waiting on. The plan is `docs/plans/2026-07-30-review-phase-tooling.md`; this
document is its results.

> **Corrected on 31 July 2026, in three places, by the session that committed it.** The
> installed-tools table at the top named the wrong tools; Task 2's headline was produced by a knip
> production run that was scanning nothing; and knip's config and oxlint's wiring, both recorded
> here as outstanding, now exist. Each correction is marked where it sits. **The original text is
> left standing beside every correction rather than overwritten** — what a tool claimed before it
> was checked is the most useful part of a document about checking tools.

**One tool out of six earned its place: Knip.** A second, oxlint, works and found little because
there was little to find — which is itself the answer. The other four are removed or not adopted,
each for a reason recorded below rather than a shrug.

**Nothing in this document is inherited or assumed. Every number below was produced by running
something in this session.**

---

## The state of the tree, exactly

**Uncommitted, and nothing has been committed this session.**

| Change | What |
|---|---|
| `package.json`, `package-lock.json` | Three dev dependencies added: `knip@6.29.0`, `oxlint@1.76.0`, `oxlint-tsgolint@7.0.2001` |
| `.gitleaks.toml` | **New file, and the one thing here worth keeping.** See Task 3 |
| `src/cases/status.ts` | One dead line removed |
| `src/cases/service.ts` | One dead line removed, and the comment above it corrected |

> **This table was wrong until 31 July 2026 and is corrected here.** It named
> `dependency-cruiser` and `squawk-cli` — the two tools this document's own prose says
> were **removed** — and omitted the two that were kept. The prose was right and the
> summary was stale. Anybody who read only the top of this page went looking for tools
> that are not installed.

**Verified after the code change, all of it run in this session:**

```
1,071 tests across 62 files · 0 failed · 0 skipped · 266.5 seconds
typecheck clean · deps:check clean
```

That is the same 1,071 across 62 that Stage 5 ended on, so the two-line deletion changed nothing.
`npm run build` is clean too.

Two tools are installed that I recommend removing — see the closing section.

---

## Task 1 — dependency-cruiser against our own checker

**Verdict: our home-made checker is correct, and the established tool is the one that is blind here.**

### The failure from Stage 5 reproduces exactly, and there are two causes rather than one

**`depcruise src` reads zero files.** Handed a *directory* it looks for `.js` files, finds none in a
TypeScript project, prints "no violations" and exits 0. Handed `src/**/*.ts` it reads 157 modules.
**This alone was enough to produce the green tick over an empty scan**, and it is not
version-related at all.

**And it cannot see `import type`.** dependency-cruiser 18.1.0 declares support for
`typescript >=2.0.0 <7.0.0`. This repository is on **7.0.2**, so its TypeScript reader is
unavailable and it silently falls back to a JavaScript one.

> **A correction to the handoff.** The handoff said dependency-cruiser *"needed `typescript@7.1.0`"*.
> That is wrong — it has never declared a TypeScript peer dependency in v17 or v18. The real gate is
> the supported-version range above. **`scripts/dependency-tree.mjs`'s own header comment had this
> right all along**; the handoff garbled it when restating it. The script was accurate; the summary
> of it was not.

### The diff the plan asked for

| | |
|---|---|
| Production files compared | 76 |
| Local edges compared | 315, of which 71 type-only |
| Edges dependency-cruiser found that ours missed | **0** |
| Edges ours found that dependency-cruiser missed | **0** |
| Production files it cruised that our report omits | **0** |

**The two graphs agree edge for edge.**

All nine of dependency-cruiser's violations are false positives:

- **Eight "circular dependencies."** Every one is closed by an `import type`, checked by hand in the
  source — `src/cases/notify.ts:45` is `import type { OutgoingMessage }`,
  `src/telegram/commands/index.ts:31` is `import type { RouterDeps, RouterOutcome }`. These are
  erased at compile time and no runtime cycle exists. Our checker ignores them deliberately and
  says so at `findCycles`.
- **One "unresolvable import"** — `grammy/types`, which resolves fine from Node.

**So the plan's rule "if a real tool disagrees, the real tool wins" does not fire.** The premise was
that the home-made tool was probably wrong. It was measured and it is right. Two regular expressions
that read `import type` as text beat a compiler integration that cannot load this compiler.

**What this does not prove.** The known limits stand untested and unchanged: a dynamic `import()`, an
unusually written re-export, and the fact that the layer map was written by the same person as the
code. Those were not exercised because **the codebase contains no such construct to exercise them
with**.

---

## Task 2 — Knip

**Proven before believed:** a deliberately unused export was planted in `src/cases/importance.ts`,
Knip caught it by name, and the file was reverted.

### The headline is good news, and it is the answer to the question the phase was built to ask

> ## ⛔ CORRECTED 31 JULY 2026 — THIS SECTION'S HEADLINE WAS PRODUCED BY A BLIND RUN
>
> **The claim below — "nothing in this codebase is used only by its tests" — was measured with a
> production run that was scanning nothing, and it is false.** The corrected finding is at the end
> of this section under *"The two-run technique, actually working"*. Read that instead.
>
> **This is the fourth instance of this document's own standing rule, and the first one where the
> rule caught this document.** A green tick is a claim about what a tool looked at.

**Nothing in this codebase is used only by its tests.**

Knip was run twice — once with test files counted as users, once with production entry points only
and tests excluded entirely. **The two runs produced identical sets, 63 items each, zero
difference.** So there is no export anywhere in `src/` that only a test reaches.

That matters because it is *this project's signature fault*: `pruneProcessedUpdates` had a test and
no caller for three stages. **A single-run Knip would not have caught that** — the test would have
counted as a user. Running it both ways is what makes the answer meaningful, and the answer is that
the fault is currently absent.

**No unused files either**, agreeing with `npm run deps:check`.

### The 63 findings

| Group | Count | Verdict |
|---|---|---|
| Command functions exported but reached only through their own `*_COMMANDS` table | ~48 | **Real, harmless. Left alone by decision** — stripping 48 `export` keywords across six large files makes a diff that hides the next real change |
| Exported types nothing imports (`Log`, `AlertSeverity`, `CaseTopicKey`, …) | 11 | Same, left alone |
| **Two dead re-exports** | 2 | **Acted on — see below** |

### The two dead re-exports, and the finding I got wrong first

`cases/status.ts:11` re-exported `CASE_STATUS_ORDER` and `cases/service.ts:49` re-exported
`OPEN_CASE_STATUSES`, both from `db/schema.ts`. **Nothing imported either**, confirmed by Knip and by
plain search.

**I first reported this as "Stage 4 built a single front door and nobody walked through it", and
that was wrong.** The head of project asked me to make sure before touching anything, and making
sure is what showed it. The comment already in `service.ts` says the opposite in plain terms: these
were re-exported *from the schema* because **"the schema is the honest home, because that is where
the database enum they must match is declared."**

So `queries.ts`, `teachers/forget.ts` and the status tests importing straight from `db/schema.ts`
are **doing exactly what the design intends**. There was no bypassed front door. The two lines were
simply leftovers nobody needed.

**Re-pointing callers through `status.ts` and `service.ts` — which is what the first, wrong reading
would have led to — would have rebuilt the second source of truth that Stage 4 removed.** The
verification is the only reason that did not happen.

**Action taken:** the two dead lines are deleted. The `export type { CaseStatus }` line above each
one **stays** — that one is live (`queries.ts:19`). The comment in `service.ts` is corrected to
record why the line went rather than leaving a comment that describes two re-exports where one now
exists.

### The two-run technique, actually working — 31 July 2026

**The production run was scanning nothing.** Knip needs a trailing `!` on an entry pattern to know
it is a *production* entry point. Without it, `--production` starts from an empty graph: it reports
zero unused exports and calls `grammy`, `pino` and `zod` unused dependencies. That is where "the two
runs produced identical sets" came from — the second set was empty-ish, not identical.

**Proved the standing way.** An unused export was planted in `src/cases/importance.ts`. Without the
`!` the first run named it and the second walked past it. With the `!` both named it. The planted
export was then removed; `git status` shows `importance.ts` unmodified.

The committed `knip.jsonc` carries the `!` and explains why, so this cannot silently regress.

**With it working, the two runs differ — 64 items against 98.** Thirty-seven things are reached by a
test and by nothing else in production.

**Most of those are not faults, and this is the distinction that matters.** A function called from
inside its own file — `runDigest`, `runRetention`, `loadEnv` — needs its `export` keyword only so a
test can reach in. Production calls it directly. Removing the export breaks the test and changes
nothing else.

**Six have no production caller anywhere**, which *is* the `pruneProcessedUpdates` shape:

| Export | Verdict |
|---|---|
| `resetEnvForTests` · `clearSettingsCache` | Test helpers by name and by intent. Correct as they are |
| `visibleCaseReferences` | A wrapper. The real path uses `visibleToStaff`, which `queries.ts` imports. Its twenty tests exercise the visibility rules through it and are **earning their keep** |
| `audienceSize` | `/announce` reports the count from `createDraft`, not from this. A redundant second way to count |
| `isRetained` · `atLeastImportance` | Importance helpers with no caller. `isRetained` restates a retention rule the purge applies its own way — a **second source of truth**, and the one item here worth a decision later |
| `isCallback` · `getSettingNumber` | Helpers superseded by other routes |

**Nothing was removed on the strength of this.** It is recorded so a later stage can decide, and
because deleting a tested helper without checking what its tests cover is how a rule loses its only
proof. `npm run knip` and `npm run knip:prod` reproduce both lists.

**What this does not change:** the two dead re-exports deleted on 30 July were found by the *first*
run, which was working correctly throughout, and confirmed by plain search. Every consumer of
`CASE_STATUS_ORDER` and `OPEN_CASE_STATUSES` imports them from `db/schema.ts` directly.
Re-verified 31 July: typecheck, build and `deps:check` all clean.

### One Knip finding that is wrong

It reports `pino-pretty` as an unused dependency. It is used at `src/log.ts:44` as
`target: 'pino-pretty'` — a module named in a string, which no static tool can follow. **Do not
remove it.**

---

## Task 3 — Gitleaks, and the hole that mattered

**The history is clean. 53 commits, 3.16 MB, zero secrets.**

The default ruleset produced exactly one finding and it is a false positive: `QAEngine.gs:39`,
`FAQ_CACHE_COUNT_KEY_ = 'faq_rows_v2_count'` — a cache key name in the Apps Script baseline commit,
flagged on entropy alone.

### But a clean scan means nothing until the scanner is shown to catch something

It was tested rather than trusted, and **the first result was that it caught nothing at all.** That
turned out to be two bad tests of mine — the canonical AWS documentation keys are allowlisted by
gitleaks on purpose, and my second attempt's report was mis-parsed. Tested properly, gitleaks 8.30.1
catches GitHub tokens, private keys and generic high-entropy API keys, and **it does read `.env`
files** (a planted GitHub token inside one was caught).

**It does not detect a Telegram bot token.** Three correctly shaped tokens were planted, including
the example from Telegram's own documentation — `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw` — in
both a `.env` and a `.js` file. **All three passed a clean scan.**

For a Telegram bot that is the single credential that matters most: whoever holds it can read every
message the bot receives and write as the bot to all 1,800 teachers.

### `.gitleaks.toml`, which is the deliverable of this task

A repository config now exists with:

- a `telegram-bot-token` rule — `\b[0-9]{8,10}:A[A-Za-z0-9_-]{33}\b`, matching the real shape
  (8–10 digits, colon, 34 characters beginning with a capital A);
- one allowlist entry for `faq_rows_v2_count`, **by its value rather than by its file**, so anything
  else that ever appears in `QAEngine.gs` is still read.

**Proven both ways.** It catches a random token in a `.env` and the documentation token in a
markdown file, and it stays silent on the allowlisted cache key.

**Re-scanned with it: 53 commits, no leaks found.** That result now means something.

```bash
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:latest git /repo --config /repo/.gitleaks.toml
```

**Nothing was installed for this** — gitleaks ran as a container, and every planted test file was
deleted immediately after each run. Nothing is left behind.

**Related and checked, because the token is added later:** `.gitignore` covers `.env` and `.env.*`
and un-ignores `.env.example`; the only `.env*` file tracked in git is `.env.example`. The token will
not be committed by accident.

---

## Task 4 — Squawk over the migrations

**Verdict: 144 findings, none of them applicable to this project, and the reason is the deploy
procedure rather than the SQL.**

| Rule | Count |
|---|---|
| `prefer-robust-stmts` | 71 |
| `require-concurrent-index-creation` | 29 |
| `prefer-bigint-over-int` | 14 |
| `require-lock-timeout` / `require-statement-timeout` | 9 / 9 |
| `constraint-missing-not-valid` | 5 |
| `adding-foreign-key-constraint` | 5 |
| `require-concurrent-index-deletion` | 2 |

**Squawk's entire threat model is "your migration will lock a table that live traffic is using."**
`RUNBOOK.md` §2.1 stops `web` and `worker`, *then* migrates, *then* starts them again. **Migrations
never run against a serving system here.** Every lock-related rule above — which is most of them —
is warning about a situation this deployment does not create.

The two that could have survived that do not:

- **`prefer-bigint-over-int` (14).** Every `integer` column is a small counter: `attempts`,
  `rows_seen`, `teacher_chase_count`, the three retention-day columns, a `year`, a per-year sequence
  `last_value`, `consecutive_failures`. None can approach 2,147,483,647.
- **`prefer-robust-stmts` (71)**, which asks for `IF NOT EXISTS` so a half-applied migration can be
  re-run. **`src/db/migrate.ts` runs each migration inside a transaction**, so the half-applied state
  cannot occur.

**When this would stop being true:** if the deployment ever changes to migrate *while serving* —
zero-downtime, rolling restarts — every one of those 29 index warnings becomes real on a table with
1,800 teachers behind it. **Squawk is worth reinstalling on the day that changes, and not before.**

---

## Task 5 — the linter

**Verdict: oxlint works, including its type-aware rules, and it found almost nothing. Both halves of
that sentence matter.**

The plan's bet was that oxlint would succeed where dependency-cruiser failed, because it is built on
the same TypeScript-Go base this repository runs on. **That bet paid.** Type-aware linting needs a
second package — `oxlint-tsgolint`, which oxlint names in its own error message when it is missing —
and once installed it ran clean on TypeScript 7.0.2. **This is the first tool in this session that
handled this compiler rather than silently degrading around it.**

### What it found across 138 files

**Four things, total, on the default rules plus type-aware.**

| Finding | Verdict |
|---|---|
| `no-useless-spread` ×2 — `src/telegram/bot.ts:83`, `src/staff/queues.test.ts:65` | Real, cosmetic |
| `no-misused-spread` — spreading a string in `ops.integration.test.ts:443` | Real, in a test, and about emoji handling |
| **`no-base-to-string` — `src/sheets/client.ts:98`** | **The only one worth reading twice** |

That last one: `values` from the Sheets API is typed `unknown[][]`, and each cell goes through
`String(cell)`. If a cell were ever an object it would silently become `[object Object]`. **It is not
a live bug** — the Sheets API returns primitives in `values` — but the *type* permits something the
code would mishandle without complaint, which is this project's recurring shape. **Recorded, not
fixed**; this phase changes no behaviour.

### The honest reading of "only four findings"

A linter finding nothing can mean the code is clean or that the linter is asleep. Here it is the
former, and the evidence is that the **same** run reports real findings in real files with precise
line and column numbers — it is reading. Broadening to `pedantic` produces `max-lines` and
`max-lines-per-function` complaints, almost all against integration tests, which are style opinions
rather than faults and are the reason a broad rule set was not adopted.

**`npm run lint` was still an alias for `typecheck`.** Whether oxlint should take that name is a
decision, not a finding, and it was not taken here.

> **Taken on 31 July 2026 by the head of project: `npm run lint` now runs oxlint.**
> `npm run lint` is `oxlint --type-aware src`; `npm run typecheck` is unchanged and still the
> compiler. Nothing in the repository called `lint`, and there is no CI, so nothing broke. Re-run
> on 31 July it reproduces exactly the four findings tabled above — the same files, the same lines —
> which is the evidence that it is reading rather than idling.

---

## Task 6 — repowise

**Researched, run, and not adopted.**

### First, the name collision, which was real

The plan cites `repowise.dev`. **The package published on npm as `repowise` is different software** —
`repowise.ai`, `github.com/nirhemo/repowise`, an *"AI-optimized codebase context generator"*. The
tool the plan means is **a Python package**: `pip install repowise`, AGPL-3.0, free to self-host.
Installing the npm one would have been a silent wrong turn.

**The real one was installed and run** (`repowise 0.37.0`, Python 3.14.4).

### It genuinely read the code

**138 files scored — the exact count of TypeScript files in `src/`.** Average health **9.3 / 10**,
worst file 2.5. 238 findings.

### And essentially all of its distinctive output is an artefact of this repository

**All twelve "critical" findings are artefacts, in two groups:**

- **Six are `untested_hotspot`** — "no paired test file" for `router.ts`, `service.ts`, `schema.ts`,
  `settings.ts` and both repositories. **It looks for `X.test.ts` and this project writes
  `X.integration.test.ts`.** `router.integration.test.ts` and `service.integration.test.ts` both
  exist. The signal is wrong about the codebase, not about the tests.
- **Six are `change_entropy` and `churn_risk`** — history-based fault predictors. **This history is
  53 commits, one author, three days.** "Top 3% change entropy" here measures the order in which the
  codebase was built, not how riskily it is maintained.

**And the largest category, 90 `dry_violation` findings, is driven by house style rather than
duplication.** The highest-scoring example claims `config/constants.ts` and
`telegram/callback-data.ts` share a 47-line clone. They share no truth whatsoever — both are objects
of short string constants, each key carrying a doc comment. A line-based clone detector sees two
files that *look* identical because this codebase comments uniformly. `constants.ts` is 498 lines of
which 97 are code.

**What survives is complexity opinion** — `routeCallback` at cyclomatic complexity 15, a five-level
nesting in `commands/staff.ts`. Legitimate, and not faults.

### Verdict

**Not useful on this repository today, and the reason is not that the tool is bad.** Its distinctive
value is git intelligence over a mature history, and this history is three days old with one author.
Its test detection does not know this project's naming convention.

**When it would become useful:** after six months or so of real operation, with more than one author
— and only if `.integration.test.ts` is taught to it, or the convention is added to its config.
Until then it reports the construction of the codebase as if it were the wear on it.

---

## What is installed now, and what was removed

| Tool | State | Why |
|---|---|---|
| **knip** | **Kept and configured** | The one tool answering a question nothing else here asks. `knip.jsonc` is committed; `npm run knip` and `npm run knip:prod` are the two runs |
| **oxlint** + **oxlint-tsgolint** | **Kept and wired** | Works on TypeScript 7 including type-aware rules. `npm run lint` runs it as of 31 July 2026 |
| `dependency-cruiser` | **Removed** | Answered its question (our checker is correct) and cannot do better on TypeScript 7 |
| `squawk-cli` | **Removed** | Its threat model is migrating a live database; this deployment stops the bot first |
| repowise | **Not adopted** | Above. Installed via `pip` outside the repository, so nothing in the project references it |

**Knip's config is now in the repository — `knip.jsonc`, committed 31 July 2026.** It carries the
two-run technique, the `!` production markers that make the second run work at all, and the
reasoning for both. Two npm scripts drive it:

```bash
npm run knip        # tests count as users
npm run knip:prod   # production entry points only
```

Both allocate a 4 GB heap explicitly, because oxc-parser allocates one large buffer and knip
crashed intermittently with `RangeError: Array buffer allocation failed` on an 8 GB machine with
Docker running. The scripts call `node --max-old-space-size=4096` directly rather than setting
`NODE_OPTIONS`, so they behave the same in PowerShell and in bash.

### On `npm audit`

**The 4 moderate advisories are pre-existing and nothing to do with this session.** They come from
`drizzle-kit` → `@esbuild-kit/*` → `esbuild`. **`npm audit --omit=dev` reports 0 vulnerabilities.**
None of the tools installed today added an advisory.

---

## The standing lesson, restated because it held again

**Every tool in this session had to be made to fail before its success meant anything, and three of
the four initially reported a clean result while examining nothing.**

- dependency-cruiser printed "no violations" over **zero modules**, twice, for two different reasons.
- Gitleaks reported "no leaks found" on a directory of planted secrets, because of how the test was
  built.
- Knip was the exception, and it was still proved with a planted export before its report was read.

**A green tick is a claim about what a tool looked at, not about the code.** That is the rule this
project already had, and it earned its keep four more times today.
