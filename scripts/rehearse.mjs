// Rehearse migrations on a Neon branch before they reach production.
//
//   node scripts/rehearse.mjs                         every file in migrations/, branch of production
//   node scripts/rehearse.mjs --against fixtures      the same on a schema-only branch with CI fixtures
//   node scripts/rehearse.mjs --dir migrations/fixed  the fixed versions
//   node scripts/rehearse.mjs --only 003 --keep       one migration, keep the branch afterwards
//   node scripts/rehearse.mjs migrations/007_x.sql --markdown rehearsal.md
//                                                    named files (CI passes the changed ones)
//
// For each migration: branch, run it while a small app keeps reading and writing, check three
// gates, print Neon's schema diff, and delete the branch. Results go to data/rehearsal/.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
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
    markdown: { type: 'string' },
    'stall-ms': { type: 'string', default: '1000' },
    tag: { type: 'string', default: '' },
  },
});
if (!['production', 'fixtures'].includes(args.against)) throw new Error('--against production|fixtures');
const stallMs = Number(args['stall-ms']);

const dir = positionals.length ? dirname(positionals[0]) : args.dir;
const files = positionals.length
  ? positionals.map((p) => basename(p))
  : readdirSync(`${ROOT}/${dir}`)
      .filter((f) => f.endsWith('.sql') && (!args.only || f.startsWith(args.only)))
      .sort();
if (files.length === 0) throw new Error(`no migrations in ${dir}`);

const production = await branchByName(need('PRODUCTION_BRANCH'));
if (!production) throw new Error('production branch not found');

const outDir = `${ROOT}/data/rehearsal/${args.against}${dir === 'migrations' ? '' : `-${basename(dir)}`}${args.tag ? `-${args.tag}` : ''}`;
mkdirSync(outDir, { recursive: true });

const summary = [];
for (const file of files) {
  const sql = readFileSync(`${ROOT}/${dir}/${file}`, 'utf8');
  const name = `rehearse-${file.replace(/\.sql$/, '').replace(/_/g, '-')}-${Date.now().toString(36)}`;
  const fixtures = args.against === 'fixtures';
  console.log(`\n${file} on a ${fixtures ? 'schema-only branch with fixtures' : 'branch of production'}`);

  const created = await createBranch({ name, parentId: production.id, schemaOnly: fixtures });
  console.log(`  branch ${created.branch.name} ready in ${(created.readyMs / 1000).toFixed(1)}s`);
  let result;
  try {
    const run = await runWithTraffic(created.uri, sql, {
      stallMs,
      beforeRun: fixtures ? (c) => c.query(readFileSync(`${ROOT}/fixtures/seed.sql`, 'utf8')) : undefined,
    });
    result = {
      migration: file,
      dir,
      against: args.against,
      branch: created.branch.name,
      branchReadyMs: created.readyMs,
      ...run,
      schemaDiff: run.error
        ? ''
        : await schemaDiff(production.name, created.branch.name).catch((e) => `schema-diff failed: ${e.message}`),
    };
  } finally {
    if (!args.keep) await deleteBranch(created.branch.id);
  }

  writeFileSync(`${outDir}/${file.replace(/\.sql$/, '.json')}`, JSON.stringify(result, null, 2) + '\n');
  summary.push(result);
  printResult(result);
  if (result.schemaDiff) console.log(result.schemaDiff.split('\n').map((l) => `    | ${l}`).join('\n'));
}

const passed = summary.filter((s) => s.verdict === 'PASS').length;
console.log(`\n${passed} of ${summary.length} passed on ${args.against}`);

if (args.markdown) {
  const cell = (v) => `${v.pass ? 'ok' : '**fail**'}: ${v.reason.replace(/\|/g, '/')}`;
  const lines = [
    `### Migration rehearsal on a ${args.against === 'fixtures' ? 'schema-only branch with fixtures' : 'Neon branch of production'}`,
    '',
    `${passed} of ${summary.length} passed. Blocking limit: ${stallMs} ms.`,
    '',
    '| Migration | Result | Ran for | Runs | Blocking | Rows |',
    '|---|---|---|---|---|---|',
    ...summary.map(
      (s) =>
        `| \`${s.migration}\` | ${s.verdict} | ${(s.migrationMs / 1000).toFixed(1)} s | ${cell(s.gates.runs)} | ${cell(s.gates.blocking)} | ${cell(s.gates.rows)} |`,
    ),
    '',
    ...summary
      .filter((s) => s.schemaDiff)
      .flatMap((s) => [`<details><summary>Schema diff: ${s.migration}</summary>`, '', '```diff', s.schemaDiff, '```', '</details>', '']),
  ];
  writeFileSync(args.markdown, lines.join('\n') + '\n');
}
process.exitCode = passed === summary.length ? 0 : 1;
