-- no-transaction
-- The same index, built without blocking writes.
CREATE INDEX CONCURRENTLY orders_created_at_idx ON orders (created_at);
