### Migration rehearsal on a Neon branch of production

1 of 3 passed, run in order on one branch; 1 not run because an earlier migration errored. Blocking limit: 1000 ms.

| Migration | Result | Ran for | Runs | App | Blocking | Rows |
|---|---|---|---|---|---|---|
| `001_add_order_source.sql` | PASS | 0.1 s | ok: completed | ok: no app query failed | ok: worst write 36 ms, worst read 33 ms (limit 1000 ms) | ok: no table lost rows |
| `002_unique_customer_email.sql` | FAIL | 0.3 s | **fail**: SQLSTATE 23505 unique_violation | ok: no app query failed | ok: worst write 50 ms, worst read 38 ms (limit 1000 ms) | ok: no table lost rows |
| `003_index_orders_created_at.sql` | NOT RUN | | | | | |

<details><summary>Schema diff: 001_add_order_source.sql</summary>

```diff
--- Database: neondb	(Branch: br-ancient-salad-b2vntgbd)
+++ Database: neondb	(Branch: br-flat-glitter-b2p3ab7p)
@@ -57,9 +57,10 @@
     id bigint NOT NULL,
     customer_id bigint NOT NULL,
     amount_cents integer NOT NULL,
     status text NOT NULL,
-    created_at timestamp with time zone DEFAULT now() NOT NULL
+    created_at timestamp with time zone DEFAULT now() NOT NULL,
+    source text DEFAULT 'web'::text NOT NULL
 );
 
 
 ALTER TABLE public.orders OWNER TO neondb_owner;
```
</details>

