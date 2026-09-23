// What the connection_uri API returns with and without `pooled`, and what each connection
// reports as its backend PID. Uses a short-lived schema-only branch, deleted at the end.
//
//   node scripts/check-connection-strings.mjs

import { need } from './lib/env.mjs';
import { branchByName, connectionUri, createBranch, deleteBranch } from './lib/neon.mjs';
import { connect } from './lib/db.mjs';

const production = await branchByName(need('PRODUCTION_BRANCH'));
const created = await createBranch({
  name: `check-connections-${Date.now().toString(36)}`,
  parentId: production.id,
  schemaOnly: true,
});
const pooledHost = (uri) => new URL(uri).hostname.includes('-pooler.');
try {
  // connectionUri() always sends `pooled`; this call leaves it out on purpose.
  const params = new URLSearchParams({ branch_id: created.branch.id, database_name: 'neondb', role_name: 'neondb_owner' });
  const res = await fetch(`https://console.neon.tech/api/v2/projects/${need('NEON_PROJECT_ID')}/connection_uri?${params}`, {
    headers: { Authorization: `Bearer ${need('NEON_API_KEY')}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`connection_uri: ${res.status}`);
  const { uri: omitted } = await res.json();
  console.log(`pooled not given:  pooler host = ${pooledHost(omitted)}`);
  console.log(`pooled=false:      pooler host = ${pooledHost(await connectionUri(created.branch.id, { pooled: false }))}`);
  console.log(`pooled=true:       pooler host = ${pooledHost(await connectionUri(created.branch.id, { pooled: true }))}`);

  const direct = await connect(created.uri);
  try {
    const { rows } = await direct.query('SELECT pg_backend_pid() AS pid');
    console.log(`direct connection: driver processID ${direct.processID}, pg_backend_pid() ${rows[0].pid}`);
  } finally {
    await direct.end();
  }
} finally {
  await deleteBranch(created.branch.id);
}
