-- rehearse: moves orders -> orders_archive
-- The DELETE matches exactly the rows the INSERT copied.
WITH moved AS (
  DELETE FROM orders
  WHERE status = 'refunded' AND created_at < now() - interval '1 year'
  RETURNING id, customer_id, amount_cents, status, created_at
)
INSERT INTO orders_archive SELECT * FROM moved;
