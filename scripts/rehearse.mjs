// Rehearse migrations on a Neon branch before they reach production.
//
//   node scripts/rehearse.mjs                         each file in migrations/ on its own branch of production
//   node scripts/rehearse.mjs --against fixtures      the same on schema-only branches with CI fixtures
//   node scripts/rehearse.mjs --dir migrations/fixed  the fixed versions
//   node scripts/rehearse.mjs --only 003 --keep       one migration, keep the branch afterwards
//   node scripts/rehearse.mjs --sequence a.sql b.sql --markdown rehearsal.md
//                                                    the files in order on ONE branch, as a deploy
//                                                    would run them (what CI uses)
//
// For each migration: run it while a small app keeps reading and writing, check four gates, print
// Neon's schema diff, and delete the branch. Results go to data/rehearsal/.
// With --public (set automatically on GitHub Actions) Postgres error DETAIL, which can quote row
// values, is left out of everything the script prints or writes.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, need } from './lib/env.mjs';
import { branchByName, createBranch, deleteBranch, schemaDiff } from './lib/neon.mjs';
import { runWithTraffic, printResult } from './lib/harness.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    against: { type: 'string', default: 'production' },
    dir: { type: 'string', default: 'migrations' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
    sequence: { type: 'boolean', default: false },
    public: { type: 'boolean', default: Boolean(process.env.GITHUB_ACTIONS) },
    markdown: { type: 'string' },
    'stall-ms': { type: 'string', default: '1000' },
    tag: { type: 'string', default: '' },
  },
});
if (!['production', 'fixtures'].includes(args.against)) throw new Error('--against production|fixtures');
const stallMs = Number(args['stall-ms']);
const fixtures = args.against === 'fixtures';

const paths = positionals.length
  ? positionals.map((p) => resolve(p))
  : readdirSync(`${ROOT}/${args.dir}`)
      .filter((f) => f.endsWith('.sql') && (!args.only || f.startsWith(args.only)))
      .sort()
      .map((f) => `${ROOT}/${args.dir}/${f}`);
if (paths.length === 0) throw new Error(`no migrations in ${args.dir}`);

const production = await branchByName(need('PRODUCTION_BRANCH'));
if (!production) throw new Error('production branch not found');

const label = positionals.length ? 'files' : args.dir === 'migrations' ? '' : basename(args.dir);
const outDir = `${ROOT}/data/rehearsal/${[args.against, label, args.tag].filter(Boolean).join('-')}`;
if (!args.public) mkdirSync(outDir, { recursive: true });

async function newBranch(name) {
  const created = await createBranch({ name, parentId: production.id, schemaOnly: fixtures });
  console.log(`  branch ${created.branch.name} ready in ${(created.readyMs / 1000).toFixed(1)}s`);
  if (fixtures) {
    const { connect } = await import('./lib/db.mjs');
    const c = await connect(created.uri);
    await c.query(readFileSync(`${ROOT}/fixtures/seed.sql`, 'utf8'));
    await c.end();
  }
  return created;
}

async function dropBranch(created) {
  if (args.keep) return null;
  try {
    await deleteBranch(created.branch.id);
    return null;
  } catch (e) {
    return `could not delete ${created.branch.name} (it expires on its own): ${e.message}`;
  }
}

async function rehearse(path, created) {
  const file = basename(path);
  const run = await runWithTraffic(created.uri, readFileSync(path, 'utf8'), { stallMs, includeDetail: !args.public });
  const result = {
    migration: file,
    against: args.against,
    branch: created.branch.name,
    branchReadyMs: created.readyMs,
    ...run,
    schemaDiff: run.error
      ? ''
      : await schemaDiff(production.name, created.branch.name).catch((e) => `schema-diff failed: ${e.message}`),
  };
  printResult(result);
  if (result.schemaDiff) console.log(result.schemaDiff.split('\n').map((l) => `    | ${l}`).join('\n'));
  return result;
}

const summary = [];
const save = (result) => {
  summary.push(result);
  if (!args.public) writeFileSync(`${outDir}/${result.migration.replace(/\.sql$/, '.json')}`, JSON.stringify(result, null, 2) + '\n');
};

if (args.sequence) {
  console.log(`\n${paths.length} migrations in order on one ${fixtures ? 'schema-only branch with fixtures' : 'branch of production'}`);
  const created = await newBranch(`rehearse-sequence-${Date.now().toString(36)}`);
  try {
    for (const path of paths) {
      console.log(`\n${basename(path)}`);
      save(await rehearse(path, created));
    }
  } finally {
    const deleteError = await dropBranch(created);
    const cycleMs = Date.now() - created.started;
    for (const r of summary) Object.assign(r, { cycleMs, deleteError });
  }
} else {
  for (const path of paths) {
    const file = basename(path);
    console.log(`\n${file} on a ${fixtures ? 'schema-only branch with fixtures' : 'branch of production'}`);
    const created = await newBranch(`rehearse-${file.replace(/\.sql$/, '').replace(/_/g, '-')}-${Date.now().toString(36)}`);
    let result;
    try {
      result = await rehearse(path, created);
    } finally {
      const deleteError = await dropBranch(created);
      if (result) save({ ...result, cycleMs: Date.now() - created.started, deleteError });
    }
  }
}

const passed = summary.filter((s) => s.verdict === 'PASS').length;
console.log(`\n${passed} of ${summary.length} passed on ${args.against}`);

if (args.markdown) {
  const cell = (v) => `${v.pass ? 'ok' : '**fail**'}: ${v.reason.replace(/\|/g, '/')}`;
  const lines = [
    `### Migration rehearsal on a ${fixtures ? 'schema-only branch with fixtures' : 'Neon branch of production'}`,
    '',
    `${passed} of ${summary.length} passed${args.sequence ? ', run in order on one branch' : ''}. Blocking limit: ${stallMs} ms.`,
    '',
    '| Migration | Result | Ran for | Runs | App | Blocking | Rows |',
    '|---|---|---|---|---|---|---|',
    ...summary.map(
      (s) =>
        `| \`${s.migration}\` | ${s.verdict} | ${(s.migrationMs / 1000).toFixed(1)} s | ${cell(s.gates.runs)} | ${cell(s.gates.app)} | ${cell(s.gates.blocking)} | ${cell(s.gates.rows)} |`,
    ),
    '',
    ...summary
      .filter((s) => s.schemaDiff)
      .flatMap((s) => [`<details><summary>Schema diff: ${s.migration}</summary>`, '', '```diff', s.schemaDiff, '```', '</details>', '']),
  ];
  writeFileSync(args.markdown, lines.join('\n') + '\n');
}
process.exitCode = passed === summary.length ? 0 : 1;
