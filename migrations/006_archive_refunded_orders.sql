-- rehearse: moves orders -> orders_archive
-- Move refunded orders older than a year out of the hot table.
INSERT INTO orders_archive
SELECT id, customer_id, amount_cents, status, created_at
FROM orders
WHERE status = 'refunded' AND created_at < now() - interval '1 year';

DELETE FROM orders
WHERE created_at < now() - interval '1 year';
