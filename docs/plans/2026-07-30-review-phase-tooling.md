# Review phase — checking this codebase with tools rather than by reading it

**Status: RESEARCHED, NOT STARTED. Nothing has been installed and nothing may be installed without
the head of project saying so, tool by tool.**

> **This is the plan for the next session.** Read `docs/plans/2026-07-29-stage-4-handoff.md` first —
> it is the current state of the system — then this. Stage 5 is finished and committed; this phase
> builds nothing for teachers and changes no behaviour.

---

## What this phase is, in one paragraph

Five stages have been built and every one of them found faults **by running things**. That worked,
and it does not scale: the suite proves the code does what its tests say, and nothing at all
examines the code as a body of work. This phase points **tools** at it — dead exports, unsafe
migrations, secrets in git history, lint rules nobody is enforcing, the dependency graph — and
uses what they say to decide what to fix.

**The rule that makes it worth doing: we are not going to review this by reading the code.** Reading
is what has already been done, five times, by the person who wrote it. A tool has no memory of what
the code was meant to do, which is exactly the property that makes it useful here.

---

## Two decisions that reverse earlier ones

### `repowise` is permitted, and this phase is where it belongs

**The handoff has said since Stage 4: "repowise is rejected — ignore repowise forever."** That was
the head of project's instruction and it was recorded correctly. **It is reversed as of 30 July
2026**, in their words: *"now is a good time to utilise repowise, it is the revising and check
phase."*

The earlier rejection was not about the tool being bad. It was about it being proposed during a
**build** stage, where a repository-intelligence engine answers questions nobody was asking. In a
review phase it answers exactly the questions being asked. **Both positions were right at the time
they were taken**, and this note exists so neither reads as somebody forgetting.

### Our own dependency tool is a suspect, not a control

`scripts/dependency-tree.mjs` is home-made. It reads imports **as text**, with two regular
expressions. The head of project's assessment on 30 July: *"the tool you already made, which is
sketchy and needs to be checked."*

That is the right assessment and it should be treated as a finding rather than a slight. Its known
limits, written down honestly:

- It matches `import`/`export … from '…'` by regular expression. **A dynamic `import()`, a
  re-export written unusually, or an import inside a conditional is invisible to it.**
- It only knows about **files**. It has never had any opinion about **exports**, which is where this
  project's characteristic fault lives (see below).
- Its layer map and its two overrides were written by the same person who wrote the code being
  checked, in one sitting, and agreed with it on the first run.
- **It has been watched to fail exactly once**, on a violation authored deliberately to make it fail.

**Task 1 of this phase is to check it against an established tool** and find out whether it has been
telling the truth. If a real tool disagrees with it, the real tool wins.

---

## What is actually missing — found by looking, on 30 July

This is the in-code half of the research, and it is what the tool list is chosen against rather
than a generic checklist.

| Gap | Evidence | Why it matters here |
|---|---|---|
| **No linter at all** | `package.json` maps `"lint"` to `tsc -p tsconfig.json`. **`lint` is an alias for `typecheck`.** There is no ESLint, no Biome, no oxlint, no config file of any kind | Every correctness rule in this project is either a type error or a test. Nothing catches a floating promise, an unawaited write, an `any` that crept in, or a `catch` that swallows |
| **Nothing checks unused *exports*** | **505 exports across `src/`.** `deps:check` reports unused *files* and finds none | **This is the project's signature fault.** `pruneProcessedUpdates` had a test and no caller for three stages. `settings.RETENTION_DAYS` was read by nobody. `staff.telegram_id` had a writer and no reader. Every one was found by a person grepping. A tool does it in a second |
| **No CI** | No `.github`, no pipeline anywhere. Only the two `docker-compose` files | Every check in this project runs because somebody remembered to run it. The suite went two whole sessions without completing once, and nobody knew |
| **The coverage config cannot run** | `vitest.config.ts` declares a `coverage` block. **`@vitest/coverage-v8` is not installed** | A configured feature that has never once executed. The same shape as every fault in §6 of the handoff |
| **Nothing lints the migrations** | Eight migrations in `drizzle/`, applied to a live database on deploy day | `drizzle-kit` has already emitted a destructive `DROP TYPE` here once, caught by a person reading it. Nothing would catch the next one |
| **No secret scanning** | `.env.example`, a confidential `FAQ-import.csv`, and `CONCERNS` A1 is *literally about a confidential document sitting in the deployment folder* | Git history is permanent. A key committed in Stage 1 and deleted in Stage 2 is still there |
| **No supply-chain gate** | `npm audit --omit=dev` reports 0 vulnerabilities today, by hand | Today's clean is not tomorrow's, and nothing re-asks |

**What Docker already covers, and what it does not.** The containers give a real PostgreSQL to test
against and a reproducible runtime — that is why the integration tests are worth anything, and it is
not small. **It says nothing whatsoever about the code**: not one line of the above is a thing Docker
could ever have reported. Docker proves the system *runs*; none of it examines what was written.

---

## The candidate tools

**Ranked by what they catch that nothing here currently catches.** Nothing below is installed. Each
needs the head of project's word before it goes anywhere near the repository.

### Tier 1 — the ones that answer a question this project has actually been bitten by

| Tool | What it would catch | Why it is first |
|---|---|---|
| **Knip** | Unused **exports**, unused files, unused dependencies, and imports of things not in `package.json` | Aims straight at the 505-export blind spot and at this project's signature fault. It is the single highest-value tool on this list |
| **Squawk** | Unsafe PostgreSQL migrations — a `NOT NULL` add, an index without `CONCURRENTLY`, a constraint taking an `ACCESS EXCLUSIVE` lock | Eight migrations, applied to a live database with 1,800 teachers behind it. A lock on deploy day is an outage, and the one destructive migration this repo has seen was caught by a human eye |
| **Gitleaks** | Secrets anywhere in the **history**, not just the current tree | Cheap, fast, and the only one of these where a hit means stop-everything. `CONCERNS` A1 is evidence this repository has already had a disclosure question |
| **repowise** | Dead code, the dependency graph, churn-against-complexity hotspots, and a code-health score | Now explicitly wanted. Its dead-code and graph layers are also a **second opinion on our home-made tool**, which is Task 1 |

### Tier 2 — the linter question, which needs a decision rather than an install

The repository has **no linter**, so this is not "replace ESLint", it is "choose the first one".

| Option | The case for it | The case against |
|---|---|---|
| **oxlint** | Its type-aware rules run on **tsgolint, built on the same TypeScript-Go base as TypeScript 7.0** — which is exactly what this repo is on. Very fast, low memory | Young. Type-aware coverage is reported around 75–85% of the `@typescript-eslint` rule set |
| **Biome** | Linter and formatter in one tool, one config, one install | The formatter would reformat every file in the repository, which buries the next real diff |
| **ESLint + typescript-eslint** | The complete rule set, and the safest default | **This is the project that just watched `dependency-cruiser` cruise zero modules because it needed the old TypeScript compiler internals.** Type-aware ESLint on TypeScript 7 is the same bet |

**The recommendation is oxlint**, and the reason is specific rather than fashionable: it is built on
the compiler this project already uses. **It must be proved on this repository before it is trusted**
— the `dependency-cruiser` lesson is that a green tick over an empty scan is worse than no tool.

**A formatter is deliberately not proposed.** Reformatting every file would destroy the readability
of every diff in a codebase whose comments are load-bearing. If one is ever wanted, it is its own
decision and its own commit.

### Tier 3 — worth knowing about, not worth starting with

- **OSV-Scanner** — dependency vulnerabilities against the OSV database, more thorough than `npm audit`.
- **Semgrep** — pattern-based static analysis with a large Node.js rule library. Powerful, and the
  most likely of these to produce noise nobody reads.
- **`@vitest/coverage-v8`** — not a new tool so much as **finishing one already half-configured**.
  Coverage is a map of what has never been executed, which is precisely this project's stated fault
  line: *"code that no test has ever executed is not known to work."*
- **dependency-cruiser** — removed in Stage 5 because it needs `typescript@7.1.0`. It is now at
  **18.1.0**, published within the last month. **Re-test it in one command before assuming anything**;
  if it cruises a non-zero number of modules, it becomes the control for Task 1 and our home-made
  tool can probably be deleted.

---

## Build order — and each step stops for confirmation

`1 · 2 · 3 · 4 · 5 · 6`

**Every one of these ends by reporting what the tool said and asking whether to act on it.** A tool
that produces a hundred findings is not a licence to change a hundred things.

- [ ] **1. Check our own tool.** Run one established graph tool (dependency-cruiser if it works on
      TypeScript 7 now, otherwise repowise or madge) and **diff its answer against
      `docs/dependency-tree.md`.** Report the disagreements. If it turns out our tool has been
      wrong, say so plainly — including about anything it certified in Stage 5.
- [ ] **2. Knip.** Run it read-only. Expect the report to be long, and **expect a number of the
      findings to be wrong** — a store function built for a stage that has not arrived is not dead
      code, it is a decision, and several are recorded as such in the plans. Triage before touching
      anything.
- [ ] **3. Gitleaks over the full history.** Fastest, and the only one whose result could stop
      everything else.
- [ ] **4. Squawk over `drizzle/`.** Read the findings against the deploy-day procedure in
      `RUNBOOK.md` §2.1 rather than in the abstract.
- [ ] **5. The linter decision, then one proving run.** Recommendation above. Prove it reports
      something real on this repository before wiring it into anything.
- [ ] **6. repowise.** Last of the tools deliberately: it is the broadest and the least specific, so
      it is most useful once the narrow tools have already been run and their findings are known.

**Then, and only then:** whether any of this becomes CI, and whether `npm run lint` should stop
being a lie.

---

## The rules for this phase

**Nothing is installed without a yes.** Tool by tool, not a blanket approval. This was stated
directly on 30 July and it is the whole shape of the phase.

**Prove every tool actually examined the code.** `dependency-cruiser` printed *"no dependency
violations found"* while examining **zero modules**. Before any tool's output is believed: how many
files did it read? Make it report something known to be true, and if possible make it fail on
purpose.

**A finding is not an instruction.** Several things a tool will flag are deliberate and are recorded
in the plans — `forgetTeacher` exists for a resignation route that is not built; `sendDocument` is
half of a feature on purpose; `casesAwaitingTeacher` is unscoped and says so at its definition.
**Check the plan before deleting anything a tool calls dead.**

**No behaviour changes in this phase.** If a tool finds a real bug, that is a `fix:` commit of its
own, described plainly — not folded into a tooling change.

**Nothing about this touches the three specification documents until the end**, exactly as every
stage has worked. Collect what changes and correct them in one pass.

---

## What this phase is not

- **Not a rewrite.** No refactor because a tool prefers a different shape.
- **Not a formatter.** See above.
- **Not test coverage as a target.** Coverage is a map of what has never run; a percentage nobody
  chose is a number people write tests to satisfy rather than to check something.
- **Not a new stage of features.** Stage 6 is documents, and it is still Stage 6.

---

## Sources

Read on 30 July 2026 while choosing the list above.

- Knip — <https://knip.dev/> · <https://github.com/webpro-nl/knip>
- Squawk — <https://squawkhq.com/docs/rules> · <https://squawkhq.com/docs/safe_migrations>
- repowise — <https://www.repowise.dev/> · <https://docs.repowise.dev/> · <https://github.com/repowise-dev/repowise>
- dependency-cruiser — <https://github.com/sverweij/dependency-cruiser/releases>
- oxlint / Biome / ESLint comparison — <https://www.pkgpulse.com/guides/biome-vs-eslint-vs-oxlint-2026> · <https://www.solberg.is/fast-type-aware-linting>
- Gitleaks, Semgrep, OSV-Scanner — <https://devsecops.ae/secrets-scanners-comparison-2026/> · <https://www.jit.io/resources/devsecops/implementing-a-complete-devsecops-toolchain-with-open-source>
