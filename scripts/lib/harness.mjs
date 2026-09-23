// Run one migration against a database while a small app keeps using it, and judge the result.
// Used by rehearse.mjs on branches and by check-on-production.mjs on production itself.

import { connect } from './db.mjs';

export async function rowCounts(client) {
  const { rows: tables } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const counts = {};
  for (const { tablename } of tables) {
    const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${tablename}`);
    counts[tablename] = Number(rows[0].n);
  }
  return counts;
}

const APP = 'rehearsal-app';

/**
 * A tiny app: one connection writing orders and one reading them, each running one query about
 * every 100 ms, plus a watcher sampling pg_stat_activity for app queries waiting on a lock.
 * The app connects through `appUri` (the pooled string, as most apps on Neon do) and the watcher
 * through `uri` (direct). The pooler moves an app client between backends, so the watcher finds
 * app queries by application_name, which the pooler passes on, not by backend PID.
 */
async function startTraffic(uri, appUri, maxOrderId, maxCustomerId, includeDetail) {
  const opened = [];
  try {
    // query_timeout is enforced by the driver: session SETs do not hold through a transaction pooler.
    for (let i = 0; i < 2; i++) opened.push(await connect(appUri, { application_name: APP, query_timeout: 300_000 }));
    opened.push(await connect(uri, { query_timeout: 60_000 }));
  } catch (e) {
    await Promise.allSettled(opened.map((c) => c.end()));
    throw e;
  }
  const [writer, reader, watcher] = opened;

  const ops = [];
  const waits = new Map();
  const samples = { ok: 0, failed: 0 };
  let running = true;
  let inserted = 0;
  const pick = (max) => 1 + Math.floor(Math.random() * max);
  const loop = async (kind, fn) => {
    while (running) {
      const started = Date.now();
      let error = null;
      try {
        await fn();
      } catch (e) {
        error = describeError(e, includeDetail);
      }
      ops.push({ kind, at: started, ms: Date.now() - started, error });
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const watch = async () => {
    while (running) {
      try {
        const { rows } = await watcher.query(
          `SELECT left(query, 70) AS query, wait_event,
                  extract(epoch FROM now() - query_start) * 1000 AS age_ms
           FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [APP],
        );
        for (const r of rows) {
          const key = `${r.wait_event}: ${r.query.replace(/\s+/g, ' ')}`;
          waits.set(key, Math.max(waits.get(key) ?? 0, Math.round(r.age_ms)));
        }
        samples.ok += 1;
      } catch {
        // a failed sample loses one observation, never the run; the count is reported
        samples.failed += 1;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const loops = [
    loop('write', async () => {
      await writer.query(
        `INSERT INTO orders (customer_id, amount_cents, status) VALUES ($1, $2, 'paid')`,
        [pick(maxCustomerId), 1999],
      );
      inserted += 1;
    }),
    loop('read', () => reader.query('SELECT id, status FROM orders WHERE id = $1', [pick(maxOrderId)])),
    watch(),
  ];
  return {
    ops,
    samples,
    get inserted() {
      return inserted;
    },
    async stop() {
      running = false;
      try {
        await Promise.allSettled(loops);
      } finally {
        await Promise.allSettled(opened.map((c) => c.end()));
      }
      return Object.fromEntries([...waits].sort((a, b) => b[1] - a[1]));
    },
  };
}

/** Options a migration file can declare in its leading comments. */
export function header(sql) {
  const moves = sql.match(/^--\s*rehearse:\s*moves\s+(\w+)\s*->\s*(\w+)/m);
  return {
    moves: moves ? { from: moves[1], to: moves[2] } : null,
    noTransaction: /^--\s*no-transaction/m.test(sql),
  };
}

function rowsGate(deltas, moves) {
  const lost = Object.entries(deltas).filter(
    ([table, d]) => d < 0 && !(moves && table === moves.from),
  );
  const problems = lost.map(([t, d]) => `${t} lost ${-d} rows`);
  let moved = null;
  if (moves) {
    const out = -(deltas[moves.from] ?? 0);
    const got = deltas[moves.to] ?? 0;
    if (out < 0) problems.push(`${moves.from} gained ${-out} rows but is declared as the source`);
    else if (out !== got) problems.push(`${moves.from} lost ${out} rows but ${moves.to} gained ${got}: ${out - got} rows unaccounted for`);
    else moved = `${out} rows moved ${moves.from} -> ${moves.to} (counts match)`;
  }
  if (problems.length) return { pass: false, reason: problems.join('; ') };
  return { pass: true, reason: moved ?? 'no table lost rows' };
}

// Postgres conditions a public result may name. Anything else is reported by code only.
const CONDITIONS = {
  '23505': 'unique_violation',
  '23502': 'not_null_violation',
  '23503': 'foreign_key_violation',
  '23514': 'check_violation',
  '22P02': 'invalid_text_representation',
  '42P01': 'undefined_table',
  '42703': 'undefined_column',
  '55P03': 'lock_not_available',
  '57014': 'query_canceled',
  '25001': 'active_sql_transaction',
};

// Error messages can quote values (a failed cast prints the value) and DETAIL quotes rows, so
// public output gets only the SQLSTATE code and its condition name.
export function describeError(e, includeDetail) {
  if (includeDetail) return e.detail ? `${e.message} (${e.detail})` : e.message;
  return `SQLSTATE ${e.code ?? 'unknown'}${CONDITIONS[e.code] ? ` ${CONDITIONS[e.code]}` : ''}`;
}

/**
 * Run `sql` on the database at `uri` with traffic around it, and apply four gates: it runs, the
 * app's queries do not fail, no app query waits longer than `stallMs`, and no table loses rows
 * (for a declared move, the counts leaving one table and arriving in the other must match).
 * With `includeDetail` false, errors are reported as SQLSTATE codes only (see describeError).
 */
export async function runWithTraffic(
  uri,
  sql,
  { appUri = uri, stallMs = 1000, beforeRun, includeDetail = true, statementTimeout = '10min' } = {},
) {
  const meta = header(sql);
  // The migration takes the direct connection, as Neon advises for schema changes.
  const client = await connect(uri);
  let traffic = null;
  try {
    // A runaway migration must not hold the branch (or production) forever.
    await client.query(`SET statement_timeout = '${statementTimeout}'`);
    if (beforeRun) await beforeRun(client);
    // Reading every table once also pulls it through the compute's cache before the timing starts.
    const warmStarted = Date.now();
    const before = await rowCounts(client);
    const warmupMs = Date.now() - warmStarted;
    const { rows: ids } = await client.query(
      'SELECT (SELECT max(id) FROM orders) AS o, (SELECT max(id) FROM customers) AS c',
    );

    traffic = await startTraffic(uri, appUri, Number(ids[0].o ?? 1), Number(ids[0].c ?? 1), includeDetail);
    await new Promise((r) => setTimeout(r, 1500));

    const started = Date.now();
    let error = null;
    try {
      if (meta.noTransaction) {
        await client.query(sql);
      } else {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
      }
    } catch (e) {
      error = describeError(e, includeDetail);
      await client.query('ROLLBACK').catch(() => {});
    }
    const finished = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    const lockWaits = await traffic.stop();
    // Read these after stop(): an insert still in flight at stop time counts too.
    const ops = traffic.ops;
    const inserted = traffic.inserted;
    const lockSamples = traffic.samples;
    traffic = null;

    const overlapping = ops.filter((o) => o.at + o.ms >= started && o.at <= finished);
    const worst = (kind) => Math.max(0, ...overlapping.filter((o) => o.kind === kind).map((o) => o.ms));
    const covered = ['write', 'read'].every((kind) => overlapping.some((o) => o.kind === kind));
    // App errors from the start of the migration to the end of the observation window.
    const appErrors = ops.filter((o) => o.error && o.at + o.ms >= started).map((o) => `${o.kind}: ${o.error}`);
    const after = await rowCounts(client);

    // Row deltas, not counting the orders the traffic loop itself inserted.
    const deltas = {};
    for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
      deltas[table] = (after[table] ?? 0) - (before[table] ?? 0) - (table === 'orders' ? inserted : 0);
    }

    const worstWrite = worst('write');
    const worstRead = worst('read');
    const gates = {
      runs: { pass: !error, reason: error ?? 'completed' },
      app: {
        pass: appErrors.length === 0,
        reason: appErrors.length ? `${appErrors.length} app queries failed, first: ${appErrors[0]}` : 'no app query failed',
      },
      // Without a read and a write overlapping the migration there is nothing to judge, unless the
      // migration itself was shorter than the limit (then nothing could have waited that long).
      blocking: covered
        ? {
            pass: worstWrite < stallMs && worstRead < stallMs,
            reason: `worst write ${worstWrite} ms, worst read ${worstRead} ms (limit ${stallMs} ms)`,
          }
        : {
            pass: finished - started < stallMs,
            reason:
              finished - started < stallMs
                ? `ran for ${finished - started} ms, under the ${stallMs} ms limit, before app traffic overlapped it`
                : `not enough app traffic overlapped the ${finished - started} ms migration to judge`,
          },
      rows: rowsGate(deltas, meta.moves),
    };
    return {
      connections: {
        migration: uri.includes('-pooler.') ? 'pooled' : 'direct',
        app: appUri.includes('-pooler.') ? 'pooled' : 'direct',
      },
      warmupMs,
      migrationMs: finished - started,
      error,
      traffic: {
        inserted,
        writesDuring: overlapping.filter((o) => o.kind === 'write').length,
        readsDuring: overlapping.filter((o) => o.kind === 'read').length,
        worstWriteMs: worstWrite,
        worstReadMs: worstRead,
        failedOps: appErrors.slice(0, 5),
      },
      // Age of an app query seen waiting on a lock: an upper estimate of its lock wait, sampled every 200 ms.
      lockWaits,
      lockSamples,
      rowsBefore: before,
      rowsAfter: after,
      rowDeltas: deltas,
      gates,
      verdict: Object.values(gates).every((g) => g.pass) ? 'PASS' : 'FAIL',
    };
  } finally {
    if (traffic) await traffic.stop().catch(() => {});
    await client.end().catch(() => {});
  }
}

export function printResult(result) {
  console.log(`  ${result.verdict}  ran in ${(result.migrationMs / 1000).toFixed(1)}s`);
  for (const [gate, v] of Object.entries(result.gates)) {
    console.log(`    ${v.pass ? 'ok  ' : 'FAIL'} ${gate.padEnd(8)} ${v.reason}`);
  }
  for (const [wait, ms] of Object.entries(result.lockWaits).slice(0, 2)) {
    console.log(`    waiting on a lock, query age ${ms} ms  ${wait}`);
  }
}
