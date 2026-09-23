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

/** A tiny app: one connection writing orders, one reading them, one watching for lock waits. */
async function startTraffic(uri, maxOrderId, maxCustomerId) {
  const writer = await connect(uri);
  const reader = await connect(uri);
  const watcher = await connect(uri);
  for (const c of [writer, reader, watcher]) await c.query(`SET statement_timeout = '300s'`);
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
  const loops = [
    loop('write', async () => {
      await writer.query(
        `INSERT INTO orders (customer_id, amount_cents, status) VALUES ($1, $2, 'paid')`,
        [pick(maxCustomerId), 1999],
      );
      inserted += 1;
    }),
    loop('read', () => reader.query('SELECT id, status FROM orders WHERE id = $1', [pick(maxOrderId)])),
    (async () => {
      while (running) {
        const { rows } = await watcher.query(
          `SELECT left(query, 70) AS query, wait_event,
                  extract(epoch FROM now() - query_start) * 1000 AS waited_ms
           FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        for (const r of rows) {
          const key = `${r.wait_event}: ${r.query.replace(/\s+/g, ' ')}`;
          waits.set(key, Math.max(waits.get(key) ?? 0, Math.round(r.waited_ms)));
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })(),
  ];
  return {
    ops,
    get inserted() {
      return inserted;
    },
    async stop() {
      running = false;
      await Promise.all(loops);
      await Promise.all([writer.end(), reader.end(), watcher.end()]);
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

/**
 * Run `sql` on the database at `uri` with traffic around it, and apply three gates:
 * it runs, it does not block the app for longer than `stallMs`, and it loses no rows
 * (or, for a declared move, every row leaving one table arrives in the other).
 */
export async function runWithTraffic(uri, sql, { stallMs = 1000, beforeRun } = {}) {
  const meta = header(sql);
  const client = await connect(uri);
  if (beforeRun) await beforeRun(client);
  // Reading every table once also pulls it through the compute's cache, so a fresh branch
  // is not measured with a cold cache that production would not have.
  const warmStarted = Date.now();
  const before = await rowCounts(client);
  const warmupMs = Date.now() - warmStarted;
  const { rows: ids } = await client.query(
    'SELECT (SELECT max(id) FROM orders) AS o, (SELECT max(id) FROM customers) AS c',
  );

  const traffic = await startTraffic(uri, Number(ids[0].o ?? 1), Number(ids[0].c ?? 1));
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
    error = e.detail ? `${e.message} (${e.detail})` : e.message;
    await client.query('ROLLBACK').catch(() => {});
  }
  const finished = Date.now();
  await new Promise((r) => setTimeout(r, 1500));
  const lockWaits = await traffic.stop();

  const during = traffic.ops.filter((o) => o.at + o.ms >= started && o.at <= finished);
  const worst = (kind) => Math.max(0, ...during.filter((o) => o.kind === kind).map((o) => o.ms));
  const after = await rowCounts(client);
  await client.end();

  // Row deltas, not counting the orders the traffic loop itself inserted.
  const deltas = {};
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    deltas[table] = (after[table] ?? 0) - (before[table] ?? 0) - (table === 'orders' ? traffic.inserted : 0);
  }
  let rows = { pass: true, reason: 'no table lost rows' };
  const lost = Object.entries(deltas).filter(([, d]) => d < 0);
  if (meta.moves) {
    const net = deltas[meta.moves.from] + deltas[meta.moves.to];
    rows =
      net === 0
        ? { pass: true, reason: `${-deltas[meta.moves.from]} rows moved ${meta.moves.from} -> ${meta.moves.to}` }
        : {
            pass: false,
            reason: `${meta.moves.from} lost ${-deltas[meta.moves.from]} rows but ${meta.moves.to} gained ${deltas[meta.moves.to]}: ${-net} rows gone`,
          };
  } else if (lost.length) {
    rows = { pass: false, reason: lost.map(([t, d]) => `${t} lost ${-d} rows`).join(', ') };
  }

  const worstWrite = worst('write');
  const worstRead = worst('read');
  const gates = {
    runs: { pass: !error, reason: error ?? 'completed' },
    blocking: {
      pass: worstWrite < stallMs && worstRead < stallMs,
      reason: `worst write ${worstWrite} ms, worst read ${worstRead} ms (limit ${stallMs} ms)`,
    },
    rows,
  };
  return {
    warmupMs,
    migrationMs: finished - started,
    error,
    traffic: {
      writesDuring: during.filter((o) => o.kind === 'write').length,
      readsDuring: during.filter((o) => o.kind === 'read').length,
      worstWriteMs: worstWrite,
      worstReadMs: worstRead,
      failedOps: traffic.ops.filter((o) => o.error).map((o) => `${o.kind}: ${o.error}`).slice(0, 5),
    },
    lockWaits,
    rowsBefore: before,
    rowsAfter: after,
    rowDeltas: deltas,
    gates,
    verdict: gates.runs.pass && gates.blocking.pass && gates.rows.pass ? 'PASS' : 'FAIL',
  };
}

export function printResult(result) {
  console.log(`  ${result.verdict}  ran in ${(result.migrationMs / 1000).toFixed(1)}s`);
  for (const [gate, v] of Object.entries(result.gates)) {
    console.log(`    ${v.pass ? 'ok  ' : 'FAIL'} ${gate.padEnd(8)} ${v.reason}`);
  }
  for (const [wait, ms] of Object.entries(result.lockWaits).slice(0, 2)) console.log(`    lock wait ${ms} ms  ${wait}`);
}
