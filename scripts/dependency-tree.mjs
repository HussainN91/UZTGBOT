/**
 * The dependency graph of src/, read straight from the source.
 *
 * Plain Node, no dependencies, no build step. That is the whole design: the
 * tool this replaces (`dependency-cruiser`) hooks into the TypeScript compiler's
 * internals, supports `typescript >=2.0.0 <7.0.0`, and on this project — which
 * is on 7.0.2 — it installed, initialised, cruised **0 modules** and printed
 * "no dependency violations found". A green tick over an empty scan is the exact
 * failure this rebuild exists to remove.
 *
 * This reads import statements as text. Every import in this codebase is static
 * and at the top of its file, which is not an accident — it is what makes what a
 * file depends on visible by reading it. So text is enough, and nothing here can
 * be broken by a compiler upgrade.
 *
 *   node scripts/dependency-tree.mjs           → the report
 *   node scripts/dependency-tree.mjs --check   → exit 1 on a cycle, an
 *                                                unresolved import, a file
 *                                                nothing uses, or an import
 *                                                that points up the layers
 *
 * The layer rule was left out of the first version of this file, deliberately,
 * because it needs the layers written down and that is a decision rather than
 * something to guess at here. They are written down now — see LAYERS below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * Files nothing imports, and that is correct.
 *
 * A process entry point is started by the server, not imported; a test file is
 * found by vitest, not imported. Reporting these as orphans is what made the
 * off-the-shelf tool's first run read as fifty problems when there were none.
 */
const ENTRY_POINTS = [
  'src/web/main.ts',
  'src/worker/main.ts',
  /** `npm run db:migrate`, and `node dist/db/migrate.js` on every deploy. */
  'src/db/migrate.ts',
  'src/scripts/set-webhook.ts',
  'src/scripts/sync-sheets.ts',
  'src/test/global-setup.ts',
];

const isTest = (file) => file.endsWith('.test.ts');

/**
 * The layer rule — D46. Nothing may import from a layer above it.
 *
 * The architecture rests on this one rule, and everything else load-bearing in
 * this project is a compile error when it breaks. This is not, so until now it
 * held because each case was answered by hand. Stage 5 added three directories
 * and the first modules whose natural shape is to reach upward — a retention
 * module wanting `telegram/dedup.ts`, a digest module wanting a reply builder —
 * and D36 answers both by composing in the job rather than importing upward.
 * This is what stops the next answer being a different one.
 *
 * Highest first. A file that matches nothing is a leaf: no database, no network.
 */
const LAYERS = [
  /** Scheduled work and the processes: the only things that know both the database and Telegram. */
  { layer: 4, prefixes: ['src/worker/', 'src/web/', 'src/scripts/'] },
  /** Commands, the router, and the teacher-facing handlers. */
  { layer: 3, prefixes: ['src/telegram/'] },
  /** Stores: the database, and no Telegram. */
  {
    layer: 2,
    prefixes: [
      'src/announcements/',
      'src/cases/',
      'src/conversation/',
      'src/db/',
      'src/faq/',
      'src/forms/',
      'src/retention/',
      'src/sheets/',
      'src/staff/',
      'src/sync/',
      'src/teachers/',
    ],
  },
];

/**
 * The handful of files whose directory is not their layer.
 *
 * Both directions exist and both are deliberate, which is why the rule cannot be
 * purely directory-shaped:
 *
 *   `config/settings.ts` sits among the pure modules and reads the database. It
 *   is a store and is treated as one — otherwise every module that reads a
 *   setting looks like a leaf touching PostgreSQL.
 *
 *   `telegram/send.ts` sits in the command layer and imports nothing at all
 *   inside `src/`. It is a leaf, which is exactly why `/export` can depend on it
 *   from layer 3 without a cycle, and why a store may depend on it later without
 *   that being a violation.
 *
 *   `telegram/callback-data.ts` is the same case and was added in Stage 6. It is
 *   a pure codec — it imports `config/constants.ts` and nothing else, touches no
 *   database and no network, and `send.ts`'s reasoning applies to it word for
 *   word. The sheet parser needs it: a FORMS row whose TYPE contains the field
 *   separator, or is long enough to overflow Telegram's 64-byte payload, makes
 *   `encodeCallback` THROW when the forms list is rendered — so one bad
 *   spreadsheet cell would break the button list for every teacher. That row has
 *   to be rejected at parse time, which means the parser must know the real
 *   budget rather than a second copy of it.
 */
const LAYER_OVERRIDES = {
  'src/config/settings.ts': 2,
  'src/telegram/send.ts': 1,
  'src/telegram/callback-data.ts': 1,
};

/**
 * Entry points and test files sit above everything.
 *
 * A process composes whatever it needs — that is what a process is for — and a
 * test must be able to reach the thing it tests wherever it lives. Neither is
 * imported by anything, which the orphan check above already guarantees.
 */
const TOP = 5;

function layerOf(file) {
  if (isTest(file) || ENTRY_POINTS.includes(file)) return TOP;
  if (LAYER_OVERRIDES[file] !== undefined) return LAYER_OVERRIDES[file];
  for (const { layer, prefixes } of LAYERS) {
    if (prefixes.some((p) => file.startsWith(p))) return layer;
  }
  return 1;
}

/** Every .ts file under src/, as a repo-relative posix path. */
function allFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allFiles(full, found);
    else if (entry.endsWith('.ts')) found.push(relative(ROOT, full).split('\\').join('/'));
  }
  return found;
}

/**
 * `import ... from '…'`, `export ... from '…'`, and bare `import '…'`.
 *
 * `type` is captured because a type-only import is erased when the code
 * compiles. That distinction is load-bearing here: `src/cases/notify.ts` and the
 * command files type-import from `src/telegram/router.ts`, which points *up* the
 * layers and is deliberate — a lower layer borrowing a shape without depending
 * on it at run time is what keeps the dispatcher and the router from forming a
 * cycle that actually exists.
 */
const FROM = /(?:^|\n)[ \t]*(?:import|export)[ \t]+([\s\S]*?)from[ \t]*['"]([^'"]+)['"]/g;
const BARE = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g;

function importsOf(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const found = [];

  for (const [, clause, specifier] of source.matchAll(FROM)) {
    found.push({ specifier, typeOnly: /^\s*type\s/.test(clause) });
  }
  for (const [, specifier] of source.matchAll(BARE)) {
    found.push({ specifier, typeOnly: false });
  }
  return found;
}

/**
 * `./status.js` → `src/cases/status.ts`.
 *
 * The `.js` on a relative import is pointing at a `.ts` file — the convention
 * TypeScript requires for this kind of project, and the single thing that made
 * the off-the-shelf tool useless without a compiler. Resolving it is two lines.
 *
 * Anything not starting with `.` is a package, and is returned as null: this
 * graph is about how the project hangs together, not about node_modules.
 */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;

  const base = join(ROOT, dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return relative(ROOT, candidate).split('\\').join('/');
    } catch {
      /* not this one */
    }
  }
  return `UNRESOLVED:${specifier}`;
}

// ---------------------------------------------------------------------------

const files = allFiles().sort();
const graph = new Map();

for (const file of files) {
  const edges = [];
  for (const { specifier, typeOnly } of importsOf(file)) {
    const target = resolveSpecifier(file, specifier);
    if (target !== null) edges.push({ target, typeOnly });
  }
  graph.set(file, edges);
}

/** Who imports each file — the question "is anything using this" needs. */
const importedBy = new Map(files.map((f) => [f, []]));
for (const [file, edges] of graph) {
  for (const { target } of edges) importedBy.get(target)?.push(file);
}

/**
 * Cycles, following runtime edges only.
 *
 * A cycle closed by a type-only import does not exist in the compiled
 * JavaScript, so it cannot produce the half-initialised module that makes a real
 * cycle one of the least legible failures in Node. Counting those would report a
 * problem this codebase deliberately does not have.
 */
function findCycles() {
  const cycles = [];
  const state = new Map();
  const stack = [];

  const visit = (file) => {
    state.set(file, 'open');
    stack.push(file);
    for (const { target, typeOnly } of graph.get(file) ?? []) {
      if (typeOnly || !graph.has(target)) continue;
      if (state.get(target) === 'open') {
        cycles.push([...stack.slice(stack.indexOf(target)), target].join(' → '));
      } else if (!state.has(target)) visit(target);
    }
    stack.pop();
    state.set(file, 'done');
  };

  for (const file of files) if (!state.has(file)) visit(file);
  return [...new Set(cycles)];
}

const unresolved = [];
for (const [file, edges] of graph) {
  for (const { target } of edges) {
    if (target.startsWith('UNRESOLVED:')) unresolved.push(`${file} → ${target.slice(11)}`);
  }
}

const orphans = files.filter(
  (f) => !isTest(f) && !ENTRY_POINTS.includes(f) && importedBy.get(f).length === 0,
);

const cycles = findCycles();

/**
 * Imports that point up the layers, and imports of a test file.
 *
 * **A type-only edge may point upward and is not a violation.** It is erased
 * when the code compiles, so it creates no dependency at run time — and this
 * codebase relies on it: `cases/notify.ts` and the command files type-import
 * from `telegram/router.ts` to borrow a shape without depending on it, which is
 * what keeps the dispatcher and the router out of a cycle that would be real.
 *
 * Importing a `*.test.ts` from anything is separately wrong however the layers
 * fall: it drags fixtures into the build and makes the shipped code depend on
 * the thing that is supposed to be checking it.
 */
const layerViolations = [];
for (const [file, edges] of graph) {
  const from = layerOf(file);
  for (const { target, typeOnly } of edges) {
    if (!graph.has(target)) continue;
    if (isTest(target) && !isTest(file)) {
      layerViolations.push(`${file} imports a test file: ${target}`);
      continue;
    }
    if (typeOnly) continue;
    const to = layerOf(target);
    if (to > from) {
      layerViolations.push(`${file} (layer ${from}) imports ${target} (layer ${to})`);
    }
  }
}

const typeOnlyEdges = [];
for (const [file, edges] of graph) {
  for (const { target, typeOnly } of edges) {
    if (typeOnly && !target.startsWith('UNRESOLVED:')) typeOnlyEdges.push(`${file} → ${target}`);
  }
}

// ---------------------------------------------------------------------------

const productionFiles = files.filter((f) => !isTest(f));
const lines = [
  '# Dependency tree — src/',
  '',
  `Generated by \`scripts/dependency-tree.mjs\`. ${productionFiles.length} source files, ` +
    `${files.length - productionFiles.length} test files.`,
  '',
  '## Cycles',
  '',
  cycles.length === 0
    ? 'None. (Type-only edges are ignored: they are erased at compile time and cannot ' +
      'produce a half-initialised module.)'
    : cycles.map((c) => `- ${c}`).join('\n'),
  '',
  '## Files nothing imports',
  '',
  'Entry points and test files are excluded — nothing importing those is correct.',
  '',
  orphans.length === 0 ? 'None.' : orphans.map((o) => `- ${o}`).join('\n'),
  '',
  '## Imports that point up the layers',
  '',
  'Nothing may import from a layer above it (D46). Type-only imports are exempt — ' +
    'they are erased at compile time and create no dependency at run time.',
  '',
  layerViolations.length === 0 ? 'None.' : layerViolations.map((v) => `- ${v}`).join('\n'),
  '',
  '## Imports that could not be resolved',
  '',
  unresolved.length === 0 ? 'None.' : unresolved.map((u) => `- ${u}`).join('\n'),
  '',
  '## Type-only imports',
  '',
  'Erased at compile time. These may point up the layers without it being a violation.',
  '',
  typeOnlyEdges.length === 0 ? 'None.' : typeOnlyEdges.map((e) => `- ${e}`).join('\n'),
  '',
  '## What imports what',
  '',
];

for (const file of productionFiles) {
  const edges = (graph.get(file) ?? []).filter((e) => graph.has(e.target));
  const users = importedBy.get(file).filter((f) => !isTest(f));
  lines.push(`### ${file}`);
  lines.push('');
  lines.push(
    edges.length === 0
      ? '- imports: nothing inside src/'
      : `- imports: ${edges.map((e) => (e.typeOnly ? `${e.target} *(type only)*` : e.target)).join(', ')}`,
  );
  lines.push(
    users.length === 0
      ? `- imported by: nothing${ENTRY_POINTS.includes(file) ? ' (entry point)' : ''}`
      : `- imported by: ${users.join(', ')}`,
  );
  lines.push('');
}

/**
 * `--check` prints nothing and exits non-zero on a real problem, so it can sit
 * beside the typecheck. The report is for a person; this is for a build.
 */
if (process.argv.includes('--check')) {
  const problems = [...cycles, ...unresolved, ...orphans, ...layerViolations];
  if (problems.length > 0) {
    process.stderr.write(`Dependency problems:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    'No cycles, no unresolved imports, nothing unused, nothing importing upward.\n',
  );
} else {
  process.stdout.write(lines.join('\n'));
}
