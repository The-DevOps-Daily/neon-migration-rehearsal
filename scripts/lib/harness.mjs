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

/**
 * A tiny app: one connection writing orders and one reading them, each running one query about
 * every 100 ms, plus a watcher sampling pg_stat_activity for those two sessions waiting on a lock.
 */
async function startTraffic(uri, maxOrderId, maxCustomerId) {
  const opened = [];
  try {
    for (let i = 0; i < 3; i++) opened.push(await connect(uri));
  } catch (e) {
    await Promise.allSettled(opened.map((c) => c.end()));
    throw e;
  }
  const [writer, reader, watcher] = opened;
  for (const c of opened) await c.query(`SET statement_timeout = '300s'`);
  const appPids = [writer.processID, reader.processID];

  const ops = [];
  const waits = new Map();
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
        error = e.message;
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
           WHERE pid = ANY($1) AND wait_event_type = 'Lock'`,
          [appPids],
        );
        for (const r of rows) {
          const key = `${r.wait_event}: ${r.query.replace(/\s+/g, ' ')}`;
          waits.set(key, Math.max(waits.get(key) ?? 0, Math.round(r.age_ms)));
        }
      } catch {
        // a failed sample loses one observation, never the run
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

/**
 * Run `sql` on the database at `uri` with traffic around it, and apply four gates: it runs, the
 * app's queries do not fail, no app query waits longer than `stallMs`, and no table loses rows
 * (for a declared move, the counts leaving one table and arriving in the other must match).
 * `includeDetail` adds Postgres' error DETAIL, which can quote row values: keep it out of
 * anything public.
 */
export async function runWithTraffic(uri, sql, { stallMs = 1000, beforeRun, includeDetail = true } = {}) {
  const meta = header(sql);
  const client = await connect(uri);
  let traffic = null;
  try {
    if (beforeRun) await beforeRun(client);
    // Reading every table once also pulls it through the compute's cache before the timing starts.
    const warmStarted = Date.now();
    const before = await rowCounts(client);
    const warmupMs = Date.now() - warmStarted;
    const { rows: ids } = await client.query(
      'SELECT (SELECT max(id) FROM orders) AS o, (SELECT max(id) FROM customers) AS c',
    );

    traffic = await startTraffic(uri, Number(ids[0].o ?? 1), Number(ids[0].c ?? 1));
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
      error = includeDetail && e.detail ? `${e.message} (${e.detail})` : e.message;
      await client.query('ROLLBACK').catch(() => {});
    }
    const finished = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    const lockWaits = await traffic.stop();
    // Read these after stop(): an insert still in flight at stop time counts too.
    const ops = traffic.ops;
    const inserted = traffic.inserted;
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
      blocking: {
        pass: worstWrite < stallMs && worstRead < stallMs,
        reason: covered
          ? `worst write ${worstWrite} ms, worst read ${worstRead} ms (limit ${stallMs} ms)`
          : `the migration ended before a read and a write overlapped it (${finished - started} ms); worst seen ${Math.max(worstWrite, worstRead)} ms`,
      },
      rows: rowsGate(deltas, meta.moves),
    };
    return {
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
