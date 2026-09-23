// The few Neon API calls a rehearsal needs: branch from production, wait for the compute,
// get a connection string, compare schemas, delete the branch.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { need } from './env.mjs';

const API = 'https://console.neon.tech/api/v2';
const run = promisify(execFile);

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${need('NEON_API_KEY')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Neon API ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const project = () => need('NEON_PROJECT_ID');

export async function branchByName(name) {
  const { branches } = await api('GET', `/projects/${project()}/branches`);
  return branches.find((b) => b.name === name) ?? null;
}

async function waitForOperations(operations, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (const op of operations ?? []) {
    for (;;) {
      if (Date.now() > deadline) throw new Error(`Neon operation ${op.action ?? op.id} did not finish in ${timeoutMs / 1000}s`);
      const { operation } = await api('GET', `/projects/${project()}/operations/${op.id}`);
      if (operation.status === 'finished') break;
      if (['failed', 'error', 'cancelled', 'skipped'].includes(operation.status)) {
        throw new Error(`Neon operation ${operation.action} ${operation.status}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Branch from production. `schemaOnly` copies the schema and no rows, which is what most CI
 * test databases look like. `expiresInMinutes` makes Neon delete the branch on its own if the
 * rehearsal never gets to clean up.
 */
export async function createBranch({ name, parentId, schemaOnly = false, expiresInMinutes = 120, cu = 1 }) {
  const started = Date.now();
  const body = {
    branch: {
      name,
      parent_id: parentId,
      expires_at: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
      ...(schemaOnly ? { init_source: 'schema-only' } : {}),
    },
    endpoints: [{ type: 'read_write', autoscaling_limit_min_cu: cu, autoscaling_limit_max_cu: cu }],
  };
  const created = await api('POST', `/projects/${project()}/branches`, body);
  try {
    await waitForOperations(created.operations);
    const readyMs = Date.now() - started;
    const uri = await connectionUri(created.branch.id);
    return { branch: created.branch, endpoint: created.endpoints?.[0], uri, readyMs, started };
  } catch (e) {
    // The branch exists but is not usable: remove it now rather than wait for its expiry.
    await deleteBranch(created.branch.id).catch(() => {});
    throw e;
  }
}

export async function connectionUri(branchId) {
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: 'neondb',
    role_name: 'neondb_owner',
  });
  const { uri } = await api('GET', `/projects/${project()}/connection_uri?${params}`);
  return uri;
}

export async function deleteBranch(branchId) {
  const res = await api('DELETE', `/projects/${project()}/branches/${branchId}`);
  await waitForOperations(res.operations);
}

/** `neon branches schema-diff`: the schema change a migration makes, as Neon reports it. */
export async function schemaDiff(baseBranch, compareBranch) {
  const { stdout } = await run(
    'npx',
    [
      '--yes',
      'neonctl@6',
      'branches',
      'schema-diff',
      baseBranch,
      compareBranch,
      '--project-id',
      project(),
      '--database',
      'neondb',
      '--no-color',
    ],
    { env: { ...process.env, NEON_API_KEY: need('NEON_API_KEY') }, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

/**
 * Put a branch back to how it was at `timestamp`. Restoring a branch onto its own history
 * requires keeping the current state under another name; this returns that branch.
 */
export async function restoreBranch(branchId, timestamp, preserveUnderName) {
  const res = await api('POST', `/projects/${project()}/branches/${branchId}/restore`, {
    source_branch_id: branchId,
    source_timestamp: timestamp,
    preserve_under_name: preserveUnderName,
  });
  await waitForOperations(res.operations);
  return branchByName(preserveUnderName);
}
