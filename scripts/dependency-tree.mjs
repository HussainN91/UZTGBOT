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
 *   node scripts/dependency-tree.mjs --check   → exit 1 if there is a cycle
 *
 * What it deliberately does NOT do: decide whether a dependency is *allowed*.
 * The layer rule — nothing may import from a layer above it — needs the layers
 * written down, and that is a decision to be made deliberately rather than
 * guessed at here. This prints the facts that decision needs.
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
  const problems = [...cycles, ...unresolved, ...orphans];
  if (problems.length > 0) {
    process.stderr.write(`Dependency problems:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('No cycles, no unresolved imports, nothing unused.\n');
} else {
  process.stdout.write(lines.join('\n'));
}
