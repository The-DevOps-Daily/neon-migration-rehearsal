### Migration rehearsal on a Neon branch of production

0 of 1 passed. Blocking limit: 1000 ms.

| Migration | Result | Ran for | Runs | Blocking | Rows |
|---|---|---|---|---|---|
| `007_index_orders_status.sql` | FAIL | 4.0 s | ok: completed | **fail**: worst write 3947 ms, worst read 105 ms (limit 1000 ms) | ok: no table lost rows |

<details><summary>Schema diff: 007_index_orders_status.sql</summary>

```diff
--- Database: neondb	(Branch: br-ancient-salad-b2vntgbd)
+++ Database: neondb	(Branch: br-floral-dawn-b2f9br68)
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


