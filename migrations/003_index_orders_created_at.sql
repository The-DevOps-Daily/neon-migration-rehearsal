-- Speed up the "orders this month" report.
CREATE INDEX orders_created_at_idx ON orders (created_at);
