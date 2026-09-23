### Migration rehearsal on a Neon branch of production

1 of 1 passed, run in order on one branch. Blocking limit: 1000 ms.

| Migration | Result | Ran for | Runs | App | Blocking | Rows |
|---|---|---|---|---|---|---|
| `007_index_orders_status.sql` | PASS | 4.1 s | ok: completed | ok: no app query failed | ok: worst write 131 ms, worst read 158 ms (limit 1000 ms) | ok: no table lost rows |

<details><summary>Schema diff: 007_index_orders_status.sql</summary>

```diff
--- Database: neondb	(Branch: br-ancient-salad-b2vntgbd)
+++ Database: neondb	(Branch: br-empty-wind-b25rcpgx)
@@ -124,8 +124,15 @@
 CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);
 
 
 --
+-- Name: orders_status_idx; Type: INDEX; Schema: public; Owner: neondb_owner
+--
+
+CREATE INDEX orders_status_idx ON public.orders USING btree (status);
+
+
+--
 -- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
 --
 
 ALTER TABLE ONLY public.orders
```
</details>


