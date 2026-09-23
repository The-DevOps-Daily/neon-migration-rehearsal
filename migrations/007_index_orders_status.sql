-- no-transaction
-- The support dashboard filters orders by status. Built without blocking writes.
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
