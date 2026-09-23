### Migration rehearsal on a Neon branch of production

2 of 2 passed, run in order on one branch. Blocking limit: 1000 ms.

| Migration | Result | Ran for | Runs | App | Blocking | Rows |
|---|---|---|---|---|---|---|
| `003_index_orders_created_at.sql` | PASS | 2.4 s | ok: completed | ok: no app query failed | ok: worst write 77 ms, worst read 45 ms (limit 1000 ms) | ok: no table lost rows |
| `006_archive_refunded_orders.sql` | PASS | 3.1 s | ok: completed | ok: no app query failed | ok: worst write 131 ms, worst read 46 ms (limit 1000 ms) | ok: 533316 rows moved orders -> orders_archive (counts match) |

<details><summary>Schema diff: 003_index_orders_created_at.sql</summary>

```diff
--- Database: neondb	(Branch: br-ancient-salad-b2vntgbd)
+++ Database: neondb	(Branch: br-wispy-surf-b2swwh35)
@@ -117,8 +117,15 @@
     ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
 
 
 --
+-- Name: orders_created_at_idx; Type: INDEX; Schema: public; Owner: neondb_owner
+--
+
+CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at);
+
+
+--
 -- Name: orders_customer_id_idx; Type: INDEX; Schema: public; Owner: neondb_owner
 --
 
 CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);
```
</details>

<details><summary>Schema diff: 006_archive_refunded_orders.sql</summary>

```diff
--- Database: neondb	(Branch: br-ancient-salad-b2vntgbd)
+++ Database: neondb	(Branch: br-wispy-surf-b2swwh35)
@@ -117,8 +117,15 @@
     ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
 
 
 --
+-- Name: orders_created_at_idx; Type: INDEX; Schema: public; Owner: neondb_owner
+--
+
+CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at);
+
+
+--
 -- Name: orders_customer_id_idx; Type: INDEX; Schema: public; Owner: neondb_owner
 --
 
 CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);
```
</details>

