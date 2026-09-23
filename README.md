# neon-migration-rehearsal

Rehearse every Postgres migration on a Neon branch of production before it ships.
For each migration, the runner branches production (copy-on-write, a few
seconds), runs the migration while a small app keeps reading and writing, checks
three gates, prints Neon's schema diff, and deletes the branch.

The same six migrations passed 6 of 6 on a schema-only branch with CI fixtures,
and 1 of 6 on branches of production.

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
- **blocking**: no read or write from the app waited longer than `--stall-ms`
  (1,000 ms by default) while the migration ran. A second connection samples
  `pg_stat_activity` for lock waits so the report names the statement that waited.
- **rows**: no table lost rows, not counting the orders the app inserted. A
  migration that moves rows declares it (`-- rehearse: moves orders -> orders_archive`)
  and then every row that leaves one table must arrive in the other.
- **schema diff**: `neon branches schema-diff` between production and the
  branch, printed for review.

A migration runs inside `BEGIN ... COMMIT` unless it starts with
`-- no-transaction` (needed for `CREATE INDEX CONCURRENTLY`).

## Results

Production: 500,000 customers and 4,000,000 orders (453 MB), 1 CU compute on
production and on every branch. Three runs; numbers are from `data/rehearse-production.txt`.

| Migration | Fixtures branch | Production branch |
|---|---|---|
| `001` add `source` column with a default | pass | pass |
| `002` unique index on `lower(email)` | pass | **fail**: 1,250 duplicate addresses |
| `003` `CREATE INDEX` on `orders(created_at)` | pass | **fail**: writes blocked 2.2 s |
| `004` `amount_cents` integer to bigint | pass | **fail**: reads and writes blocked 8.2 s |
| `005` `phone SET NOT NULL` | pass | **fail**: 15,000 NULL phones |
| `006` archive refunded orders | pass | **fail**: 2,133,408 orders deleted, never archived |

The fixed versions in `migrations/fixed/` (`CREATE INDEX CONCURRENTLY`, and a
`DELETE ... RETURNING` move) pass on production branches.

`scripts/check-on-production.mjs` runs a migration on production itself with the
same traffic and gates, then undoes it with Neon's point-in-time restore
(`data/on-production*/`, `data/check-on-production*.txt`). For `003` the branch
and production agreed (2.2 s both). For `004` production blocked for 10.7 s and
14.7 s against 8.2 to 9.1 s on branches: the rehearsal caught it every time, but
its lock time was a lower bound.

## In CI

`.github/workflows/rehearse-migrations.yml` rehearses the migrations a pull
request adds or changes and comments the gate table on the pull request. It uses
a project-scoped Neon API key (it can branch this project and nothing else),
runs on `pull_request` so forks get no secrets, and every branch is created with
an expiry time, so a crashed run cannot leave branches behind.

## Files

- `scripts/seed-production.mjs` builds the production data with `generate_series`
- `scripts/rehearse.mjs` the runner; `--against fixtures` uses schema-only branches
- `scripts/check-on-production.mjs` the same run on production, then a restore
- `scripts/lib/harness.mjs` traffic, lock sampling and gates
- `scripts/lib/neon.mjs` the Neon API calls (branch, connection string, restore, delete) and `neonctl branches schema-diff`
- `migrations/` six realistic migrations; `migrations/fixed/` two fixes
- `fixtures/seed.sql` what a CI test database usually holds
- `data/` every recorded run

## License

MIT
