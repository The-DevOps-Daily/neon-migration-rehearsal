// Is a rehearsal on a branch a fair stand-in for production? Run the same migration on the
// production branch itself, with the same traffic and gates, then undo it with Neon's
// point-in-time restore.
//
//   node scripts/check-on-production.mjs migrations/003_index_orders_created_at.sql
//
// Only for this demo project: it changes production for a few seconds before restoring it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { ROOT, need } from './lib/env.mjs';
import { branchByName, connectionUri, deleteBranch, restoreBranch } from './lib/neon.mjs';
import { connect } from './lib/db.mjs';
import { runWithTraffic, printResult, rowCounts } from './lib/harness.mjs';

// Columns with types, and index names: enough to see that the restore undid the migration.
async function schemaFingerprint(client) {
  const { rows: cols } = await client.query(
    `SELECT table_name || '.' || column_name || ' ' || data_type AS c FROM information_schema.columns
     WHERE table_schema = 'public' ORDER BY 1`,
  );
  const { rows: idx } = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`);
  return [...cols.map((r) => r.c), ...idx.map((r) => `index ${r.indexname}`)].join('\n');
}

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: node scripts/check-on-production.mjs <migration.sql>...');
const production = await branchByName(need('PRODUCTION_BRANCH'));
const uri = await connectionUri(production.id);
mkdirSync(`${ROOT}/data/on-production`, { recursive: true });

for (const path of files) {
  const file = basename(path);
  const sql = readFileSync(`${ROOT}/${path}`, 'utf8');
  console.log(`\n${file} on production itself`);

  const c = await connect(uri);
  const { rows } = await c.query('SELECT now() AS t');
  const restorePoint = rows[0].t.toISOString();
  const countsBefore = await rowCounts(c);
  const schemaBefore = await schemaFingerprint(c);
  await c.end();
  // Leave a moment between the restore point and the first write.
  await new Promise((r) => setTimeout(r, 2000));

  const result = { migration: file, restorePoint, ...(await runWithTraffic(uri, sql)) };
  printResult(result);

  const started = Date.now();
  const preserved = await restoreBranch(production.id, restorePoint, `before-restore-${Date.now().toString(36)}`);
  result.restoreMs = Date.now() - started;
  const check = await connect(uri);
  result.countsAfterRestore = await rowCounts(check);
  const schemaAfter = await schemaFingerprint(check);
  await check.end();
  result.restoredCleanly =
    JSON.stringify(result.countsAfterRestore) === JSON.stringify(countsBefore) && schemaAfter === schemaBefore;
  if (preserved) await deleteBranch(preserved.id);
  console.log(
    `  restored production to ${restorePoint} in ${(result.restoreMs / 1000).toFixed(1)}s; schema and row counts ${result.restoredCleanly ? 'match' : 'DIFFER from'} the restore point`,
  );
  writeFileSync(`${ROOT}/data/on-production/${file.replace(/\.sql$/, '.json')}`, JSON.stringify(result, null, 2) + '\n');
}
