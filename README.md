# neon-migration-rehearsal

Rehearse every Postgres migration on a Neon branch of production before it ships.
For each migration, the runner branches production (copy-on-write, a few
seconds), runs the migration while a small app keeps reading and writing, checks
four gates, prints Neon's schema diff, and deletes the branch.

The same six migrations passed 6 of 6 on a schema-only branch with CI fixtures,
and 1 of 6 on branches of production, in each of three runs.

Companion to the DevOps Daily article
[Rehearse every migration on a Neon branch before production](https://devops-daily.com/posts/rehearse-migrations-on-a-neon-branch).

## Run it

You need Node 20+, a Neon project, and an API key that can create branches in it.

```bash
npm install
cp .env.example .env                        # NEON_API_KEY, NEON_PROJECT_ID, DATABASE_URL
node scripts/seed-production.mjs            # 500,000 customers, 4,000,000 orders on main
node scripts/rehearse.mjs                   # every migration, on a branch of production
node scripts/rehearse.mjs --against fixtures    # the same, on schema-only branches with CI fixtures
node scripts/rehearse.mjs --dir migrations/fixed
```

## The gates

- **runs**: the migration completes without an error.
- **app**: no read or write from the app failed from the start of the migration to 1.5 s after it.
- **blocking**: no app read or write took longer than `--stall-ms` (1,000 ms by
  default) while the migration ran. A second connection samples `pg_stat_activity`
  for the app's sessions waiting on a lock, so the report names the statement that
  waited.
- **rows**: no table lost rows, not counting the orders the app inserted. A
  migration that moves rows declares it (`-- rehearse: moves orders -> orders_archive`),
  and then the number of rows leaving one table must equal the number arriving in
  the other (a count check, not a row-by-row one). All other tables are still checked.
- **schema diff**: `neon branches schema-diff` between production and the
  branch, printed for review.

A migration runs inside `BEGIN ... COMMIT` unless it starts with
`-- no-transaction` (needed for `CREATE INDEX CONCURRENTLY`). By default each
migration gets its own branch; `--sequence` runs the given files in order on one
branch, the way a deploy applies them.

## Results

Production: 500,000 customers and 4,000,000 orders (453 MB), 1 CU compute on
production and on every branch. Three full runs (`data/rehearse-production*.txt`,
`data/rehearsal/`), the same verdicts every time:

| Migration | Fixtures branch | Production branch |
|---|---|---|
| `001` add `source` column with a default | pass | pass |
| `002` unique index on `lower(email)` | pass | **fail**: 1,250 addresses appear twice |
| `003` `CREATE INDEX` on `orders(created_at)` | pass | **fail**: writes blocked 2.3 to 3.1 s |
| `004` `amount_cents` integer to bigint | pass | **fail**: reads and writes blocked 8.0 to 13.1 s |
| `005` `phone SET NOT NULL` | pass | **fail**: 15,000 NULL phones |
| `006` archive refunded orders | pass | **fail**: about 2.13 million orders deleted, never archived |

The fixed versions in `migrations/fixed/` (`CREATE INDEX CONCURRENTLY`, and a
`DELETE ... RETURNING` move) pass on production branches, one per branch and in
sequence on one branch.

`scripts/check-on-production.mjs` runs a migration on production itself with the
same traffic and gates, then undoes it with Neon's point-in-time restore
(`data/on-production/`, `data/check-on-production.txt`). The restore runs even if
the measurement fails, and if the schema or row counts do not match the restore
point afterwards, the pre-restore state is kept as a branch. `003` blocked writes
for 2.4 s on production; `004` blocked for 9.2 s and 8.0 s. The branch and
production ranges overlap: a rehearsal predicts the order of magnitude, not the
exact seconds.

`data/superseded/` holds the runs from the first version of the harness, before a
review added the app gate, safer cleanup and the trusted CI checkout. It measured
stalls the same way.

## In CI

`.github/workflows/rehearse-migrations.yml` rehearses the migrations a pull
request adds or changes, in order on one branch, and comments the gate table on
the pull request.

- The rehearsal code and its dependencies come from the base branch; only the
  pull request's migration SQL is used, so a pull request cannot change the script
  that holds the key. `npm ci` runs with `--ignore-scripts`.
- It runs on `pull_request` for branches of this repository only; forks get no secrets.
- The key is project-scoped: it cannot reach other projects or delete this one,
  but within the project it has editor access, including production's connection
  string. Treat it as a production secret. Anyone who can push a branch can run a
  workflow with it, so if that is too many people, put it in a GitHub environment
  that needs approval.
- On GitHub Actions the script leaves out Postgres error DETAIL, which can quote
  row values, from the log and the comment.
- Every branch is created with an expiry time, so a cancelled run cannot leave
  branches behind.

## Files

- `scripts/seed-production.mjs` builds the production data with `generate_series`
- `scripts/rehearse.mjs` the runner; `--against fixtures` uses schema-only branches, `--sequence` one branch
- `scripts/check-on-production.mjs` the same run on production, then a restore
- `scripts/lib/harness.mjs` traffic, lock sampling and gates
- `scripts/lib/neon.mjs` the Neon API calls (branch, connection string, restore, delete) and `neonctl branches schema-diff`
- `migrations/` six realistic migrations; `migrations/fixed/` two fixes
- `fixtures/seed.sql` what a CI test database usually holds
- `data/` every recorded run

## License

MIT
