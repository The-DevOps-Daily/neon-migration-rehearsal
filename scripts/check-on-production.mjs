// Is a rehearsal on a branch a fair stand-in for production? Run the same migration on the
// production branch itself, with the same traffic and gates, then undo it with Neon's
// point-in-time restore.
//
//   node scripts/check-on-production.mjs migrations/003_index_orders_created_at.sql
//
// Only for this demo project: it changes production for a few seconds before restoring it.
// The restore runs even if the measurement fails. If the restored schema or row counts do not
// match the restore point, the pre-restore state is kept as a branch and the script exits 1.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ROOT, need } from './lib/env.mjs';
import { branchByName, connectionUri, deleteBranch, restoreBranch } from './lib/neon.mjs';
import { connect } from './lib/db.mjs';
import { runWithTraffic, printResult, rowCounts } from './lib/harness.mjs';

// Columns with type, nullability and default; constraints; full index definitions.
async function schemaFingerprint(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => r.x);
  return [
    ...(await q(`SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS x
                 FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)),
    ...(await q(`SELECT conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS x
                 FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`)),
    ...(await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)),
  ].join('\n');
}

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: node scripts/check-on-production.mjs <migration.sql>...');
const production = await branchByName(need('PRODUCTION_BRANCH'));
const uri = await connectionUri(production.id);
mkdirSync(`${ROOT}/data/on-production`, { recursive: true });

for (const path of files) {
  const file = basename(path);
  const sql = readFileSync(resolve(path), 'utf8');
  console.log(`\n${file} on production itself`);

  const c = await connect(uri);
  const { rows } = await c.query('SELECT now() AS t');
  const restorePoint = rows[0].t.toISOString();
  const countsBefore = await rowCounts(c);
  const schemaBefore = await schemaFingerprint(c);
  await c.end();
  // Leave a moment between the restore point and the first write.
  await new Promise((r) => setTimeout(r, 2000));

  const result = { migration: file, restorePoint };
  try {
    Object.assign(result, await runWithTraffic(uri, sql));
    printResult(result);
  } catch (e) {
    result.harnessError = e.message;
    console.log(`  measurement failed: ${e.message}`);
  } finally {
    const started = Date.now();
    const preserved = await restoreBranch(production.id, restorePoint, `before-restore-${Date.now().toString(36)}`);
    result.restoreMs = Date.now() - started;
    const check = await connect(uri);
    result.countsAfterRestore = await rowCounts(check);
    const schemaAfter = await schemaFingerprint(check);
    await check.end();
    result.restoredCleanly =
      JSON.stringify(result.countsAfterRestore) === JSON.stringify(countsBefore) && schemaAfter === schemaBefore;
    if (result.restoredCleanly && preserved) {
      await deleteBranch(preserved.id);
    } else {
      result.keptBranch = preserved?.name ?? null;
      process.exitCode = 1;
    }
    console.log(
      `  restored production to ${restorePoint} in ${(result.restoreMs / 1000).toFixed(1)}s; schema and row counts ${
        result.restoredCleanly ? 'match' : `DIFFER from`
      } the restore point${result.keptBranch ? ` (kept ${result.keptBranch})` : ''}`,
    );
    writeFileSync(`${ROOT}/data/on-production/${file.replace(/\.sql$/, '')}-${restorePoint.replace(/[:.]/g, '')}.json`, JSON.stringify(result, null, 2) + '\n');
  }
}
